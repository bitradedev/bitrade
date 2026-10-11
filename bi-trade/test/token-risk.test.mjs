import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {PlatformStore} from '../lib/database.mjs';
import {evaluateTokenRisk,TokenRiskGuard,RISK_POLICY} from '../lib/token-risk.mjs';

const TOKEN='0x'+'11'.repeat(20),POOL='0x'+'22'.repeat(20),CREATOR='0x'+'33'.repeat(20);
const wallet=i=>'0x'+String(i+100).padStart(40,'0');
function evidence(){return {info:{address:TOKEN,price:{price:'1'},liquidity:'100000',stat:{top_bundler_trader_percentage:'0'},dev:{creator_address:CREATOR}},holders:{list:[{address:POOL,amount_percentage:.5,addr_type:2,maker_token_tags:[]},...Array.from({length:25},(_,i)=>({address:wallet(i),amount_percentage:.02,addr_type:0,maker_token_tags:[],native_transfer:null}))]},security:{address:TOKEN,is_honeypot:false,is_blacklist:false,can_not_sell:0}};}
function fixture(t,options={}){const root=resolve('bi-trade/data/test-runs');mkdirSync(root,{recursive:true});const dir=mkdtempSync(resolve(root,'risk-')),store=new PlatformStore(dir),guard=new TokenRiskGuard(store,options);t.after(async()=>{await guard.close();store.close();assert.ok(dir.startsWith(root+'\\')||dir.startsWith(root+'/'));rmSync(dir,{recursive:true,force:true});});return {store,guard};}

test('Local invocation exhaustion preserves expired risk evidence and retries next round without making it fresh or safe',async t=>{
 let now=Date.now(),exhausted=true,attempts=0;
 const {guard,store}=fixture(t,{now:()=>now,source:{riskReport:async()=>{attempts++;if(exhausted)throw Object.assign(Error('CF_SUBREQUEST_BUDGET: subrequest limit'),{code:'CF_SUBREQUEST_BUDGET'});return evaluateTokenRisk(TOKEN,evidence(),now);}}});
 const previous={...evaluateTokenRisk(TOKEN,evidence(),now-121000),buyAllowed:false,state:'blocked',reasons:['Known risk']};store.put('token-risk-reports',previous);
 await guard.refresh(TOKEN);assert.deepEqual(store.get('token-risk-reports',TOKEN),previous);assert.equal(guard.snapshot(TOKEN).buyAllowed,false);assert.equal(guard.snapshot(TOKEN).fetchedAt,previous.fetchedAt);
 exhausted=false;now+=1000;const recovered=await guard.refresh(TOKEN);assert.equal(attempts,2);assert.equal(recovered.fetchedAt,now);assert.equal(recovered.buyAllowed,true);
});

