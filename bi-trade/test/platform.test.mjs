import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {request} from 'node:http';
import {createPlatformApp} from '../platform.mjs';
import {accounts,viem} from '../lib/dependencies.mjs';
import {LiveDesk,recordReceipt} from '../lib/live-desk.mjs';
import {v2Abi,erc20Abi,ROUTER_V2,WBNB} from '../lib/bsc-rpc.mjs';
import {SHOWCASE_PROFILES} from '../lib/showcase-agents.mjs';
import {publicAgent} from '../lib/public-agents.mjs';
import {runScheduledRound} from '../../cloudflare/scheduler.mjs';
import {IOBudget} from '../../cloudflare/io-budget.mjs';
import {aiRequestFailure,aiHttpFailure} from '../lib/ai-errors.mjs';

const ROOT=resolve('bi-trade/data/test-runs');mkdirSync(ROOT,{recursive:true});
test('AI-selected paper sizing uses executable impact at preparation and fill, preserves reverse quotes, balance and slippage',async t=>{
 const f=await fixture(t,{showcase:true}),a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id);
 f.app.paper.seed(a.id,f.g.fx);const before=structuredClone(f.app.paper.account(a.id));
 const constraints=f.app.showcase.context(a).executionConstraints;
 assert.equal('maxLiquidityShare' in constraints,false);assert.equal(constraints.maxBuyPriceImpactPct,2);assert.equal(constraints.maxFillSlippageBps,100);
 let impact=0.5,reverseUnavailable=false,outputFactor=100n;const quote=f.g.quote.bind(f.g);
 f.g.quote=async p=>{if(p.side==='sell'&&reverseUnavailable)throw Error('Reverse quote unavailable');const q=await quote(p);return {...q,priceImpactPct:p.side==='buy'?impact:95,outputRaw:p.side==='buy'?String(BigInt(q.outputRaw)*outputFactor/100n):q.outputRaw};};
 const input={token:TOKEN,side:'buy',amount:'150000000000000000'};
 for(const value of [2.001,NaN,undefined,-1]){impact=value;await assert.rejects(f.app.paper.submit(a,{...input,id:'invalid-'+String(value)}),/价格冲击/);}
 impact=0.5;reverseUnavailable=true;await assert.rejects(f.app.paper.submit(a,{...input,id:'reverse-unavailable'}),/Reverse quote/);reverseUnavailable=false;
 assert.equal(f.app.paper.orders(a.id).length,0);assert.deepEqual(f.app.paper.account(a.id),before);
 const pending=await f.app.paper.submit(a,{...input,id:'impact-changed'});pending.dueAt=0;f.app.store.put('paper-orders',pending);f.g.advance();impact=2.1;await f.app.paper.tick();
 assert.equal(f.app.store.get('paper-orders',pending.id).status,'failed');assert.equal(f.app.paper.fills(a.id).length,0);assert.deepEqual(f.app.paper.account(a.id),before);
 impact=0.5;const slippage=await f.app.paper.submit(a,{...input,id:'slippage-changed'});slippage.dueAt=0;f.app.store.put('paper-orders',slippage);f.g.advance();outputFactor=98n;await f.app.paper.tick();assert.match(f.app.store.get('paper-orders',slippage.id).error,/1%滑点/);assert.equal(f.app.paper.fills(a.id).length,0);
 outputFactor=100n;const reverseChanged=await f.app.paper.submit(a,{...input,id:'reverse-changed'});reverseChanged.dueAt=0;f.app.store.put('paper-orders',reverseChanged);f.g.advance();reverseUnavailable=true;await f.app.paper.tick();assert.match(f.app.store.get('paper-orders',reverseChanged.id).error,/Reverse quote/);assert.equal(f.app.paper.fills(a.id).length,0);assert.deepEqual(f.app.paper.account(a.id),before);reverseUnavailable=false;
 outputFactor=100n;impact=2;const accepted=await f.app.paper.submit(a,{...input,id:'accepted-large'});accepted.dueAt=0;f.app.store.put('paper-orders',accepted);f.g.advance();await f.app.paper.tick();
 assert.equal(f.app.paper.fills(a.id).length,1);assert.equal(f.app.paper.fills(a.id)[0].usd,150.01);assert.equal(f.app.paper.check(a.id),true);
});
test('temporary AI failure keeps the last real decision, schedules a future retry and recovers without a trade',async t=>{
 let failNow=true,calls=0;
 const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>({model:'test',intervalMinutes:1,dailyCalls:null}),planner:{async decide(){calls++;if(failNow)throw aiRequestFailure({name:'TimeoutError'});return {action:'hold',token:null,sizeUsd:null,exit:null,reason:'真实恢复后继续观察'};}}}});
 const id=SHOWCASE_PROFILES[0].id,oldAt=Date.now()-300000;
 f.app.showcase.status(id,{lastDecisionAt:oldAt,decision:{action:'hold',token:null,sizeUsd:null,reason:'上次有效评估'},nextDecisionAt:0});
 await f.app.showcase.run({agentId:id});
 let a=(await f.call('/api/public/agent?id='+id)).value.agent;
 assert.equal(a.runtime.state,'waiting-ai');assert.ok(f.app.store.get('showcase-status',id).aiIssue.retryAt>Date.now());
 assert.equal('aiRetryAt' in a.runtime,false);
 assert.equal(a.runtime.lastDecisionAt,oldAt);assert.equal(a.runtime.decision.reason,'上次有效评估');
 assert.equal(f.app.paper.orders().length,0);await f.app.showcase.run({agentId:id});assert.equal(calls,1);
 failNow=false;f.app.showcase.status(id,{nextDecisionAt:0});f.app.showcase.exitChecks.clear();await f.app.showcase.run({agentId:id});
 a=(await f.call('/api/public/agent?id='+id)).value.agent;
 assert.equal(a.runtime.state,'observing');assert.equal(f.app.store.get('showcase-status',id).aiIssue,null);assert.ok(a.runtime.lastDecisionAt>oldAt);assert.equal(f.app.paper.orders().length,0);
});
test('An explicit decision-service Retry-After persists without renewing the last valid decision or creating a trade',async t=>{
 let calls=0;const retryAt=Date.now()+900000;
 const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>({model:'test',intervalMinutes:1,dailyCalls:null}),planner:{async decide(){calls++;throw aiHttpFailure(503,{retryAt});}}}});
 const id=SHOWCASE_PROFILES[0].id,oldAt=Date.now()-600000;
 f.app.showcase.status(id,{lastDecisionAt:oldAt,decision:{action:'hold',token:null,sizeUsd:null,reason:'上次有效评估',exit:null},nextDecisionAt:0});
 f.app.paper.seed(id,f.g.fx);const account=structuredClone(f.app.paper.account(id));await f.app.showcase.run({agentId:id});
 const saved=f.app.store.get('showcase-status',id);assert.equal(saved.nextDecisionAt,retryAt);assert.equal(saved.aiIssue.retryAt,retryAt);assert.equal(saved.lastDecisionAt,oldAt);
 f.app.showcase.exitChecks.clear();await f.app.showcase.run({agentId:id});assert.equal(calls,1);assert.deepEqual(f.app.paper.account(id),account);assert.equal(f.app.paper.orders().length,0);
 const publicView=(await f.call('/api/public/agent?id='+id)).value.agent;assert.equal(publicView.runtime.lastDecisionAt,oldAt);assert.equal('aiIssue' in publicView.runtime,false);
});

test('Market outage is shown as waiting with retry time, spends no AI calls and resumes decisions on recovery',async t=>{
 let calls=0;const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>({model:'test-model',intervalMinutes:1,dailyCalls:null}),planner:{async decide(){calls++;return {action:'hold',token:null,sizeUsd:null,reason:'测试恢复后保持观察',exit:{takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60}};}}}});
 const original=f.g.markets,retryAt=Date.now()+300000;f.g.markets=()=>[];f.g.marketWait=()=>({retryAt});f.g.marketReason=()=> '行情服务暂不可用';
 await f.app.showcase.run();assert.equal(calls,0);assert.equal(f.app.store.all('ai-usage').length,0);assert.equal(f.app.paper.orders().length,0);
 const pub=(await f.call('/api/public')).value;assert.equal(pub.agents.length,3);for(const a of pub.agents){assert.equal(a.runtime.state,'waiting-market');assert.equal(a.runtime.marketRetryAt,retryAt);assert.equal(a.runtime.nextDecisionAt,0);}
 f.g.markets=original;f.g.marketWait=()=>null;await f.app.showcase.run();assert.equal(calls,3);for(const a of (await f.call('/api/public')).value.agents){assert.equal(a.runtime.state,'observing');assert.equal(a.runtime.marketRetryAt,null);}
});
test('root always opens the scroll introduction; home and account routes remain directly accessible',async t=>{
 const f=await fixture(t);
 assert.match(await (await fetch(f.url+'/')).text(),/id="intro-content"/);
 assert.match(await (await fetch(f.url+'/home')).text(),/landing.css/);
 assert.match(await (await fetch(f.url+'/dashboard')).text(),/id="content"/);
 assert.equal(f.app.store.all('agents').length,0);
});
test('configured reverse proxies give independent visitors separate session quotas; untrusted headers cannot bypass them',async t=>{
 const f=await fixture(t,{trustedProxyIPs:['127.0.0.1']});
 for(let n=1;n<=11;n++)assert.equal((await f.call('/api/session',{},null,{'X-Forwarded-For':'198.51.100.'+n})).status,200);
 for(let n=0;n<10;n++)assert.equal((await f.call('/api/session',{},null,{'X-Forwarded-For':'203.0.113.1'})).status,200);
 assert.equal((await f.call('/api/session',{},null,{'X-Forwarded-For':'203.0.113.1'})).status,429);
 const direct=await fixture(t);
 for(let n=1;n<=10;n++)assert.equal((await direct.call('/api/session',{},null,{'X-Forwarded-For':'198.51.100.'+n})).status,200);
 assert.equal((await direct.call('/api/session',{},null,{'X-Forwarded-For':'198.51.100.11'})).status,429);
});
test('verified owners and Agent tokens use separate request quotas and indexed ledger lookups retain account isolation',async t=>{
 const scopes=[];const f=await fixture(t,{rateLimit:(_req,kind,_max,_ms,scope)=>scopes.push({kind,scope})});
 const one=await f.owner(),two=await f.owner(),a=await f.register(one),b=await f.register(two);
 scopes.length=0;await f.call('/api/state',undefined,one);await f.call('/api/state',undefined,two);
 await f.agentCall(a,'get_account');await f.agentCall(b,'get_account');await f.call('/api/health',undefined,null,{Authorization:'Bearer '+'a'.repeat(43)});
 const keys=scopes.filter(x=>x.kind==='requests').map(x=>x.scope);
 assert.match(keys[0],/^owner:/);assert.notEqual(keys[0],keys[1]);assert.equal(keys[2],'agent:'+a.agentId);assert.equal(keys[3],'agent:'+b.agentId);assert.match(keys[4],/^ip:/);
 assert.deepEqual(f.app.store.byOwner('agents',one.state.owner.id).map(x=>x.id),[a.agentId]);
 f.app.store.put('query-test',{id:'a',agentId:a.agentId});f.app.store.put('query-test',{id:'b',agentId:b.agentId});
 assert.deepEqual(f.app.store.forAgent('query-test',a.agentId).map(x=>x.id),['a']);
 const plan=f.app.store.db.prepare("EXPLAIN QUERY PLAN SELECT payload FROM entities WHERE kind=? AND json_extract(payload,'$.agentId')=? ORDER BY rowid").all('query-test',a.agentId);
 assert.match(JSON.stringify(plan),/entities_by_agent/);
});
const TOKEN='0x1111111111111111111111111111111111111111',OWNER=accounts.privateKeyToAccount('0x'+'31'.repeat(32)),OTHER=accounts.privateKeyToAccount('0x'+'32'.repeat(32));
function gateway(){const g={head:100,headAt:Date.now(),connected:true,calls:0,failure:null,fx:1000,quotes:[],start(){},stop(){},statuses(){return [{chain:'bsc',head:this.head,headAt:this.headAt,connected:this.connected}]},markets(){return [{chain:'bsc',address:TOKEN,symbol:'TEST',nativeUsd:this.fx,priceUsd:1,quality:'verified',updatedAt:Date.now(),venue:'pancake-v2'}]},getMarket(){return this.markets()[0]},async quote(p){this.calls++;this.quotes.push(p);if(this.failure)throw this.failure;const input=p.nativeAmountRaw??p.tokenAmountRaw;return {id:'quote-'+this.calls,chain:'bsc',token:p.token,side:p.side,block:p.block,inputRaw:input,spentInputRaw:input,refundRaw:'0',outputRaw:String(p.side==='buy'?BigInt(input)*1000n:BigInt(input)/1000n),at:Date.now(),quality:'verified',nativeUsd:this.fx,priceUsd:1,priceImpactPct:0,impactQuality:'verified',tokenDecimals:18,fees:{gasUsd:.01,approvalUsd:0,protocolUsd:.02,taxUsd:0,conversionUsd:0,includedInOutput:true,quality:'verified'}}},advance(){this.head++;this.headAt=Date.now();}};return g;}
async function fixture(t,options={}){if(options.showcase===true)options={...options,showcaseOptions:{riskGuard:{snapshot:token=>({token,state:'screened',buyAllowed:true,reasons:[],metrics:{liquidityUsd:100000,referencePriceUsd:1}}),tick(){},async assertBuy(){},async close(){}},...(options.showcaseOptions??{})}};const dataDir=mkdtempSync(resolve(ROOT,'run-')),g=gateway(),rpc=options.rpc??{calls:0,balance:async()=>0n},app=await createPlatformApp({dataDir,gateway:g,rpc,showcase:false,...options}),url=await app.start(0);t.after(async()=>{await app.close();assert.ok(dataDir.startsWith(ROOT+'\\')||dataDir.startsWith(ROOT+'/'));rmSync(dataDir,{recursive:true,force:true});});
 async function call(path,data,session=null,extra={}){const res=await fetch(url+path,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{'Content-Type':'application/json',...(!['/api/agent','/mcp'].includes(path)?{Origin:url}:{})}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.state.csrf}:{}),...extra},...(data===undefined?{}:{body:JSON.stringify(data)})});const value=await res.json();return {status:res.status,value,cookie:res.headers.get('set-cookie')?.split(';')[0]};}
 async function owner(){const r=await call('/api/session',{});return {cookie:r.cookie,state:r.value};}
 async function register(session,name='Agent'){const p=await call('/api/pair',{},session),r=await call('/api/agent',{action:'register_dot',arguments:{pairingCode:p.value.pairingCode,name}});assert.equal(r.status,200);return r.value.result;}
 const agentCall=(agent,action,args={})=>call('/api/agent',{action,arguments:args},null,{Authorization:'Bearer '+agent.agentToken});return {app,g,rpc,url,call,owner,register,agentCall};
}
test('Browser paper sessions last 30 days and renew the same identity without creating or changing an Agent',async t=>{
 const f=await fixture(t),response=await fetch(f.url+'/api/session',{method:'POST',headers:{Origin:f.url,'Content-Type':'application/json'},body:'{}'}),state=await response.json(),cookie=response.headers.get('set-cookie');
 assert.match(cookie,/HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000/);assert.equal(state.owner.kind,'demo');assert.equal(state.owner.address,null);assert.deepEqual(state.agents,[]);
 const s={cookie:cookie.split(';')[0],state},agent=await f.register(s),session=f.app.auth.session({headers:{cookie:s.cookie}});
 f.app.store.db.prepare('UPDATE credentials SET expires=? WHERE hash=?').run(Date.now()+1000,session.hash);
 const renewed=await fetch(f.url+'/api/session',{method:'POST',headers:{Origin:f.url,'Content-Type':'application/json',Cookie:s.cookie},body:'{}'}),next=await renewed.json();
 assert.equal(next.owner.id,state.owner.id);assert.equal(next.csrf,state.csrf);assert.equal(renewed.headers.get('set-cookie')?.split(';')[0],s.cookie);assert.equal(next.agents[0].id,agent.agentId);assert.equal(f.app.store.all('agents').length,1);
 assert.ok(f.app.store.db.prepare('SELECT expires FROM credentials WHERE hash=?').get(session.hash).expires>Date.now()+29*86400000);assert.doesNotMatch(JSON.stringify(next),new RegExp(session.token));
 f.app.store.db.prepare('UPDATE credentials SET expires=0 WHERE hash=?').run(session.hash);assert.equal(f.app.auth.renewDemo(session),null);assert.equal(f.app.auth.session({headers:{cookie:s.cookie}}),null);
 const walletIssued=f.app.auth.issue({id:state.owner.id,kind:'wallet'});assert.equal(walletIssued.maxAge,86400);assert.equal(f.app.auth.renewDemo({owner:{kind:'wallet'}}),null);
});

