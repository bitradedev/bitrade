import test from 'node:test';
import assert from 'node:assert/strict';
import {SignalInbox} from './signal-inbox.mjs';
const event={id:'a',chain:'robinhood',kind:'trade',token:'token',at:1000,payload:{verified:true}};
test('an event arriving before its shared snapshot can be retried within the same immutable deadline',()=>{
 const box=new SignalInbox();assert.equal(box.offer(event,{stage:'curve'},1100),true);
 assert.deepEqual(box.due(1100),[event]);assert.deepEqual(box.due(1200),[]);assert.deepEqual(box.due(3100),[event]);
 assert.deepEqual(box.due(31000),[]);assert.equal(box.items.size,0);
});
test('completed, replayed, overflowing and invalidated signals cannot cause repeated entries',()=>{
 const box=new SignalInbox(2);assert.equal(box.offer({...event,replayed:true},{stage:'curve'},1100),false);
 box.offer(event,{stage:'curve'},1100);box.complete(event);assert.equal(box.items.size,0);
 for(let i=0;i<3;i++)box.offer({...event,id:String(i),token:String(i)},{stage:'curve'},1100);
 assert.equal(box.items.size,2);box.reset('bsc');assert.equal(box.items.size,2);box.reset('robinhood');assert.equal(box.items.size,0);
});
