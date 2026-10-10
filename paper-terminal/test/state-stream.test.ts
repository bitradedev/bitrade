import test from 'node:test';import assert from 'node:assert/strict';
import type {AppState} from '../src/shared/domain.js';
import {stateChange,applyStateChange,StateStreamReceiver,newerState} from '../src/shared/state-stream.js';
const wire=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
function state():AppState {return {stateRevision:1,mode:'paper',at:1000,csrf:'generation-a',chains:[{chain:'bsc',head:100,connected:true},{chain:'robinhood',head:200,connected:true}],markets:Array.from({length:300},(_,i)=>({id:'market-'+i,chain:i<150?'bsc':'robinhood',address:'0x'+i.toString(16).padStart(40,'0'),symbol:'实际字段'+i,priceUsd:.01,updatedAt:1000,metadata:{feeEvidence:'原始费用证明',phase:'curve'}})),accounts:[{id:'manual-bsc',nativeBalanceRaw:'1000000000000000000',cashUsd:100}],positions:[{id:'batch-a',originalRaw:'123456789012345678901234567890',remainingRaw:'123456789012345678901234567890',rules:{targets:[{gainPct:30,sellOriginalPct:50}]}}],orders:[{id:'order-a',status:'queued',error:'',referenceQuote:{fees:{taxUsd:.1,approvalUsd:.2}}}],fills:[],strategies:[{id:'strategy-a',version:'v1',state:'waiting'}],researchRuns:[],audit:[{id:1,message:'已发现真实样本'}],risk:{riskPct:.5},health:{uptimeMs:1,ledger:{passed:true,errors:[]},equity:Object.fromEntries(Array.from({length:10},(_,i)=>['account-'+i,Array.from({length:300},(_,j)=>({at:j*60000,value:100,conservative:100}))]))}} as unknown as AppState;}

test('state deltas exactly preserve fills, frozen units, fees, reorg removals and future fields',()=>{
 const base=state(),next=wire(base);next.at=2000;next.stateRevision=2;
 next.markets[0].priceUsd=null;next.markets[0].metadata=undefined;next.markets[0].scannerStage='graduated';next.markets[0].progressPct=null;
 next.orders[0]={...next.orders[0],status:'failed',error:'重组使该报价失效'};
 next.positions=[];next.fills=[{id:'fill-a',orderId:'order-a',tokenRaw:'900719925474099312345',fees:{taxUsd:.12,gasUsd:.01}} as any];
 next.audit=[{id:2,message:'无法卖出样本继续留档'} as any];next.strategies[0].version='v2';
 next.accounts[0].nativeBalanceRaw='1000000000000000001';
 (next as any).futureField={unknownTax:null};next.health.unknownFeeReason='费用缺失';delete next.health.uptimeMs;
 const actual=applyStateChange(wire(base),wire(stateChange(base,next)));
 assert.deepEqual(actual,wire(next));assert.equal(actual.fills[0].tokenRaw,'900719925474099312345');
 assert.equal(Object.hasOwn(actual.markets[0],'metadata'),false);
});
test('delta changes preserve array order and untouched row identity',()=>{
 const base=state(),next=wire(base);next.markets=[next.markets[2],next.markets[0],next.markets[1],...next.markets.slice(3)];next.markets[1].priceUsd=.02;
 const actual=applyStateChange(base,stateChange(base,next));assert.deepEqual(actual,wire(next));
 assert.equal(actual.markets[0],base.markets[2]);assert.equal(actual.markets[2],base.markets[1]);assert.notEqual(actual.markets[1],base.markets[0]);assert.equal(actual.health.equity,base.health.equity);
});
test('omitted optional root and health fields clear previous values rather than retaining stale proof',()=>{
 const base=state();base.controlActivity=[];base.health.obsoleteProof='old';const next=wire(base);next.controlActivity=undefined;next.health.obsoleteProof=undefined;
 const actual=applyStateChange(wire(base),wire(stateChange(base,next)));assert.deepEqual(actual,wire(next));
});
test('stream baseline is independent of newer HTTP data; missing revisions require full reconnect',()=>{
 const base=state(),receiver=new StateStreamReceiver();receiver.accept({type:'state-snapshot',streamId:'stream-a',revision:0,state:base});
 const http=wire(base);http.stateRevision=3;http.at=3000;http.orders[0].status='filled';
 const streamed=wire(base);streamed.stateRevision=2;streamed.at=2000;streamed.markets[1].priceUsd=.03;
 const first=receiver.accept({type:'state-delta',streamId:'stream-a',baseRevision:0,revision:1,patch:stateChange(base,streamed)});
 assert.deepEqual(first,wire(streamed));assert.equal(newerState(http,first,new Set([base.csrf])),false);
 assert.throws(()=>receiver.accept({type:'state-delta',streamId:'stream-a',baseRevision:2,revision:3,patch:stateChange(streamed,http)}),/不连续/);
 const later=wire(http);later.stateRevision=4;later.at=4000;later.markets[1].priceUsd=.04;
 assert.deepEqual(receiver.accept({type:'state-delta',streamId:'stream-a',baseRevision:1,revision:2,patch:stateChange(streamed,later)}),later);
 assert.deepEqual(receiver.accept({type:'state-snapshot',streamId:'stream-b',revision:0,state:http}),http);
 assert.throws(()=>receiver.accept({type:'state-delta',streamId:'stream-a',baseRevision:2,revision:3,patch:{}}),/不连续/);
});
test('logical state revision prevents clock rollback stalls and rejects delayed prior process replies',()=>{
 const base=state(),next=wire(base);next.stateRevision=2;next.at=500;
 assert.equal(newerState(base,next,new Set([base.csrf])),true);
 const old=wire(base);old.at=9000;assert.equal(newerState(next,old,new Set([base.csrf])),false);
 const restarted={...next,csrf:'generation-b',stateRevision:1};assert.equal(newerState(next,restarted,new Set(['generation-a'])),true);
 assert.equal(newerState(restarted,next,new Set(['generation-a','generation-b'])),false);
});
test('bad IDs, duplicate order and unsafe field keys are rejected without advancing baseline',()=>{
 const base=state(),change=stateChange(base,{...base,markets:base.markets.slice(1)});
 change.collections.markets.order=['does-not-exist'];assert.throws(()=>applyStateChange(base,change),/顺序/);
 const unsafe=JSON.parse('{"fields":{"__proto__":{"polluted":true}},"removedFields":[],"collections":{}}');assert.throws(()=>applyStateChange(base,unsafe),/字段/);
 assert.equal(({} as any).polluted,undefined);
});
test('one actual market update does not retransmit hundreds of unchanged markets and equity points',()=>{
 const base=state(),next=wire(base);next.at=2000;next.stateRevision=2;next.markets[10].priceUsd=.02;
 const full=Buffer.byteLength(JSON.stringify(next)),delta=Buffer.byteLength(JSON.stringify(stateChange(base,next)));
 assert.ok(delta<full*.05,`delta ${delta} / full ${full}`);assert.deepEqual(applyStateChange(base,stateChange(base,next)),next);
});
