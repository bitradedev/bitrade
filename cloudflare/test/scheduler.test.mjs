import test from 'node:test';
import assert from 'node:assert/strict';
import {runScheduledRound} from '../scheduler.mjs';
import {IOBudget} from '../io-budget.mjs';

test('a delayed model cannot hold the next market, exit or matching alarm; background I/O stays in its original budget',async()=>{
 let release,started,quotes=0,watched=0,modelCalls=0,queued=false;
 const ready=new Promise(r=>release=r),begin=new Promise(r=>started=r),kept=[];
 const io=new IOBudget(5,async()=>Response.json({})),rows=new Map();
 const host={io,working:null,decisionTask:null,importing:false,ctx:{storage:{async setAlarm(){}},waitUntil:task=>kept.push(task)},store:{all:()=>[],put:(kind,v)=>rows.set(kind+v.id,v),prune(){}},arm:async()=>{}};
 const app={paper:{orders:()=>queued?[{status:'queued'}]:[],async tick(){queued=false;}},showcase:{freshMarkets:()=>[],async watchExits(){watched++;await io.fetch('https://exit.example');queued=true;},async tick(){modelCalls++;await io.fetch('https://model.example');started();await ready;await io.fetch('https://after-model.example');}}};
 host.app=app;host.initialize=async()=>app;host.risk={tick(){},task:null};host.market={async refresh(){quotes++;await io.fetch('https://price.example');},async pulse(){await io.fetch('https://pulse.example');},async updateHead(){await io.fetch('https://head.example');},async fx(){await io.fetch('https://fx.example');}};
 const round=()=>io.run('alarm',()=>runScheduledRound(host));
 const first=round();await begin;let timer;
 const completed=await Promise.race([first.then(()=>true),new Promise(r=>timer=setTimeout(()=>r(false),40))]);clearTimeout(timer);
 try{
  if(completed){await round();assert.equal(watched,1);assert.equal(queued,true);await round();assert.equal(queued,false);assert.equal(rows.get('cloud-settingsscheduler').phase,'matching');}
 }finally{release();await first;await Promise.all(kept);}
 assert.equal(completed,true,'the first alarm must finish before the model response');assert.equal(quotes,2);assert.equal(modelCalls,1);
 assert.equal(io.lastDecision.used,4);assert.equal(io.lastDecision.limit,5);assert.equal(io.lastAlarm.used,2);assert.equal(host.decisionTask,null);
});

test('a completed alarm cannot renew the remaining budget of its waiting decision',async()=>{
 let release;const ready=new Promise(r=>release=r),calls=[],io=new IOBudget(3,async url=>{calls.push(url);return Response.json({});});
 let task;
 await io.run('alarm',async()=>{
  await io.fetch('https://original.example/1');await io.fetch('https://original.example/2');
  task=io.trackDecision((async()=>{await ready;await io.fetch('https://original.example/3');await io.fetch('https://original.example/rejected');})());
 });
 const rejected=assert.rejects(task,{code:'CF_SUBREQUEST_BUDGET'});
 await io.run('alarm',async()=>{await io.fetch('https://new.example/1');});
 release();await rejected;
 assert.deepEqual(calls,['https://original.example/1','https://original.example/2','https://new.example/1','https://original.example/3']);
 assert.equal(io.lastDecision.used,3);assert.equal(io.lastAlarm.used,1);assert.ok(io.lastDecision.completedAt);
});