test('pairing tickets and browser visits create no wallets; only runtime registration can claim one',async t=>{
 const f=await fixture(t),s=await f.owner(),p=await f.call('/api/pair',{},s),args={pairingCode:p.value.pairingCode,name:'Actual runtime'};
 assert.equal(f.app.store.all('agents').length,0);assert.equal(f.app.store.all('paper-accounts').length,0);
 const page=await fetch(f.url+'/pair');assert.equal(page.status,200);assert.equal(f.app.store.all('agents').length,0);
 assert.equal((await f.call('/api/agent',{action:'register_dot',arguments:args},null,{Origin:f.url})).status,403);
 assert.equal((await f.call('/api/agent',{action:'register_dot',arguments:args},s)).status,403);
 assert.equal((await f.call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'register_dot',arguments:args}},null,{Origin:f.url})).value.result.isError,true);
 assert.equal(f.app.store.all('agents').length,0);assert.equal(f.app.store.all('paper-accounts').length,0);
 const registered=await f.call('/api/agent',{action:'register_dot',arguments:args});assert.equal(registered.status,200);
 const a=registered.value.result;assert.equal((await f.call('/api/state',undefined,s)).value.agents[0].connectionState,'awaiting-agent');
 assert.equal((await f.agentCall(a,'get_account',{unexpected:true})).status,400);assert.equal(f.app.store.get('agents',a.agentId).lastAgentRequestAt,undefined);
 assert.equal((await f.agentCall(a,'get_account')).value.result.connectionState,'connected');
});

test('closing is Owner-only, revokes credentials and reconnect links, hides public data, and preserves ledger for recovery',async t=>{
 const f=await fixture(t),s=await f.owner(),other=await f.owner(),a=await f.register(s,'Keep history');
 const buy=await f.agentCall(a,'buy_token',{token:TOKEN,amount:'10000000000000000',requestKey:'fill-before-close'});
 const o=f.app.store.get('paper-orders',buy.value.result.id);o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();
 assert.equal(f.app.paper.fills(a.agentId).length,1);
 const capital=f.app.paper.account(a.agentId).nativeRaw,positions=f.app.paper.lots(a.agentId);
 const pending=await f.agentCall(a,'buy_token',{token:TOKEN,amount:'10000000000000000',requestKey:'cancel-on-close'});
 const reconnect=await f.call('/api/pair',{agentId:a.agentId},s);await f.call('/api/control',{agentId:a.agentId,public:true},s);
 assert.equal((await f.call('/api/agent/close',{agentId:a.agentId},other)).status,404);
 assert.equal((await f.call('/api/agent/close',{agentId:a.agentId},s,{'X-CSRF-Token':'wrong'})).status,403);
 assert.equal((await f.call('/api/agent/close',{agentId:a.agentId},s)).value.connectionState,'closed');
 assert.equal((await f.call('/api/agent/close',{agentId:a.agentId},s)).status,200);
 const state=(await f.call('/api/state',undefined,s)).value;assert.equal(state.agents.length,0);assert.equal(state.archivedAgents.length,1);assert.equal(state.activity.length,1);
 assert.equal(f.app.paper.account(a.agentId).nativeRaw,capital);assert.deepEqual(f.app.paper.lots(a.agentId),positions);assert.equal(f.app.paper.check(a.agentId),true);
 assert.equal(f.app.store.get('paper-orders',pending.value.result.id).status,'cancelled');assert.equal((await f.agentCall(a,'get_account')).status,401);
 assert.equal((await f.call('/api/control',{agentId:a.agentId,paused:false,public:true},s)).status,409);
 assert.equal((await f.call('/api/agent',{action:'register_dot',arguments:{pairingCode:reconnect.value.pairingCode,name:'old link'}})).status,403);
 assert.equal((await f.call('/api/public')).value.agents.length,0);assert.equal((await f.call('/api/leaderboard')).value.total,0);assert.equal((await f.call('/api/public/agent?id='+a.agentId)).status,404);
 assert.equal((await f.call('/api/state',undefined,other)).value.archivedAgents.length,0);
 const restored=await f.call('/api/agent/restore',{agentId:a.agentId},s);assert.equal(restored.value.address,a.address);assert.equal(restored.value.paused,true);assert.equal(restored.value.connectionState,'needs-reconnect');
 assert.equal((await f.agentCall(a,'get_account')).status,401);
 const p=await f.call('/api/pair',{agentId:a.agentId},s),replacement=await f.call('/api/agent',{action:'register_dot',arguments:{pairingCode:p.value.pairingCode,name:'same wallet'}});
 assert.equal(replacement.value.result.agentId,a.agentId);assert.equal(replacement.value.result.address,a.address);assert.equal((await f.agentCall(replacement.value.result,'get_account')).status,200);
 assert.equal(f.app.paper.account(a.agentId).nativeRaw,capital);
});

test('closure during a pending quote prevents a fill and a late account response cannot reopen it',async t=>{
 const f=await fixture(t),s=await f.owner(),a=await f.register(s),quote=f.g.quote.bind(f.g);let release;
 f.g.quote=async p=>{await new Promise(r=>release=r);return quote(p);};
 const buy=f.agentCall(a,'buy_token',{token:TOKEN,amount:'10000000000000000',requestKey:'closing-quote'});while(!release)await new Promise(r=>setTimeout(r,5));
 assert.equal((await f.call('/api/agent/close',{agentId:a.agentId},s)).status,200);release();assert.equal((await buy).status,409);assert.equal(f.app.paper.fills(a.agentId).length,0);
 await f.call('/api/agent/restore',{agentId:a.agentId},s);const p=await f.call('/api/pair',{agentId:a.agentId},s),r=await f.call('/api/agent',{action:'register_dot',arguments:{pairingCode:p.value.pairingCode,name:'same'}});
 let balanceRelease;f.rpc.balance=async()=>{await new Promise(r=>balanceRelease=r);return 0n;};
 const account=f.agentCall(r.value.result,'get_account');while(!balanceRelease)await new Promise(r=>setTimeout(r,5));
 await f.call('/api/agent/close',{agentId:a.agentId},s);balanceRelease();assert.equal((await account).status,401);assert.ok(f.app.store.get('agents',a.agentId).closedAt);assert.equal(f.app.store.get('agents',a.agentId).public,false);
});

test('unresolved live orders block closure before credential revocation',async t=>{
 const f=await fixture(t),s=await f.owner(),a=await f.register(s);
 for(const status of ['preparing','signed','submitted']){f.app.store.put('live-orders',{id:'pending-live',agentId:a.agentId,mode:'live',status,createdAt:Date.now()});assert.equal((await f.call('/api/agent/close',{agentId:a.agentId},s)).status,409);assert.equal((await f.agentCall(a,'get_account')).status,200);assert.equal(f.app.store.get('agents',a.agentId).closedAt,undefined);}
 f.app.store.put('live-orders',{id:'pending-live',agentId:a.agentId,mode:'live',status:'confirmed',createdAt:Date.now()});assert.equal((await f.call('/api/agent/close',{agentId:a.agentId},s)).status,200);
});

