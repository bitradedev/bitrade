import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createPublicApp,fillCsv} from '../server.mjs';
import {createTrialRuntime} from '../../paper-trial/runner.mjs';
import {Store} from '../../paper-terminal/dist/server/store.js';
import {ACCOUNTS} from '../../paper-trial/policy.mjs';

function offlineGateway(){return {state:{markets:[],strategies:[],chains:[]},connected:false,receivedAt:0,lastError:'测试中无行情',statuses:()=>[{chain:'bsc',connected:false,head:0,headAt:0,gaps:0}],markets:()=>[],getMarket:()=>null,quote:async()=>{throw Error('测试禁止网络报价');}};}
async function request(app,path,{cookie,method='GET',body,csrf,origin=app.origin,headers={}}={}){
 const r=await fetch(app.origin+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json',origin}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 const text=await r.text();return {status:r.status,headers:r.headers,value:r.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text};
}
async function begin(app){const r=await request(app,'/api/session',{method:'POST',body:{create:true}});assert.equal(r.status,201);const cookie=r.headers.get('set-cookie').split(';')[0];return {cookie,response:r,state:(await request(app,'/api/state',{cookie})).value};}

test('CSV keeps negative realized PnL numeric while escaping formula-like text',()=>{
 const output=fillCsv([{id:'export-fixture',netUsd:-3.9,usd:29.71,costBasisUsd:33.61,reason:'=untrusted("text")'}]);
 assert.ok(output.startsWith('\ufeff'));assert.match(output,/"33\.61","-3\.9"/);assert.ok(!output.includes("'-3.9"));assert.ok(output.includes('"\'=untrusted(""text"")"'));
});

test('a fresh install waits for the source database, then skips its preconnection history',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bi-trade-fresh-'));let runtime,source;
 const wait=()=>new Promise(r=>setTimeout(r,650));
 try{
  runtime=await createTrialRuntime({dataDir:join(dir,'account'),sourcePath:join(dir,'source','terminal.sqlite'),gateway:offlineGateway(),chains:['bsc'],accounts:ACCOUNTS.filter(a=>a.chain==='bsc'),enabledChains:['bsc'],executionCheck:false,server:false});
  await wait();assert.match(runtime.state().lastError,/共享行情数据库尚未就绪/);assert.equal(runtime.state().fills.length,0);
  source=new Store(join(dir,'source'));source.event({id:'preconnection-history',chain:'bsc',at:Date.now()-1000,block:1,kind:'head'});
  await wait();assert.equal(runtime.state().lastError,'');assert.equal(runtime.state().counters.events,0);
  source.event({id:'new-source-event',chain:'bsc',at:Date.now(),block:2,kind:'head'});
  await wait();assert.equal(runtime.state().counters.events,1);assert.equal(runtime.state().fills.length,0);assert.equal(runtime.state().orders.length,0);
 }finally{if(runtime)await runtime.stop();source?.close();rmSync(dir,{recursive:true,force:true});}
});

