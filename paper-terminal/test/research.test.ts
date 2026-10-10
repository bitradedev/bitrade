import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DAY_MS, ENTRY_BUDGETS_USD, createExecutionFailurePolicy, createResearchSample, evaluateForward, exitGrid, feeAwareStopEstimates, freezeResearchWinner, legacyBaseline, passesFormalMetrics, quoteNativeCashFlow, quoteSlippageAccepted, replayPortfolio, researchDataHash, researchWindows, runResearch, runResearchInWorker, tokenClusterBootstrap, type ExecutableQuoteSnapshot, type ResearchObservation, type ResearchSample, type ReplayResult, type NativeFxSnapshot, type EntryPreparation } from '../src/server/research.js';
import { evaluateShortSignal, evaluateSwingSignal, evaluateWalletSignal, walletSignalKey, type MomentumContext, type SignalBar, type WalletSignalContext } from '../src/server/signals.js';
import type { ExitRules, MarketEvent, Quote, MarketGateway, Chain, Market, ChainStatus, QuoteRequest, PaperOrder } from '../src/shared/domain.js';
import { DEFAULT_RISK } from '../src/shared/domain.js';
import { nativeUsd, usdNative } from '../src/server/money.js';
import { Broker, type BrokerClock } from '../src/server/broker.js';
import { Store } from '../src/server/store.js';

const START=Date.UTC(2026,0,2,0,0);
const RULES:ExitRules={stopPct:15,targets:[{gainPct:30,sellOriginalPct:50}],trailPct:20,maxHoldMs:600_000,protectBreakeven:true};
function quote(at:number,block:number,side:'buy'|'sell',quantity:number,price:number,token='coin',budget=1):ExecutableQuoteSnapshot {
  const units=quantity/1000;
  const native=(v:number)=>(BigInt(Math.round(v*1e6))*1_000_000_000_000n).toString();
  const q:Quote={id:`${token}-${at}-${side}-${quantity}-${budget}`,chain:'bsc',token,side,at,block,inputRaw:side==='buy'?native(budget):String(quantity),outputRaw:side==='buy'?String(quantity):native(units*price),spentInputRaw:side==='buy'?native(budget):String(quantity),refundRaw:'0',tokenDecimals:3,nativeUsd:1,priceUsd:price,priceImpactPct:0,fees:{gasUsd:0,approvalUsd:0,protocolUsd:0,taxUsd:0,conversionUsd:0,includedInOutput:true,quality:'verified',notes:[]},quality:'verified',venue:'fixture-executable',reason:''};
  return {quote:q,requestedUsd:side==='buy'?budget:undefined,requestedTokenRaw:side==='sell'?String(quantity):undefined,tokenAmountRaw:String(quantity),cashDebitUsd:side==='buy'?budget:0,cashCreditUsd:side==='sell'?units*price:0,feesUsd:0,costsIncluded:true,executable:true,receivedAt:at,validUntil:at+5_000,stopEstimates:side==='buy'?[5,10,15].map(stopPct=>({stopPct,netProceedsUsd:budget*(1-stopPct/100),quality:'verified',at})):undefined};
}
function observation(at:number,block:number,price:number,token='coin',budget=1,quantity=1000):ResearchObservation {
  const quotes=[quote(at,block,'buy',quantity,price,token,budget)];
  // Exact per-quantity executable fixtures, never proportionally inferred by engine.
  for(let amount=50;amount<=quantity;amount+=50)quotes.push(quote(at,block,'sell',amount,price,token,budget));
  if(!quotes.some(q=>q.requestedTokenRaw===String(quantity)))quotes.push(quote(at,block,'sell',quantity,price,token,budget));
  return {at,receivedAt:at,block,priceUsd:price,quotes};
}
function sample(id:string,start=START,prices=[1,1,2,2,1.5,1.5],options:{budget?:number;quantity?:number;token?:string}={}):ResearchSample {
  const {budget=1,quantity=1000,token=id}=options;
  const points=prices.map((p,i)=>observation(start+i*1000,1+i,p,token,budget,quantity));
  return createResearchSample({id,chain:'bsc',token,signalAt:start,receivedAt:start,decisionAt:start,capturedAt:start,source:'authoritative',entry:points[0],later:points.slice(1),coveredThrough:start+7*DAY_MS,reason:'verified fixture signal'});
}
function change(s:ResearchSample,fn:(s:any)=>void):ResearchSample {const x=structuredClone(s);fn(x);return createResearchSample(x);}
const window=(start=START)=>({from:start,to:start+60_000,chain:'bsc' as const});

function preparation(budgetUsd:number,offset:number,status:EntryPreparation['status']='ready',token='stream'):EntryPreparation {
  const at=START+offset,block=Math.floor(offset/1000)+1;
  const buy=quote(at,block,'buy',budgetUsd*1000,1,token,budgetUsd),reverse=quote(at,block,'sell',budgetUsd*1000,1,token,budgetUsd);
  buy.stopEstimates=feeAwareStopEstimates(buy.quote,reverse.quote);
  return {at,receivedAt:at,block,budgetUsd,status,...(status==='ready'?{buy,reverse}:{reason:status==='failed'?'captured RPC failure':'captured preparation expiry'})};
}
function stream(preps:EntryPreparation[],later:ResearchObservation[]=[],token='stream'):ResearchSample {
  return createResearchSample({id:'stream:'+token,chain:'bsc',token,signalAt:START,receivedAt:START,decisionAt:START,capturedAt:START,source:'authoritative',entry:{at:START,receivedAt:START,block:1,priceUsd:1,quotes:[]},entryPreparations:preps,later,coveredThrough:START+60_000,reason:'causal preparation fixture'});
}
function streamPath(budget:number,offset=3500,token='stream'):ResearchObservation[]{
  return [1,2,2,1.5,1.5].map((price,i)=>observation(START+offset+i*500,10+i,price,token,budget,budget*1000));
}
function asPreparationStream(s:ResearchSample):ResearchSample {
  const preps=ENTRY_BUDGETS_USD.filter(b=>b>=1).map(b=>{
    const p=preparation(b,s.capturedAt-START,'ready',s.token);p.block=s.entry.block;p.buy!.quote.block=p.block;p.reverse!.quote.block=p.block;
    if(b===1){p.buy=structuredClone(s.entry.quotes.find(q=>q.quote.side==='buy')) as ExecutableQuoteSnapshot;p.reverse=structuredClone(s.entry.quotes.find(q=>q.requestedTokenRaw==='1000')) as ExecutableQuoteSnapshot;p.last=true;}
    return p;
  });
  return change(s,x=>{x.entry.quotes=[];x.entryPreparations=preps;});
}

test('causal preparation stream admits the first affordable size immediately, not the final preparation',()=>{
  const s=change(stream([preparation(5,1000),preparation(3,2000),preparation(2,3000),{...preparation(1.5,7000),last:true}],streamPath(2)),x=>{x.decisionAt=START+20_000;});
  const r=replayPortfolio([s],RULES,window()),a=r.attempts[0];
  assert.equal(r.attempts.length,1);assert.equal(a.status,'closed');assert.equal(a.decisionAt,START+3000);assert.equal(a.openedAt,START+3500);assert.equal(a.originalRaw,'2000');assert.equal(a.netUsd,1.5);assert.equal(r.authoritative,true);
  assert.deepEqual(a.preparations!.map(p=>p.disposition),['rejected','rejected','selected','unused']);
  assert.ok(Object.isFrozen(s.entryPreparations)&&Object.isFrozen(s.entryPreparations![0].buy!.quote));
});

test('each of 32 exit candidates selects once with its own causal decision time and risk sizing',()=>{
  const s=stream([preparation(5,1000),preparation(3,2000),{...preparation(2,3000),last:true}],[]);
  for(const c of exitGrid('short')){
    const r=replayPortfolio([s],c.rules,{...window(),to:START+3200}),a=r.attempts[0];assert.equal(r.attempts.length,1);
    assert.equal(a.decisionAt,START+(c.rules.stopPct===10?2000:3000));
    assert.equal(a.preparations!.filter(p=>p.disposition==='selected')[0].budgetUsd,c.rules.stopPct===10?3:2);
  }
});

test('out-of-order ready amounts wait for larger rejection and never backdate decision',()=>{
  const s=stream([{...preparation(3,1000),last:false},preparation(5,2000),{...preparation(2,7000),last:true}],streamPath(3,2500));
  const r=replayPortfolio([s],{...RULES,stopPct:10},window()),a=r.attempts[0];
  assert.equal(a.decisionAt,START+2000);assert.equal(a.openedAt,START+2500);assert.equal(a.originalRaw,'3000');assert.equal(a.preparations![0].at,START+1000);assert.equal(a.preparations![0].disposition,'selected');
  assert.equal(replayPortfolio([stream([{...preparation(3,1000),last:true}])],{...RULES,stopPct:10},window()).attempts[0].fills.length,0);
});

test('expired, default-15s and wallet deadlines never admit a late preparation or charge policy gas',()=>{
  for(const [offset,expiry] of [[5000,START+5000],[15000,undefined]] as const){
    const s=change(stream([{...preparation(5,offset),last:true}]),x=>{x.signalExpiresAt=expiry;const b=x.entryPreparations[0].buy;b.quote.fees.gasUsd=.01;b.executionFailurePolicy=createExecutionFailurePolicy(b.quote,b.receivedAt);});
    const r=replayPortfolio([s],RULES,window());assert.equal(r.attempts.length,1);assert.equal(r.attempts[0].fills.length,0);assert.equal(r.attempts[0].feesUsd,0);assert.equal(r.metrics.netUsd,0);assert.match(r.attempts[0].reason,/expired/);
  }
  const empty=change(stream([]),x=>{x.signalExpiresAt=START+5000;});assert.equal(replayPortfolio([empty],RULES,window()).attempts[0].endedAt,START+5000);
});

