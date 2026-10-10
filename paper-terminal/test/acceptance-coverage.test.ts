import test from 'node:test';
import assert from 'node:assert/strict';
import {assessMarketCoverage} from '../src/server/market-coverage.js';
const row=(id:number,at:number,details:Record<string,unknown>)=>({id,at,kind:'gap',details:JSON.stringify(details)});
test('fresh heads and a reconciled empty book cannot hide live proof-queue losses',()=>{
 const checked=assessMarketCoverage([row(7,10001,{id:'gap:proof:bsc:tx:1',chain:'bsc',payload:{reason:'实时回执队列溢出，丢弃的成交不能用于连续覆盖'}})],10000);
 assert.equal(checked.passed,false);assert.equal(checked.losses.length,1);assert.equal(checked.issues[0].key,'bsc:proof-overflow');assert.equal(checked.ignoredStartupRecovery.length,0);
});
test('only explicit initial cursor recovery is excluded; later replayed holes still fail coverage',()=>{
 const details={chain:'robinhood',replayed:true,payload:{reason:'缺口超过 256 区块，仅回放最近区块，期间交易状态未知'}};
 const checked=assessMarketCoverage([row(1,15000,details),row(2,25001,details)],10000);
 assert.equal(checked.passed,false);assert.equal(checked.ignoredStartupRecovery.length,1);assert.deepEqual(checked.losses.map(r=>r.id),[2]);
});
test('backward wall timestamps and malformed records cannot erase market gaps selected by audit ID',()=>{
 const checked=assessMarketCoverage([row(3,9999,{chain:'bsc',replayed:true,payload:{reason:'缺口超过 64 区块'}}),{id:4,at:11000,kind:'gap',details:'broken-json'}],10000);
 assert.equal(checked.passed,false);assert.deepEqual(checked.losses.map(r=>r.id),[3,4]);assert.equal(checked.ignoredStartupRecovery.length,0);
});
test('known overflow issue groups are stable as more unique lost events accumulate',()=>{
 const checked=assessMarketCoverage([row(8,20000,{id:'gap:proof:tx1',chain:'bsc'}),row(9,21000,{id:'gap:proof:tx2',chain:'bsc'})],10000);
 assert.equal(checked.issues.length,1);assert.equal(checked.issues[0].count,2);assert.equal(assessMarketCoverage([],10000).passed,true);
});

test('failed live receipt proofs invalidate coverage even without a queue overflow',()=>{
 const checked=assessMarketCoverage([{id:10,at:10001,kind:'gateway',message:'BSC 实时事件核验失败',details:{id:'bsc:hash:tx:1',replayed:false,reason:'foreground 只读核验超过5秒预算'}},{id:11,at:10002,kind:'gateway',message:'Robinhood 实时事件核验失败',details:{id:'robinhood:hash:tx:2',replayed:false,reason:'区块不可用'}}],10000);
 assert.equal(checked.passed,false);assert.deepEqual(checked.issues.map(r=>r.key),['bsc:proof-failure','robinhood:proof-failure']);assert.equal(checked.ignoredStartupRecovery.length,0);
});

test('historical proof errors and unrelated market or quote rejections do not pretend to be live coverage loss',()=>{
 const checked=assessMarketCoverage([{id:12,at:50000,kind:'gateway',message:'BSC 实时事件核验失败',details:{replayed:true,reason:'historical timeout'}},{id:13,at:50001,kind:'gateway',message:'手动报价失败',details:{replayed:false,reason:'unsupported token'}},{id:14,at:50002,kind:'gateway',message:'Robinhood 实时事件核验失败',details:{reason:'unknown replay status'}}],10000);
 assert.equal(checked.passed,true);assert.equal(checked.losses.length,0);
});
