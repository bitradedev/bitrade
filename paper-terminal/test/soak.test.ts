import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../src/server/store.js';
import {Engine} from '../src/server/engine.js';
import type {MarketGateway,Chain} from '../src/shared/domain.js';

// Injected clocks test the decision; these fixtures are not live acceptance.
function fixture(){
 const dir=resolve('data/test-runs');mkdirSync(dir,{recursive:true});const store=new Store(mkdtempSync(resolve(dir,'soak-'))),time={wall:Date.now(),mono:0};
 const gateway={statuses:()=>['bsc','robinhood'].map(chain=>({chain:chain as Chain,connected:true,head:100,headAt:time.wall,chainTime:time.wall,gaps:0,reconnects:0,lastError:'',source:'isolated clock fixture'})),markets:()=>[],getMarket:()=>undefined} as unknown as MarketGateway;
 const engine=new Engine(store,gateway,{wall:()=>time.wall,monotonic:()=>time.mono});engine.codeHash='clock-test';
 const advance=(ms:number)=>{time.wall+=ms;time.mono+=ms;engine.healthSample();};return {store,engine,time,advance,report:()=>store.meta<any>('soak')};
}
test('1440 observations at 23h59 cannot pass; a completed measured 24-hour record stays immutable',()=>{const f=fixture();try{f.engine.healthSample();for(let i=0;i<1439;i++)f.advance(60000);assert.equal(f.report().samples,1440);assert.equal(f.report().elapsedMs,86340000);assert.equal(f.report().status,'running');f.advance(60000);assert.equal(f.report().elapsedMs,86400000);assert.equal(f.report().status,'passed');assert.equal(f.report().timingSource,'process-monotonic');const completed=f.report();f.advance(935000);assert.deepEqual(f.report(),completed);}finally{f.store.close();}});
test('wall clock corrections cannot invent elapsed time, samples, or restore a passing report',()=>{const f=fixture();try{f.engine.healthSample();f.time.wall+=935000;f.time.mono+=60000;f.engine.healthSample();assert.equal(f.report().elapsedMs,60000);assert.equal(f.report().samples,2);assert.equal(f.report().gaps,1);assert.equal(f.report().clockChanges,1);const gap=f.store.auditRows(10).find(r=>r.kind==='soak_gap')!;assert.equal((gap.details as any).monotonicGapMs,60000);assert.equal((gap.details as any).clockShiftMs,875000);const forged={...f.report(),samples:1440,elapsedMs:86400000,status:'passed'};f.store.setMeta('soak',forged);f.engine.healthSample();assert.equal(f.report().status,'running');assert.equal(f.report().samples,2);f.time.wall-=935000;f.time.mono+=60000;f.engine.healthSample();assert.equal(f.report().clockChanges,2);assert.equal(f.report().status,'running');}finally{f.store.close();}});
test('an actual sampling pause retains the gap and does not backfill missed minutes',()=>{const f=fixture();try{f.engine.healthSample();f.advance(60000);f.advance(935000);assert.equal(f.report().samples,3);assert.equal(f.report().gaps,1);assert.equal(f.report().clockChanges,0);assert.equal(f.report().elapsedMs,995000);assert.equal(f.report().status,'running');}finally{f.store.close();}});
test('repeated checks in the same measured minute count once and clock gaps invalidate research coverage',()=>{const f=fixture();try{f.engine.healthSample();for(let i=0;i<2000;i++)f.engine.healthSample();assert.equal(f.report().samples,1);const tape={strategyId:'bsc-wallet-short',start:f.time.wall,lastBlock:100,sample:{id:'clock-gap-tape',source:'authoritative',chain:'bsc',reason:'isolated',later:[]}};(f.engine as any).tapes.set('clock-gap-tape',tape);f.time.wall+=935000;f.time.mono+=60000;f.engine.healthSample();assert.equal(tape.sample.source,'estimated');assert.equal(tape.sample.later.length,1);assert.equal(f.store.samples(tape.strategyId)[0].source,'estimated');assert.equal(f.store.meta('lastGap:bsc'),f.time.wall);assert.equal(f.store.meta('lastGap:robinhood'),f.time.wall);}finally{f.store.close();}});
test('a changed build archives prior timing evidence and starts its own measured run',()=>{const f=fixture();try{f.engine.healthSample();f.advance(60000);const old=f.report();f.engine.codeHash='changed-code';f.engine.healthSample();assert.equal(f.report().samples,1);assert.equal(f.report().elapsedMs,0);assert.equal(f.report().codeHash,'changed-code');const archive=f.store.evidence('soak');assert.equal(archive[0].codeHash,old.codeHash);assert.equal(archive[0].samples,2);assert.equal(archive[0].status,'interrupted');}finally{f.store.close();}});
test('a failed ledger check between minute samples is retained without creating an extra minute',()=>{const f=fixture();try{f.engine.healthSample();f.engine.broker.checks=()=>({passed:false,errors:['isolated ledger failure'],ledger:[]});f.engine.healthSample();assert.equal(f.report().samples,1);assert.equal(f.report().ledgerFailures,1);assert.equal(f.store.auditRows(1)[0].kind,'ledger_failure');}finally{f.store.close();}});