test('Agent avatar choices are scoped to the Owner, persist through reconnect and closure, and are shared publicly',async t=>{
 const f=await fixture(t),s=await f.owner(),other=await f.owner();
 assert.equal((await f.call('/api/pair',{avatar:'../../private'},s)).status,400);assert.equal(f.app.store.all('agents').length,0);
 const p=await f.call('/api/pair',{avatar:'rebound'},s),r=await f.call('/api/agent',{action:'register_dot',arguments:{pairingCode:p.value.pairingCode,name:'Chosen avatar'}}),a=r.value.result;
 assert.equal((await f.call('/api/state',undefined,s)).value.agents[0].avatar,'rebound');
 const balance=f.app.paper.account(a.agentId).nativeRaw;
 assert.equal((await f.call('/api/avatar',{agentId:a.agentId,avatar:'rotation'},other)).status,404);
 assert.equal((await f.call('/api/avatar',{agentId:a.agentId,avatar:'https://untrusted.invalid/track'},s)).status,400);
 assert.equal((await f.call('/api/avatar',{agentId:a.agentId,avatar:'rotation'},s)).value.avatar,'rotation');
 await f.call('/api/control',{agentId:a.agentId,public:true},s);assert.equal((await f.call('/api/public')).value.agents[0].avatar,'rotation');assert.equal((await f.call('/api/leaderboard')).value.entries[0].avatar,'rotation');
 const recon=await f.call('/api/pair',{agentId:a.agentId},s);await f.call('/api/agent',{action:'register_dot',arguments:{pairingCode:recon.value.pairingCode,name:'same'}});
 assert.equal((await f.call('/api/state',undefined,s)).value.agents[0].avatar,'rotation');
 await f.call('/api/agent/close',{agentId:a.agentId},s);assert.equal((await f.call('/api/avatar',{agentId:a.agentId,avatar:'trend'},s)).status,409);await f.call('/api/agent/restore',{agentId:a.agentId},s);
 assert.equal((await f.call('/api/state',undefined,s)).value.agents[0].avatar,'rotation');assert.equal(f.app.paper.account(a.agentId).nativeRaw,balance);
 for(const avatar of ['trend','rebound','rotation']){const res=await fetch(f.url+'/agent-'+avatar+'-v1.png');assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'image/png');assert.match(res.headers.get('cache-control'),/max-age=86400/);const bytes=new Uint8Array(await res.arrayBuffer());assert.deepEqual([...bytes.slice(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(bytes[25],6,'PNG retains RGBA transparency');}
});

test('a failed provider validation stops AI calls, and restart keeps the next evaluation time',async t=>{
 let calls=0;const f=await fixture(t,{showcase:true,showcaseOptions:{planner:{decide:async()=>{calls++;throw Error('Must not call invalid provider');}},configReader:()=>({apiKey:'test-placeholder',model:'gpt-5.4-mini',intervalMinutes:60,dailyCalls:12})}});
 f.app.store.put('settings',{id:'ai-provider',updatedAt:123});f.app.store.put('ai-validation',{id:'provider',configurationUpdatedAt:123,valid:false,reason:'OpenAI 密钥验证失败（HTTP 401），AI 调用已停用，请重新配置有效密钥。'});
 await f.app.showcase.run();assert.equal(calls,0);assert.equal(f.app.store.all('ai-usage').length,0);for(const p of SHOWCASE_PROFILES)assert.equal(f.app.store.get('showcase-status',p.id).state,'error');
 const id=SHOWCASE_PROFILES[0].id,next=Date.now()+3600000;f.app.store.put('showcase-status',{id,nextDecisionAt:next,state:'observing'});
 const {ShowcaseAgents}=await import('../lib/showcase-agents.mjs');const restarted=new ShowcaseAgents({store:f.app.store,vault:f.app.vault,paper:f.app.paper,gateway:f.g,execute:()=>{throw Error();}});assert.equal(f.app.store.get('showcase-status',id).nextDecisionAt,next);await restarted.stop();
});

test('homepage data keeps private Agents Owner-only and records actual authenticated Agent access',async t=>{
 const f=await fixture(t),one=await f.owner(),two=await f.owner(),a=await f.register(one,'Private Agent'),b=await f.register(two,'Other Agent');
 const initial=(await f.call('/api/state',undefined,one)).value;
 assert.deepEqual(initial.agents.map(x=>x.id),[a.agentId]);assert.equal(initial.agents[0].public,false);assert.equal(initial.agents[0].lastAgentRequestAt,undefined);
 assert.deepEqual((await f.call('/api/public')).value.agents,[]);assert.deepEqual((await f.call('/api/state')).value.agents,[]);
 assert.equal((await f.call('/api/agent',{action:'get_account',arguments:{}},null,{Authorization:'Bearer invalid-token'})).status,401);
 assert.equal(f.app.store.get('agents',a.agentId).lastAgentRequestAt,undefined);
 const before=Date.now(),account=await f.agentCall(a,'get_account');assert.equal(account.status,200);
 const visited=f.app.store.get('agents',a.agentId);assert.ok(visited.lastAgentRequestAt>=before);assert.equal(visited.lastAgentTool,'get_account');assert.equal(f.app.store.get('agents',b.agentId).lastAgentRequestAt,undefined);
 await f.call('/api/state',undefined,one);await f.call('/api/public');assert.equal(f.app.store.get('agents',a.agentId).lastAgentRequestAt,visited.lastAgentRequestAt);
 assert.equal((await f.call('/api/control',{agentId:a.agentId,public:true},two)).status,404);await f.call('/api/control',{agentId:a.agentId,public:true},one);
 const published=(await f.call('/api/public')).value;assert.deepEqual(published.agents.map(x=>x.id),[a.agentId]);assert.doesNotMatch(JSON.stringify(published),/encryptedKey|privateKey|agentToken|lastAgentTool|lastAgentRequestAt/);
 await f.call('/api/control',{agentId:a.agentId,public:false},one);assert.deepEqual((await f.call('/api/public')).value.agents,[]);assert.equal((await f.call('/api/state',undefined,one)).value.agents.length,1);
});
test('wallet login validates domain, chain, exact signer, purpose, expiration and one-use nonce',async t=>{const f=await fixture(t),s=await f.owner(),challenge=await f.call('/api/login/challenge',{address:OWNER.address});assert.match(challenge.value.message,new RegExp(new URL(f.url).host));assert.match(challenge.value.message,/Chain ID: 56/);const wrong=await OTHER.signMessage({message:challenge.value.message});assert.equal((await f.call('/api/login',{id:challenge.value.id,signature:wrong},s)).status,403);const signature=await OWNER.signMessage({message:challenge.value.message}),login=await f.call('/api/login',{id:challenge.value.id,signature},s);assert.equal(login.status,200);assert.equal(login.value.owner.address,OWNER.address.toLowerCase());assert.equal(login.value.owner.id,s.state.owner.id);assert.equal((await f.call('/api/login',{id:challenge.value.id,signature},s)).status,403);assert.equal((await f.call('/api/state',undefined,s)).value.owner,null);
 const expired=f.app.auth.challenge(OWNER.address);f.app.store.db.prepare('UPDATE challenges SET expires=0 WHERE id=?').run(expired.id);await assert.rejects(f.app.auth.verify(expired.id,await OWNER.signMessage({message:expired.message}),'login'),/失效/);
 const purpose=f.app.auth.challenge(OWNER.address,'recover',login.value.owner,'x');await assert.rejects(f.app.auth.verify(purpose.id,await OWNER.signMessage({message:purpose.message}),'login'),/用途/);
});
test('Owner sessions, pairing and Agent credentials are isolated; private keys never enter normal API output',async t=>{const f=await fixture(t),one=await f.owner(),two=await f.owner(),a=await f.register(one),b=await f.register(two),state1=await f.call('/api/state',undefined,one),state2=await f.call('/api/state',undefined,two);assert.equal(state1.value.agents.length,1);assert.equal(state1.value.agents[0].id,a.agentId);assert.equal(state2.value.agents[0].id,b.agentId);assert.doesNotMatch(JSON.stringify(state1.value),/encryptedKey|privateKey|agentToken|signed-tx/);assert.equal((await f.call('/api/control',{agentId:a.agentId,paused:true},two)).status,404);assert.equal((await f.call('/api/control',{agentId:a.agentId,paused:true},one,{'X-CSRF-Token':'wrong'})).status,403);assert.equal((await f.call('/api/pair',{},one,{Origin:'https://evil.invalid'})).status,403);assert.equal((await f.call('/api/agent',{action:'get_account',arguments:{}},null,{Authorization:'Bearer '+a.agentToken})).value.result.id,a.agentId);assert.equal((await f.agentCall(b,'get_trade',{id:'other-order'})).status,404);const hostStatus=await new Promise((ok,no)=>{const r=request(f.url+'/api/state',{headers:{Host:'evil.invalid'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});r.on('error',no);r.end();});assert.equal(hostStatus,403);
});

test('concurrent wallet logins cannot bind two signers to the same demo portfolio',async t=>{
 const f=await fixture(t),s=await f.owner(),agent=await f.register(s),original=f.app.store.get('agents',agent.agentId),balance=f.app.paper.account(agent.agentId);
 const signers=[OWNER,OTHER],challenges=await Promise.all(signers.map(signer=>f.call('/api/login/challenge',{address:signer.address}))),signatures=await Promise.all(challenges.map((c,i)=>signers[i].signMessage({message:c.value.message})));
 const verify=f.app.auth.verify.bind(f.app.auth);let arrived=0,release;const ready=new Promise(r=>release=r);
 f.app.auth.verify=async(...args)=>{const result=await verify(...args);if(++arrived===2)release();await ready;return result;};
 const logins=await Promise.all(challenges.map((c,i)=>f.call('/api/login',{id:c.value.id,signature:signatures[i]},s)));
 assert.ok(logins.every(r=>r.status===200));assert.notEqual(logins[0].value.owner.id,logins[1].value.owner.id);
 const sessions=logins.map(r=>({cookie:r.cookie,state:r.value})),states=await Promise.all(sessions.map(session=>f.call('/api/state',undefined,session)));
 for(let i=0;i<states.length;i++)assert.equal(states[i].value.owner.address,signers[i].address.toLowerCase());
 const claimant=states.findIndex(r=>r.value.owner.id===s.state.owner.id);assert.ok(claimant>=0);
 assert.deepEqual(states[claimant].value.agents.map(a=>a.id),[agent.agentId]);assert.deepEqual(states[1-claimant].value.agents,[]);
 assert.equal((await f.call('/api/control',{agentId:agent.agentId,paused:true},sessions[1-claimant])).status,404);
 assert.equal((await f.call('/api/state',undefined,s)).value.owner,null);assert.deepEqual(f.app.store.get('agents',agent.agentId),original);assert.deepEqual(f.app.paper.account(agent.agentId),balance);
 assert.equal((await f.agentCall(agent,'get_account')).status,200);
});

test('logout while a wallet signature is being verified prevents the stale session from claiming its demo portfolio',async t=>{
 const f=await fixture(t),s=await f.owner(),agent=await f.register(s),challenge=await f.call('/api/login/challenge',{address:OWNER.address}),signature=await OWNER.signMessage({message:challenge.value.message});
 const verify=f.app.auth.verify.bind(f.app.auth);let reached,release;const verifying=new Promise(r=>reached=r),ready=new Promise(r=>release=r);
 f.app.auth.verify=async(...args)=>{const result=await verify(...args);reached();await ready;return result;};
 const pending=f.call('/api/login',{id:challenge.value.id,signature},s);await verifying;
 assert.equal((await f.call('/api/logout',{},s)).status,200);release();const login=await pending;
 assert.equal(login.status,200);assert.equal(login.value.owner.address,OWNER.address.toLowerCase());assert.notEqual(login.value.owner.id,s.state.owner.id);assert.deepEqual(login.value.agents,[]);
 const old=f.app.store.get('owners',s.state.owner.id);assert.equal(old.kind,'demo');assert.equal(old.address,null);assert.equal(f.app.store.get('agents',agent.agentId).ownerId,old.id);
 assert.equal((await f.call('/api/state',undefined,s)).value.owner,null);assert.equal((await f.agentCall(agent,'get_account')).status,200);
});

test('wallet login without a browser session restores the same owner while an expired demo remains unclaimed',async t=>{
 const f=await fixture(t);
 async function login(signer,session){const c=await f.call('/api/login/challenge',{address:signer.address});return f.call('/api/login',{id:c.value.id,signature:await signer.signMessage({message:c.value.message})},session);}
 const first=await login(OWNER);assert.equal(first.status,200);const signedIn={cookie:first.cookie,state:first.value},agent=await f.register(signedIn),account=f.app.paper.account(agent.agentId);
 const again=await login(OWNER);assert.equal(again.status,200);assert.equal(again.value.owner.id,first.value.owner.id);assert.deepEqual(again.value.agents.map(a=>a.id),[agent.agentId]);assert.deepEqual(f.app.paper.account(agent.agentId),account);
 const s=await f.owner(),current=f.app.auth.session({headers:{cookie:s.cookie}}),challenge=f.app.auth.challenge(OTHER.address);
 f.app.store.db.prepare('UPDATE credentials SET expires=0 WHERE hash=?').run(current.hash);
 const issued=await f.app.auth.login(challenge.id,await OTHER.signMessage({message:challenge.message}),current);
 assert.notEqual(issued.owner.id,s.state.owner.id);assert.equal(issued.owner.address,OTHER.address.toLowerCase());assert.equal(f.app.store.get('owners',s.state.owner.id).address,null);
});
test('pairing expires/consumes once; reconnect rotates only token and retains wallet, capital and pause',async t=>{const f=await fixture(t),s=await f.owner(),p=await f.call('/api/pair',{},s),args={pairingCode:p.value.pairingCode,name:'First'},r=await f.call('/api/agent',{action:'register_dot',arguments:args}),a=r.value.result;assert.equal((await f.call('/api/agent',{action:'register_dot',arguments:args})).status,403);await f.call('/api/control',{agentId:a.agentId,paused:true},s);f.app.paper.seed(a.agentId,1000);const p2=await f.call('/api/pair',{agentId:a.agentId},s),r2=await f.call('/api/agent',{action:'register_dot',arguments:{pairingCode:p2.value.pairingCode,name:'Different'}}),b=r2.value.result;assert.equal(b.agentId,a.agentId);assert.equal(b.address,a.address);assert.equal(b.paused,true);assert.equal((await f.agentCall(a,'get_account')).status,401);assert.equal((await f.agentCall(b,'get_account')).status,200);assert.equal(f.app.paper.account(a.agentId).nativeRaw,'1000000000000000000');assert.equal(f.app.store.get('agents',a.agentId).name,'First');
 const p3=await f.call('/api/pair',{},s),row=f.app.store.get('pairings',(await import('../lib/database.mjs')).digest(p3.value.pairingCode));row.expiresAt=0;f.app.store.put('pairings',row);assert.equal((await f.call('/api/agent',{action:'register_dot',arguments:{pairingCode:p3.value.pairingCode,name:'expired'}})).status,403);
});
test('paper uses a later block, exact quote sizes, fees and a balanced FIFO ledger; duplicates do not trade twice',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s),args={token:TOKEN,amount:'10000000000000000',requestKey:'buy-1',reason:'Verified test fixture signal'},r=await f.agentCall(a,'buy_token',args);assert.equal(r.status,200);const id=r.value.result.id;assert.equal((await f.agentCall(a,'buy_token',args)).value.result.id,id);assert.equal((await f.agentCall(a,'buy_token',{...args,amount:'20000000000000000'})).status,409);assert.equal((await f.agentCall(a,'buy_token',{...args,requestKey:'buy-2'})).status,409);await f.app.paper.tick();assert.equal(f.app.paper.fills(a.agentId).length,0);const order=f.app.store.get('paper-orders',id);order.dueAt=Date.now()-1;f.app.store.put('paper-orders',order);await f.app.paper.tick();assert.equal(f.app.paper.fills(a.agentId).length,0);f.g.advance();await f.app.paper.tick();assert.equal(f.app.paper.fills(a.agentId).length,1);assert.equal(f.app.paper.account(a.agentId).nativeRaw,'989990000000000000');assert.equal(f.app.paper.check(a.agentId),true);assert.equal(f.g.quotes[0].nativeAmountRaw,args.amount);assert.equal(f.g.quotes[1].tokenAmountRaw,'10000000000000000000');assert.equal(f.g.quotes[2].nativeAmountRaw,args.amount);
 const data=viem.encodeFunctionData({abi:v2Abi,functionName:'swapExactTokensForETHSupportingFeeOnTransferTokens',args:[5000000000000000000n,0n,[TOKEN,WBNB],a.address,9999999999n]}),sale=await f.agentCall(a,'submit_transaction',{to:ROUTER_V2,data,value:'0',requestKey:'sell-half'});assert.equal(sale.status,200);let o=f.app.store.get('paper-orders',sale.value.result.id);o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();assert.equal(f.app.paper.lots(a.agentId)[0].remainingRaw,'5000000000000000000');assert.equal(f.app.paper.fills(a.agentId)[1].netRaw,'-15000000000000');assert.equal(f.app.paper.check(a.agentId),true);assert.equal((await f.agentCall(a,'get_trade',{id})).value.result.status,'filled');
});
test('paper rejects stale data, size above available balance, wrong recipient, unknown calls and suspended Agents',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s);assert.equal((await f.agentCall(a,'buy_token',{token:TOKEN,amount:'1000000000000000000',requestKey:'over'})).status,400);assert.equal(f.app.paper.fills(a.agentId).length,0);f.g.headAt=0;assert.equal((await f.agentCall(a,'buy_token',{token:TOKEN,amount:'10000000000000000',requestKey:'stale'})).status,503);f.g.headAt=Date.now();assert.equal((await f.agentCall(a,'submit_transaction',{to:TOKEN,data:'0x',value:'1',requestKey:'generic'})).status,400);const bad=viem.encodeFunctionData({abi:v2Abi,functionName:'swapExactETHForTokens',args:[0n,[WBNB,TOKEN],OTHER.address,9999999999n]});assert.equal((await f.agentCall(a,'submit_transaction',{to:ROUTER_V2,data:bad,value:'10000000000000000',requestKey:'bad-recipient'})).status,400);const order=await f.agentCall(a,'buy_token',{token:TOKEN,amount:'10000000000000000',requestKey:'valid'});assert.equal(order.status,200);await f.call('/api/control',{agentId:a.agentId,paused:true},s);assert.equal(f.app.store.get('paper-orders',order.value.result.id).status,'cancelled');assert.equal((await f.agentCall(a,'buy_token',{token:TOKEN,amount:'10000000000000000',requestKey:'paused'})).status,409);
});
test('a quote interrupted by pause or feed generation never creates a fill',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s);const q=f.g.quote.bind(f.g);let release;f.g.quote=async p=>{await new Promise(r=>release=r);return q(p);};const pending=f.agentCall(a,'buy_token',{token:TOKEN,amount:'10000000000000000',requestKey:'race'});while(!release)await new Promise(r=>setTimeout(r,5));await f.call('/api/control',{agentId:a.agentId,paused:true},s);release();assert.equal((await pending).status,409);assert.equal(f.app.paper.orders(a.agentId).length,0);assert.equal(f.app.paper.fills(a.agentId).length,0);
});
test('paper pending state is cancelled on restart; actual filled capital is retained',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s);const r=await f.agentCall(a,'buy_token',{token:TOKEN,amount:'10000000000000000',requestKey:'restart'});const {PaperDesk}=await import('../lib/paper-desk.mjs');const restarted=new PaperDesk(f.app.store,f.g);assert.equal(restarted.orders(a.agentId)[0].status,'cancelled');assert.equal(restarted.account(a.agentId).nativeRaw,'1000000000000000000');assert.equal(restarted.check(a.agentId),true);
});
test('public visibility requires opt-in; paper/live filters and no secret material',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s);assert.equal((await f.call('/api/public')).value.agents.length,0);await f.call('/api/control',{agentId:a.agentId,public:true},s);const p=(await f.call('/api/public')).value;assert.equal(p.agents.length,1);assert.equal(p.agents[0].id,a.agentId);assert.doesNotMatch(JSON.stringify(p),/ownerId|encryptedKey|privateKey|agentToken|policy|signed/);assert.equal((await f.call('/api/control',{agentId:a.agentId,mode:'live'},s)).status,403);await f.call('/api/control',{agentId:a.agentId,public:false},s);assert.equal((await f.call('/api/public')).value.agents.length,0);
});
test('all real-money entry points are locked before signing/broadcast, even with valid Agent credentials',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s),stored=f.app.store.get('agents',a.agentId);stored.mode='live';f.app.store.put('agents',stored);let signed=0,rpcCalls=0;f.app.vault.account=()=>{signed++;throw Error('unexpected signing');};f.rpc.prepare=async()=>{rpcCalls++;throw Error('unexpected RPC');};f.rpc.buyTransaction=f.rpc.prepare;f.rpc.broadcast=f.rpc.prepare;
 assert.equal((await f.agentCall(a,'buy_token',{token:TOKEN,amount:'1',requestKey:'locked'})).status,423);assert.equal((await f.agentCall(a,'submit_transaction',{to:TOKEN,data:'0x',value:'0',requestKey:'locked-2'})).status,423);assert.equal((await f.call('/api/recovery/challenge',{agentId:a.agentId},s)).status,423);assert.equal((await f.call('/api/withdraw/challenge',{agentId:a.agentId,amountWei:'1'},s)).status,423);assert.equal((await f.call('/api/recovery',{id:'x',signature:'x'},s)).status,423);assert.equal((await f.call('/api/withdraw',{id:'x',signature:'x'},s)).status,423);assert.equal(signed,0);assert.equal(rpcCalls,0);assert.equal(f.app.live.orders().length,0);assert.equal((await f.call('/api/health')).value.liveEnabled,false);
});
function mockRpc(){const rpc={raw:[],found:null,client:{getBlockNumber:async()=>103n},async prepare(a,tx){return {...tx,gas:21000n,gasPrice:1000000000n,nonce:7,chainId:56,type:'legacy'};},async broadcast(raw){this.raw.push(raw);return viem.keccak256(raw);},async receipt(){return this.found;},async block(){return {hash:'0x'+'ab'.repeat(32),timestamp:1000n};}};return rpc;}
test('mock live signing persists exact bytes and hash, enforces one pending nonce, retries identical bytes after restart',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s),stored=f.app.store.get('agents',a.agentId);stored.mode='live';f.app.store.put('agents',stored);const rpc=mockRpc(),desk=new LiveDesk(f.app.store,f.app.vault,rpc,{enabled:true}),tx={to:OTHER.address.toLowerCase(),data:'0x',value:1n,kind:'transfer'},id='mock-live-1',o=await desk.submit(stored,id,tx);assert.equal(o.status,'submitted');assert.equal(rpc.raw.length,1);const decoded=viem.parseTransaction(rpc.raw[0]);assert.equal(decoded.chainId,56);assert.equal(decoded.nonce,7);assert.equal(await viem.recoverTransactionAddress({serializedTransaction:rpc.raw[0]}),viem.getAddress(a.address));assert.ok(f.app.store.get('live-orders',id).signed.data);await assert.rejects(desk.submit(stored,'mock-live-2',tx),/待核对/);o.signedAt=0;o.lastRetryAt=0;f.app.store.put('live-orders',o);const restart=new LiveDesk(f.app.store,f.app.vault,rpc,{enabled:true});await restart.reconcile(o);assert.equal(rpc.raw.length,2);assert.equal(rpc.raw[0],rpc.raw[1]);rpc.found={status:'success',gasUsed:21000n,effectiveGasPrice:1000000000n,blockNumber:101n,blockHash:'0x'+'ab'.repeat(32),logs:[]};await restart.reconcile(o);assert.equal(f.app.store.get('live-orders',id).status,'confirmed');const row=f.app.store.get('live-activity',id);assert.equal(row.netRaw,null);assert.equal(row.kind,'transfer');assert.equal(f.app.store.all('live-lots').length,0);await restart.reconcile(f.app.store.get('live-orders',id));assert.equal(f.app.store.all('live-activity').length,1);
});
test('live receipt cannot be booked before canonical finality; off mode cannot resend a previously signed transaction',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s),stored=f.app.store.get('agents',a.agentId);stored.mode='live';f.app.store.put('agents',stored);const rpc=mockRpc(),desk=new LiveDesk(f.app.store,f.app.vault,rpc,{enabled:true}),o=await desk.submit(stored,'canonical',{to:OTHER.address.toLowerCase(),data:'0x',value:1n});rpc.found={status:'success',gasUsed:21000n,effectiveGasPrice:1n,blockNumber:102n,blockHash:'0x'+'ab'.repeat(32),logs:[]};await desk.reconcile(o);assert.equal(f.app.store.all('live-activity').length,0);rpc.found.blockNumber=101n;rpc.found.blockHash='0x'+'cd'.repeat(32);await desk.reconcile(o);assert.equal(f.app.store.all('live-activity').length,0);const off=new LiveDesk(f.app.store,f.app.vault,rpc,{enabled:false});await assert.rejects(off.reconcile(o),/尚未开启/);await off.tick();assert.equal(rpc.raw.length,1);
});
function transfer(from,to,value){return {address:TOKEN,topics:viem.encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from,to}}),data:viem.encodeAbiParameters([{type:'uint256'}],[value])};}
test('real receipt FIFO includes gas; unknown transferred cost and withdrawals are never profit',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s),agent=f.app.store.get('agents',a.agentId),gas=10n;const buyData=viem.encodeFunctionData({abi:v2Abi,functionName:'swapExactETHForTokensSupportingFeeOnTransferTokens',args:[0n,[WBNB,TOKEN],a.address,9999999999n]}),buy={id:'buy-live',agentId:a.agentId,hash:'0x'+'aa'.repeat(32),transaction:{to:ROUTER_V2,data:buyData,value:'1000'}};
 recordReceipt(f.app.store,agent,buy,{status:'success',gasUsed:gas,effectiveGasPrice:1n,blockNumber:1n,logs:[transfer(ROUTER_V2,a.address,100n)]},1);assert.equal(f.app.store.all('live-lots')[0].nativeCostRaw,'1010');const data=viem.encodeFunctionData({abi:v2Abi,functionName:'swapExactTokensForETHSupportingFeeOnTransferTokens',args:[50n,0n,[TOKEN,WBNB],a.address,9999999999n]}),withdrawAbi=viem.parseAbi(['event Withdrawal(address indexed src,uint256 wad)']),withdrawLog={address:WBNB,topics:viem.encodeEventTopics({abi:withdrawAbi,eventName:'Withdrawal',args:{src:ROUTER_V2}}),data:viem.encodeAbiParameters([{type:'uint256'}],[600n])},sell={id:'sell-live',hash:'0x'+'bb'.repeat(32),transaction:{to:ROUTER_V2,data,value:'0'}};
 recordReceipt(f.app.store,agent,sell,{status:'success',gasUsed:gas,effectiveGasPrice:1n,blockNumber:2n,logs:[transfer(a.address,ROUTER_V2,50n),withdrawLog]},2);assert.equal(f.app.store.get('live-activity','sell-live').netRaw,'85');assert.equal(f.app.store.all('live-lots')[0].remainingRaw,'50');sell.id='unknown-cost';recordReceipt(f.app.store,agent,sell,{status:'success',gasUsed:gas,effectiveGasPrice:1n,blockNumber:3n,logs:[transfer(a.address,ROUTER_V2,100n),withdrawLog]},3);assert.equal(f.app.store.get('live-activity','unknown-cost').netRaw,null);assert.equal(f.app.store.get('live-activity','unknown-cost').unknownCost,true);
 recordReceipt(f.app.store,agent,{id:'withdraw',kind:'withdraw',hash:'0x'+'cc'.repeat(32),transaction:{to:OWNER.address,data:'0x',value:'1'}},{status:'success',gasUsed:gas,effectiveGasPrice:1n,blockNumber:4n,logs:[]},4);assert.equal(f.app.store.get('live-activity','withdraw').netRaw,null);
});
test('MCP initializes, lists core tools, scopes access and reports tool errors; GET SSE is explicitly unsupported',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s),init=await f.call('/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});assert.equal(init.value.result.protocolVersion,'2025-06-18');const list=await f.call('/mcp',{jsonrpc:'2.0',id:2,method:'tools/list'});assert.deepEqual(list.value.result.tools.map(t=>t.name),['register_dot','get_account','buy_token','submit_transaction','get_trade']);const result=await f.call('/mcp',{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_account',arguments:{}}},null,{Authorization:'Bearer '+a.agentToken});assert.equal(JSON.parse(result.value.result.content[0].text).id,a.agentId);const bad=await f.call('/mcp',{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get_account',arguments:{}}});assert.equal(bad.value.result.isError,true);assert.equal((await f.call('/mcp')).status,405);
});
test('failed quote preparation is visible in Owner orders and stable retries return the same failure',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s);f.g.failure=Error('Verified fixture: route unavailable');const args={token:TOKEN,amount:'10000000000000000',requestKey:'no-route'},r=await f.agentCall(a,'buy_token',args);assert.equal(r.status,503);assert.match(r.value.error,/route unavailable/);const state=(await f.call('/api/state',undefined,s)).value;assert.equal(state.orders.length,1);assert.equal(state.orders[0].status,'failed');assert.match(state.orders[0].error,/route unavailable/);assert.equal(state.activity.length,0);const retry=await f.agentCall(a,'buy_token',args);assert.equal(retry.value.result.id,state.orders[0].id);assert.equal(retry.value.result.status,'failed');assert.equal(f.g.calls,1);
});
test('fresh Owner signatures bind recovery and withdrawal to their purpose, Agent, amount and recipient; mock transport only',async t=>{const rpc=mockRpc();rpc.balance=async()=>1000000000000000000n;const f=await fixture(t,{liveEnabled:true,rpc}),guest=await f.owner(),c=(await f.call('/api/login/challenge',{address:OWNER.address})).value,logged=await f.call('/api/login',{id:c.id,signature:await OWNER.signMessage({message:c.message})},guest),s={cookie:logged.cookie,state:logged.value},a=await f.register(s);assert.equal((await f.call('/api/control',{agentId:a.agentId,mode:'live'},s)).status,200);
 const recover=(await f.call('/api/recovery/challenge',{agentId:a.agentId},s)).value;assert.equal((await f.call('/api/recovery',{id:recover.id,signature:await OTHER.signMessage({message:recover.message})},s)).status,403);const signature=await OWNER.signMessage({message:recover.message}),r=await f.call('/api/recovery',{id:recover.id,signature},s);assert.equal(r.status,200);assert.equal(accounts.privateKeyToAccount(r.value.privateKey).address.toLowerCase(),a.address);assert.equal(f.app.store.get('agents',a.agentId).paused,true);assert.equal((await f.call('/api/recovery',{id:recover.id,signature},s)).status,403);assert.equal(rpc.raw.length,0);
 const w=(await f.call('/api/withdraw/challenge',{agentId:a.agentId,amountWei:'123456789'},s)).value;assert.match(w.message,/123456789/);assert.match(w.message,new RegExp(OWNER.address.toLowerCase()));const sig=await OWNER.signMessage({message:w.message});assert.equal((await f.call('/api/recovery',{id:w.id,signature:sig},s)).status,403);const sent=await f.call('/api/withdraw',{id:w.id,signature:sig},s);assert.equal(sent.status,200);assert.equal(sent.value.status,'submitted');const tx=viem.parseTransaction(rpc.raw[0]);assert.equal(tx.to.toLowerCase(),OWNER.address.toLowerCase());assert.equal(tx.value,123456789n);assert.equal(tx.chainId,56);assert.equal((await f.call('/api/withdraw',{id:w.id,signature:sig},s)).status,403);
});
test('Owner-signed limited policy is enforced in paper preparation AND new-block fill',async t=>{const f=await fixture(t),guest=await f.owner(),c=(await f.call('/api/login/challenge',{address:OWNER.address})).value,logged=await f.call('/api/login',{id:c.id,signature:await OWNER.signMessage({message:c.message})},guest),s={cookie:logged.cookie,state:logged.value},a=await f.register(s),p=(await f.call('/api/policy/challenge',{agentId:a.agentId,mode:'limited',tokens:[TOKEN],budgetWei:'20000000000000000',maxGasWei:'1000000000000000',expiresAt:Date.now()+86400000},s)).value;assert.equal((await f.call('/api/policy',{id:p.id,signature:await OWNER.signMessage({message:p.message})},s)).status,200);assert.equal((await f.agentCall(a,'submit_transaction',{to:TOKEN,data:'0x',value:'0',requestKey:'generic-limited'})).status,403);const r=await f.agentCall(a,'buy_token',{token:TOKEN,amount:'10000000000000000',requestKey:'limited-buy'});assert.equal(r.status,200);const agent=f.app.store.get('agents',a.agentId);agent.policy.expiresAt=0;f.app.store.put('agents',agent);const o=f.app.store.get('paper-orders',r.value.result.id);o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();assert.equal(f.app.store.get('paper-orders',o.id).status,'failed');assert.equal(f.app.paper.fills(a.agentId).length,0);
});
test('idempotence ignores JSON field order and accepts original pre-upgrade digests without a second order',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s),args={token:TOKEN,amount:'10000000000000000',requestKey:'stable'},first=await f.agentCall(a,'buy_token',args),second=await f.agentCall(a,'buy_token',{requestKey:args.requestKey,amount:args.amount,token:args.token});assert.equal(first.value.result.id,second.value.result.id);const {digest,json}=await import('../lib/database.mjs');f.app.store.db.prepare('UPDATE intents SET signature=? WHERE agent=? AND requestKey=?').run(digest(json({action:'buy_token',args})),a.agentId,args.requestKey);assert.equal((await f.agentCall(a,'buy_token',args)).value.result.id,first.value.result.id);assert.equal(f.app.paper.orders(a.agentId).length,1);
});
test('generic token transfers consume old FIFO inventory; returned assets have unknown costs',async t=>{const f=await fixture(t),s=await f.owner(),a=await f.register(s),agent=f.app.store.get('agents',a.agentId);f.app.store.put('live-lots',{id:'original',agentId:a.agentId,token:TOKEN,remainingRaw:'100',nativeCostRaw:'1010',at:0});const tx={to:TOKEN,data:'0x',value:'0'},receipt=logs=>({status:'success',gasUsed:10n,effectiveGasPrice:1n,blockNumber:1n,logs});recordReceipt(f.app.store,agent,{id:'transfer-out',hash:'0x'+'aa'.repeat(32),transaction:tx},receipt([transfer(a.address,OTHER.address,100n)]),1);assert.equal(f.app.store.get('live-lots','original').remainingRaw,'0');recordReceipt(f.app.store,agent,{id:'returned',hash:'0x'+'ab'.repeat(32),transaction:tx},receipt([transfer(OTHER.address,a.address,100n)]),2);const newLot=f.app.store.all('live-lots').find(p=>p.orderId==='returned');assert.equal(newLot.nativeCostRaw,null);assert.equal(f.app.store.get('live-activity','returned').netRaw,null);
});