test('wallet swing preparation ready at twenty seconds remains eligible under its sixty-second TTL',()=>{
  const later=streamPath(2,20_500).map((p,i)=>({...p,block:30+i,quotes:p.quotes.map(q=>({...q,quote:{...q.quote,block:30+i}}))}));
  const base=stream([preparation(5,18_000),preparation(3,19_000),{...preparation(2,20_000),last:true}],later);
  const wallet=change(base,x=>{x.signalExpiresAt=START+60_000;x.maxEntryPriceUsd=1.10;}),r=replayPortfolio([wallet],RULES,window()),a=r.attempts[0];
  assert.equal(a.status,'closed');assert.equal(a.decisionAt,START+20_000);assert.equal(a.openedAt,START+20_500);assert.equal(a.originalRaw,'2000');assert.equal(r.authoritative,true);
  const ordinary=replayPortfolio([base],RULES,window());assert.equal(ordinary.attempts[0].fills.length,0);assert.equal(ordinary.attempts[0].endedAt,START+15_000);assert.equal(ordinary.attempts[0].reason,'entry preparation expired');
});

test('preparation admission recomputes exact reverse risk; bogus stored stop estimates cannot select size',()=>{
  const s=change(stream([preparation(5,1000),preparation(3,2000),{...preparation(2,3000),last:true}],streamPath(2)),x=>{for(const p of x.entryPreparations)for(const e of p.buy.stopEstimates)e.netProceedsUsd=999;});
  const a=replayPortfolio([s],RULES,window()).attempts[0];assert.equal(a.decisionAt,START+3000);assert.equal(a.originalRaw,'2000');
});

test('unknown fees, mismatched/partial reverse, future receipt and stale pair are strictly ineligible',()=>{
  const base=stream([preparation(5,1000),{...preparation(3,2000),last:true}],streamPath(3,2500));
  for(const modify of [
    (p:any)=>{p.reverse.quote.fees.quality='unavailable';},
    (p:any)=>{p.reverse.quote.inputRaw='2000';},
    (p:any)=>{p.reverse.quote.spentInputRaw='2000';p.reverse.tokenAmountRaw='2000';p.reverse.quote.refundRaw='1000';},
    (p:any)=>{p.reverse.receivedAt=p.at+1;},
    (p:any)=>{p.buy.quote.at=START-5001;p.buy.receivedAt=START;p.buy.validUntil=START+30_000;},
    (p:any)=>{p.receivedAt=p.at+1;},
  ]){const s=change(base,x=>{modify(x.entryPreparations[1]);}),r=replayPortfolio([s],{...RULES,stopPct:10},window());assert.equal(r.attempts[0].fills.length,0);assert.equal(r.attempts[0].feesUsd,0);assert.equal(r.authoritative,false);}
});

test('failed preparations remain in one attempt, including later failures, without hypothetical gas charges',()=>{
  const first=preparation(5,1000,'failed'),failedBuy=quote(START+1000,2,'buy',5000,1,'stream',5);failedBuy.quote.fees.gasUsd=.03;failedBuy.executionFailurePolicy=createExecutionFailurePolicy(failedBuy.quote);first.buy=failedBuy;
  const s=stream([first,preparation(3,1500),{...preparation(2,2000,'failed'),last:true}],streamPath(3,2000));
  const r=replayPortfolio([s],{...RULES,stopPct:10},window()),a=r.attempts[0];assert.equal(a.status,'closed');assert.equal(a.decisionAt,START+1500);assert.equal(a.preparations!.length,3);assert.equal(a.failures.length,2);assert.equal(a.feesUsd,0);assert.equal(r.authoritative,false);assert.equal(a.originalRaw,'3000');
});

test('explicit incurred preparation failure cost stays in native cash and statistics; no fallback execution',()=>{
  const p=preparation(5,1000,'failed'),b=quote(START+1000,2,'buy',5000,1,'stream',5);b.quote.fees.gasUsd=.03;
  b.failureCost={id:'observed-prep-execution',at:p.at,receivedAt:p.at,cashDebitUsd:.03,feesUsd:.03,nativeDebitRaw:usdNative(.03,1).toString(),nativeUsd:1,quality:'verified',incurred:true,reason:'recorded execution gas'};p.buy=b;
  const r=replayPortfolio([stream([p,{...preparation(3,2000),last:true}],streamPath(3,2500))],{...RULES,stopPct:10},window()),a=r.attempts[0];
  assert.equal(a.status,'failed');assert.equal(a.feesUsd,.03);assert.equal(a.fills.length,0);assert.ok(Math.abs(r.metrics.netUsd+.03)<1e-6);assert.equal(r.nativeAccounting.finalNativeRaw,usdNative(99.97,1).toString());
});

test('stream handles quote tuples arriving individually on the same head without false buy failures',()=>{
  const selected=stream([preparation(5,1000),{...preparation(3,2000),last:true}],streamPath(3,2500));
  const s=change(selected,x=>{
    const unrelated=observation(START+2500,10,1,'stream',2,2000);unrelated.quotes=unrelated.quotes.filter(q=>q.quote.side==='sell');
    x.later.unshift(unrelated);x.later[1].at+=1;x.later[1].receivedAt+=1;
    const split=x.later[2],buyOnly={...split,quotes:split.quotes.filter((q:any)=>q.quote.side==='buy')},sellOnly={...split,at:split.at+1,receivedAt:split.receivedAt+1,quotes:split.quotes.filter((q:any)=>q.quote.side==='sell')};x.later.splice(2,1,buyOnly,sellOnly);
    for(const p of x.later.slice(4)){p.at+=1;p.receivedAt+=1;}
  });
  const r=replayPortfolio([s],{...RULES,stopPct:10},window());assert.equal(r.attempts[0].status,'closed');assert.equal(r.attempts[0].openedAt,START+2501);assert.equal(r.attempts[0].fills.length,3);assert.equal(r.attempts[0].feesUsd,0);assert.equal(r.authoritative,true);
});

test('stream reference expires after five seconds even if fill and gas policy are fresh',()=>{
  const s=change(stream([preparation(5,1000),{...preparation(3,2000),last:true}],streamPath(3,7500)),x=>{
    const b=x.later[0].quotes[0];b.quote.outputRaw='1500';b.tokenAmountRaw='1500';b.quote.priceUsd=2;b.quote.fees.gasUsd=.03;b.executionFailurePolicy=createExecutionFailurePolicy(b.quote,b.receivedAt);
  });
  const r=replayPortfolio([s],{...RULES,stopPct:10},{...window(),maxQuoteAgeMs:15_000});assert.equal(r.attempts[0].reason,'entry reference quote expired before fill');assert.equal(r.attempts[0].feesUsd,0);assert.equal(r.attempts[0].fills.length,0);
});

test('stream window clipping keeps validation/future preparations out of decisions and deterministic hashes',async()=>{
  const base=stream([preparation(5,1000),preparation(3,2000),{...preparation(2,7000),last:true}],streamPath(3,2500)),rules={...RULES,stopPct:10},options={...window(),to:START+6000};
  const future=change(base,x=>{x.entryPreparations[2].buy.quote.priceUsd=999;x.entryPreparations[2].at+=1000;x.entryPreparations[2].receivedAt+=1000;x.decisionAt=START+99_000;});
  const a=replayPortfolio([base],rules,options),b=replayPortfolio([future],rules,options);assert.equal(a.dataHash,b.dataHash);assert.deepEqual(a,b);
  assert.equal(replayPortfolio([base],rules,{...window(),from:START+1500}).attempts.length,0);
  const boundary=replayPortfolio([stream([preparation(5,1000),preparation(3,2000),preparation(2,3000)])],RULES,{...window(),to:START+2500});assert.equal(boundary.attempts[0].fills.length,0);assert.equal(boundary.authoritative,false);assert.match(boundary.attempts[0].reason,/boundary/);
  assert.deepEqual(await runResearchInWorker({kind:'replay',samples:[base],rules,options}),a);
});

test('duplicate causal sample and size cannot execute twice or erase missing evidence',()=>{
  const s=stream([preparation(5,1000),{...preparation(3,2000),last:true}],streamPath(3,2500));
  const r=replayPortfolio([s,s],{...RULES,stopPct:10},window());assert.equal(r.attempts.length,1);assert.equal(r.attempts[0].fills.filter(f=>f.side==='buy').length,1);assert.equal(r.authoritative,false);
  const dup=change(s,x=>{x.entryPreparations.push({...x.entryPreparations[1],at:START+3500,receivedAt:START+3500,last:true});});const b=replayPortfolio([dup],{...RULES,stopPct:10},window());assert.equal(b.attempts[0].fills.filter(f=>f.side==='buy').length,1);assert.equal(b.authoritative,false);
});

test('causal preparation shares the bankroll, pending position cap, daily quota and consecutive loss stop',()=>{
  // Keep $1 eligible after real losses while excluding the next $1.50 ladder step.
  const risk={...DEFAULT_RISK,maxPositionPct:1.1};
  const simultaneous=Array.from({length:4},(_,i)=>asPreparationStream(sample(`stream-cap-${i}`)));
  const cap=replayPortfolio(simultaneous,RULES,{...window(),risk});assert.equal(cap.attempts.filter(a=>a.fills.some(f=>f.side==='buy')).length,3);assert.equal(cap.attempts[3].reason,'maximum simultaneous positions');
  const sequential=Array.from({length:11},(_,i)=>asPreparationStream(sample(`stream-day-${i}`,START+i*10_000)));
  const daily=replayPortfolio(sequential,RULES,{...window(),to:START+120_000,risk});assert.equal(daily.metrics.count,10);assert.equal(daily.attempts[10].reason,'daily entry limit');
  const losses=Array.from({length:4},(_,i)=>asPreparationStream(sample(`stream-loss-${i}`,START+i*10_000,[1,1,.5,.5])));
  const stopped=replayPortfolio(losses,RULES,{...window(),risk});assert.equal(stopped.metrics.count,3);assert.match(stopped.attempts[3].reason,/loss limit/);
});

