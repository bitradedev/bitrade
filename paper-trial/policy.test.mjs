import test from 'node:test';
import assert from 'node:assert/strict';
import {decision,admission,budgets,RULES,RISK,INITIAL_CAPITAL_USD,MAX_ORDER_USD,entryAttempt,retainedTrades,signalDeadline,eligibleMarket,assertOutlay} from './policy.mjs';
import {SharedGateway,sourceReset,sourceCoverageGap} from './gateway.mjs';
const now=1791555000000,token='0x'+'1'.repeat(40),wallet='0x'+'2'.repeat(40);
const market={chain:'bsc',address:token,quality:'verified',priceUsd:1.2,createdAt:now-120000,updatedAt:now};
const event={id:'fresh',chain:'bsc',kind:'trade',token,at:now,receivedAt:now,side:'buy',priceUsd:1.2,amountUsd:30,payload:{verified:true}};
const trades=[{id:'old',at:now-45000,receivedAt:now-45000,priceUsd:1,amountUsd:10,side:'buy',verified:true},{id:'new',at:now-1000,receivedAt:now-1000,priceUsd:1.2,amountUsd:30,side:'buy',verified:true}];
const context={family:'momentum',event,market,now,coverageStart:now-65000,hasGap:false,trades,wallets:[wallet]};
test('a current verified breakout can qualify; stale, future or replayed data cannot',()=>{
 assert.equal(decision(context).eligible,true);
 for(const e of [{...event,replayed:true},{...event,at:now-30001},{...event,receivedAt:now+1},{...event,payload:{verified:false}}])assert.equal(decision({...context,event:e}).eligible,false);
 assert.equal(decision({...context,market:{...market,updatedAt:now-5001}}).eligible,false);
 assert.equal(decision({...context,market:{...market,quality:'estimated'}}).eligible,false);
});
test('restart warm-up and data gaps do not qualify as uninterrupted coverage',()=>{
 assert.equal(decision({...context,coverageStart:now-59000}).eligible,false);
 assert.equal(decision({...context,hasGap:true}).eligible,false);
});
test('wallet signals require a watched first buy and bounded entry premium',()=>{
 const e={...event,kind:'wallet',wallet,firstBuy:true,priceUsd:1.15};
 const c={...context,family:'wallet',event:e};assert.equal(decision(c).eligible,true);
 for(const change of [{firstBuy:false},{side:'sell'},{wallet:'0x'+'3'.repeat(40)},{at:now-60001},{priceUsd:1}])assert.equal(decision({...c,event:{...e,...change}}).eligible,false);
});
const account={id:'x',paused:false,haltReason:'',dayEntries:0,consecutiveLosses:0,dayNetUsd:0,dayStartEquityUsd:100,conservativeEquityUsd:100};
test('pending orders, user pause and end-of-window block new entry',()=>{
 assert.equal(admission(account,[],[],now,now+1),null);
 assert.match(admission({...account,paused:true},[],[],now,now+1),/暂停/);
 assert.match(admission(account,[],[],now,now),/窗口已结束/);
 const orders=Array.from({length:3},()=>({accountId:'x',side:'buy',status:'queued'}));
 assert.match(admission(account,[],orders,now,now+1),/持仓上限/);
 assert.match(admission({...account,dayNetUsd:-20},[],[],now,now+1),/净亏损/);
});
test('autonomous trial can allocate $40 from $200 while shrinking with equity',()=>{
 assert.equal(budgets(50)[0],budgets(100)[0]/2);assert.equal(budgets(200)[0],40);
 assert.ok(budgets(10000).every(v=>v<=40));assert.equal(INITIAL_CAPITAL_USD,200);assert.equal(MAX_ORDER_USD,40);
 assert.equal(RISK.riskPct,5);assert.equal(RISK.maxPositionPct,20);assert.equal(RULES.maxHoldMs,600000);
});
test('shared gateway cannot point at external execution services or accept real trade arguments',async()=>{
 assert.throws(()=>new SharedGateway('https://example.com'),/仅允许/);
 const g=new SharedGateway();
 await assert.rejects(()=>g.quote({chain:'bsc',token,recipient:wallet,side:'swap',block:1,nativeAmountRaw:'1'}),/参数无效/);
 await assert.rejects(()=>g.quote({chain:'bsc',token,recipient:wallet,side:'buy',block:1,nativeAmountRaw:'1'}),/连接过期/);
});
test('Robinhood gaps cannot keep resetting the independent BSC trial',()=>{
 const old={csrf:'same',chains:[{chain:'bsc',head:100,gaps:0},{chain:'robinhood',head:200,gaps:2}]};
 assert.equal(sourceReset(old,{csrf:'same',chains:[{chain:'bsc',head:101,gaps:0},{chain:'robinhood',head:201,gaps:3}]}),false);
 assert.equal(sourceReset(old,{csrf:'same',chains:[{chain:'bsc',head:99,gaps:0}]}),true);
 assert.equal(sourceReset(old,{csrf:'new',chains:old.chains}),true);
 assert.equal(sourceReset(old,{csrf:'same',chains:[{chain:'bsc',head:101,gaps:0},{chain:'robinhood',head:201,gaps:3}]},'robinhood'),false);
 assert.equal(sourceCoverageGap(old,{csrf:'same',chains:[{chain:'bsc',head:101,gaps:0},{chain:'robinhood',head:201,gaps:3}]},'robinhood'),true);
 assert.equal(sourceReset(old,{csrf:'same',chains:[{chain:'bsc',head:99,gaps:0},{chain:'robinhood',head:201,gaps:2}]},'robinhood'),false);
});
test('Robinhood runs both trial signal families with chain-specific market and wallet evidence',()=>{
 const c={...context,chain:'robinhood',market:{...market,chain:'robinhood',platform:'pons-v2'},event:{...event,chain:'robinhood'}};
 assert.equal(decision(c).eligible,true);
 const walletContext={...c,family:'wallet',event:{...c.event,kind:'wallet',wallet,firstBuy:true,priceUsd:1.15}};
 assert.equal(decision(walletContext).eligible,true);
 assert.equal(decision({...c,market}).eligible,false);
 assert.equal(decision({...c,event}).eligible,false);
});
test('Robinhood skips Pons V1, allows V2 and resolved external routes',()=>{
 assert.equal(eligibleMarket({chain:'robinhood',platform:'pons'}),false);
 assert.equal(eligibleMarket({chain:'robinhood',platform:'待核实'}),false);
 assert.equal(eligibleMarket({chain:'robinhood',platform:'pons-v2'}),true);
 assert.equal(eligibleMarket({chain:'robinhood',platform:'待核实',metadata:{route:'pons-v2'}}),true);
 assert.equal(eligibleMarket({chain:'robinhood',stage:'dex',platform:'待核实',metadata:{route:'v3'}}),true);
 assert.equal(eligibleMarket({chain:'robinhood',stage:'dex',platform:'pons-v1',metadata:{route:'v4'}}),false);
 assert.equal(decision({...context,chain:'robinhood',event:{...event,chain:'robinhood'},market:{...market,chain:'robinhood',platform:'pons'}}).eligible,false);
});
test('external momentum can enter older tokens, but requires fresh verified trades and volume',()=>{
 const c={...context,chain:'robinhood',market:{...market,chain:'robinhood',stage:'dex',platform:'dex',metadata:{route:'v3'},createdAt:now-86400000},event:{...event,chain:'robinhood',at:now-30000},coverageStart:now-185000,trades:[{...trades[0],at:now-120000,receivedAt:now-120000},{...trades[1],amountUsd:16}]};
 assert.equal(decision(c).eligible,true);
 assert.equal(decision({...c,market:{...c.market,quality:'unavailable'}}).eligible,false);
 assert.equal(decision({...c,market:{...c.market,updatedAt:now-5001}}).eligible,false);
 assert.equal(decision({...c,trades:[c.trades[0],{...trades[1],amountUsd:14}]}).eligible,false);
 assert.equal(decision({...c,trades:[c.trades[0],{...trades[1],side:'sell'}]}).eligible,false);
 assert.equal(decision({...c,event:{...c.event,at:now-60001}}).eligible,false);
 assert.equal(decision({...c,coverageStart:now-179999}).eligible,false);
 assert.equal(decision({...c,hasGap:true}).eligible,false);
});
test('runtime trade retention and submission deadline support the longer external observation',()=>{
 const history=retainedTrades([{at:now-120000},{at:now-30000},{at:now-190000}],now);
 assert.equal(history.length,2);assert.equal(history[0].at,now-120000);
 assert.equal(signalDeadline('momentum',{stage:'dex'},now-30000),now+30000);
 assert.equal(signalDeadline('momentum',{stage:'curve'},now),now+30000);
});
test('absolute $40 admission includes gas and approval while avoiding double-counting quoted fees',()=>{
 const q={spentInputRaw:'1000000000000000000',nativeUsd:40,fees:{gasUsd:0,approvalUsd:0,protocolUsd:2,taxUsd:1,conversionUsd:1}};
 assert.equal(assertOutlay(q),40);
 assert.throws(()=>assertOutlay({...q,fees:{...q.fees,gasUsd:.01}}),/40美元/);
 assert.throws(()=>assertOutlay({...q,nativeUsd:40.5}),/40美元/);
});
test('a chain reset does not invalidate the other chain quote epoch',()=>{
 const affected=[],g=new SharedGateway(undefined,c=>affected.push(c));
 g.reset('robinhood');assert.equal(g.epochs.bsc,0);assert.equal(g.epochs.robinhood,1);assert.deepEqual(affected,['robinhood']);
 g.reset();assert.equal(g.epochs.bsc,1);assert.equal(g.epochs.robinhood,2);
});
test('history coverage loss resets observations but never falsely labels fresh quotes as reorged',()=>{
 const canonical=[],coverage=[],g=new SharedGateway(undefined,c=>canonical.push(c),c=>coverage.push(c));
 g.noticeGap('robinhood');assert.deepEqual(coverage,['robinhood']);assert.equal(g.epochs.robinhood,0);assert.deepEqual(canonical,[]);
 g.reset('robinhood');assert.equal(g.epochs.robinhood,1);assert.deepEqual(canonical,['robinhood']);
});
test('an unfilled failure can retry but queued, filled and repeated failures never create duplicate entries',()=>{
 const failed={clientId:'trial:test',status:'failed'};assert.deepEqual(entryAttempt([failed],'trial:test'),{allowed:true,index:1});
 for(const status of ['queued','quoting','filled','partial'])assert.equal(entryAttempt([{...failed,status}],'trial:test').allowed,false);
 assert.equal(entryAttempt([failed,{...failed,clientId:'trial:test:1'},{...failed,clientId:'trial:test:2'}],'trial:test').allowed,false);
 assert.deepEqual(entryAttempt([{clientId:'unrelated',status:'filled'}],'trial:test'),{allowed:true,index:0});
});