test('old 200U capital is topped up once with a separate balanced ledger, retaining positions and PnL',async t=>{
 const f=await fixture(t),s=await f.owner(),a=await f.register(s);f.app.store.put('paper-accounts',{id:a.agentId,initialUsd:200,nativeRaw:'150000000000000000',seedFx:1000,realizedNativeRaw:'-2000000000000000',realizedUsd:-2,feesUsd:3});f.app.paper.ledger(a.agentId,'150000000000000000','legacy');
 f.app.store.put('paper-lots',{id:'legacy-lot',agentId:a.agentId,token:TOKEN,remainingRaw:'100',decimals:18,nativeCostRaw:'50000000000000000',usdCost:50,at:Date.now()});
 const view=f.app.paper.view(a.agentId);assert.equal(view.initialUsd,1000);assert.equal(view.nativeRaw,'950000000000000000');assert.equal(view.realizedUsd,-2);assert.equal(view.positions[0].remainingRaw,'100');assert.equal(f.app.paper.check(a.agentId),true);
 f.app.paper.view(a.agentId);const rows=f.app.store.all('paper-ledger').filter(x=>x.kind==='virtual-capital-adjustment');assert.equal(rows.length,1);assert.equal(rows[0].usdDelta,800);
});
test('paper fills above 40U while preserving balance and later-block checks',async t=>{
 const f=await fixture(t),s=await f.owner(),a=await f.register(s),r=await f.agentCall(a,'buy_token',{token:TOKEN,amount:'150000000000000000',requestKey:'large'});assert.equal(r.status,200);assert.equal(f.app.paper.fills(a.agentId).length,0);const o=f.app.store.get('paper-orders',r.value.result.id);o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();assert.equal(f.app.paper.fills(a.agentId).length,1);assert.equal(f.app.paper.account(a.agentId).nativeRaw,'849990000000000000');assert.equal(f.app.paper.check(a.agentId),true);
});
test('three builtins are permanently public paper Agents; missing key causes no fake trades or owner exposure',async t=>{
 const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>null}}),s=await f.owner();await f.app.showcase.tick();
 const p=(await f.call('/api/public')).value;assert.equal(p.agents.length,3);assert.ok(p.agents.every(a=>a.mode==='paper'&&a.source==='builtin'&&a.initialUsd===1000&&a.runtime.state==='needs-config'));assert.deepEqual((await f.call('/api/state',undefined,s)).value.agents,[]);assert.equal(f.app.paper.fills().length,0);assert.equal(f.g.quotes.length,0);
 for(const a of p.agents){assert.equal((await f.call('/api/control',{agentId:a.id,mode:'live'},s)).status,404);assert.equal((await f.call('/api/pair',{agentId:a.id},s)).status,404);assert.equal((await f.call('/api/public/agent?id='+a.id)).value.agent.id,a.id);}
 assert.doesNotMatch(JSON.stringify(p),/ownerId|encryptedKey|apiKey|privateKey|agentToken/);
 const {ShowcaseAgents}=await import('../lib/showcase-agents.mjs'),again=new ShowcaseAgents({store:f.app.store,vault:f.app.vault,paper:f.app.paper,gateway:f.g,execute:()=>{},configReader:()=>null});assert.equal(f.app.store.all('agents').length,3);assert.deepEqual(f.app.store.all('agents').map(a=>a.address),p.agents.map(a=>a.address));await again.stop();
});