test('32 deterministic combinations per horizon; losing baseline is separate',()=>{
  for(const horizon of ['short','swing'] as const){const grid=exitGrid(horizon);assert.equal(grid.length,32);assert.equal(new Set(grid.map(c=>c.id)).size,32);assert.deepEqual(grid,exitGrid(horizon));assert.ok(grid.every(c=>c.kind==='grid'&&c.id!==legacyBaseline().id));}
  assert.deepEqual(legacyBaseline().rules.targets,[{gainPct:50,sellOriginalPct:60},{gainPct:100,sellOriginalPct:25},{gainPct:200,sellOriginalPct:15}]);
});
test('snapshot deep freeze and canonical SHA256 hash are stable independent of key order',()=>{
  const s=sample('frozen');assert.ok(Object.isFrozen(s)&&Object.isFrozen(s.entry.quotes[0].quote.fees));
  assert.throws(()=>{(s.entry.quotes[0].quote as any).priceUsd=999;});
  assert.equal(researchDataHash({b:2,a:1}),researchDataHash({a:1,b:2}));assert.match(researchDataHash(s),/^[a-f0-9]{64}$/);
});
test('first next head after 500ms; original quantity exits and actual trailing cashflows',()=>{
  const r=replayPortfolio([sample('profit')],RULES,window());const a=r.attempts[0];
  assert.equal(a.status,'closed');assert.equal(a.fills[0].at,START+1000);
  assert.deepEqual(a.fills.map(f=>f.tokenRaw),['1000','500','500']);
  assert.equal(a.fills[1].reason,'take profit');assert.equal(a.fills[2].reason,'trailing exit');
  assert.equal(a.netUsd,.75);assert.equal(r.metrics.netUsd,.75);assert.equal(r.metrics.count,1);assert.equal(r.authoritative,true);
  assert.equal(r.metrics.score,r.metrics.returnPct/Math.max(r.metrics.maxDrawdownPct,1));
});
test('fee-aware risk recipe matches native spend, stop+slippage and outside costs',()=>{
  const buy=quote(START,1,'buy',3000,1,'risk',3).quote;
  const reverse=quote(START+10,1,'sell',3000,.9,'risk').quote;
  buy.fees.gasUsd=.1;buy.fees.approvalUsd=.02;reverse.fees.gasUsd=.03;reverse.fees.approvalUsd=.04;
  buy.fees.protocolUsd=.3;reverse.fees.taxUsd=.3; // Already included in native quote.
  const e=feeAwareStopEstimates(buy,reverse,[15],3)[0];
  const expected=2.7*.85*.97-.03-.04;
  assert.ok(Math.abs(e.netProceedsUsd-expected)<1e-6);
  reverse.outputRaw='0';const expensive=feeAwareStopEstimates(buy,reverse,[15],3)[0];assert.ok(expensive.netProceedsUsd<0);
  assert.throws(()=>feeAwareStopEstimates(buy,{...reverse,inputRaw:'1500'},[15]),/exact full reverse/);
});
test('protectBreakeven compares full net liquidation with allocated remaining COST',()=>{
  const s=change(sample('cost',START,[1,1,1.5,1.5,1.04,1.04],{budget:1.1}),x=>{
    for(const p of [x.entry,...x.later])for(const q of p.quotes)if(q.quote.side==='buy'){
      q.quote.spentInputRaw='1000000000000000000';q.quote.fees.gasUsd=.1;q.feesUsd=.1;
      for(const estimate of q.stopEstimates)estimate.netProceedsUsd=(1-estimate.stopPct/100)*.97;
    }
  });
  const r=replayPortfolio([s],{...RULES,trailPct:90},window());const a=r.attempts[0];
  assert.equal(a.status,'closed');assert.equal(a.fills[2].reason,'trailing exit');assert.equal(a.fills[2].cashCreditUsd,.52);
  assert.ok(1.04>1); // Price above entry still fails to protect $0.55 remaining cost.
});
test('multiple take-profit targets merge original quantities, not remaining quantities',()=>{
  const r=replayPortfolio([sample('multi',START,[1,1,4,4])],legacyBaseline().rules,window());const a=r.attempts[0];
  assert.equal(a.status,'closed');assert.equal(a.fills.length,2);assert.equal(a.fills[1].tokenRaw,'1000');assert.deepEqual(a.fills[1].targets,[0,1,2]);assert.equal(a.netUsd,3);
});
test('exit triggers prefer exact whole-remaining sell price over higher market reference',()=>{
  const s=change(sample('sell-price',START,[1,1,1.5,1.5]),x=>{for(const p of x.later.slice(1)){const q=p.quotes.find((q:any)=>q.requestedTokenRaw==='1000');q.quote.priceUsd=1.2;q.quote.outputRaw=usdNative(1.2,1).toString();q.cashCreditUsd=1.2;}});
  const r=replayPortfolio([s],RULES,window());assert.equal(r.attempts[0].fills.length,1);assert.ok(r.attempts[0].fills.every(f=>f.reason!=='take profit'));
});
test('whole-sell price can trigger when market reference cannot; reprice the new remaining size',()=>{
  const s=change(sample('sized-price',START,[1,1,1,1,1.5,1.5]),x=>{for(let i=1;i<x.later.length;i++){const p=x.later[i];for(const q of p.quotes)if(q.quote.side==='sell'){
    const size=Number(q.requestedTokenRaw),price=size===1000?1.5:i<=2?1.6:1.1;q.quote.priceUsd=price;q.quote.outputRaw=usdNative(size/1000*price,1).toString();q.cashCreditUsd=size/1000*price;
  }}});
  const r=replayPortfolio([s],RULES,window());const a=r.attempts[0];assert.equal(a.status,'closed');assert.deepEqual(a.fills.map(f=>f.tokenRaw),['1000','500','500']);assert.equal(a.fills[1].cashCreditUsd,.8);assert.equal(a.fills[2].reason,'trailing exit');assert.equal(a.fills[2].cashCreditUsd,.55);
});
function oddTape(id:string,prices:number[]):ResearchSample {
  return change(sample(id,START,prices,{quantity:1001,budget:1.001}),x=>{for(const p of [x.entry,...x.later])for(const amount of [500,501,700,301,600,401,250,151,150,1]){
    if(!p.quotes.some((q:any)=>q.requestedTokenRaw===String(amount)))p.quotes.push(quote(p.at,p.block,'sell',amount,p.priceUsd,id,1.001));
  }});
}
test('odd original quantity 1001: seventy percent is 700, remaining is EXACTLY 301',()=>{
  const r=replayPortfolio([oddTape('odd-grid',[1,1,1.5,1.5,1.1,1.1])],{...RULES,targets:[{gainPct:30,sellOriginalPct:70}]},window());
  assert.equal(r.attempts[0].status,'closed');assert.deepEqual(r.attempts[0].fills.map(f=>f.tokenRaw),['1001','700','301']);assert.equal(r.authoritative,true);
});
test('odd baseline target rounding matches cumulative Broker goals and exact remaining quotes',()=>{
  const r=replayPortfolio([oddTape('odd-base',[1,1,1.6,1.6,2.1,2.1,3.1,3.1])],legacyBaseline().rules,window());
  assert.equal(r.attempts[0].status,'closed');assert.deepEqual(r.attempts[0].fills.map(f=>f.tokenRaw),['1001','600','250','151']);assert.equal(r.attempts[0].remainingRaw,'0');assert.equal(r.authoritative,true);
});
test('gap prices use next executable quote; no imaginary threshold fill',()=>{
  const r=replayPortfolio([sample('jump',START,[1,1,1.5,.8,.8])],RULES,window());const a=r.attempts[0];
  assert.equal(a.fills.length,2);assert.ok(a.fills.every(f=>f.reason!=='take profit'));
  assert.equal(a.fills[1].reason,'stop loss');assert.equal(a.fills[1].cashCreditUsd,.8);assert.ok(Math.abs(a.netUsd+.2)<1e-9);
});
test('whole-position quotes cannot stand in for exact partial-sale quotes',()=>{
  const s=change(sample('exact'),x=>{for(const p of x.later)p.quotes=p.quotes.filter((q:any)=>q.quote.side==='buy'||q.requestedTokenRaw==='1000');});
  const r=replayPortfolio([s],RULES,window());const a=r.attempts[0];
  assert.equal(a.status,'purged');assert.equal(a.fills.length,1);assert.equal(a.remainingRaw,'1000');assert.equal(r.authoritative,false);
  assert.ok(a.failures.some(f=>f.reason.includes('quantity/fees missing')||f.reason.includes('trigger quote missing')));
});
test('missing/unsellable inventory retained at zero; loss stays in portfolio net and DD',()=>{
  const s=change(sample('blocked'),x=>{for(const p of x.later)p.quotes=p.quotes.filter((q:any)=>q.quote.side==='buy');});
  const r=replayPortfolio([s],RULES,window());assert.equal(r.attempts.length,1);assert.equal(r.attempts[0].status,'purged');
  assert.equal(r.attempts[0].conservativeValueUsd,0);assert.equal(r.metrics.netUsd,-1);assert.ok(r.metrics.maxDrawdownPct>=1);assert.equal(r.authoritative,false);
  assert.equal(r.nativeAccounting.realizedTradingUsd,0);assert.equal(r.nativeAccounting.unrealizedTradingUsd,-1);assert.equal(r.nativeAccounting.conservativeTradingUsd,-1);
});
test('already-net costs deducted once; observed fee attribution retained',()=>{
  const s=change(sample('fees'),x=>{for(const p of [x.entry,...x.later])for(const q of p.quotes){q.feesUsd=.02;q.quote.fees.protocolUsd=.02;if(q.quote.side==='sell'){q.cashCreditUsd=Math.max(0,q.cashCreditUsd-.02);q.quote.outputRaw=usdNative(q.cashCreditUsd,q.quote.nativeUsd).toString();}}});
  const r=replayPortfolio([s],RULES,window());const a=r.attempts[0];
  assert.ok(Math.abs(a.netUsd-.71)<1e-9);assert.equal(a.feesUsd,.06);assert.ok(Math.abs(r.metrics.netUsd-.71)<1e-9);
});
test('unknown tax/fee blocked; explicit contemporaneous gas assumption permitted',()=>{
  const estimated=change(sample('gas'),x=>{for(const p of [x.entry,...x.later])for(const q of p.quotes){q.quote.fees.quality='estimated';q.quote.quality='estimated';q.gasAssumption={at:q.quote.at,gasUsd:0,approvalUsd:0,method:'block gas estimate',nonGasFeesVerified:true,executableQuoteVerified:true};}});
  assert.equal(replayPortfolio([estimated],RULES,window()).metrics.count,1);
  const unknown=change(estimated,x=>{for(const p of [x.entry,...x.later])for(const q of p.quotes)q.gasAssumption.nonGasFeesVerified=false;});
  const r=replayPortfolio([unknown],RULES,window());assert.equal(r.attempts[0].status,'skipped');assert.equal(r.authoritative,false);assert.equal(r.metrics.count,0);
  const future=change(estimated,x=>{for(const p of [x.entry,...x.later])for(const q of p.quotes)q.gasAssumption.at=q.quote.at+1;});
  assert.equal(replayPortfolio([future],RULES,window()).metrics.count,0);
});
test('risk includes stop fees, five-percent exposure, exact sizes, no interpolation',()=>{
  const expensive=sample('too-big',START,[1,1,2,2,1.5,1.5],{budget:5,quantity:5000});
  const r=replayPortfolio([expensive],RULES,window());assert.equal(r.attempts[0].status,'skipped');assert.match(r.attempts[0].reason,/risk budget/);
  const impossible=change(sample('fees-risk'),x=>{for(const p of [x.entry,...x.later])for(const q of p.quotes)for(const v of q.stopEstimates??[])v.netProceedsUsd=.1;});
  assert.equal(replayPortfolio([impossible],RULES,window()).metrics.count,0);
  assert.throws(()=>replayPortfolio([],RULES,{...window(),risk:{riskPct:1,maxPositionPct:5,maxPositions:3,dailyEntries:10,maxConsecutiveLosses:3,dailyLossPct:1.5}}),/never relaxed/);
});
test('three simultaneous positions and daily ten entry limit on shared bankroll',()=>{
  const holds=Array.from({length:4},(_,i)=>sample(`hold-${i}`,START+i,[1,1,1,1]));
  const r=replayPortfolio(holds,RULES,window());assert.equal(r.attempts.filter(a=>a.openedAt!==null).length,3);assert.match(r.attempts[3].reason,/simultaneous/);
  const noTargets={...RULES,targets:[],maxHoldMs:1000};
  const flat=Array.from({length:12},(_,i)=>sample(`flat-${i}`,START+i*10_000,[1,1,1,1]));
  const dayResult=replayPortfolio(flat,noTargets,{...window(),to:START+200_000});assert.equal(dayResult.metrics.count,10);assert.equal(dayResult.attempts[10].reason,'daily entry limit');
});
test('failed orders release daily reservations; only FILLED entries use the daily quota',()=>{
  const failed=Array.from({length:11},(_,i)=>change(sample(`attempt-${i}`,START+i*10_000),x=>{const q=x.later[0].quotes.find((q:any)=>q.quote.side==='buy');q.quote.outputRaw='500';q.tokenAmountRaw='500';}));
  const filled=sample('after-failures',START+120_000);
  const r=replayPortfolio([...failed,filled],RULES,{...window(),to:START+180_000});assert.equal(r.attempts.filter(a=>a.status==='failed').length,11);assert.equal(r.attempts.at(-1)!.status,'closed');assert.equal(r.metrics.count,1);
});
test('three consecutive net losses stop entries; daily loss stop includes unknown inventory',()=>{
  const losers=Array.from({length:6},(_,i)=>sample(`loss-${i}`,START+i*10_000,[1,1,.9,.9],{budget:1,quantity:1000}));
  const rules={...RULES,stopPct:5};const r=replayPortfolio(losers,rules,{...window(),to:START+100_000});
  assert.equal(r.metrics.count,3);assert.equal(r.attempts[3].reason,'consecutive loss limit');
  const blocked=Array.from({length:4},(_,i)=>change(sample(`unknown-${i}`,START+i*10_000,[1,1,1,1]),x=>{for(const p of x.later)p.quotes=p.quotes.filter((q:any)=>q.quote.side==='buy');}));
  const b=replayPortfolio(blocked,RULES,{...window(),to:START+100_000});assert.equal(b.attempts[2].reason,'daily net loss limit');assert.equal(b.metrics.netUsd,-2);
});
test('fill-time slippage/fees risk rechecked and refund quantities used',()=>{
  const slipped=change(sample('slip'),x=>{const q=x.later[0].quotes.find((q:any)=>q.quote.side==='buy');q.tokenAmountRaw='500';q.quote.outputRaw='500';});
  assert.equal(replayPortfolio([slipped],RULES,window()).attempts[0].status,'failed');
  const partial=change(sample('refund'),x=>{for(const p of [x.entry,...x.later]){for(const q of p.quotes.filter((q:any)=>q.quote.side==='buy')){q.tokenAmountRaw='500';q.quote.outputRaw='500';q.cashDebitUsd=.5;q.quote.spentInputRaw='500000000000000000';q.quote.refundRaw='500000000000000000';for(const v of q.stopEstimates)v.netProceedsUsd=.5*(1-v.stopPct/100);}}});
  const r=replayPortfolio([partial],RULES,window());assert.equal(r.attempts[0].originalRaw,'500');assert.ok(Math.abs(r.attempts[0].netUsd-.375)<1e-9);
});
test('boundary purge does not carry future positions or use future observations in hash',()=>{
  const a=sample('boundary',START,[1,1,1,1,2,2,1.5,1.5]);
  const b=change(a,x=>{x.later.at(-1).priceUsd=999;});
  const opts={...window(),to:START+3500};
  const r=replayPortfolio([a],RULES,opts);assert.equal(r.attempts[0].status,'purged');assert.equal(r.metrics.count,0);
  assert.equal(r.dataHash,replayPortfolio([b],RULES,opts).dataHash);
  assert.equal(replayPortfolio([a],RULES,{from:START+4000,to:START+10_000}).attempts.length,0);
});
test('candles/exploratory data cannot be formally promoted',()=>{
  const c=change(sample('candle'),x=>{x.source='candles';});const r=replayPortfolio([c],RULES,window());assert.equal(r.metrics.count,0);assert.equal(r.authoritative,false);
});
test('archived failure costs retained in cash, net, PF and fees; no invented random failures',()=>{
  const failed=change(sample('failed-buy'),x=>{const q=x.later[0].quotes.find((q:any)=>q.quote.side==='buy');q.executable=false;q.tokenAmountRaw='0';q.quote.outputRaw='0';q.failureCost={id:'execution-1',at:START+1000,receivedAt:START+1000,cashDebitUsd:.2,feesUsd:.2,quality:'verified',reason:'captured failure outcome',incurred:true};});
  const r=replayPortfolio([failed,sample('winning',START+10_000)],RULES,window());
  assert.equal(r.attempts[0].status,'failed');assert.equal(r.attempts[0].netUsd,-.2);assert.ok(Math.abs(r.metrics.netUsd-.55)<1e-9);assert.equal(r.metrics.feesUsd,.2);assert.equal(r.metrics.profitFactor,3.75);assert.equal(r.authoritative,true);
  const sell=change(sample('failed-sell',START,[1,1,2,2,2,2,1.5,1.5]),x=>{const q=x.later[2].quotes.find((q:any)=>q.requestedTokenRaw==='500');q.executable=false;q.tokenAmountRaw='0';q.quote.spentInputRaw='0';q.failureCost={id:'sell-execution',at:START+3000,receivedAt:START+3000,cashDebitUsd:.1,feesUsd:.1,quality:'verified',reason:'captured sell failure',incurred:true};});
  const outcome=replayPortfolio([sell],RULES,window());assert.equal(outcome.attempts[0].status,'closed');assert.ok(Math.abs(outcome.metrics.netUsd-.65)<1e-9);assert.equal(outcome.metrics.feesUsd,.1);assert.equal(outcome.authoritative,true);
});
test('missing pre-submit data plus hypothetical gas profile never creates a phantom debit',()=>{
  const s=change(sample('profile-only'),x=>{const q=x.later[0].quotes.find((q:any)=>q.quote.side==='buy');q.executable=false;q.quote.quality='unavailable';q.failureCost={id:'profile',at:q.quote.at,receivedAt:q.receivedAt,cashDebitUsd:.2,feesUsd:.2,quality:'verified',reason:'hypothetical gas if broadcast'};});
  const r=replayPortfolio([s],RULES,window());assert.equal(r.attempts[0].status,'failed');assert.equal(r.attempts[0].feesUsd,0);assert.equal(r.metrics.netUsd,0);assert.equal(r.authoritative,false);
});
test('PF and bootstrap gates handle losses and token correlations deterministically',()=>{
  const metrics={count:50,tokens:20,netUsd:1,returnPct:1,profitFactor:1.2,maxDrawdownPct:10,winRate:50,score:1,feesUsd:0};
  assert.equal(passesFormalMetrics(metrics),true);assert.equal(passesFormalMetrics({...metrics,profitFactor:1.19}),false);assert.equal(passesFormalMetrics({...metrics,maxDrawdownPct:10.01}),false);assert.equal(passesFormalMetrics({...metrics,netUsd:0}),false);
  const trades=[{token:'A',netUsd:2},{token:'a',netUsd:3},{token:'B',netUsd:-4}];
  const x=tokenClusterBootstrap(trades,7);assert.equal(x,tokenClusterBootstrap([...trades].reverse(),7));assert.ok(x<0);
  assert.equal(tokenClusterBootstrap([{token:'one',netUsd:2},{token:'ONE',netUsd:3}],7),5);
});

