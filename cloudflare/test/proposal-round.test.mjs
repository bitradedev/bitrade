import test from 'node:test';
import assert from 'node:assert/strict';
import {IOBudget} from '../io-budget.mjs';
import {runScheduledRound} from '../scheduler.mjs';

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