test('reconstruction preserves completed decisions and outage states without presenting a lost model task as running',async t=>{
 const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>null}}),at=Date.now()-5000;
 const completed={id:SHOWCASE_PROFILES[0].id,state:'observing',reason:'已经完成自主退出评估',checkedAt:at,lastDecisionAt:at,nextDecisionAt:Date.now()+60000,decision:{action:'hold',token:null,sizeUsd:null,reason:'继续观察',exit:null}};
 const waiting={...completed,id:SHOWCASE_PROFILES[1].id,state:'waiting-risk',reason:'风险资料暂不可用'};
 const interrupted={...completed,id:SHOWCASE_PROFILES[2].id,state:'thinking',reason:'AI 正在评估'};
 for(const row of [completed,waiting,interrupted])f.app.store.put('showcase-status',row);
 const accounts=f.app.store.all('paper-accounts'),beforeCalls=f.g.calls;
 const {ShowcaseAgents}=await import('../lib/showcase-agents-core.mjs');
 const rebuilt=new ShowcaseAgents({store:f.app.store,vault:f.app.vault,paper:f.app.paper,gateway:f.g,execute:()=>{throw Error('No order during reconstruction');},riskGuard:{close:async()=>{}},configReader:()=>null});
 assert.deepEqual(f.app.store.get('showcase-status',completed.id),completed);assert.deepEqual(f.app.store.get('showcase-status',waiting.id),waiting);
 const recovered=f.app.store.get('showcase-status',interrupted.id);assert.equal(recovered.state,'observing');assert.match(recovered.reason,/重启中断/);assert.equal(recovered.lastDecisionAt,at);assert.equal(recovered.nextDecisionAt,interrupted.nextDecisionAt);assert.equal(recovered.checkedAt,at);
 assert.deepEqual(f.app.store.all('paper-accounts'),accounts);assert.equal(f.app.paper.orders().length,0);assert.equal(f.g.calls,beforeCalls);await rebuilt.stop();
});
test('AI proposals execute through paper quotes above 40U and stop/TP checks; no real transport',async t=>{
 let calls=0;const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>({model:'test-model',intervalMinutes:15,dailyCalls:1}),planner:{async decide(c,strategy,context){calls++;assert.equal(context.account.initialUsd,1000);assert.doesNotMatch(JSON.stringify(context),/encryptedKey|ownerId|agentToken|apiKey/);return {action:'buy',token:TOKEN,sizeUsd:150,reason:'测试模型依据采样提出模拟决策',exit:{takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60}};}}}});
 await f.app.showcase.tick();assert.equal(calls,1);assert.equal(f.app.paper.orders().length,1);assert.equal(f.app.paper.fills().length,0);assert.equal(f.app.store.get('showcase-status',SHOWCASE_PROFILES[1].id).state,'quota');
 const o=f.app.paper.orders()[0];o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();assert.equal(f.app.paper.fills().length,1);assert.equal(f.app.paper.fills()[0].usd,150.01);
 f.g.fx=1200;f.app.showcase.tickAt=0;f.app.showcase.exitChecks.clear();await f.app.showcase.tick();const sale=f.app.paper.orders().find(x=>x.side==='sell');assert.ok(sale);assert.match(sale.reason,/止盈/);sale.dueAt=Date.now()-1;f.app.store.put('paper-orders',sale);f.g.advance();await f.app.paper.tick();assert.equal(f.app.paper.fills().length,2);assert.ok(f.app.paper.fills()[1].netUsd>0);assert.equal(f.app.paper.check(o.agentId),true);assert.equal(f.app.live.orders().length,0);
 const rank=(await f.call('/api/leaderboard')).value;assert.equal(rank.entries[0].id,o.agentId);assert.equal(rank.entries[0].rank,1);assert.ok(rank.entries[0].returnPct>0);assert.equal(calls,1);
});
test('hold proposals cannot replace active entry rules; model context, public details and actual stop execution agree',async t=>{
 let calls=0,heldContext;const entry={takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60};
 const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>({model:'test-model',intervalMinutes:1,dailyCalls:null}),planner:{async decide(_c,_s,context){calls++;if(calls===1)return {action:'buy',token:TOKEN,sizeUsd:150,reason:'测试入场',exit:entry};heldContext=context;return {action:'hold',token:null,sizeUsd:null,reason:'持有，不修改入场规则',exit:{takeProfitPct:30,stopLossPct:15,maxHoldMinutes:1440}};}}}});
 const a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id);
 for(const p of SHOWCASE_PROFILES.slice(1))f.app.store.put('agents',{...f.app.store.get('agents',p.id),paused:true});
 await f.app.showcase.run();const buy=f.app.paper.orders(a.id)[0];buy.dueAt=Date.now()-1;f.app.store.put('paper-orders',buy);f.g.advance();await f.app.paper.tick();
 const saved=f.app.store.get('showcase-exits',buy.id);assert.equal(f.app.paper.lots(a.id).length,1);
 f.app.showcase.status(a.id,{nextDecisionAt:0});f.app.showcase.exitChecks.clear();await f.app.showcase.run();
 assert.equal(calls,2);assert.deepEqual(heldContext.account.positions[0].exitPlan.rule,entry);
 assert.equal(heldContext.account.positions[0].exitPlan.entryOrderId,buy.id);assert.equal(heldContext.account.positions[0].costUsd,150.01);
 assert.deepEqual(f.app.store.get('showcase-exits',buy.id),saved);
 const detail=(await f.call('/api/public/agent?id='+a.id)).value.agent;assert.equal(detail.exitPlans.length,1);assert.deepEqual(detail.exitPlans[0].rule,entry);assert.equal(detail.exitPlans[0].state,'active');
 assert.equal(detail.exitPlans[0].deadlineAt,heldContext.account.positions[0].exitPlan.deadlineAt);assert.doesNotMatch(JSON.stringify(detail),/encryptedKey|ownerId|agentToken|apiKey/);
 f.g.fx=940;f.g.advance();f.app.showcase.exitChecks.clear();await f.app.showcase.run();
 const sell=f.app.paper.orders(a.id).find(o=>o.side==='sell');assert.ok(sell);assert.match(sell.reason,/止损/);assert.equal(calls,2);
 sell.dueAt=Date.now()-1;f.app.store.put('paper-orders',sell);f.g.advance();await f.app.paper.tick();
 assert.equal(f.app.paper.lots(a.id).length,0);assert.equal(f.app.paper.check(a.id),true);assert.deepEqual((await f.call('/api/public/agent?id='+a.id)).value.agent.exitPlans,[]);assert.equal(f.app.live.orders().length,0);
});

