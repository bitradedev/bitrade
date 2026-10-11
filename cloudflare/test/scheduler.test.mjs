import test from 'node:test';
import assert from 'node:assert/strict';
import {runScheduledRound} from '../scheduler.mjs';
import {IOBudget} from '../io-budget.mjs';
import {TokenRiskGuard} from '../../bi-trade/lib/token-risk-core.mjs';

test('A costly Meme refresh defers risk to its own persisted round without poisoning evidence; queued matching still comes first',async()=>{
 const token='0x'+'11'.repeat(20),at=Date.now(),rows=new Map();let collected=0,refreshes=0,decisions=0,queued=false,matched=0,heavy=true;
 let io=new IOBudget(45,async()=>Response.json({}));
 const store={all:()=>[],get:(kind,id)=>rows.get(kind+id),put:(kind,v)=>{rows.set(kind+v.id,structuredClone(v));return v;},prune(){}};
 const previous={id:token,token,chain:'bsc',fetchedAt:at-121000,policy:'bsc-meme-paper-v1',state:'blocked',buyAllowed:false,reasons:['Known concentration'],metrics:{largestObservedFloatShare:50}};
 store.put('token-risk-reports',previous);
 const risk=new TokenRiskGuard(store,{now:()=>at,maxTokensPerTick:1,source:{async riskReport(t){collected++;for(let i=0;i<20;i++)await io.fetch('https://risk.example/'+i);return {...previous,token:t,fetchedAt:at,reasons:['New verified concentration']};}}});
 const app={paper:{orders:()=>queued?[{status:'queued'}]:[],async tick(){if(queued){matched++;queued=false;}}},showcase:{freshMarkets:()=>[{address:token,updatedAt:at}],tick(){decisions++;return null;}}};
 const market={marketScope:()=>({kind:'meme'}),isEntryCandidate:t=>t===token,async refresh(){refreshes++;for(let i=0;i<(heavy?36:3);i++)await io.fetch('https://market.example/'+i);},async updateHead(){await io.fetch('https://head.example');},async fx(){await io.fetch('https://fx.example');},async pulse(){await io.fetch('https://pulse.example');}};
 let host={io,riskRequestReserve:32,store,risk,app,market,initialize:async()=>app,arm:async()=>{},ctx:{storage:{async setAlarm(){}},waitUntil(){}}};
 const round=()=>io.run('alarm',()=>runScheduledRound(host));
 await round();assert.equal(collected,0);assert.equal(decisions,0);assert.deepEqual(store.get('token-risk-reports',token),previous);assert.deepEqual(store.get('cloud-settings','risk-priority-round').tokens,[token]);assert.equal(io.lastAlarm.used,36);
 // Reconstruction retains the queue, but an already queued order is matched first.
 io=new IOBudget(45,async()=>Response.json({}));host={...host,io,working:null,decisionTask:null};queued=true;
 await round();assert.equal(matched,1);assert.equal(collected,0);assert.deepEqual(store.get('cloud-settings','risk-priority-round').tokens,[token]);
 await round();assert.equal(collected,1);assert.equal(refreshes,1);assert.equal(io.lastAlarm.used,22);assert.equal(store.get('cloud-settings','scheduler').phase,'risk');assert.deepEqual(store.get('cloud-settings','risk-priority-round').tokens,[]);assert.equal(store.get('token-risk-reports',token).fetchedAt,at);assert.equal(risk.snapshot(token).buyAllowed,false);
 heavy=false;await round();assert.equal(refreshes,2);assert.equal(decisions,1);assert.equal(collected,1);assert.ok(io.lastAlarm.used<45);await risk.close();
});

