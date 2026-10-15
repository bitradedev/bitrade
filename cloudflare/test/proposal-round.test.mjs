import test from 'node:test';
import assert from 'node:assert/strict';
import {IOBudget} from '../io-budget.mjs';
import {runScheduledRound} from '../scheduler.mjs';
import {marketRuntime} from '../market-runtime.mjs';
import {runProposalRound} from '../proposal-round.mjs';

test('VPS direct intents retain their key and deadline across budget or stale-evidence continuation and cannot submit invalid evidence',async()=>{
 for(const outcome of ['blocked','unknown','stale','budget','changed']){
  const io=new IOBudget(128),rows=new Map();let submitted=0,rejected=0,checks=0,busy=true;
  const proposal={id:'showcase-trend',agentId:'showcase-trend',state:'pending',stage:'execute',createdAt:Date.now(),expiresAt:Date.now()+300000,requestKey:'same-intent',decision:{action:'buy',token:'0x'+'11'.repeat(20)}};
  const app={showcase:{validateProposal(){return outcome!=='changed'||++checks===1;},executeProposal(){submitted++;},rejectProposal(){rejected++;}}};
  const host={io,marketPolicy:marketRuntime({BI_TRADE_SELF_HOSTED:'true'}),store:{put(k,v){rows.set(k,structuredClone(v));}},market:{async updateHead(){},async fx(){},async refresh(){},getMarket:()=>({quality:'verified',updatedAt:Date.now()})},risk:{async refresh(){if(outcome==='budget'&&busy)for(let i=0;i<81;i++)await io.fetch('data:,');return {buyAllowed:!['blocked','unknown'].includes(outcome),fetchedAt:Date.now()-(outcome==='stale'?121000:0)};}}};
  await io.run('alarm',()=>runProposalRound(host,app,proposal));assert.equal(submitted,0);
  assert.equal(rejected,['blocked','unknown'].includes(outcome)?1:0);
  if(['budget','stale'].includes(outcome)){
   const next=rows.get('showcase-proposals');assert.equal(next.requestKey,proposal.requestKey);assert.equal(next.createdAt,proposal.createdAt);assert.equal(next.expiresAt,proposal.expiresAt);
   assert.equal(next.stage,outcome==='stale'?'risk':'execute');
   if(outcome==='budget'){busy=false;await io.run('alarm',()=>runProposalRound(host,app,next));assert.equal(submitted,1);}
  }
 }
});

test('VPS buys and sells reach guarded order preparation in one fresh round, including a stale prior risk snapshot',async()=>{
 for(const stage of ['evidence','risk','execute'])for(const side of ['buy','sell']){
  const rows=new Map(),io=new IOBudget(128,async()=>Response.json({})),calls=[];
  let proposal={id:'showcase-trend',agentId:'showcase-trend',state:'pending',stage,decision:{action:side,token:'0x'+'11'.repeat(20)}};
  const store={all:()=>[],get:(k,id)=>rows.get(k+id),put:(k,v)=>{rows.set(k+v.id,structuredClone(v));if(k==='showcase-proposals')proposal=structuredClone(v);}};
  const app={paper:{orders:()=>[]},showcase:{pendingProposal:()=>proposal.state==='pending'?proposal:null,validateProposal:()=>true,async executeProposal(p){calls.push('execute');await io.fetch('https://quote.example');store.put('showcase-proposals',{...p,state:'submitted'});},rejectProposal(){assert.fail('Old risk age must trigger refresh, not immediate rejection');}}};
  const host={io,store,marketPolicy:marketRuntime({BI_TRADE_SELF_HOSTED:'true'}),initialize:async()=>app,arm:async()=>{},ctx:{storage:{async setAlarm(){}},waitUntil(){}},market:{async updateHead(){},async fx(){},async refresh(_t,o){assert.equal(o.onlyRequested,true);calls.push('market');await io.fetch('https://market.example');},getMarket:()=>({quality:'verified',updatedAt:Date.now()})},risk:{snapshot:()=>({buyAllowed:false,fetchedAt:Date.now()-121000}),async refresh(){calls.push('risk');await io.fetch('https://risk.example');return {buyAllowed:true,fetchedAt:Date.now()};}}};
  await io.run('alarm',()=>runScheduledRound(host));assert.equal(proposal.state,'submitted');assert.deepEqual(calls,side==='buy'?['market','risk','execute']:['market','execute']);assert.equal(rows.get('cloud-settingsscheduler').phase,'proposal-direct');
 }
});