test('AI can replace a legacy 4/2 exit, remove fixed conditions and later sell through the real isolated paper executor',async t=>{
 let phase='buy',seen;
 const f=await fixture(t,{showcase:true,showcaseOptions:{maxAgentsPerRun:1,configReader:()=>({model:'test',intervalMinutes:1,dailyCalls:null}),planner:{async decide(_c,_s,context){seen=context;
  if(phase==='buy')return {action:'buy',token:TOKEN,sizeUsd:100,reason:'隔离入场',exit:{takeProfitPct:4,stopLossPct:2,maxHoldMinutes:240}};
  if(phase==='target')return {action:'manage',token:TOKEN,sizeUsd:null,reason:'根据新证据自主扩大收益目标，不设固定时限',exit:{takeProfitPct:1000,stopLossPct:null,maxHoldMinutes:null}};
  if(phase==='clear')return {action:'manage',token:TOKEN,sizeUsd:null,reason:'由后续行情评估退出，不设固定涨幅',exit:null};
  if(phase==='sell')return {action:'sell',token:TOKEN,sizeUsd:null,reason:'自主决定退出，仍须核价',exit:null};
  return {action:'hold',token:null,sizeUsd:null,reason:'继续持有，不强制小幅止盈',exit:null};
 }}}});
 const a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id),run=async()=>{f.app.showcase.status(a.id,{nextDecisionAt:0});f.app.showcase.exitChecks.clear();await f.app.showcase.run({agentId:a.id});};
 await run();const buy=f.app.paper.orders(a.id)[0];buy.dueAt=Date.now()-1;f.app.store.put('paper-orders',buy);f.g.advance();await f.app.paper.tick();
 const legacy={...f.app.store.get('showcase-exits',buy.id),policyVersion:1};f.app.store.put('showcase-exits',legacy);const originalLots=f.app.paper.lots(a.id);
 f.g.fx=1200;phase='target';await run();assert.equal(seen.account.positions[0].exitPlan.state,'ai-managed');assert.equal(seen.account.positions[0].exitPlan.previousRule.takeProfitPct,4);
 let plan=(await f.call('/api/public/agent?id='+a.id)).value.agent.exitPlans[0];assert.equal(plan.rule.takeProfitPct,1000);assert.equal(plan.rule.stopLossPct,null);assert.equal(plan.deadlineAt,null);assert.equal(f.app.paper.orders(a.id).length,1);
 phase='clear';await run();plan=(await f.call('/api/public/agent?id='+a.id)).value.agent.exitPlans[0];assert.equal(plan.state,'ai-managed');assert.equal(plan.rule.takeProfitPct,null);assert.equal(f.app.store.all('showcase-exit-updates').length,2);
 assert.deepEqual(f.app.store.get('showcase-exits',buy.id),legacy);assert.deepEqual(f.app.paper.lots(a.id),originalLots);
 f.g.fx=2000;phase='hold';const quotes=f.g.calls;await run();assert.equal(f.g.calls,quotes);assert.equal(f.app.paper.orders(a.id).length,1,'A price rise above the legacy 4% does not force a sale');
 phase='sell';await run();const sale=f.app.paper.orders(a.id).find(o=>o.side==='sell');assert.ok(sale);assert.equal(sale.status,'queued');assert.equal(f.app.paper.fills(a.id).length,1);
 sale.dueAt=Date.now()-1;f.app.store.put('paper-orders',sale);f.g.advance();await f.app.paper.tick();assert.equal(f.app.paper.fills(a.id).length,2);assert.equal(f.app.paper.lots(a.id).length,0);assert.equal(f.app.paper.check(a.id),true);assert.equal(f.app.live.orders().length,0);
});

test('nullable take-profit and deadline do not accidentally trigger at zero; AI-selected stop remains executable',async t=>{
 const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>null}}),a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id);
 const o=await f.app.paper.submit(a,{id:'optional-stop',token:TOKEN,side:'buy',amount:'100000000000000000'});o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();
 f.app.store.put('showcase-exits',{id:o.id,agentId:a.id,token:TOKEN,policyVersion:2,takeProfitPct:null,stopLossPct:5,maxHoldMinutes:null});
 f.g.fx=1200;assert.equal(await f.app.showcase.exits(a),false);assert.equal(f.app.paper.orders(a.id).length,1);
 f.g.fx=940;assert.equal(await f.app.showcase.exits(a),true);assert.match(f.app.paper.orders(a.id).find(o=>o.side==='sell').reason,/止损/);assert.equal(f.app.live.orders().length,0);
});

test('a buy without fixed exits stays AI-managed and a paused or stale model cannot revise its plan',async t=>{
 let phase='buy',release,started;
 const f=await fixture(t,{showcase:true,showcaseOptions:{maxAgentsPerRun:1,configReader:()=>({model:'test',intervalMinutes:1,dailyCalls:null}),planner:{async decide(){
  if(phase==='buy')return {action:'buy',token:TOKEN,sizeUsd:50,reason:'自主选择入场，后续评估退出',exit:null};
  started();return new Promise(r=>{release=()=>r({action:'manage',token:TOKEN,sizeUsd:null,reason:'模型待完成的修改',exit:{takeProfitPct:1000,stopLossPct:null,maxHoldMinutes:null}});});
 }}}}),a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id);
 await f.app.showcase.run({agentId:a.id});const o=f.app.paper.orders(a.id)[0];o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();
 assert.equal((await f.call('/api/public/agent?id='+a.id)).value.agent.exitPlans[0].state,'ai-managed');const lots=f.app.paper.lots(a.id),saved=f.app.store.get('showcase-exits',o.id);
 phase='manage';f.app.showcase.status(a.id,{nextDecisionAt:0});const ready=new Promise(r=>started=r),task=f.app.showcase.run({agentId:a.id});await ready;
 f.app.store.put('agents',{...a,paused:true});release();await task;assert.equal(f.app.store.all('showcase-exit-updates').length,0);assert.deepEqual(f.app.store.get('showcase-exits',o.id),saved);
 f.app.store.put('agents',a);f.app.showcase.status(a.id,{nextDecisionAt:0});const again=new Promise(r=>started=r),pending=f.app.showcase.run({agentId:a.id});await again;
 f.app.showcase.manageExit(a,{token:TOKEN,exit:{takeProfitPct:null,stopLossPct:10,maxHoldMinutes:null},reason:'先到的另一份明确计划'});release();await pending;
 assert.equal(f.app.store.all('showcase-exit-updates').length,1);assert.equal((await f.call('/api/public/agent?id='+a.id)).value.agent.exitPlans[0].rule.takeProfitPct,null);assert.deepEqual(f.app.paper.lots(a.id),lots);assert.equal(f.app.paper.check(a.id),true);assert.equal(f.app.live.orders().length,0);
});

test('a pending model cannot block other exits or buy back a position already closed by the exit watcher',async t=>{
 let release,started,calls=0;const ready=new Promise(r=>release=r),begin=new Promise(r=>started=r);
 const f=await fixture(t,{showcase:true,showcaseOptions:{maxAgentsPerRun:1,configReader:()=>({model:'test',intervalMinutes:1,dailyCalls:null}),planner:{async decide(){calls++;started();await ready;return {action:'buy',token:TOKEN,sizeUsd:100,reason:'过期提案不得买回',exit:{takeProfitPct:20,stopLossPct:10,maxHoldMinutes:60}};}}}});
 const agents=SHOWCASE_PROFILES.slice(0,2).map(p=>f.app.store.get('agents',p.id));
 for(const [i,a] of agents.entries()){
  const id='watch-entry-'+i,o=await f.app.paper.submit(a,{id,token:TOKEN,side:'buy',amount:'100000000000000000'});o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();
  f.app.store.put('showcase-exits',{policyVersion:2,id,orderId:id,agentId:a.id,token:TOKEN,takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60});
 }
 const pending=f.app.showcase.tick();await begin;assert.equal(f.app.showcase.tick(),pending);
 try{
  f.g.fx=940;f.g.advance();f.app.showcase.exitChecks.clear();
  await f.app.showcase.watchExits();assert.equal(f.app.paper.orders().filter(o=>o.side==='sell').length,1);
  await f.app.showcase.watchExits();assert.equal(f.app.paper.orders().filter(o=>o.side==='sell').length,2);
  for(const o of f.app.paper.orders().filter(o=>o.side==='sell')){assert.match(o.reason,/止损/);o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);}
  f.g.advance();await f.app.paper.tick();assert.ok(agents.every(a=>f.app.paper.lots(a.id).length===0));
 }finally{release();await pending;}
 assert.equal(calls,1);assert.equal(f.app.paper.fills().length,4);assert.equal(f.app.paper.orders().filter(o=>o.side==='buy').length,2);
 assert.match(f.app.store.get('showcase-status',agents[0].id).reason,/旧提案已取消/);
 for(const a of agents){assert.equal(f.app.paper.check(a.id),true);assert.ok(f.app.paper.fills(a.id).find(f=>f.side==='sell').netUsd<0);}
 assert.equal(f.app.live.orders().length,0);
});