test('a stale held Meme gets risk collection even when no market is fresh, without adding legacy fallback entries', async () => {
  const meme = '0x6bdcce4a559076e37755a78ce0c06214e59e4444';
  const cake = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';
  const candidate = '0xeccbb861c0dda7efd964010085488b69317e4444';
  const at = Date.now(), rows = new Map(), collected = [], calls = [];
  const io = new IOBudget(4, async url => { calls.push(url); return Response.json({}); });
  const store = {
    all: kind => kind === 'paper-lots' ? [
      { token: cake, remainingRaw: '1' },
      { token: meme, remainingRaw: '1' },
    ] : [],
    get: (kind, id) => rows.get(kind + id),
    put: (kind, value) => rows.set(kind + value.id, value),
    prune() {},
  };
  store.put('token-risk-reports', { id: meme, token: meme, chain: 'bsc', fetchedAt: at - 121000,
    policy: 'bsc-meme-paper-v1', state: 'screened-limited', buyAllowed: true, reasons: [], metrics: {} });
  const risk = new TokenRiskGuard(store, { maxTokensPerTick: 1, now: () => at, source: {
    async riskReport(token) {
      collected.push(token);
      await io.fetch('https://risk.example/' + token);
      // Missing safety evidence stays blocked: collection is not permission to buy.
      return { id: token, token, chain: 'bsc', fetchedAt: at, policy: 'bsc-meme-paper-v1',
        state: 'unknown', buyAllowed: false, reasons: ['Safety evidence missing'], metrics: null };
    },
  } });
  let fresh = [];
  const app = {
    paper: { orders: () => [], async tick() {} },
    showcase: {
      freshMarkets: () => fresh,
      tick() { risk.tick([meme, cake]); return null; },
    },
  };
  const host = { io, store, risk, app, initialize: async () => app, arm: async () => {},
    ctx: { storage: { async setAlarm() {} }, waitUntil() {} },
    market: {
      marketScope: () => ({ kind: 'meme' }),
      isEntryCandidate: token => [meme, candidate].includes(token),
      async refresh() { await io.fetch('https://market.example'); },
      async pulse() { await io.fetch('https://pulse.example'); },
    },
  };
  assert.equal(risk.snapshot(meme).buyAllowed, false);
  await io.run('alarm', () => runScheduledRound(host));
  assert.deepEqual(collected, [meme], 'An empty fresh list must not starve the held Meme report');
  assert.equal(store.get('token-risk-reports', meme).fetchedAt, at);
  assert.equal(risk.snapshot(meme).buyAllowed, false);
  assert.equal(io.lastAlarm.used, 3);
  assert.equal(store.get('token-risk-reports', cake), undefined);

  // A still-current held report consumes no collection slot; a new candidate can proceed.
  risk.refreshAt = at - 15000;
  fresh = [{ address: candidate, updatedAt: at }];
  await io.run('alarm', () => runScheduledRound(host));
  assert.deepEqual(collected, [meme, candidate]);
  assert.equal(io.lastAlarm.used, 3);
  assert.equal(store.get('token-risk-reports', cake), undefined);
  await risk.close();
});
test('failed held exits get their own bounded retry round before heavy collection, while queued matching stays first',async()=>{
 const calls=[],rows=new Map(),io=new IOBudget(4,async url=>{calls.push(url);return Response.json({});});let queued=false,watched=0;
 const host={io,ctx:{storage:{setAlarm:async()=>{}},waitUntil(){}},store:{all:kind=>kind==='showcase-status'?[{id:'showcase-trend',exitFailures:[{token:'held'}]}]:[],get:(k,id)=>rows.get(k+id),put:(k,v)=>rows.set(k+v.id,v),prune(){}},arm:async()=>{}};
 const app={paper:{orders:()=>queued?[{status:'queued'}]:[],tick:async()=>{queued=false;}},showcase:{watchExits:async options=>{assert.equal(options.onlyFailures,true);watched++;await io.fetch('https://exit.example');},freshMarkets:()=>[],tick:()=>{throw Error('Do not run a model in an exit retry round');}}};host.initialize=async()=>app;host.market={updateHead:async()=>{await io.fetch('https://head.example');},fx:async()=>{await io.fetch('https://fx.example');},refresh:async()=>{throw Error('Do not consume the exit budget on discovery');}};host.risk={tick:()=>{throw Error('Do not collect holders in an exit retry round');}};
 await io.run('alarm',()=>runScheduledRound(host));assert.equal(watched,1);assert.equal(rows.get('cloud-settingsscheduler').phase,'exits');assert.equal(io.lastAlarm.used,3);assert.deepEqual(calls,['https://head.example','https://fx.example','https://exit.example']);
 queued=true;await io.run('alarm',()=>runScheduledRound(host));assert.equal(queued,false);assert.equal(watched,1);assert.equal(rows.get('cloud-settingsscheduler').phase,'matching');assert.equal(io.lastAlarm.used,2);
});

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


test('A completed priority risk check with old chart evidence cannot pin all later discovery to that token',async()=>{
 const token='0x'+'11'.repeat(20),at=Date.now(),rows=new Map(),io=new IOBudget(45,async()=>Response.json({}));let refreshes=0;
 const store={all:()=>[],get:(kind,id)=>rows.get(kind+id),put:(kind,v)=>rows.set(kind+v.id,structuredClone(v)),prune(){}};
 store.put('cloud-settings',{id:'risk-priority-round',tokens:[token]});
 const risk=new TokenRiskGuard(store,{now:()=>at,source:{async riskReport(){await io.fetch('https://risk.example');return {id:token,token,chain:'bsc',fetchedAt:at-121000,state:'unknown',buyAllowed:false,reasons:['Old chart evidence'],metrics:null};}}});
 const app={paper:{orders:()=>[],async tick(){}},showcase:{freshMarkets:()=>[],tick(){return null;}}};
 const host={io,riskRequestReserve:32,store,risk,app,initialize:async()=>app,arm:async()=>{},ctx:{storage:{async setAlarm(){}},waitUntil(){}},market:{marketScope:()=>({kind:'meme'}),isEntryCandidate:()=>true,async updateHead(){await io.fetch('https://head.example');},async fx(){},async refresh(){refreshes++;},async pulse(){}}};
 await io.run('alarm',()=>runScheduledRound(host));assert.deepEqual(store.get('cloud-settings','risk-priority-round').tokens,[]);assert.equal(risk.snapshot(token).buyAllowed,false);assert.equal(risk.snapshot(token).fetchedAt,at-121000);
 await io.run('alarm',()=>runScheduledRound(host));assert.equal(refreshes,1);await risk.close();
});