test('holder risk screening keeps missing/partial fields unknown rather than treating them as zeros',()=>{
 assert.equal(evaluateTokenRisk(TOKEN,evidence()).state,'screened');
 for(const mutate of [d=>{delete d.info.stat.top_bundler_trader_percentage;},d=>{d.holders.list=[];},d=>{d.holders.list=d.holders.list.slice(0,8);},d=>{d.holders.list[1].amount_percentage=true;},d=>{delete d.holders.list[1].maker_token_tags;},d=>{delete d.security.is_honeypot;},d=>{d.security.address=POOL;}]){const d=evidence();mutate(d);const r=evaluateTokenRisk(TOKEN,d);assert.equal(r.buyAllowed,false);assert.equal(r.state,'unknown');assert.ok(r.reasons.length);}
});
test('a failed independent risk source keeps its provider label, blocks entry and recovers without calling GMGN',async t=>{
 let now=Date.now(),unavailable=true,fallbackCalls=0;
 const label='BSC RPC · DEX Screener · Honeypot.is';
 const {guard,store}=fixture(t,{now:()=>now,source:{label:()=>label,riskReport:async()=>{
  if(unavailable)throw Error('Chart source cooling down');
  return {...evaluateTokenRisk(TOKEN,evidence(),now),source:label};
 },info:async()=>{fallbackCalls++;throw Error('GMGN must not be called');}}});
 const failed=await guard.refresh(TOKEN);assert.equal(failed.source,label);assert.equal(failed.state,'unknown');assert.equal(failed.buyAllowed,false);assert.equal(failed.metrics,null);assert.equal(fallbackCalls,0);
 await assert.rejects(guard.assertBuy(TOKEN,{sizeUsd:10}),/开仓风险检查未通过/);
 unavailable=false;now+=RISK_POLICY.maxAgeMs;const recovered=await guard.refresh(TOKEN);assert.equal(recovered.source,label);assert.equal(recovered.buyAllowed,true);assert.equal(recovered.fetchedAt,now);assert.equal(fallbackCalls,0);assert.equal(store.get('token-risk-reports',TOKEN).source,label);
});
test('raw risk reads report the configured API source and retain the default CLI attribution when no label is supplied',async t=>{
 const d=evidence(),source={info:async()=>d.info,holders:async()=>d.holders,security:async()=>d.security};
 const api=fixture(t,{source:{...source,label:()=> 'GMGN API'}}),local=fixture(t,{source});
 assert.equal((await api.guard.refresh(TOKEN)).source,'GMGN API');
 assert.equal((await local.guard.refresh(TOKEN)).source,'GMGN CLI · token info/holders/security');
});
test('pool-dominated launch supply suppresses inflated wallet percentages and cannot pass a clean verdict',()=>{
 const d=evidence();d.holders.list=[{address:POOL,amount_percentage:.993,addr_type:2,maker_token_tags:[]},{address:wallet(0),amount_percentage:.007,addr_type:0,maker_token_tags:['bundler']}];
 const r=evaluateTokenRisk(TOKEN,d);assert.equal(r.state,'unknown');assert.equal(r.buyAllowed,false);assert.equal(r.metrics.bundlerObservedFloatShare,null);assert.equal(r.metrics.largestObservedFloatShare,null);assert.match(r.reasons.join('；'),/不足2%/);
});
test('bundler holdings and bundler trade volume are separate measurements and both can block entries',()=>{
 const held=evidence();for(const h of held.holders.list.slice(1,9))h.maker_token_tags=['bundler'];const a=evaluateTokenRisk(TOKEN,held);assert.equal(a.state,'blocked');assert.ok(a.metrics.bundlerObservedFloatShare>.30);assert.equal(a.metrics.bundlerVolumeShare,0);
 const volume=evidence();volume.info.stat.top_bundler_trader_percentage='.4';const b=evaluateTokenRisk(TOKEN,volume);assert.equal(b.state,'blocked');assert.equal(b.metrics.bundlerObservedWallets,0);assert.equal(b.metrics.bundlerVolumeShare,.4);
});
test('creator funding and concentrated common funding are evidence; exchange withdrawal origins are not common-control proof',()=>{
 const creator=evidence();creator.holders.list[1].native_transfer={from_address:CREATOR};assert.equal(evaluateTokenRisk(TOKEN,creator).state,'blocked');
 const linked=evidence();for(const h of linked.holders.list.slice(1,9))h.native_transfer={from_address:wallet(90)};assert.equal(evaluateTokenRisk(TOKEN,linked).state,'blocked');
 const exchange=evidence();for(const h of exchange.holders.list.slice(1,9))h.native_transfer={from_address:wallet(90),name:'Binance: Hot Wallet 10'};const r=evaluateTokenRisk(TOKEN,exchange);assert.equal(r.state,'screened');assert.deepEqual(r.metrics.linkedFunding,[]);
});
test('the token contract remains in float but is excluded from ordinary-wallet and common-funding concentration',()=>{
 const d=evidence();d.holders.list=d.holders.list.slice(0,21);d.holders.list.push({address:TOKEN,amount_percentage:.10,addr_type:2,maker_token_tags:[],native_transfer:{from_address:CREATOR}});
 const r=evaluateTokenRisk(TOKEN,d);assert.equal(r.metrics.poolSupplyShare,.5);assert.equal(r.metrics.tradeableFloatShare,.5);assert.ok(r.metrics.largestObservedFloatShare<.1);assert.equal(r.state,'screened');
});
test('entry checks enforce age, price coherence and depth; concurrent refreshes share one read-only collection',async t=>{
 let now=1000000,calls=0;const d=evidence(),source={async info(){calls++;return d.info;},async holders(){calls++;return d.holders;},async security(){calls++;return d.security;},close(){}};
 const {guard}=fixture(t,{source,now:()=>now});await Promise.all([guard.refresh(TOKEN),guard.refresh(TOKEN)]);assert.equal(calls,3);
 await guard.assertBuy(TOKEN,{sizeUsd:150,marketPrice:1});assert.equal(calls,3);
 await assert.rejects(guard.assertBuy(TOKEN,{sizeUsd:150,marketPrice:2,refresh:false}),/价格偏差/);
 await assert.rejects(guard.assertBuy(TOKEN,{sizeUsd:1001,marketPrice:1,refresh:false}),/流动性的1%/);
 now+=RISK_POLICY.maxAgeMs+1;await assert.rejects(guard.assertBuy(TOKEN,{sizeUsd:150,marketPrice:1,refresh:false}),/已过期/);
});
test('read failures record unknown risk without leaking provider diagnostics or claiming absent tags are safe',async t=>{
 const {guard,store}=fixture(t,{source:{async info(){throw Error('sensitive-provider-diagnostic');},close(){}}});const r=await guard.refresh(TOKEN);assert.equal(r.buyAllowed,false);assert.equal(r.state,'unknown');assert.doesNotMatch(JSON.stringify(store.get('token-risk-reports',TOKEN)),/sensitive-provider-diagnostic/);
});