function days(from:number,length:number,prefix:string):ResearchSample[]{
  return Array.from({length:length*8},(_,i)=>sample(`${prefix}-${i}`,from+Math.floor(i/8)*DAY_MS+(i%8)*60_000,[1,1,2,2,1.5,1.5],{token:`${prefix}-token-${i%24}`}));
}
test('14-day train/7-day validation top five; freeze; seven NEW days; no future tuning',()=>{
  const end=START+21*DAY_MS,w=researchWindows(end);assert.equal(w.trainStart,START);assert.equal(w.trainEnd,START+14*DAY_MS);
  const data=[...days(START,14,'train'),...days(w.trainEnd,7,'val')];
  const r=runResearch({strategyId:'bsc-wallet-short',chain:'bsc',horizon:'short',samples:data,validationEnd:end,now:end});
  assert.equal(r.attempts.length,32);assert.equal(r.attempts.filter(a=>a.validation!==null).length,5);assert.equal(r.baselines.length,1);
  assert.equal(r.run.status,'forward');assert.ok(r.frozen);assert.equal(r.run.promotedAt,null);assert.equal(r.frozen!.forwardStart,end);assert.equal(r.frozen!.forwardEnd,end+7*DAY_MS);
  assert.equal(r.frozen!.risk.riskPct,.5);assert.equal(r.frozen!.risk.maxPositionPct,5);assert.ok(Object.isFrozen(r.frozen!.risk));
  const forward=days(end,7,'forward');
  const resealed=freezeResearchWinner(r,end+30_000);assert.equal(resealed.frozen!.forwardStart,end+30_000);assert.notEqual(resealed.frozen!.selectionHash,r.frozen!.selectionHash);assert.deepEqual(resealed.run.validation,r.run.validation);
  assert.throws(()=>freezeResearchWinner(r,end-1),/after selection/);
  assert.equal(evaluateForward({frozen:r.frozen!,samples:forward,now:end+6*DAY_MS}).status,'collecting');
  const result=evaluateForward({frozen:r.frozen!,samples:forward,now:end+7*DAY_MS});assert.equal(result.status,'passed');assert.ok(result.lower90Usd>0);
  const changed=structuredClone(r.frozen!) as any;changed.rules.stopPct=99;
  assert.throws(()=>evaluateForward({frozen:changed,samples:forward,now:end+7*DAY_MS}),/altered/);
  const changedRisk=structuredClone(r.frozen!) as any;changedRisk.risk.riskPct=.1;assert.throws(()=>evaluateForward({frozen:changedRisk,samples:forward,now:end+7*DAY_MS}),/altered/);
  assert.throws(()=>evaluateForward({frozen:r.frozen!,samples:forward,now:end+7*DAY_MS,priorTests:[result.testWindow]}),/already consumed/);
  const retuned=runResearch({strategyId:'bsc-wallet-short',chain:'bsc',horizon:'short',samples:forward,validationEnd:end+7*DAY_MS,now:end+7*DAY_MS,priorTests:[result.testWindow]});
  assert.equal(retuned.run.status,'failed');assert.equal(retuned.frozen,null);assert.match(retuned.run.reason,/reused test tuning/);
  // Appending enormous future candles/quotes cannot influence historical selection.
  const future=sample('future',end+DAY_MS,[1,1,999,999,800,800]);
  const repeat=runResearch({strategyId:'bsc-wallet-short',chain:'bsc',horizon:'short',samples:[...data,future],validationEnd:end,now:end});assert.equal(repeat.frozen!.selectionHash,r.frozen!.selectionHash);
  const archived=forward.map(s=>change(s,x=>{x.capturedAt=end-1;}));assert.equal(evaluateForward({frozen:r.frozen!,samples:archived,now:end+7*DAY_MS}).status,'failed');
});
test('insufficient/failed validation attempts all retained and never enabled',()=>{
  const end=START+21*DAY_MS;
  const r=runResearch({strategyId:'wait',chain:'bsc',horizon:'short',samples:[sample('one')],validationEnd:end,now:end});
  assert.equal(r.run.status,'collecting');assert.equal(r.attempts.length,32);assert.equal(r.frozen,null);assert.ok(r.attempts.every(a=>a.training.attempts.length===1));
});
test('worker computation matches synchronous deterministic replay',async()=>{
  const samples=[sample('worker')],options=window();
  const value=await runResearchInWorker({kind:'replay',samples,rules:RULES,options},{timeoutMs:20_000}) as ReplayResult;
  assert.deepEqual(value,replayPortfolio(samples,RULES,options));
  const abort=new AbortController();abort.abort();await assert.rejects(runResearchInWorker({kind:'replay',samples,rules:RULES,options},{signal:abort.signal}),/aborted/);
});

