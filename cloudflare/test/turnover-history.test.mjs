import test from 'node:test';
import assert from 'node:assert/strict';
import {readTurnoverHistory} from '../turnover-history.mjs';
import {IOBudget} from '../io-budget.mjs';
function fixture(){
 let now=1800000000000,head=5000,fork='canonical',refuse=false;const base=now-head*450,rows=new Map(),queries=[];
 const store={get:(k,id)=>rows.get(k+id),put:(k,v)=>rows.set(k+v.id,structuredClone(v))};
 const rpc={block:async n=>({number:n??head,time:base+(n??head)*450,hash:fork+':'+(n??head)}),async request(_method,[p]){const from=Number(BigInt(p.fromBlock)),to=Number(BigInt(p.toBlock));queries.push({from,to});if(refuse&&to<4996)throw Object.assign(Error('HTTP 403'),{rpcUnavailable:true});return [1000,2000].filter(n=>n>=from&&n<=to).map(n=>({block:n,quoteRaw:600n*10n**18n}));}};
 const reader={store,rpc,now:()=>now},parse=logs=>({quoteRaw:logs.reduce((n,l)=>n+l.quoteRaw,0n),buys:logs.length,sells:0});
 return {reader,queries,read:()=>readTurnoverHistory(reader,'pool',{number:head},false,1,'topic',parse),advance(ms){now+=ms;head+=Math.floor(ms/450);},fork(){fork='fork';},refuse(){refuse=true;},now:()=>now};
}
test('Confirmed turnover accumulates disjoint backfill across rounds without duplicate counts or refreshing a cached timestamp',async()=>{
 const f=fixture(),first=await f.read();assert.equal(first.quoteRaw,String(600n*10n**18n));assert.equal(f.queries.length,3);assert.equal(first.latestSample.toBlock,first.toBlock);assert.equal(first.latestSample.buys,0,'Backfilled historic buys cannot become recent buying pressure');const cached=await f.read();assert.equal(cached.at,first.at);assert.equal(f.queries.length,3);
 f.advance(61000);const next=await f.read();assert.equal(next.quoteRaw,String(1200n*10n**18n));assert.equal(next.buys,2);assert.ok(next.fromBlock<first.fromBlock);assert.ok(next.at>first.at);assert.ok(f.queries.length<=6);const again=await f.read();assert.equal(again.quoteRaw,next.quoteRaw);assert.equal(again.at,next.at);
 for(let i=0;i<f.queries.length;i++)for(let j=i+1;j<f.queries.length;j++){const a=f.queries[i],b=f.queries[j];assert.ok(a.to<b.from||b.to<a.from,'No overlapping event totals are added twice');}
});
test('Forks discard old confirmed totals and observations older than 24h cannot satisfy the volume floor',async()=>{
 const f=fixture();await f.read();f.advance(61000);await f.read();f.fork();const reset=await f.read();assert.equal(reset.quoteRaw,'0');
 f.advance(86401000);const aged=await f.read();assert.equal(aged.quoteRaw,'0');assert.ok(f.now()-aged.fromTime<86400000);
});
test('Unavailable history retains a partial floor, honors backfill cooldown, and cannot hide malformed data as an outage',async()=>{
 const f=fixture();f.refuse();const r=await f.read();assert.equal(r.quoteRaw,'0');const past=f.queries.filter(q=>q.to<4996).length;f.advance(61000);await f.read();assert.equal(f.queries.filter(q=>q.to<4996).length,past);
 const bad=fixture();await assert.rejects(readTurnoverHistory(bad.reader,'pool',{number:5000},false,1,'topic',()=>{throw Error('wrong pool');}),/wrong pool/);
});
test('Local budget exhaustion preserves completed historical reads for a new round without manufacturing a fresh report',async()=>{
 const f=fixture(),io=new IOBudget(1,async()=>Response.json({})),request=f.reader.rpc.request;
 f.reader.rpc.request=async(...args)=>{await io.fetch('https://rpc.example');return request(...args);};
 await assert.rejects(io.run('alarm',()=>f.read()),{code:'CF_SUBREQUEST_BUDGET'});assert.equal(io.lastAlarm.used,1);assert.equal(f.queries.length,1);assert.equal(f.reader.store.get('cloud-public-cache','meme-turnover:pool'),undefined);
 await assert.rejects(io.run('alarm',()=>f.read()),{code:'CF_SUBREQUEST_BUDGET'});assert.equal(f.queries.length,2);assert.equal(f.reader.store.get('cloud-public-cache','meme-turnover:pool'),undefined);
 await assert.rejects(io.run('alarm',()=>f.read()),{code:'CF_SUBREQUEST_BUDGET'});assert.equal(f.queries.length,3);
 const completed=await io.run('alarm',()=>f.read());assert.equal(completed.quoteRaw,String(1200n*10n**18n));assert.equal(io.lastAlarm.used,1);
});