test('a real paper stop is checked and matched before a pending Meme risk continuation, without model calls',async t=>{
 const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>null}}),a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id),id='risk-wait-stop';
 const entry=await f.app.paper.submit(a,{id,token:TOKEN,side:'buy',amount:'100000000000000000'});entry.dueAt=Date.now()-1;f.app.store.put('paper-orders',entry);f.g.advance();await f.app.paper.tick();
 f.app.store.put('showcase-exits',{policyVersion:2,id,orderId:id,agentId:a.id,token:TOKEN,takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60});
 f.app.store.put('cloud-settings',{id:'risk-priority-round',tokens:[TOKEN]});
 const calls=[],io=new IOBudget(45,async url=>{calls.push(url);return Response.json({});});
 const host={io,store:f.app.store,app:f.app,initialize:async()=>f.app,arm:async()=>{},ctx:{storage:{async setAlarm(){}},waitUntil(){}},risk:{tick(){throw Error('Stop checks and matching must precede pending risk work');}},market:{async updateHead(){await io.fetch('https://head.example');f.g.advance();},async fx(){await io.fetch('https://fx.example');},refresh(){throw Error('Do not spend exit budget on discovery');}}};
 f.g.fx=940;f.g.advance();f.app.showcase.exitChecks.clear();
 await io.run('alarm',()=>runScheduledRound(host));
 const sale=f.app.paper.orders(a.id).find(o=>o.side==='sell');assert.ok(sale);assert.equal(sale.status,'queued');assert.match(sale.reason,/止损/);assert.equal(f.app.paper.fills(a.id).length,1);assert.equal(f.app.store.get('cloud-settings','scheduler').phase,'exits');
 sale.dueAt=Date.now()-1;f.app.store.put('paper-orders',sale);await io.run('alarm',()=>runScheduledRound(host));
 assert.equal(f.app.store.get('cloud-settings','scheduler').phase,'matching');assert.equal(f.app.paper.fills(a.id).length,2);assert.ok(f.app.paper.fills(a.id).find(x=>x.side==='sell').netUsd<0);assert.equal(f.app.paper.lots(a.id).length,0);assert.equal(f.app.paper.check(a.id),true);
 assert.deepEqual(f.app.store.get('cloud-settings','risk-priority-round').tokens,[TOKEN]);assert.equal(f.app.store.all('ai-usage').length,0);assert.equal(f.app.live.orders().length,0);assert.deepEqual(calls,['https://head.example','https://fx.example','https://head.example','https://fx.example']);
});

test('deferred AI proposals persist without an order, use current guarded execution once, and expose safe execution results',async t=>{
 let calls=0;const f=await fixture(t,{showcase:true,showcaseOptions:{maxAgentsPerRun:1,deferExecution:true,configReader:()=>({model:'test',intervalMinutes:1,dailyCalls:null}),planner:{async decide(){calls++;return {action:'buy',token:TOKEN,sizeUsd:50,reason:'隔离测试：先核查再执行',exit:{takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60}};}}}}),a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id);
 await f.app.showcase.run();const proposal=f.app.showcase.pendingProposal();assert.equal(proposal.agentId,a.id);assert.equal(f.app.paper.orders().length,0);assert.equal(f.app.paper.fills().length,0);assert.equal(calls,1);
 const pending=(await f.call('/api/public/agent?id='+a.id)).value.agent;assert.equal(pending.runtime.state,'waiting-execution');assert.equal(pending.runtime.lastExecution.status,'pending');assert.doesNotMatch(JSON.stringify(pending),/basis|requestKey|ownerId|encryptedKey/);
 await f.app.showcase.executeProposal(proposal);const order=f.app.paper.orders(a.id)[0];assert.equal(order.status,'queued');assert.deepEqual(f.app.store.get('showcase-exits',order.id).stopLossPct,5);await f.app.showcase.executeProposal(proposal);assert.equal(f.app.paper.orders(a.id).length,1);assert.equal(f.app.paper.fills(a.id).length,0);
 order.dueAt=Date.now()-1;f.app.store.put('paper-orders',order);f.g.advance();await f.app.paper.tick();assert.equal(f.app.paper.fills(a.id).length,1);assert.equal(f.app.paper.check(a.id),true);assert.equal(f.app.live.orders().length,0);assert.equal(calls,1);
 const finished=(await f.call('/api/public/agent?id='+a.id)).value.agent;assert.equal(finished.runtime.lastExecution.status,'filled');
 f.app.store.put('requests',{id:'old-failed-attempt',agentId:a.id,createdAt:Date.now()+1,action:'buy_token',status:'failed',error:'CF_SUBREQUEST_BUDGET private-provider-secret'});const failed=(await f.call('/api/public/agent?id='+a.id)).value.agent;assert.equal(failed.runtime.lastExecution.code,'REQUEST_BUDGET');assert.doesNotMatch(JSON.stringify(failed),/private-provider-secret|CF_SUBREQUEST_BUDGET/);
});

test('public builtin execution results respect an already completed round reset without deleting retained requests',async t=>{
 const f=await fixture(t,{showcase:true}),id=SHOWCASE_PROFILES[0].id,at=Date.now();
 f.app.store.put('requests',{id:'private-old-request',agentId:id,createdAt:at-1000,status:'failed',action:'buy_token',error:'CF_SUBREQUEST_BUDGET'});
 f.app.store.put('cloud-settings',{id:'showcase-paper-reset',completedAt:at,agentIds:[id]});
 assert.equal((await f.call('/api/public/agent?id='+id)).value.agent.runtime.lastExecution,null);assert.ok(f.app.store.get('requests','private-old-request'));
 f.app.store.put('requests',{id:'current-request',agentId:id,createdAt:at+1,status:'failed',action:'buy_token',error:'CF_SUBREQUEST_BUDGET'});
 assert.equal((await f.call('/api/public/agent?id='+id)).value.agent.runtime.lastExecution.code,'REQUEST_BUDGET');
});

test('deferred proposals cannot execute after pause, expiry or account change',async t=>{
 for(const kind of ['pause','expiry','balance']){
  const f=await fixture(t,{showcase:true,showcaseOptions:{maxAgentsPerRun:1,deferExecution:true,configReader:()=>({model:'test',intervalMinutes:1,dailyCalls:null}),planner:{async decide(){return {action:'buy',token:TOKEN,sizeUsd:50,reason:'隔离测试：旧提案不得执行',exit:{takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60}};}}}}),a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id);
  await f.app.showcase.run();const p=f.app.showcase.pendingProposal();if(kind==='pause')f.app.store.put('agents',{...a,paused:true});else if(kind==='expiry'){p.expiresAt=Date.now()-1;f.app.store.put('showcase-proposals',p);}else {const balance=f.app.paper.account(a.id);f.app.store.put('paper-accounts',{...balance,nativeRaw:String(BigInt(balance.nativeRaw)+1n)});}
  await f.app.showcase.executeProposal(p);assert.equal(f.app.paper.orders(a.id).length,0);assert.equal(f.app.paper.fills(a.id).length,0);assert.equal(f.app.showcase.pendingProposal(),null);assert.equal(f.app.live.orders().length,0);
 }
});

test('an account change during an exit quote discards the entire old position snapshot',async t=>{
 const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>null}}),a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id),other='0x'+'22'.repeat(20);
 for(const [id,token] of [['snapshot-first',TOKEN],['snapshot-second',other]]){
  const o=await f.app.paper.submit(a,{id,token,side:'buy',amount:'100000000000000000'});o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();
  f.app.store.put('showcase-exits',{policyVersion:2,id,agentId:a.id,token,orderId:id,takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60});
 }
 let release,started;const ready=new Promise(r=>release=r),begin=new Promise(r=>started=r),quote=f.g.quote.bind(f.g),attempts=[];
 f.g.fx=940;f.g.advance();f.g.quote=async p=>{if(p.side==='sell'){attempts.push(p.token);if(p.token===TOKEN){started();await ready;}}return quote(p);};
 const watching=f.app.showcase.watchExits();await begin;
 try{
  const amount=f.app.paper.lots(a.id).find(l=>l.token===other).remainingRaw,o=await f.app.paper.submit(a,{id:'concurrent-snapshot-sale',token:other,side:'sell',amount});
  o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();
 }finally{release();await watching;}
 assert.deepEqual(attempts,[TOKEN,other,other]);assert.deepEqual(f.app.paper.lots(a.id).map(l=>l.token),[TOKEN]);
 assert.equal(f.app.paper.fills(a.id).length,3);assert.equal(f.app.paper.orders(a.id).filter(o=>o.side==='sell').length,1);assert.equal(f.app.paper.check(a.id),true);
 assert.equal(f.app.live.orders().length,0);
});

test('the exit watcher respects pause, quote failures and stale heads without changing inventory',async t=>{
 const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>null}}),a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id),id='watch-unavailable',o=await f.app.paper.submit(a,{id,token:TOKEN,side:'buy',amount:'100000000000000000'});
 o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();f.app.store.put('showcase-exits',{policyVersion:2,id,orderId:id,agentId:a.id,token:TOKEN,takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60});
 const lots=f.app.paper.lots(a.id),balance=f.app.paper.account(a.id),quotes=f.g.calls;
 f.app.store.put('agents',{...a,paused:true});await f.app.showcase.watchExits();assert.equal(f.g.calls,quotes);
 f.app.store.put('agents',a);f.g.headAt=0;await f.app.showcase.watchExits();assert.equal(f.g.calls,quotes);
 f.g.advance();f.app.showcase.exitChecks.clear();f.g.failure=Error('private fixture diagnostic');await f.app.showcase.watchExits();assert.equal(f.app.store.get('showcase-status',a.id).exitFailures.length,1);
 assert.doesNotMatch(JSON.stringify((await f.call('/api/public/agent?id='+a.id)).value),/private fixture diagnostic/);
 assert.deepEqual(f.app.paper.lots(a.id),lots);assert.deepEqual(f.app.paper.account(a.id),balance);assert.equal(f.app.paper.orders(a.id).length,1);assert.equal(f.app.live.orders().length,0);
});

for(const [trigger,fx,maxHoldMinutes] of [['止盈',1200,60],['止损',940,60],['持有时间到期',1000,1]])test('one unavailable token does not block another held token from '+trigger,async t=>{
 const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>null}}),a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id),other='0x'+'22'.repeat(20);
 for(const [id,token] of [['unavailable-entry',TOKEN],['working-entry',other]]){
  const o=await f.app.paper.submit(a,{id,token,side:'buy',amount:'100000000000000000'});o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();
  f.app.store.put('showcase-exits',{policyVersion:2,id,agentId:a.id,token,orderId:id,takeProfitPct:10,stopLossPct:5,maxHoldMinutes});
 }
 assert.equal(f.app.paper.fills(a.id).length,2);
 for(const l of f.app.paper.lots(a.id))f.app.store.put('paper-lots',{...l,at:Date.now()-(l.token===TOKEN?120000:61000)});
 const quote=f.g.quote.bind(f.g),attempts=[];f.g.fx=fx;f.g.advance();f.g.quote=async p=>{if(p.side==='sell'){attempts.push(p.token);if(p.token===TOKEN)throw Error('isolated fixture: no verified exit route');}return quote(p);};
 assert.equal(await f.app.showcase.exits(a),true);assert.deepEqual(attempts.slice(0,2),[TOKEN,other]);
 const sale=f.app.paper.orders(a.id).find(o=>o.side==='sell');assert.ok(sale);assert.equal(sale.token,other);assert.match(sale.reason,new RegExp(trigger));
 sale.dueAt=Date.now()-1;f.app.store.put('paper-orders',sale);f.g.advance();await f.app.paper.tick();
 assert.deepEqual(f.app.paper.lots(a.id).map(l=>l.token),[TOKEN]);assert.equal(f.app.paper.fills(a.id).length,3);assert.equal(f.app.paper.check(a.id),true);assert.equal(f.app.live.orders().length,0);
 const detail=(await f.call('/api/public/agent?id='+a.id)).value.agent;assert.equal(detail.exitPlans[0].token,TOKEN);assert.equal(detail.runtime.exitFailures[0].token,TOKEN);assert.equal(detail.runtime.exitFailures.length,1);assert.doesNotMatch(JSON.stringify(detail.runtime),/isolated fixture|no verified exit route/);
});

test('a failed exit quote keeps AI deferred throughout the retry interval and resumes only after verification',async t=>{
 let calls=0,now=Date.now();
 const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>({model:'test-model',intervalMinutes:1,dailyCalls:null}),planner:{async decide(){calls++;return {action:'hold',token:null,sizeUsd:null,reason:'重新核价后观察',exit:{takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60}};}}}}),a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id),id='retry-window-entry';
 for(const p of SHOWCASE_PROFILES.slice(1))f.app.store.put('agents',{...f.app.store.get('agents',p.id),paused:true});
 const o=await f.app.paper.submit(a,{id,token:TOKEN,side:'buy',amount:'100000000000000000'});o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();
 f.app.store.put('showcase-exits',{policyVersion:2,id,agentId:a.id,token:TOKEN,orderId:id,takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60});
 f.app.showcase.now=()=>now;const inventory=f.app.paper.lots(a.id),account=f.app.paper.account(a.id);
 f.g.failure=Error('isolated unavailable exit');await f.app.showcase.run();assert.equal(calls,0);
 const quotes=f.g.calls;f.g.failure=null;now+=1000;f.g.advance();await f.app.showcase.run();
 assert.equal(calls,0,'AI must wait for the failed position to be verified again');assert.equal(f.g.calls,quotes,'retry waiting must not increase provider requests');
 assert.equal(f.app.store.get('showcase-status',a.id).state,'observing');assert.equal(f.app.store.get('showcase-status',a.id).exitFailures.length,1);
 now+=30000;f.g.advance();await f.app.showcase.run();assert.equal(calls,1);assert.deepEqual(f.app.store.get('showcase-status',a.id).exitFailures,[]);
 assert.deepEqual(f.app.paper.lots(a.id),inventory);assert.deepEqual(f.app.paper.account(a.id),account);assert.equal(f.app.paper.fills(a.id).length,1);assert.equal(f.app.paper.check(a.id),true);assert.equal(f.app.live.orders().length,0);
});