const FX_TOKEN='0x1111111111111111111111111111111111111111';
function fxSample():ResearchSample {
  const rates=[100,120,120,120,80,80],nativePrices=[.01,.01,.02,.02,.0175,.0175];
  const offsets=[0,1000,2000,3000,6000,7000];
  const points=rates.map((rate,i)=>{
    const p=observation(START+offsets[i],i+1,nativePrices[i]*rate,FX_TOKEN);
    for(const snapshot of p.quotes){
      const q=snapshot.quote;q.nativeUsd=rate;q.fees.gasUsd=.01;
      if(q.side==='buy'){
        const amount=Math.floor(.01/nativePrices[i]*1000);q.inputRaw=usdNative(1,100).toString();q.spentInputRaw=q.inputRaw;q.outputRaw=String(amount);snapshot.tokenAmountRaw=String(amount);q.priceUsd=nativeUsd(q.spentInputRaw,rate)/(amount/1000);
      }else{q.outputRaw=usdNative(Number(BigInt(q.spentInputRaw))/1000*nativePrices[i],1).toString();q.priceUsd=nativeUsd(q.outputRaw,rate)/(Number(BigInt(q.spentInputRaw))/1000);}
      const flow=quoteNativeCashFlow(q);snapshot.cashDebitUsd=q.side==='buy'?flow.cashDebitUsd:.01;snapshot.cashCreditUsd=q.side==='sell'?nativeUsd(q.outputRaw,rate):0;snapshot.feesUsd=flow.feesUsd;
    }
    const b=p.quotes.find(q=>q.quote.side==='buy')!;
    const r=p.quotes.find(q=>q.requestedTokenRaw===b.tokenAmountRaw);
    if(r)b.stopEstimates=feeAwareStopEstimates(b.quote,r.quote);
    return p;
  });
  return createResearchSample({id:'fx',chain:'bsc',token:FX_TOKEN,signalAt:START,receivedAt:START,decisionAt:START,capturedAt:START,source:'authoritative',entry:points[0],later:points.slice(1),coveredThrough:START+60_000,reason:'FX parity fixture'});
}
class ParityClock implements BrokerClock {
  mono=0;constructor(public wall:number){}
  now=()=>this.wall;monotonic=()=>this.mono;
  advanceTo(at:number){const delta=at-this.wall;if(delta<0)throw Error('Parity clock cannot go backwards');this.wall=at;this.mono+=delta;}
}
class TapeGateway implements MarketGateway {
  private cursor=0;overrideFx:number|null=null;readonly clock:ParityClock;
  constructor(readonly points:readonly ResearchObservation[]){this.clock=new ParityClock(points[0].receivedAt);}
  get index(){return this.cursor;}
  set index(index:number){this.clock.advanceTo(this.points[index].receivedAt);this.cursor=index;}
  get point(){return this.points[this.index];}
  statuses():ChainStatus[]{return [{chain:'bsc',connected:true,head:this.point.block,headAt:this.point.receivedAt,chainTime:this.point.at,gaps:0,reconnects:0,lastError:'',source:'isolated parity tape'}];}
  markets():Market[]{return [{id:'bsc:'+FX_TOKEN,chain:'bsc',address:FX_TOKEN,name:'Parity',symbol:'PAR',platform:'fixture',stage:'curve',createdAt:START,priceUsd:this.point.priceUsd,nativeUsd:this.overrideFx??this.point.quotes[0].quote.nativeUsd,quoteAddress:'native',decimals:3,liquidityUsd:100000,volumeUsd:10000,buyTaxPct:0,sellTaxPct:0,updatedAt:this.point.priceAt??this.point.at,block:this.point.block,quality:'verified',reason:''}];}
  getMarket(chain:Chain,token:string){return chain==='bsc'&&token===FX_TOKEN?this.markets()[0]:undefined;}
  async quote(request:QuoteRequest):Promise<Quote>{const q=this.point.quotes.find(q=>q.quote.side===request.side&&(request.side==='buy'?q.quote.inputRaw===request.nativeAmountRaw:q.requestedTokenRaw===request.tokenAmountRaw));if(!q)throw new Error('exact tape size missing');return structuredClone(q.quote);}
  async candles(){return [];}async start(){}async stop(){}async addToken(){return this.markets()[0];}setWallets(){}
}
function paritySetup(s:ResearchSample){
  const base=resolve('data/test-runs');mkdirSync(base,{recursive:true});const store=new Store(mkdtempSync(resolve(base,'research-parity-')));
  const gateway=new TapeGateway(structuredClone([s.entry,...s.later]) as ResearchObservation[]),broker=new Broker(store,gateway,()=>{},{clock:gateway.clock});
  return {store,gateway,broker};
}
async function executeFrame(broker:Broker,gateway:TapeGateway,order:PaperOrder,index:number){assert.ok(order,'expected an armed order');gateway.index=index;assert.ok(gateway.clock.now()>=order.dueAt&&gateway.point.receivedAt>=order.dueAt);await broker.execute(order);const o=broker.store.get<PaperOrder>('orders',order.id)!;assert.ok(o.status==='filled'||o.status==='partial',o.error);await broker.updateValuations();return o;}
function policyTape(id:string,prices:number[]=[1,1,1,1]):ResearchSample {
  return change(sample(id,START,prices,{token:FX_TOKEN}),x=>{for(const p of [x.entry,...x.later]){
    for(const snapshot of p.quotes){const q=snapshot.quote;q.fees.gasUsd=.01;q.fees.approvalUsd=.02;
      snapshot.cashDebitUsd=q.side==='buy'?nativeUsd(q.spentInputRaw,q.nativeUsd)+.03:.03;snapshot.cashCreditUsd=q.side==='sell'?nativeUsd(q.outputRaw,q.nativeUsd):0;snapshot.feesUsd=.03;
      snapshot.executionFailurePolicy=createExecutionFailurePolicy(q,snapshot.receivedAt);
    }
    const b=p.quotes.find((q:any)=>q.quote.side==='buy'),reverse=p.quotes.find((q:any)=>q.requestedTokenRaw===b.tokenAmountRaw);b.stopEstimates=feeAwareStopEstimates(b.quote,reverse.quote);
  }});
}
function outputAt(s:ResearchSample,quantity:number):ResearchSample {
  return change(s,x=>{const p=x.later[0],b=p.quotes.find((q:any)=>q.quote.side==='buy');b.quote.outputRaw=String(quantity);b.tokenAmountRaw=String(quantity);b.quote.priceUsd=1/(quantity/1000);
    const reverse=quote(p.at,p.block,'sell',quantity,1,FX_TOKEN);reverse.quote.fees.gasUsd=.01;reverse.quote.fees.approvalUsd=.02;reverse.cashCreditUsd=quantity/1000;reverse.cashDebitUsd=.03;reverse.feesUsd=.03;reverse.executionFailurePolicy=createExecutionFailurePolicy(reverse.quote,reverse.receivedAt);p.quotes.push(reverse);
    b.stopEstimates=feeAwareStopEstimates(b.quote,reverse.quote);
  });
}
async function brokerBuyOutcome(s:ResearchSample){
  const {broker,gateway,store}=paritySetup(s);try{
    const order=await broker.submit({clientId:randomUUID(),accountId:'manual-bsc',token:FX_TOKEN,side:'buy',amountUsd:1,reason:'条件失败费对账',rules:RULES});gateway.index=1;await broker.execute(order);
    return {account:broker.account('manual-bsc'),order:broker.orders()[0],positions:broker.positions()};
  }finally{store.close();}
}

