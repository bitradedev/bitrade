import test from 'node:test';import assert from 'node:assert/strict';
import {RpcScheduler} from '../src/server/adapters/scheduler.js';

test('one chain cooldown cannot expire another chain head or foreground quote',async()=>{
 const scheduler=new RpcScheduler(2),limited={},healthy={},order:string[]=[];scheduler.pause(80,limited);
 const a=scheduler.schedule(limited,'head',async()=>{order.push('limited');return 1;});
 const b=scheduler.schedule(healthy,'head',async()=>{order.push('healthy-head');return 2;});const c=scheduler.schedule(healthy,'foreground',async()=>{order.push('healthy-quote');return 3;});
 assert.deepEqual(await Promise.all([b,c]),[2,3]);assert.deepEqual(order,['healthy-head','healthy-quote']);assert.equal(scheduler.stats().backoffQueued,1);await a;assert.equal(order.at(-1),'limited');assert.equal(scheduler.stats().active,0);
});
test('same-chain cooldown remains respected when priority is raised',async()=>{
 const scheduler=new RpcScheduler(2),owner={},order:string[]=[];scheduler.pause(45,owner);const a=scheduler.schedule(owner,'background',async()=>{order.push('sent');return 1;});scheduler.promote(a,'foreground');await new Promise(r=>setTimeout(r,10));assert.deepEqual(order,[]);assert.equal(scheduler.stats().backoffQueued,1);assert.equal(await a,1);
});
test('cooldown expiry does not resurrect an already expired or cancelled request',async()=>{
 const scheduler=new RpcScheduler(2),a={},b={};let sends=0;scheduler.pause(70,a);scheduler.pause(70,b);const expired=assert.rejects(scheduler.schedule(a,'head',async()=>{sends++;},performance.now()+15),/时限|过期/);const pending=scheduler.schedule(b,'foreground',async()=>{sends++;});const cancelled=assert.rejects(pending,/停止/);scheduler.cancel(b);await Promise.all([expired,cancelled]);await new Promise(r=>setTimeout(r,80));assert.equal(sends,0);assert.equal(scheduler.stats().queued,0);
});
test('an explicitly global pause still holds every owner without changing the shared pace',async()=>{
 const scheduler=new RpcScheduler(5),order:string[]=[];scheduler.pause(35);const a=scheduler.schedule({},'head',async()=>{order.push('a');}),b=scheduler.schedule({},'foreground',async()=>{order.push('b');});await new Promise(r=>setTimeout(r,10));assert.deepEqual(order,[]);await Promise.all([a,b]);assert.deepEqual(order,['a','b']);assert.equal(scheduler.stats().intervalMs,5);
});