test('same-runtime restore at 23h59 starts a new measured baseline before completion and cannot pass one minute later',async()=>{
 const f=fixture();try{
  f.engine.healthSample();const original=f.report(),backup=f.store.backup();
  for(let i=0;i<1439;i++)f.advance(60000);
  assert.equal(f.report().elapsedMs,86340000);assert.equal(f.report().samples,1440);assert.equal(f.report().status,'running');
  await f.engine.restore(backup);
  const reset=f.report();assert.equal(reset.runtimeId,original.runtimeId,'the regression must restore within the same process');assert.equal(reset.codeHash,original.codeHash);assert.equal(reset.startedAt,f.time.wall);assert.notEqual(reset.startedAt,original.startedAt);
  assert.equal(reset.elapsedMs,0,'restore must publish a fresh measured baseline before its promise resolves');assert.equal(reset.samples,1);assert.equal(reset.status,'running');assert.equal(reset.completedAt,null);assert.deepEqual(reset.connectedSamples,{bsc:1,robinhood:1});assert.equal(f.engine.broker.checks().passed,true);
  f.advance(60000);assert.equal(f.report().startedAt,reset.startedAt);assert.equal(f.report().elapsedMs,60000);assert.equal(f.report().samples,2);assert.equal(f.report().status,'running');assert.equal(f.report().completedAt,null);
 }finally{f.store.close();}
});

test('failed restore preserves the active measured proof and its original minute baseline',async()=>{
 const f=fixture();try{
  f.engine.healthSample();f.advance(60000);const before=f.report(),archives=f.store.evidence('soak');
  await assert.rejects(()=>f.engine.restore(Buffer.from('isolated invalid SQLite backup')));
  assert.deepEqual(f.report(),before);assert.deepEqual(f.store.evidence('soak'),archives);assert.equal(f.engine.broker.stopped,false);assert.equal(f.engine.broker.checks().passed,true);
  f.engine.healthSample();assert.deepEqual(f.report(),before,'a failed restore cannot reset the private counters on the next health sample');
  f.advance(60000);assert.equal(f.report().startedAt,before.startedAt);assert.equal(f.report().elapsedMs,120000);assert.equal(f.report().samples,3);assert.equal(f.report().status,'running');
 }finally{f.store.close();}
});
test('restoring a same-process backup at 23h59 starts fresh timing and retains pre-restore evidence',async()=>{const f=fixture();try{f.engine.healthSample();const backup=f.store.backup();for(let i=0;i<1439;i++)f.advance(60000);assert.equal(f.report().samples,1440);await f.engine.restore(backup);assert.equal(f.report().elapsedMs,0);assert.equal(f.report().samples,1);assert.equal(f.report().status,'running');assert.ok(f.store.evidence('soak').some(r=>r.samples===1440&&r.status==='interrupted'));f.advance(60000);assert.equal(f.report().elapsedMs,60000);assert.equal(f.report().samples,2);assert.equal(f.report().status,'running');}finally{f.store.close();}});
test('a rejected backup leaves current measured timing and counters intact',async()=>{const f=fixture();try{f.engine.healthSample();f.advance(60000);const before=f.report();await assert.rejects(()=>f.engine.restore(Buffer.from('invalid isolated backup')));assert.deepEqual(f.report(),before);f.advance(60000);assert.equal(f.report().elapsedMs,120000);assert.equal(f.report().samples,3);}finally{f.store.close();}});