function budgetPair(budget:number,offset:number,fx=100):EntryPreparation {
  const p=preparation(budget,offset,'ready',FX_TOKEN),q=p.buy!.quote,reverse=p.reverse!.quote,quantity=Math.round((budget-.03)*1000);
  q.nativeUsd=fx;q.inputRaw=usdNative(budget-.03,fx).toString();q.spentInputRaw=q.inputRaw;q.outputRaw=String(quantity);q.fees.gasUsd=.01;q.fees.approvalUsd=.02;
  reverse.nativeUsd=fx;reverse.inputRaw=String(quantity);reverse.spentInputRaw=String(quantity);reverse.outputRaw=usdNative(quantity/1000,fx).toString();reverse.fees.gasUsd=.02;
  for(const snap of [p.buy!,p.reverse!]){
    const v=snap.quote;snap.tokenAmountRaw=String(quantity);snap.requestedTokenRaw=v.side==='sell'?String(quantity):undefined;
    snap.cashDebitUsd=v.side==='buy'?budget:.02;snap.cashCreditUsd=v.side==='sell'?quantity/1000:0;snap.feesUsd=v.fees.gasUsd+v.fees.approvalUsd;
    snap.executionFailurePolicy=createExecutionFailurePolicy(v,snap.receivedAt);
  }
  p.buy!.stopEstimates=feeAwareStopEstimates(q,reverse);return p;
}
function budgetFill(reference:EntryPreparation,offset:number,fx:number,output?:number):ResearchObservation {
  const p=structuredClone(reference),at=START+offset,block=10+Math.floor(offset/1000),b=p.buy!,r=p.reverse!,quantity=output??Number(b.quote.outputRaw);
  for(const snap of [b,r]){snap.quote.at=at;snap.quote.block=block;snap.quote.nativeUsd=fx;snap.quote.id+=':fill:'+offset;snap.receivedAt=at;snap.validUntil=at+5000;}
  b.quote.outputRaw=String(quantity);b.tokenAmountRaw=String(quantity);b.quote.priceUsd=nativeUsd(b.quote.spentInputRaw,fx)/(quantity/1000);
  r.quote.inputRaw=String(quantity);r.quote.spentInputRaw=String(quantity);r.tokenAmountRaw=String(quantity);r.requestedTokenRaw=String(quantity);r.quote.outputRaw=usdNative(quantity/1000*.01,1).toString();r.quote.priceUsd=.01*fx;
  for(const snap of [b,r]){const q=snap.quote,flow=quoteNativeCashFlow(q);snap.cashDebitUsd=q.side==='buy'?flow.cashDebitUsd:q.fees.gasUsd+q.fees.approvalUsd;snap.cashCreditUsd=q.side==='sell'?nativeUsd(q.outputRaw,fx):0;snap.feesUsd=flow.feesUsd;snap.executionFailurePolicy=createExecutionFailurePolicy(q,at);}
  b.stopEstimates=feeAwareStopEstimates(b.quote,r.quote);
  return {at,receivedAt:at,block,priceUsd:b.quote.priceUsd,quotes:[b,r]};
}
async function submitPrepared(broker:Broker,gateway:TapeGateway,rules=RULES){
  const b=gateway.point.quotes.find(q=>q.quote.side==='buy')!,q=await broker.getQuote('manual-bsc',{chain:'bsc',token:FX_TOKEN,side:'buy',nativeAmountRaw:b.quote.inputRaw,block:b.quote.block,recipient:broker.recipient('manual-bsc')}),reverse=await broker.getQuote('manual-bsc',{chain:'bsc',token:FX_TOKEN,side:'sell',tokenAmountRaw:q.outputRaw,block:q.block,recipient:broker.recipient('manual-bsc')});
  const original=gateway.quote.bind(gateway);let repeated=0;gateway.quote=async request=>{repeated++;return original(request);};
  try{
    const order=await broker.submit({clientId:randomUUID(),accountId:'manual-bsc',token:FX_TOKEN,side:'buy',amountUsd:nativeUsd(q.inputRaw,q.nativeUsd),rules,reason:'共享准备报价对账'},{reference:q,reverse});assert.equal(repeated,0);return order;
  }finally{gateway.quote=original;}
}

test('prepared Broker and causal replay match exact TOTAL budget, outside gas, native balance and fees without refetch',async()=>{
  const preps=[budgetPair(5,1000),budgetPair(3,2000),{...budgetPair(2,3000),last:true}],chosen=preps[2],point:ResearchObservation={at:chosen.at,receivedAt:chosen.at,block:chosen.block,priceUsd:1,quotes:[chosen.buy!,chosen.reverse!]},later=[budgetFill(chosen,3500,100)];
  const s=stream(preps,later,FX_TOKEN),r=replayPortfolio([s],RULES,{...window(),to:START+4000}),legacy=change(s,x=>{delete x.entryPreparations;x.entry=point;x.decisionAt=point.at;});const {broker,gateway,store}=paritySetup(legacy);
  try{
    const order=await submitPrepared(broker,gateway);assert.equal(order.decisionAt,r.attempts[0].decisionAt);assert.equal(order.dueAt,START+3500);await executeFrame(broker,gateway,order,1);
    const account=broker.account('manual-bsc');assert.equal(account.nativeBalanceRaw,r.nativeAccounting.finalNativeRaw);assert.equal(account.reservedNativeRaw,r.nativeAccounting.reservedNativeRaw);assert.equal(account.feesUsd,r.attempts[0].feesUsd);
    assert.equal(broker.positions()[0].costUsd,r.attempts[0].outlayUsd);assert.equal(r.attempts[0].outlayUsd,2);assert.equal(r.attempts[0].originalRaw,'1970');assert.ok(Math.abs(account.conservativeEquityUsd-100-r.metrics.netUsd)<1e-6);
  }finally{store.close();}
});

test('prepared Broker and causal stream retain moving-FX native cash benchmark and drawdown parity',async()=>{
  const preps=[budgetPair(5,1000),budgetPair(3,2000),{...budgetPair(2,3000),last:true}],chosen=preps[2],point:ResearchObservation={at:chosen.at,receivedAt:chosen.at,block:chosen.block,priceUsd:1,quotes:[chosen.buy!,chosen.reverse!]},later=[budgetFill(chosen,3500,120),budgetFill(chosen,3900,90)];
  const s=stream(preps,later,FX_TOKEN),fxTrace:NativeFxSnapshot[]=[{chain:'bsc',at:START,receivedAt:START,nativeUsd:100,quality:'verified',source:'initial FX'},{chain:'bsc',at:START+3500,receivedAt:START+3500,nativeUsd:120,quality:'verified',source:'live FX'},{chain:'bsc',at:START+3900,receivedAt:START+3900,nativeUsd:90,quality:'verified',source:'live FX'}];
  const r=replayPortfolio([s],RULES,{...window(),to:START+4000,fxTrace}),legacy=change(s,x=>{delete x.entryPreparations;x.entry=point;x.decisionAt=point.at;}),{broker,gateway,store}=paritySetup(legacy);
  try{
    const order=await submitPrepared(broker,gateway),equities=[broker.account('manual-bsc').conservativeEquityUsd];gateway.index=1;equities.push(broker.revalueAccount('manual-bsc').conservativeEquityUsd);await executeFrame(broker,gateway,order,1);equities.push(broker.account('manual-bsc').conservativeEquityUsd);
    gateway.index=2;await broker.updateValuations();const account=broker.revalueAccount('manual-bsc');equities.push(account.conservativeEquityUsd);
    assert.equal(account.nativeBalanceRaw,r.nativeAccounting.finalNativeRaw);assert.equal(broker.positions()[0].costUsd,r.attempts[0].outlayUsd);assert.ok(Math.abs(account.conservativeEquityUsd-100-r.metrics.netUsd)<1e-6);
    assert.equal(r.nativeAccounting.idleBenchmarkEquityUsd,90);assert.equal(r.nativeAccounting.idleBenchmarkNetUsd,-10);assert.ok(Math.abs(r.nativeAccounting.excessOverIdleUsd-account.conservativeEquityUsd+90)<1e-6);
    let high=100,dd=0;for(const e of equities){high=Math.max(high,e);dd=Math.max(dd,(high-e)/high*100);}assert.ok(Math.abs(dd-r.metrics.maxDrawdownPct)<1e-6);
  }finally{store.close();}
});

