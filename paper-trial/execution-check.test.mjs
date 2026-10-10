import test from 'node:test';
import assert from 'node:assert/strict';
import {ExecutionCheck,CHECK_ACCOUNT} from './execution-check.mjs';
function fixture(){const meta=new Map(),accounts=new Map(),orders=[],positions=[],fills=[],submitted=[];const store={meta:k=>meta.get(k),setMeta:(k,v)=>meta.set(k,structuredClone(v)),put:(_t,a)=>accounts.set(a.id,structuredClone(a)),audit:()=>{}};
 const broker={stopped:false,ensureAccount:(id,name,chain)=>accounts.set(id,{id,name,chain,paused:false,nativeBalanceRaw:null,initialCapitalUsd:100}),account:id=>accounts.get(id),accounts:()=>[...accounts.values(),{id:'trial-robinhood-momentum',paused:false}],orders:()=>orders,positions:()=>positions,fills:()=>fills,recipient:()=> '0x'+'1'.repeat(40),fresh:()=>({head:10}),checks:()=>({passed:true}),
  quoteBudget:async()=>({id:'buy-q',quality:'verified',venue:'pons-v2',priceImpactPct:1,inputRaw:'10000000000000000000',outputRaw:'100',block:10,nativeUsd:1}),getQuote:async()=>({id:'sell-q',quality:'verified',inputRaw:'100',block:10}),submit:async(input,prepared)=>{submitted.push({input,prepared});const o={id:'buy',status:'queued',accountId:CHECK_ACCOUNT.id,...input};orders.push(o);return o;}};
 const market={chain:'robinhood',platform:'pons-v2',stage:'curve',metadata:{route:'pons-v2'},address:'0x'+'2'.repeat(40),decimals:18,nativeUsd:1,updatedAt:1000,symbol:'TEST'};
 const gateway={markets:()=>[market]};return {store,broker,gateway,accounts,orders,positions,fills,submitted};}
test('verification uses its own $200 ledger and real prepared quotes; completion needs both buy and exit',async()=>{
 const f=fixture(),check=new ExecutionCheck(f.store,f.broker,f.gateway);assert.equal(f.accounts.get(CHECK_ACCOUNT.id).initialCapitalUsd,200);
 const result=await check.run();assert.equal(result.status,'queued');assert.equal(f.submitted[0].input.source,'execution-check');assert.equal(f.submitted[0].input.rules.maxHoldMs,30000);assert.equal(f.submitted[0].prepared.reference.id,'buy-q');
 f.orders[0].positionId='p';f.positions.push({id:'p',accountId:CHECK_ACCOUNT.id,closedAt:null});assert.equal(check.state().status,'holding');
 f.positions[0].closedAt=2000;assert.equal(check.state().status,'completed');assert.equal(check.state().ledgerPassed,true);
});
test('paused accounts and unavailable quotes cannot generate pretend validation fills',async()=>{
 const f=fixture(),check=new ExecutionCheck(f.store,f.broker,f.gateway);f.accounts.get(CHECK_ACCOUNT.id).paused=true;await assert.rejects(check.run(),/暂停/);assert.equal(f.orders.length,0);
 f.accounts.get(CHECK_ACCOUNT.id).paused=false;f.broker.quoteBudget=async()=>{throw Error('费用不可核实');};const result=await check.run();assert.equal(result.status,'failed');assert.equal(result.attempts.length,1);assert.equal(f.submitted.length,0);assert.equal(f.fills.length,0);
});
