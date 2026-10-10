import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveWorkQueue} from '../src/server/live-work-queue.js';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
test('log fetching can advance while a slow proof is blocked, with live FIFO ahead of history',async()=>{
 const gate=deferred(),done=deferred(),ran:string[]=[];const q=new LiveWorkQueue(e=>{throw e;},()=>{});
 q.add({id:'slow',replayed:true,run:async()=>{await gate.promise;ran.push('slow');}});
 q.add({id:'history',replayed:true,run:async()=>{ran.push('history');done.resolve();}});
 q.add({id:'live-1',replayed:false,run:async()=>{ran.push('live-1');}});
 q.add({id:'live-2',replayed:false,run:async()=>{ran.push('live-2');}});
 q.add({id:'live-1',replayed:false,run:async()=>{ran.push('duplicate');}});
 assert.equal(q.pending,3);gate.resolve();await done.promise;assert.deepEqual(ran,['slow','live-1','live-2','history']);q.close();
});
test('overflow prefers dropping history, reports lost live work, and errors do not stop the queue',async()=>{
 const gate=deferred(),done=deferred(),drops:string[]=[],errors:unknown[]=[],ran:string[]=[];const q=new LiveWorkQueue(e=>errors.push(e),j=>drops.push(j.id),2);
 q.add({id:'slow',replayed:true,run:()=>gate.promise});
 q.add({id:'history',replayed:true,run:async()=>{ran.push('history');}});
 q.add({id:'live-1',replayed:false,run:async()=>{ran.push('lost');}});
 q.add({id:'live-2',replayed:false,run:async()=>{throw Error('unverified');}});
 q.add({id:'live-3',replayed:false,run:async()=>{ran.push('live-3');done.resolve();}});
 assert.deepEqual(drops,['history','live-1']);assert.equal(q.pending,2);gate.resolve();await done.promise;assert.equal(errors.length,1);assert.deepEqual(ran,['live-3']);q.close();
});
test('closing cancels queued work while an already running read completes',async()=>{
 const gate=deferred(),done=deferred();let touched=false;const q=new LiveWorkQueue(()=>{},()=>{});
 q.add({id:'read',replayed:false,run:async()=>{await gate.promise;done.resolve();}});
 q.add({id:'later',replayed:false,run:async()=>{touched=true;}});q.close();gate.resolve();await done.promise;assert.equal(q.pending,0);assert.equal(touched,false);
});