test('prepared Broker and stream charge conditional slippage Gas/approval identically, never risk/data rejections',async()=>{
  for(const [output,missing] of [[1900,false],[1970,true]] as const){
    const preps=[budgetPair(5,1000),budgetPair(3,2000),{...budgetPair(2,3000),last:true}],chosen=preps[2],point:ResearchObservation={at:chosen.at,receivedAt:chosen.at,block:chosen.block,priceUsd:1,quotes:[chosen.buy!,chosen.reverse!]},fill=budgetFill(chosen,3500,100,output);
    if(missing)fill.quotes[0].quote.fees.quality='unavailable';
    const s=stream(preps,[fill],FX_TOKEN),r=replayPortfolio([s],RULES,{...window(),to:START+4000}),legacy=change(s,x=>{delete x.entryPreparations;x.entry=point;x.decisionAt=point.at;}),{broker,gateway,store}=paritySetup(legacy);
    try{const order=await submitPrepared(broker,gateway);gateway.index=1;await broker.execute(order);assert.equal(broker.orders()[0].status,'failed');assert.equal(r.attempts[0].status,'failed');assert.equal(r.nativeAccounting.finalNativeRaw,broker.account('manual-bsc').nativeBalanceRaw);assert.equal(r.attempts[0].feesUsd,missing?0:.03);assert.equal(broker.account('manual-bsc').feesUsd,r.attempts[0].feesUsd);}finally{store.close();}
  }
});
test('conditional slippage policy archives assumptions, not incurred fees; raw THREE percent boundary matches Broker',async()=>{
  const s=outputAt(policyTape('boundary-policy'),970),policy=s.later[0].quotes[0].executionFailurePolicy!;
  assert.equal(policy.version,'paper-slippage-v1');assert.equal(policy.conditional,'slippageOnly');assert.equal('incurred' in policy,false);
  const r=replayPortfolio([s],RULES,{...window(),to:START+1500}),live=await brokerBuyOutcome(s);
  assert.equal(live.order.status,'filled');assert.equal(r.attempts[0].fills.length,1);assert.equal(r.attempts[0].originalRaw,'970');
  assert.equal(r.attempts[0].feesUsd,.03);assert.equal(r.attempts[0].failures.length,0);assert.equal(r.nativeAccounting.finalNativeRaw,live.account.nativeBalanceRaw);
});
test('conditional buy slippage failure pays archived native Gas PLUS approval exactly like Broker',async()=>{
  const s=outputAt(policyTape('below-boundary'),969),r=replayPortfolio([s],RULES,window()),live=await brokerBuyOutcome(s);
  assert.equal(live.order.status,'failed');assert.equal(live.positions.length,0);assert.equal(r.attempts[0].status,'failed');assert.equal(r.authoritative,true);
  assert.equal(r.attempts[0].feesUsd,.03);assert.equal(r.nativeAccounting.finalNativeRaw,live.account.nativeBalanceRaw);assert.ok(Math.abs(r.metrics.netUsd-live.account.conservativeEquityUsd+100)<1e-6);
  assert.equal(r.attempts[0].failures.filter(f=>f.cashDebitUsd!==undefined).length,1);
});
test('conditional sell slippage failure pays the same Gas/approval as Broker without inventing a sale',async()=>{
  const s=change(policyTape('sell-policy',[1,1,1.5,1.5]),x=>{for(const [i,p] of x.later.entries())if(i>=1){const q=p.quotes.find((q:any)=>q.requestedTokenRaw==='500');q.quote.priceUsd=i===1?2:1.8;q.quote.outputRaw=usdNative(q.quote.priceUsd*.5,1).toString();q.cashCreditUsd=q.quote.priceUsd*.5;}});
  const r=replayPortfolio([s],RULES,{...window(),to:START+3500}),{broker,gateway,store}=paritySetup(s);
  try{
    const buy=await broker.submit({clientId:randomUUID(),accountId:'manual-bsc',token:FX_TOKEN,side:'buy',amountUsd:1,reason:'卖出条件失败费',rules:RULES});await executeFrame(broker,gateway,buy,1);
    gateway.index=2;await broker.updateValuations();await broker.evaluateExits();const sell=broker.orders().find(o=>o.side==='sell'&&o.status==='queued')!;assert.ok(sell);gateway.index=3;await broker.execute(sell);
    assert.equal(broker.orders().find(o=>o.id===sell.id)!.status,'failed');assert.equal(r.attempts[0].fills.filter(f=>f.side==='sell').length,0);
    assert.equal(r.nativeAccounting.finalNativeRaw,broker.account('manual-bsc').nativeBalanceRaw);assert.equal(r.attempts[0].feesUsd,broker.account('manual-bsc').feesUsd);assert.equal(r.attempts[0].remainingRaw,'1000');
  }finally{store.close();}
});
test('conditional policies do not charge risk/data/input/expiry/premium rejects',async()=>{
  const base=policyTape('no-phantom');
  const risk=change(base,x=>{const p=x.later[0],b=p.quotes.find((q:any)=>q.quote.side==='buy'),r=p.quotes.find((q:any)=>q.requestedTokenRaw==='1000');r.quote.outputRaw=usdNative(.1,1).toString();r.quote.priceUsd=.1;r.cashCreditUsd=.1;b.stopEstimates=feeAwareStopEstimates(b.quote,r.quote);});
  const rejected=replayPortfolio([risk],RULES,window()),live=await brokerBuyOutcome(risk);assert.equal(live.order.status,'failed');assert.equal(rejected.attempts[0].status,'failed');assert.equal(rejected.attempts[0].feesUsd,0);assert.equal(rejected.nativeAccounting.finalNativeRaw,live.account.nativeBalanceRaw);assert.equal(live.account.feesUsd,0);
  for(const changed of [
    change(base,x=>{x.later[0].quotes[0].executable=false;}),
    change(base,x=>{x.later[0].quotes[0].quote.inputRaw=usdNative(2,1).toString();}),
    change(base,x=>{x.later[0].quotes[0].quote.at=START-6000;}),
    change(base,x=>{x.signalExpiresAt=START+500;}),
    change(base,x=>{x.later[0].quotes[0].quote.priceUsd=2;x.maxEntryPriceUsd=1.1;}),
  ]){const r=replayPortfolio([changed],RULES,window());assert.equal(r.attempts[0].feesUsd,0);assert.equal(r.metrics.netUsd,0);}
});
test('wrong-version or wrong-amount conditional failure policies cannot understate formal failure expenses',()=>{
  const source=outputAt(policyTape('invalid-policy'),969);
  for(const modify of [(p:any)=>{p.version='unknown-version';},(p:any)=>{p.nativeDebitRaw='0';p.cashDebitUsd=0;p.feesUsd=0;},(p:any)=>{p.at=START+2000;}]){
    const s=change(source,x=>{modify(x.later[0].quotes[0].executionFailurePolicy);}),r=replayPortfolio([s],RULES,window());assert.equal(r.authoritative,false);assert.equal(r.attempts[0].feesUsd,0);
  }
});
test('parity clock must advance MONOTONIC time as well as wall time and head receipt',async()=>{
  const {broker,gateway,store}=paritySetup(fxSample());try{
    const buy=await broker.submit({clientId:randomUUID(),accountId:'manual-bsc',token:FX_TOKEN,side:'buy',amountUsd:1,reason:'双时钟延迟验收',rules:RULES});gateway.index=1;gateway.clock.mono=0;
    await broker.execute(buy);assert.equal(broker.positions().length,0);assert.equal(broker.orders()[0].status,'queued');
    gateway.clock.mono=1000;await broker.execute(buy);assert.equal(broker.positions().length,1);assert.equal(broker.orders()[0].status,'filled');
  }finally{store.close();}
});
test('moving FX: real Broker and replay match native ledger, fills, USD risk/equity/DD and idle benchmark',async()=>{
  const s=fxSample(),fxTrace:NativeFxSnapshot[]=[{chain:'bsc',at:START+8000,receivedAt:START+8000,nativeUsd:90,quality:'verified',source:'market-rate'}];
  const r=replayPortfolio([s],RULES,{...window(),fxTrace});const a=r.attempts[0];assert.equal(a.status,'closed');assert.equal(a.fills.length,3);
  // 20% USD price increase is ONLY FX; raw output/spend unchanged, so fill passes.
  assert.equal(quoteSlippageAccepted(s.entry.quotes[0].quote,s.later[0].quotes[0].quote,3),true);
  const {broker,gateway,store}=paritySetup(s);const equity:number[]=[100];
  try{
    const buy=await broker.submit({clientId:randomUUID(),accountId:'manual-bsc',token:FX_TOKEN,side:'buy',amountUsd:1,reason:'原生币汇率对账',rules:RULES});
    await executeFrame(broker,gateway,buy,1);equity.push(broker.revalueAccount('manual-bsc').conservativeEquityUsd);
    gateway.index=2;await broker.updateValuations();equity.push(broker.revalueAccount('manual-bsc').conservativeEquityUsd);await broker.evaluateExits();
    const first=broker.orders().find(o=>o.side==='sell'&&o.status==='queued')!;await executeFrame(broker,gateway,first,3);equity.push(broker.revalueAccount('manual-bsc').conservativeEquityUsd);
    gateway.index=4;await broker.updateValuations();equity.push(broker.revalueAccount('manual-bsc').conservativeEquityUsd);await broker.evaluateExits();
    const last=broker.orders().find(o=>o.side==='sell'&&o.status==='queued')!;await executeFrame(broker,gateway,last,5);equity.push(broker.revalueAccount('manual-bsc').conservativeEquityUsd);
    gateway.clock.advanceTo(START+8000);gateway.overrideFx=90;const account=broker.revalueAccount('manual-bsc');equity.push(account.conservativeEquityUsd);
    assert.equal(account.nativeBalanceRaw,r.nativeAccounting.finalNativeRaw);
    assert.ok(Math.abs(account.cashUsd-r.nativeAccounting.cashUsd)<1e-6);
    assert.ok(Math.abs(account.conservativeEquityUsd-100-r.metrics.netUsd)<1e-6);
    assert.ok(Math.abs(broker.positions()[0].netRealizedUsd-a.netUsd)<1e-6);
    assert.equal(r.nativeAccounting.idleBenchmarkEquityUsd,90);assert.equal(r.nativeAccounting.idleBenchmarkNetUsd,-10);
    assert.ok(Math.abs(r.nativeAccounting.excessOverIdleUsd-(account.conservativeEquityUsd-90))<1e-6);
    assert.ok(a.netUsd>0&&r.metrics.netUsd<0);assert.equal(passesFormalMetrics(r.metrics),false);
    let peak=100,dd=0;for(const value of equity){peak=Math.max(peak,value);dd=Math.max(dd,(peak-value)/peak*100);}assert.ok(Math.abs(dd-r.metrics.maxDrawdownPct)<1e-6);
    assert.equal(broker.checks().passed,true);
  }finally{store.close();}
});
test('cash-only FX drawdown blocks new entries exactly like live; future FX cannot change history',()=>{
  const s=change(sample('fx-halt',START+10_000),x=>{for(const p of [x.entry,...x.later])for(const q of p.quotes){q.quote.nativeUsd=94;q.quote.inputRaw=q.quote.side==='buy'?usdNative(1,94).toString():q.quote.inputRaw;q.quote.spentInputRaw=q.quote.side==='buy'?q.quote.inputRaw:q.quote.spentInputRaw;if(q.quote.side==='sell')q.quote.outputRaw=usdNative(q.cashCreditUsd,94).toString();}});
  const trace:NativeFxSnapshot[]=[{chain:'bsc',at:START,receivedAt:START,nativeUsd:100,quality:'verified',source:'initial'},{chain:'bsc',at:START+10_000,receivedAt:START+10_000,nativeUsd:94,quality:'verified',source:'current'}];
  const r=replayPortfolio([s],RULES,{...window(),fxTrace:trace});assert.equal(r.attempts[0].reason,'daily net loss limit');assert.equal(r.metrics.netUsd,-6);assert.equal(r.metrics.maxDrawdownPct,6);
  const future={...trace[1],at:START+70_000,receivedAt:START+70_000,nativeUsd:10000};assert.equal(replayPortfolio([s],RULES,{...window(),fxTrace:[...trace,future]}).dataHash,r.dataHash);
  const {broker,gateway,store}=paritySetup(fxSample());try{broker.fundNative('manual-bsc',100);gateway.overrideFx=94;assert.ok(broker.revalueAccount('manual-bsc').haltReason.includes('净亏损'));}finally{store.close();}
});
test('wallet premium and expiry checked at BOTH decision and post-delay fill',()=>{
  const base=fxSample();
  const premium=change(base,x=>{x.maxEntryPriceUsd=1.10;x.signalExpiresAt=START+5000;});const r=replayPortfolio([premium],RULES,window());assert.equal(r.attempts[0].status,'failed');assert.equal(r.attempts[0].reason,'wallet fill price exceeds premium cap');assert.equal(r.attempts[0].feesUsd,0);
  const early=change(base,x=>{x.maxEntryPriceUsd=.99;});assert.match(replayPortfolio([early],RULES,window()).attempts[0].reason,/premium cap/);
  const expired=change(base,x=>{x.signalExpiresAt=START+500;});assert.equal(replayPortfolio([expired],RULES,window()).attempts[0].reason,'wallet signal expired at fill');
  const old=change(base,x=>{x.signalExpiresAt=START-1;});assert.equal(replayPortfolio([old],RULES,window()).attempts[0].reason,'wallet signal expired');
});
test('known slippage gas needs archived failure cost: never formally pass a zero-cost omission',()=>{
  const bad=change(sample('gas-omitted'),x=>{const q=x.later[0].quotes.find((q:any)=>q.quote.side==='buy');q.quote.outputRaw='500';q.tokenAmountRaw='500';q.quote.priceUsd=2;q.quote.fees.gasUsd=.01;q.feesUsd=.01;q.cashDebitUsd=1.01;});
  const r=replayPortfolio([bad],RULES,window());assert.equal(r.attempts[0].status,'failed');assert.equal(r.authoritative,false);assert.match(r.attempts[0].reason,/gas cost snapshot missing/);
  const accounted=change(bad,x=>{const q=x.later[0].quotes.find((q:any)=>q.quote.side==='buy');q.executionFailurePolicy=createExecutionFailurePolicy(q.quote,q.receivedAt);});
  const complete=replayPortfolio([accounted],RULES,window());assert.equal(complete.authoritative,true);assert.ok(Math.abs(complete.metrics.netUsd+.01)<1e-6);assert.equal(complete.attempts[0].feesUsd,.01);
});
test('truthful stop snapshot AFTER buy quote but before observation is accepted, never backdated',()=>{
  const s=change(sample('stop-time'),x=>{for(const p of [x.entry,...x.later]){p.at+=10;p.receivedAt+=10;for(const q of p.quotes){for(const e of q.stopEstimates??[])e.at=q.quote.at+10;} }x.decisionAt+=10;x.capturedAt+=10;});
  assert.equal(replayPortfolio([s],RULES,window()).metrics.count,1);
  const future=change(s,x=>{for(const p of [x.entry,...x.later])for(const q of p.quotes)for(const e of q.stopEstimates??[])e.at=p.at+1;});assert.equal(replayPortfolio([future],RULES,window()).metrics.count,0);
});
test('Gas exceeds tiny sell proceeds: native debit and net trade match real Broker; slippage excludes outside gas',async()=>{
  const s=change(sample('tiny',START,[1,1,1.5,1.5,1.5,1.5],{token:FX_TOKEN}),x=>{for(const p of x.later.slice(1))for(const q of p.quotes)if(q.quote.side==='sell'){q.quote.fees.gasUsd=.8;q.cashCreditUsd=nativeUsd(q.quote.outputRaw,1);q.cashDebitUsd=.8;q.feesUsd=.8;}for(const p of x.later.slice(3)){p.at+=2000;p.receivedAt+=2000;for(const q of p.quotes){q.quote.at+=2000;q.receivedAt+=2000;q.validUntil+=2000;}} });
  const r=replayPortfolio([s],RULES,window());assert.equal(r.attempts[0].status,'closed');assert.ok(Math.abs(r.metrics.netUsd+1.1)<1e-6);
  const flow=quoteNativeCashFlow(s.later[2].quotes.find(q=>q.requestedTokenRaw==='500')!.quote);assert.equal(flow.nativeDeltaRaw,'-50000000000000000');assert.equal(flow.tradeCashUsd,-.05);
  const {broker,gateway,store}=paritySetup(s);try{
    const buy=await broker.submit({clientId:randomUUID(),accountId:'manual-bsc',token:FX_TOKEN,side:'buy',amountUsd:1,reason:'负卖出净额对账',rules:RULES});await executeFrame(broker,gateway,buy,1);
    gateway.index=2;await broker.updateValuations();await broker.evaluateExits();const first=broker.orders().find(o=>o.side==='sell'&&o.status==='queued')!;await executeFrame(broker,gateway,first,3);
    gateway.index=4;await broker.evaluateExits();const last=broker.orders().find(o=>o.side==='sell'&&o.status==='queued')!;await executeFrame(broker,gateway,last,5);
    assert.equal(broker.account('manual-bsc').nativeBalanceRaw,r.nativeAccounting.finalNativeRaw);assert.ok(Math.abs(broker.positions()[0].netRealizedUsd-r.attempts[0].netUsd)<1e-6);
  }finally{store.close();}
  const ref=s.later[1].quotes.find(q=>q.requestedTokenRaw==='500')!.quote;const changed=structuredClone(ref) as Quote;changed.fees.gasUsd=10;assert.equal(quoteSlippageAccepted(ref,changed,3),true);
});

