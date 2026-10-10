import test from 'node:test';
import assert from 'node:assert/strict';
import {ExitStudy,EXIT_VARIANTS,studyAction,studyMetrics} from './exit-study.mjs';
const token='0x'+'1'.repeat(40),recipient='0x'+'2'.repeat(40);
function fixture(){
 let now=100000,mono=100000,head=10,price=1,quality='verified',feeQuality='estimated',partial=false,broken=false;
 const meta=new Map(),audit=[],fills=[],orders=[],calls=[];
 const store={meta:k=>meta.get(k),setMeta:(k,v)=>meta.set(k,structuredClone(v)),audit:(...a)=>audit.push(a)};
 const broker={stopped:false,activeSubmissions:0,inFlight:new Set(),fills:()=>fills,orders:()=>orders,recipient:()=>recipient,
  fresh:()=>({head,headAt:now,connected:true}),getQuote:async(_id,q)=>{calls.push(q);if(broken)throw Error('共享行情断开');return {id:'quote-'+calls.length,at:now,block:q.block,inputRaw:q.tokenAmountRaw,spentInputRaw:partial?'50':q.tokenAmountRaw,outputRaw:String(BigInt(Math.round(Number(q.tokenAmountRaw)*price*1e16))),priceUsd:price,nativeUsd:1,quality,fees:{quality:feeQuality,gasUsd:.01,approvalUsd:.02,protocolUsd:0,taxUsd:0,conversionUsd:0}};}};
 const study=new ExitStudy(store,broker,()=>now,()=>mono);
 const add=(id='entry-1',chain='robinhood',usd=40)=>{const orderId='order-'+id;orders.push({id:orderId,fillQuote:{id:'entry-quote-'+id,tokenDecimals:0}});fills.push({id,orderId,accountId:'trial-'+chain+'-momentum',chain,token,side:'buy',at:now,block:head,tokenRaw:'100',priceUsd:1,usd,fees:{gasUsd:.01,approvalUsd:0,protocolUsd:.02,taxUsd:0,conversionUsd:0}});};
 return {store,broker,study,add,audit,calls,set:(o)=>{if(o.now!==undefined)now=o.now;if(o.mono!==undefined)mono=o.mono;if(o.head!==undefined)head=o.head;if(o.price!==undefined)price=o.price;if(o.quality!==undefined)quality=o.quality;if(o.feeQuality!==undefined)feeQuality=o.feeQuality;if(o.partial!==undefined)partial=o.partial;if(o.broken!==undefined)broken=o.broken;}};
}
test('all exit variants mirror the same actual simulated entry once, with independent chain budgets',()=>{
 const f=fixture();for(let i=0;i<3;i++)f.add('r-'+i);f.study.captureEntries();f.study.captureEntries();assert.equal(f.study.data.groups.length,3);
 assert.ok(f.study.data.groups.every(g=>g.cases.every(c=>c.costUsd===40&&c.originalRaw==='100'&&c.feesUsd===.03)));
 f.add('r-over');f.add('b-0','bsc');f.study.captureEntries();assert.equal(f.study.data.groups.length,4);assert.match(f.audit.find(a=>a[1].includes('共同跳过'))[1],/资金或持仓/);
});
test('execution checks are excluded from profitability and exit-parameter comparisons',()=>{
 const f=fixture();f.add();f.broker.fills()[0].accountId='trial-robinhood-check';f.study.captureEntries();assert.equal(f.study.data.groups.length,0);
});
test('a triggered stop waits for 500 real milliseconds AND a later observed block',async()=>{
 const f=fixture();f.add();f.set({price:.8});await f.study.tick();assert.equal(f.study.data.groups[0].cases[0].remainingRaw,'100');
 f.set({now:100600,mono:100100,head:11});await f.study.tick();assert.ok(f.study.data.groups[0].cases.every(c=>!c.closedAt));
 f.set({mono:100600,head:10});await f.study.tick();assert.ok(f.study.data.groups[0].cases.every(c=>!c.closedAt));
 f.set({head:11});await f.study.tick();const group=f.study.data.groups[0];assert.ok(group.cases.every(c=>c.closedAt===100600&&c.remainingRaw==='0'));
 assert.ok(group.cases.every(c=>Math.abs(c.profitUsd-(.8-.03-40))<1e-10));assert.equal(f.study.state('robinhood').pairedCount,1);
 assert.ok(f.calls.every(q=>q.side==='sell'));
});
test('unavailable, partial or disconnected exit quotes never become fills',async()=>{
 for(const change of [{quality:'unavailable'},{feeQuality:'unavailable'},{partial:true},{broken:true}]){
  const f=fixture();f.add();f.set({price:.8,...change});await f.study.tick();f.set({now:101000,mono:101000,head:11});await f.study.tick();
  assert.ok(f.study.data.groups[0].cases.every(c=>!c.closedAt&&c.remainingRaw==='100'&&c.proceedsUsd===0));
 }
});
test('a failed exit models quoted Gas and approval without inventing sold tokens',async()=>{
 const f=fixture();f.add();f.set({price:.8});await f.study.tick();f.set({now:101000,mono:101000,head:11,price:.5});await f.study.tick();
 assert.ok(f.study.data.groups[0].cases.every(c=>c.remainingRaw==='100'&&!c.closedAt&&c.proceedsUsd===-.03&&c.exits[0].failed));
});
test('restart and data gaps cancel prepared exits and preserve remaining quantities',async()=>{
 const f=fixture();f.add();f.set({price:.8});await f.study.tick();f.study.onGap('bsc');assert.ok(f.study.data.groups[0].cases.every(c=>c.pending));
 const reopened=new ExitStudy(f.store,f.broker,()=>101000,()=>101000);assert.ok(reopened.data.groups[0].cases.every(c=>!c.pending&&c.remainingRaw==='100'));
 f.study.onGap('robinhood');assert.ok(f.study.data.groups[0].cases.every(c=>!c.pending));
});
test('take profit sells half the original units then uses its own trailing exit',async()=>{
 const f=fixture();f.add();f.set({price:1.6});await f.study.tick();f.set({now:101000,mono:101000,head:11});await f.study.tick();
 assert.ok(f.study.data.groups[0].cases.every(c=>c.remainingRaw==='50'&&c.targetDone&&!c.closedAt));
 f.set({now:102000,mono:102000,head:12,price:1.2});await f.study.tick();assert.ok(f.study.data.groups[0].cases.every(c=>c.pending.all));
 f.set({now:103000,mono:103000,head:13});await f.study.tick();assert.ok(f.study.data.groups[0].cases.every(c=>c.remainingRaw==='0'&&c.closedAt));
 const c=f.study.data.groups[0].cases[0];assert.ok(Math.abs(c.proceedsUsd-(.8-.03+.6-.01))<1e-10);
});
test('comparison excludes unfinished matched entries and requires a diversified minimum sample',()=>{
 const group=(i,closed=true)=>({token:'token-'+i%5,cases:EXIT_VARIANTS.map((v,j)=>({variantId:v.id,closedAt:closed||j===0?1000+i:null,profitUsd:3-j,costUsd:40,feesUsd:.1}))});
 const result=studyMetrics([group(0,false),group(1)]);assert.equal(result.pairedCount,1);assert.ok(result.rows.every(r=>r.count===1));assert.equal(result.candidate,null);
 const ready=studyMetrics(Array.from({length:20},(_,i)=>group(i)));assert.equal(ready.candidate,'tight');assert.match(ready.conclusion,/后续新样本/);
 const rule=EXIT_VARIANTS[0],c={entryPriceUsd:1,peakPriceUsd:1,originalRaw:'100',remainingRaw:'100',openedAt:0,targetDone:false};
 assert.equal(studyAction(c,rule,1,600000).all,true);
});