test('AI proposal evidence, risk and double quotes use distinct bounded alarms; matching still precedes the next proposal',async()=>{
 const rows=new Map(),io=new IOBudget(45,async()=>Response.json({}));let submitted=0,matched=0,queued=false,proposal={id:'showcase-trend',agentId:'showcase-trend',state:'pending',stage:'evidence',decision:{action:'buy',token:'0x'+'11'.repeat(20)}};
 const store={all:()=>[],get:(k,id)=>rows.get(k+id),put:(k,v)=>{rows.set(k+v.id,structuredClone(v));if(k==='showcase-proposals')proposal=structuredClone(v);},prune(){}};
 const app={paper:{orders:()=>queued?[{status:'queued'}]:[],async tick(){matched++;queued=false;}},showcase:{pendingProposal:()=>proposal.state==='pending'?proposal:null,validateProposal:()=>true,async executeProposal(p){for(let i=0;i<18;i++)await io.fetch('https://quote.example/'+i);submitted++;queued=true;store.put('showcase-proposals',{...p,state:'submitted'});},freshMarkets:()=>[],tick(){throw Error('No model call in proposal execution');}}};
 const host={io,store,initialize:async()=>app,arm:async()=>{},ctx:{storage:{async setAlarm(){}},waitUntil(){}},market:{getMarket:()=>({quality:'verified',updatedAt:Date.now()}),async updateHead(){await io.fetch('https://head.example');},async fx(){await io.fetch('https://fx.example');},async refresh(_tokens,options){assert.equal(options.onlyRequested,true);for(let i=0;i<34;i++)await io.fetch('https://evidence.example/'+i);}},risk:{async refresh(){for(let i=0;i<37;i++)await io.fetch('https://risk.example/'+i);return {buyAllowed:true};},snapshot:()=>({buyAllowed:true})}};
 const round=()=>io.run('alarm',()=>runScheduledRound(host));await round();assert.equal(submitted,0);assert.equal(proposal.stage,'risk');assert.equal(io.lastAlarm.used,36);
 await round();assert.equal(submitted,0);assert.equal(proposal.stage,'execute');assert.equal(io.lastAlarm.used,39);
 await round();assert.equal(submitted,1);assert.equal(queued,true);assert.equal(io.lastAlarm.used,20);await round();assert.equal(matched,1);assert.equal(io.lastAlarm.used,2);assert.equal(store.get('cloud-settings','scheduler').phase,'matching');
});

test('Changed or missing risk at execution cancels the proposal without submitting an order',async()=>{
 const io=new IOBudget(45,async()=>Response.json({})),rows=new Map();let rejected=0,submitted=0;
 const proposal={id:'showcase-trend',state:'pending',stage:'execute',decision:{action:'buy',token:'0x'+'11'.repeat(20)}};
 const app={paper:{orders:()=>[]},showcase:{pendingProposal:()=>proposal,validateProposal:()=>true,rejectProposal(){rejected++;},executeProposal(){submitted++;}}};
 const host={io,store:{all:()=>[],get:(k,id)=>rows.get(k+id),put:(k,v)=>rows.set(k+v.id,v)},initialize:async()=>app,arm:async()=>{},ctx:{storage:{async setAlarm(){}},waitUntil(){}},market:{async updateHead(){},async fx(){}},risk:{snapshot:()=>({buyAllowed:false})}};
 await io.run('alarm',()=>runScheduledRound(host));assert.equal(rejected,1);assert.equal(submitted,0);assert.equal(io.lastAlarm.used,0);
});