function shortContext():MomentumContext {
  return {chain:'bsc',token:'coin',now:START+120_000,createdAt:START,priceUsd:2,priceAt:START+120_000,coverageStart:START,hasGap:false,trades:[
    {id:'prior',at:START+70_000,receivedAt:START+70_000,priceUsd:1,amountUsd:10,side:'buy',verified:true},
    {id:'buy',at:START+110_000,receivedAt:START+110_000,priceUsd:2,amountUsd:15,side:'buy',verified:true},
    {id:'sell',at:START+119_000,receivedAt:START+119_000,priceUsd:1.9,amountUsd:5,side:'sell',verified:true},
  ]};
}
test('actual short breakout, 2x volume and 1.5 buy/sell; no future trades or duplicate inflation',()=>{
  const c=shortContext();assert.equal(evaluateShortSignal(c).eligible,true);
  assert.equal(evaluateShortSignal({...c,priceUsd:1}).eligible,false);assert.equal(evaluateShortSignal({...c,createdAt:c.now-600_000}).eligible,false);
  assert.equal(evaluateShortSignal({...c,coverageStart:c.now-50_000}).eligible,false);
  const small={...c,trades:c.trades.map(t=>t.id==='buy'?{...t,amountUsd:2}:t)};
  assert.equal(evaluateShortSignal({...small,trades:[...small.trades,{...c.trades[1],id:'future',at:c.now+1,receivedAt:c.now+1,amountUsd:999},small.trades[1]]}).eligible,false);
  assert.equal(evaluateShortSignal({...c,hasGap:true}).eligible,false);
});
function bars(now:number,period:number,count:number,lastClose:number,lastVolume:number):SignalBar[]{
  return Array.from({length:count},(_,i)=>({time:Math.floor(now/period)*period-(count-i)*period,open:1,high:i===count-1?lastClose:1.1,low:.9,close:i===count-1?lastClose:1,volume:i===count-1?lastVolume:10,receivedAt:Math.floor(now/period)*period-(count-i-1)*period,complete:true}));
}
test('swing uses prior20 completed minute bars, doubled volume, rising 5m EMA20',()=>{
  const c=shortContext(),now=START+200*60_000;
  const s={...c,now,priceAt:now,minuteBars:bars(now,60_000,21,2,20),fiveMinuteBars:bars(now,300_000,21,1.2,20)};
  assert.equal(evaluateSwingSignal(s).eligible,true);
  assert.equal(evaluateSwingSignal({...s,minuteBars:s.minuteBars.slice(1)}).eligible,false);
  assert.equal(evaluateSwingSignal({...s,fiveMinuteBars:bars(now,300_000,21,.9,20)}).eligible,false);
  const incomplete={...s.minuteBars[20],time:Math.floor(now/60_000)*60_000,close:999,high:999,complete:false,receivedAt:now+60_000};
  assert.deepEqual(evaluateSwingSignal({...s,minuteBars:[...s.minuteBars,incomplete]}),evaluateSwingSignal(s));
  assert.equal(evaluateSwingSignal({...s,minuteBars:s.minuteBars.map((b,i)=>i===20?{...b,volume:19.9}:b)}).eligible,false);
});
function wallet():WalletSignalContext {
  const event:MarketEvent={id:'tx',chain:'bsc',kind:'wallet',block:1,at:START,receivedAt:START+100,token:'coin',wallet:'whale',side:'buy',firstBuy:true,payload:{verified:true}};
  return {chain:'bsc',horizon:'short',now:START+1000,event,wallets:['WHALE'],targetEntryPriceUsd:1,ourExecutablePriceUsd:1.1,firstVerifiedBuy:true,seenFirstBuys:new Set()};
}
test('wallet first verified buy only, strict freshness and premium; ignore sell/add/replay',()=>{
  const c=wallet();assert.equal(evaluateWalletSignal(c).eligible,true);
  assert.equal(evaluateWalletSignal({...c,ourExecutablePriceUsd:1.10001}).eligible,false);
  assert.equal(evaluateWalletSignal({...c,now:START+5001}).eligible,false);
  assert.equal(evaluateWalletSignal({...c,horizon:'swing',now:START+60_000}).eligible,true);
  assert.equal(evaluateWalletSignal({...c,seenFirstBuys:new Set([walletSignalKey('bsc','whale','coin')])}).eligible,false);
  for(const patch of [{side:'sell'}, {replayed:true},{firstBuy:false},{payload:{verified:false}},{payload:{verified:true,add:true}}])assert.equal(evaluateWalletSignal({...c,event:{...c.event,...patch} as MarketEvent}).eligible,false);
});