test('two actual independent BSC runtimes isolate capital, journal and pause; persisted on restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bi-trade-isolation-')),books=[];
 let app;
 try{
  app=await createPublicApp({dataDir:dir,port:0,gateway:offlineGateway(),makeRuntime:async o=>{const b=await createTrialRuntime(o);books.push(b);return b;}});
  const guest=await request(app,'/api/state');assert.equal(guest.value.accounts.length,0);assert.equal(guest.value.session,null);assert.equal(guest.value.csrf,null);
  const a=await begin(app),b=await begin(app);
  assert.notEqual(a.cookie,b.cookie);assert.notEqual(a.state.session.label,b.state.session.label);assert.notEqual(a.state.csrf,b.state.csrf);
  assert.equal(a.state.virtualOnly,true);assert.equal(a.state.chains.length,1);assert.equal(a.state.chains[0].chain,'bsc');
  assert.equal(a.state.accounts.length,2);assert.ok(a.state.accounts.every(v=>v.initialCapitalUsd===200&&v.cashUsd===200&&!v.paused));
  assert.equal(a.state.orders.length,0);assert.equal(a.state.fills.length,0);assert.equal(a.state.executionCheck,null);
  assert.notEqual(books[0].dataDir,books[1].dataDir);assert.notEqual(books[0].broker.store,books[1].broker.store);
  books[0].broker.store.audit('isolation-test','只属于用户A的检查记录');
  const paused=await request(app,'/api/pause',{cookie:a.cookie,method:'POST',csrf:a.state.csrf,body:{paused:true,chain:'bsc'}});assert.equal(paused.status,200);
  const aa=(await request(app,'/api/state',{cookie:a.cookie})).value,bb=(await request(app,'/api/state',{cookie:b.cookie})).value;
  assert.ok(aa.accounts.every(v=>v.paused));assert.ok(bb.accounts.every(v=>!v.paused));
  assert.ok(aa.audit.some(r=>r.message==='只属于用户A的检查记录'));assert.ok(!bb.audit.some(r=>r.message==='只属于用户A的检查记录'));
  assert.equal((await request(app,'/api/state?userId='+a.state.session.label,{cookie:b.cookie})).value.session.label,b.state.session.label);
  assert.equal((await request(app,'/api/pause',{cookie:b.cookie,method:'POST',csrf:a.state.csrf,body:{paused:true,chain:'bsc'}})).status,403);
  assert.equal((await request(app,'/api/pause',{cookie:a.cookie,method:'POST',csrf:a.state.csrf,body:{paused:false,userId:b.state.session.label}})).status,400);
  await app.stop();app=null;
  app=await createPublicApp({dataDir:dir,port:0,gateway:offlineGateway()});
  const afterA=(await request(app,'/api/state',{cookie:a.cookie})).value,afterB=(await request(app,'/api/state',{cookie:b.cookie})).value;
  assert.equal(afterA.session.label,a.state.session.label);assert.ok(afterA.accounts.every(v=>v.paused));assert.ok(afterB.accounts.every(v=>!v.paused));
  assert.equal(afterA.ledger.passed,true);assert.ok(afterA.accounts.every(v=>v.initialCapitalUsd===200));
  assert.equal((await request(app,'/api/session',{cookie:a.cookie,method:'POST',body:{create:true}})).status,200);
 }finally{if(app)await app.stop();rmSync(dir,{recursive:true,force:true});}
});

test('session credentials, Origin/CSRF, chain and routes restrict public controls',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bi-trade-security-'));let app;
 try{
  app=await createPublicApp({dataDir:dir,port:0,gateway:offlineGateway()});
  assert.equal((await request(app,'/api/session',{method:'POST',origin:'https://unrelated.example',body:{create:true}})).status,403);
  const a=await begin(app);const setCookie=a.response.headers.get('set-cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);assert.match(setCookie,/Max-Age=2592000/);
  assert.ok(!JSON.stringify(a.state).includes(a.cookie.split('=')[1]));assert.ok(!JSON.stringify(a.state).includes('dataDir'));
  const invalid=(await request(app,'/api/state',{cookie:'bi_trade_session='+'A'.repeat(43)})).value;assert.equal(invalid.session,null);assert.equal(invalid.accounts.length,0);
  assert.equal((await request(app,'/api/pause',{method:'POST',body:{paused:true}})).status,401);
  assert.equal((await request(app,'/api/pause',{cookie:a.cookie,method:'POST',body:{paused:true}})).status,403);
  assert.equal((await request(app,'/api/pause',{cookie:a.cookie,csrf:a.state.csrf,method:'POST',body:{paused:true,chain:'robinhood'}})).status,400);
  for(const path of ['/api/stop','/api/orders','/api/check','/api/paper/quote','/api/private-key','/api/swap'])assert.equal((await request(app,path,{method:'POST',body:{}})).status,404);
  assert.equal((await request(app,'/api/export')).status,401);assert.equal((await request(app,'/api/export',{cookie:a.cookie})).status,200);
  const badHost=await new Promise((yes,no)=>{const r=httpRequest(app.origin+'/api/state',{headers:{Host:'unrelated.example'}},res=>{res.resume();yes(res.statusCode);});r.once('error',no);r.end();});assert.equal(badHost,403);
 }finally{if(app)await app.stop();rmSync(dir,{recursive:true,force:true});}
});

test('concurrent creation limits do not create fictitious balances or unlimited books',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bi-trade-limits-'));let app;
 try{app=await createPublicApp({dataDir:dir,port:0,gateway:offlineGateway(),maxUsers:1,makeRuntime:async o=>{await new Promise(r=>setTimeout(r,30));return createTrialRuntime(o);}});const results=await Promise.all([request(app,'/api/session',{method:'POST',body:{create:true}}),request(app,'/api/session',{method:'POST',body:{create:true}})]);assert.deepEqual(results.map(r=>r.status).sort(),[201,503]);assert.equal((await request(app,'/api/state')).value.accounts.length,0);}
 finally{if(app)await app.stop();rmSync(dir,{recursive:true,force:true});}
});