test('unavailable exits keep all inventory, defer AI, and clear retry notices after real quotes recover',async t=>{
 let calls=0;const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>({model:'test-model',intervalMinutes:1,dailyCalls:null}),planner:{async decide(){calls++;return {action:'hold',token:null,sizeUsd:null,reason:'隔离测试恢复后观察',exit:{takeProfitPct:30,stopLossPct:15,maxHoldMinutes:1440}};}}}}),a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id),other='0x'+'22'.repeat(20);
 for(const p of SHOWCASE_PROFILES.slice(1))f.app.store.put('agents',{...f.app.store.get('agents',p.id),paused:true});
 for(const [id,token] of [['missing-first',TOKEN],['missing-second',other]]){
  const o=await f.app.paper.submit(a,{id,token,side:'buy',amount:'100000000000000000'});o.dueAt=Date.now()-1;f.app.store.put('paper-orders',o);f.g.advance();await f.app.paper.tick();
  f.app.store.put('showcase-exits',{policyVersion:2,id,agentId:a.id,token,orderId:id,takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60});
 }
 const lots=f.app.paper.lots(a.id),balance=f.app.paper.account(a.id).nativeRaw;f.g.failure=Error('isolated provider body must not be published');
 await f.app.showcase.run();assert.equal(calls,0);assert.deepEqual(f.app.paper.lots(a.id),lots);assert.equal(f.app.paper.account(a.id).nativeRaw,balance);assert.equal(f.app.paper.orders(a.id).filter(o=>o.side==='sell').length,0);
 const failed=(await f.call('/api/public/agent?id='+a.id)).value.agent.runtime;assert.match(failed.reason,/部分持仓退出报价/);assert.deepEqual(failed.exitFailures.map(f=>f.token).sort(),[TOKEN,other].sort());assert.doesNotMatch(JSON.stringify(failed),/isolated provider body/);
 f.g.failure=null;f.g.advance();f.app.showcase.exitChecks.clear();await f.app.showcase.run();assert.equal(calls,1);assert.deepEqual(f.app.paper.lots(a.id),lots);assert.deepEqual((await f.call('/api/public/agent?id='+a.id)).value.agent.runtime.exitFailures,[]);assert.equal(f.app.paper.check(a.id),true);
 const quotes=f.g.calls;f.g.headAt=0;f.app.showcase.exitChecks.clear();await f.app.showcase.run();assert.equal(f.g.calls,quotes);assert.equal(calls,1);assert.match(f.app.store.get('showcase-status',a.id).reason,/BSC行情已过期/);assert.equal(f.app.live.orders().length,0);
});

test('unlimited AI quota retains usage above previous caps while one-minute scheduling prevents repeated immediate calls',async t=>{
 let calls=0;const f=await fixture(t,{showcase:true,showcaseOptions:{configReader:()=>({model:'test-model',intervalMinutes:1,dailyCalls:null}),planner:{async decide(){calls++;return {action:'hold',token:null,sizeUsd:null,reason:'测试行情不足，保持观察',exit:{takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60}};}}}});
 const day=new Date().toISOString().slice(0,10),before=Date.now();f.app.store.put('ai-usage',{id:day,calls:5000});
 await f.app.showcase.run();assert.equal(calls,3);assert.equal(f.app.store.get('ai-usage',day).calls,5003);
 for(const p of SHOWCASE_PROFILES){const status=f.app.store.get('showcase-status',p.id);assert.equal(status.state,'observing');assert.ok(status.nextDecisionAt>=before+60000);assert.ok(status.nextDecisionAt<=Date.now()+60000);}
 await f.app.showcase.run();assert.equal(calls,3);assert.equal(f.app.store.get('ai-usage',day).calls,5003);assert.equal(f.app.paper.orders().length,0);assert.equal(f.app.live.orders().length,0);
});
test('Cloud scheduling advances one Agent at a time, preserves its cursor on restart and retains per-Agent cooldowns',async t=>{
 const calls=[],f=await fixture(t,{showcase:true,showcaseOptions:{maxAgentsPerRun:1,configReader:()=>({model:'test-model',intervalMinutes:1,dailyCalls:null}),planner:{async decide(_c,strategy){calls.push(strategy.name);return {action:'hold',token:null,sizeUsd:null,reason:'分轮验证',exit:{takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60}};}}}});
 await f.app.showcase.run();assert.deepEqual(calls,[SHOWCASE_PROFILES[0].strategy.name]);assert.equal(f.app.store.get('showcase-cursor','platform').next,1);
 await f.app.showcase.run();await f.app.showcase.run();assert.deepEqual(calls,SHOWCASE_PROFILES.map(p=>p.strategy.name));await f.app.showcase.run();assert.equal(calls.length,3);
 assert.equal(f.app.store.get('showcase-cursor','platform').next,1);assert.equal(f.app.paper.orders().length,0);
});
test('unknown holder risk keeps empty builtins observing without spending AI calls or requesting quotes',async t=>{
 let calls=0;const riskGuard={snapshot:token=>({token,state:'unknown',buyAllowed:false,reasons:['持仓标签缺失']}),tick(){},async assertBuy(){throw Error('Should never submit');},async close(){}};
 const f=await fixture(t,{showcase:true,showcaseOptions:{riskGuard,configReader:()=>({model:'test-model',intervalMinutes:1,dailyCalls:null}),planner:{async decide(){calls++;throw Error('Should not call');}}}});
 await f.app.showcase.run();assert.equal(calls,0);assert.equal(f.g.quotes.length,0);assert.equal(f.app.paper.orders().length,0);for(const p of SHOWCASE_PROFILES)assert.match(f.app.store.get('showcase-status',p.id).reason,/持仓风险筛查/);
});
test('an AI buy proposal cannot bypass a changed holder-risk entry check',async t=>{
 let guarded=0;const riskGuard={snapshot:token=>({token,state:'screened',buyAllowed:true,reasons:[]}),tick(){},async assertBuy(){guarded++;throw Object.assign(new Error('开仓风险检查未通过：捆绑持仓超过上限'),{status:409});},async close(){}};
 const f=await fixture(t,{showcase:true,showcaseOptions:{riskGuard,configReader:()=>({model:'test-model',intervalMinutes:1,dailyCalls:1}),planner:{async decide(){return {action:'buy',token:TOKEN,sizeUsd:100,reason:'模型提出买入，仍须独立风控',exit:{takeProfitPct:20,stopLossPct:10,maxHoldMinutes:60}};}}}});
 await f.app.showcase.run();assert.equal(guarded,1);assert.equal(f.g.quotes.length,0);assert.equal(f.app.paper.orders().length,0);assert.equal(f.app.paper.fills().length,0);assert.match(f.app.store.all('requests')[0].error,/捆绑持仓/);
});
test('risk is rechecked before a pending builtin buy fills, while risk-blocked holdings can still sell',async t=>{
 let blocked=false,checks=0;const riskGuard={snapshot:token=>({token,state:blocked?'blocked':'screened',buyAllowed:!blocked,reasons:[]}),tick(){},async assertBuy(){checks++;if(blocked)throw Object.assign(new Error('开仓风险检查未通过：新增捆绑风险'),{status:409});},async close(){}};
 const f=await fixture(t,{showcase:true,showcaseOptions:{riskGuard,configReader:()=>null}}),a=f.app.store.get('agents',SHOWCASE_PROFILES[0].id),initial=f.app.paper.account(a.id).initialUsd;
 const failed=await f.app.paper.submit(a,{id:'risk-changed-before-fill',token:TOKEN,side:'buy',amount:'100000000000000000'});failed.dueAt=Date.now()-1;f.app.store.put('paper-orders',failed);blocked=true;f.g.advance();await f.app.paper.tick();assert.equal(f.app.paper.orders()[0].status,'failed');assert.equal(f.app.paper.fills().length,0);assert.equal(f.app.paper.view(a.id).balanceUsd,initial);
 blocked=false;const buy=await f.app.paper.submit(a,{id:'guarded-buy',token:TOKEN,side:'buy',amount:'100000000000000000'});buy.dueAt=Date.now()-1;f.app.store.put('paper-orders',buy);f.g.advance();await f.app.paper.tick();assert.equal(f.app.paper.fills().length,1);
 blocked=true;const before=checks,amount=f.app.paper.lots(a.id)[0].remainingRaw,sell=await f.app.paper.submit(a,{id:'risk-exit-still-allowed',token:TOKEN,side:'sell',amount});sell.dueAt=Date.now()-1;f.app.store.put('paper-orders',sell);f.g.advance();await f.app.paper.tick();assert.equal(checks,before);assert.equal(f.app.paper.fills().length,2);assert.equal(f.app.paper.lots(a.id).length,0);assert.equal(f.app.paper.check(a.id),true);
});
test('external Agents cannot bypass Meme scope or changed entry risk during actual paper matching',async t=>{
 let blocked=false,checks=0;const riskGuard={snapshot:token=>({token,state:'screened-limited',buyAllowed:!blocked,reasons:[]}),tick(){},async assertBuy(){checks++;if(blocked)throw Object.assign(Error('开仓风险检查未通过'),{status:409});},async close(){}};
 const f=await fixture(t,{showcase:true,showcaseOptions:{riskGuard,configReader:()=>null}}),s=await f.owner(),a=await f.register(s,'External Meme');f.g.marketScope=()=>({kind:'meme'});f.g.assertEntry=token=>{if(token!==TOKEN)throw Object.assign(Error('当前仅允许 BSC Meme 新开仓'),{status:409});};
 const before=f.g.calls;assert.equal((await f.agentCall(a,'buy_token',{token:WBNB,amount:'1000000000000000',requestKey:'wrong-scope'})).status,409);assert.equal(f.g.calls,before);assert.equal(checks,0);
 const buy=await f.agentCall(a,'buy_token',{token:TOKEN,amount:'1000000000000000',requestKey:'meme-risk-later'});assert.equal(buy.status,200);assert.equal(checks,1);const order=f.app.store.get('paper-orders',buy.value.result.id);f.app.store.put('paper-orders',{...order,dueAt:Date.now()-1});blocked=true;f.g.advance();await f.app.paper.tick();assert.equal(checks,2);assert.equal(f.app.store.get('paper-orders',order.id).status,'failed');assert.equal(f.app.paper.fills(a.agentId).length,0);assert.equal(f.app.paper.view(a.agentId).balanceUsd,1000);
});
test('rankings include only opted-in Agents, expose strategy descriptions, separate modes and exclude capital topups',async t=>{
 const f=await fixture(t),one=await f.owner(),two=await f.owner(),a=await f.register(one,'Alpha'),b=await f.register(one,'Beta'),privateA=await f.register(two,'Private');
 assert.equal((await f.call('/api/strategy',{agentId:a.agentId,name:'My trend',description:'公开的进入与退出规则'},two)).status,404);assert.equal((await f.call('/api/strategy',{agentId:a.agentId,name:'My trend',description:'公开的进入与退出规则'},one)).status,200);
 for(const id of [a.agentId,b.agentId])await f.call('/api/control',{agentId:id,public:true},one);
 for(const id of [a.agentId,b.agentId,privateA.agentId])f.app.store.put('paper-fills',{id:'sale-'+id,agentId:id,mode:'paper',side:'sell',netRaw:'2000000000000000',netUsd:20,at:Date.now()});
 const rank=(await f.call('/api/leaderboard')).value;assert.equal(rank.entries.length,2);assert.deepEqual(rank.entries.map(x=>x.rank),[1,1]);assert.ok(rank.entries.every(x=>x.returnPct===2));assert.equal(rank.entries.find(x=>x.id===a.agentId).strategy.name,'My trend');assert.equal((await f.call('/api/leaderboard?mode=live')).value.total,0);assert.equal((await f.call('/api/leaderboard?source=builtin')).value.total,0);assert.equal((await f.call('/api/leaderboard?mode=wrong')).status,400);assert.equal((await f.call('/api/public/agent?id='+privateA.agentId)).status,404);assert.doesNotMatch(JSON.stringify(rank),/ownerId|encryptedKey|privateKey|apiKey|agentToken/);
 await f.call('/api/control',{agentId:a.agentId,public:false},one);assert.equal((await f.call('/api/leaderboard')).value.total,1);
});
