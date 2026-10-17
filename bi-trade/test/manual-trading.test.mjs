import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {PlatformRepository} from '../lib/database-core.mjs';
import {chainStore} from '../lib/trading-network.mjs';
import {EncryptedVault} from '../lib/vault-core.mjs';
import {createPlatformCore} from '../platform-core.mjs';
import {handleFetch} from '../../cloudflare/bridge.mjs';
const TOKEN='0x'+'11'.repeat(20),OTHER='0x'+'22'.repeat(20),origin='https://paper.example.test';
async function fixture(t){
 const db=new DatabaseSync(':memory:');const base=new PlatformRepository(db,fn=>{db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}),store=chainStore(base,'robinhood'),vault=new EncryptedVault(Buffer.alloc(32,8));
 const g={chain:'robinhood',head:100,headAt:Date.now(),factor:100n,bad:false,async updateHead(){this.head++;this.headAt=Date.now();},async fx(){return {usd:2000,at:Date.now()};},nativeReference(){return {usd:2000,at:Date.now()};},statuses(){return [{chain:this.chain,connected:true,head:this.head,headAt:this.headAt}];},markets(){return [TOKEN,OTHER].map((address,i)=>({chain:this.chain,address,symbol:i?'OLD':'TEST',platform:'pons-v2',stage:'curve',quality:'verified',updatedAt:Date.now()-(i?60000:0),priceUsd:1}));},getMarket(_chain,token){return this.markets().find(m=>m.address===token);},async assertExternalEntry(token){if(token!==TOKEN)throw Error('private provider error');},async refresh(){},async quote(p){if(this.bad)throw Error('private provider payload');const input=p.nativeAmountRaw??p.tokenAmountRaw;return {id:'quote',chain:this.chain,token:p.token,side:p.side,block:p.block,at:Date.now(),inputRaw:input,spentInputRaw:input,refundRaw:'0',outputRaw:String(p.side==='buy'?BigInt(input)*2000n*this.factor/100n:BigInt(input)/2000n),tokenDecimals:18,nativeUsd:2000,priceUsd:1,quality:'verified',priceImpactPct:25,fees:{gasUsd:.01,approvalUsd:0,protocolUsd:.02,taxUsd:0,conversionUsd:0,includedInOutput:true,quality:'estimated',notes:['private fee evidence']}};}};
 const app=await createPlatformCore({store,vault,gateway:g,origin,showcase:false,rpc:{balance:async()=>0n},assetReader:name=>readFile('bi-trade/web/'+name)});
 t.after(()=>db.close());
 async function call(path,data,s=null,extra={}){const r=await handleFetch(app,new Request(origin+path,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(s?{Cookie:s.cookie,'X-CSRF-Token':s.csrf}:{}),...extra},...(data===undefined?{}:{body:JSON.stringify(data)})}),'127.0.0.1');const text=await r.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:r.status,value,cookie:r.headers.get('Set-Cookie')?.split(';')[0]};}
 async function owner(){const r=await call('/api/session',{});return {cookie:r.cookie,csrf:r.value.csrf};}
 async function start(s){const r=await call('/api/manual/start',{},s);assert.equal(r.status,200);return r.value;}
 async function preview(s,data={}){const r=await call('/api/manual/preview',{token:TOKEN,side:'buy',unit:'USD',amount:'500',...data},s);assert.equal(r.status,200,JSON.stringify(r.value));return r.value;}
 async function fill(order){store.put('paper-orders',{...store.get('paper-orders',order.id),dueAt:0});await g.updateHead();await app.paper.tick();}
 return {app,base,store,g,vault,call,owner,start,preview,fill};
}
test('manual routes enforce sessions, Origin and CSRF; one separate paper account persists without exposing keys or pairing it as an Agent',async t=>{
 const f=await fixture(t),s=await f.owner();
 assert.equal((await f.call('/api/manual')).status,401);
 assert.equal((await f.call('/api/manual/start',{},s,{'X-CSRF-Token':'wrong'})).status,403);
 assert.equal((await f.call('/api/manual/start',{},s,{Origin:'https://evil.test'})).status,403);assert.equal(f.store.all('agents').length,0);
 const first=await f.start(s),again=await f.start(s);assert.equal(first.account.id,again.account.id);assert.equal(first.account.initialUsd,1000);assert.equal(first.account.balanceUsd,1000);assert.equal(f.store.all('paper-ledger').length,1);
 assert.equal((await f.call('/api/state',undefined,s)).value.agents.length,0);assert.equal((await f.call('/api/leaderboard')).value.total,0);
 assert.equal((await f.call('/api/pair',{agentId:first.account.id},s)).status,409);
 assert.equal((await f.call('/api/control',{agentId:first.account.id,mode:'live',public:true},s)).status,409);
 assert.doesNotMatch(JSON.stringify(first),/privateKey|encryptedKey|ownerId|agentToken|private fee/);
 const session=f.app.auth.session({headers:{cookie:s.cookie}});assert.equal(f.app.state(session).agents.length,0);assert.equal(f.base.all('paper-accounts').length,0);
 assert.match((await f.call('/trade')).value,/trade.js/);
 const rows=(await f.call('/api/manual/markets')).value.markets;assert.equal(rows.length,2);assert.equal(rows[1].fresh,false);assert.ok(rows[1].at<Date.now()-59000);
});
test('manual real-quote previews do not fill, submissions are idempotent, partial sells use known quantities and FIFO fees; balances never refill',async t=>{
 const f=await fixture(t),s=await f.owner(),started=await f.start(s),p=await f.preview(s);
 assert.equal(f.app.paper.fills().length,0);assert.equal(p.inputUsd,500);assert.equal(p.outsideFeesUsd,.01);assert.doesNotMatch(JSON.stringify(p),/private fee evidence/);
 const data={previewId:p.id,requestKey:'buy-once'},one=await f.call('/api/manual/order',data,s),again=await f.call('/api/manual/order',data,s);
 assert.equal(one.status,200);assert.equal(one.value.id,again.value.id);assert.equal(f.app.paper.fills().length,0);assert.equal(f.app.paper.orders().length,1);
 assert.equal((await f.call('/api/manual/order',{...data,requestKey:'duplicate-preview'},s)).status,409);
 await f.fill(one.value);assert.equal(f.app.paper.fills().length,1);
 let v=(await f.call('/api/manual',undefined,s)).value;assert.equal(v.account.balanceUsd,499.99);assert.equal(v.positions.length,1);assert.equal(v.positions[0].remainingRaw,p.outputRaw);
 assert.equal((await f.start(s)).account.balanceUsd,499.99);
 const reopened=await createPlatformCore({store:f.store,vault:f.vault,gateway:f.g,origin,showcase:false,rpc:{balance:async()=>0n}});
 const response=await handleFetch(reopened,new Request(origin+'/api/manual',{headers:{Cookie:s.cookie}}),'127.0.0.1');
 assert.equal((await response.json()).account.balanceUsd,499.99);assert.equal(f.store.all('paper-ledger').filter(x=>x.kind==='initial-virtual-capital').length,1);
 f.store.put('manual-previews',{...f.store.get('manual-previews',p.id),expiresAt:0});
 assert.equal((await f.call('/api/manual/order',data,s)).value.id,one.value.id);
 const sale=await f.preview(s,{side:'sell',unit:undefined,amount:undefined,percent:25});assert.equal(sale.amount,String(BigInt(p.outputRaw)/4n));
 const order=(await f.call('/api/manual/order',{previewId:sale.id,requestKey:'sell-quarter'},s)).value;await f.fill(order);
 v=(await f.call('/api/manual',undefined,s)).value;assert.equal(v.positions[0].remainingRaw,String(BigInt(p.outputRaw)*3n/4n));assert.ok(v.account.realizedUsd<0);assert.equal(v.fills.length,2);assert.equal(v.fills[0].decimals,18);assert.equal(f.app.paper.check(started.account.id),true);
 assert.equal(f.app.live.orders().length,0);assert.equal(f.base.all('paper-fills').length,0);
});
test('manual trading rejects foreign previews and orders, stale quotes, oversells and insufficient fee balance without changing funds',async t=>{
 const f=await fixture(t),s=await f.owner(),other=await f.owner();await f.start(s);await f.start(other);
 const p=await f.preview(s),data={previewId:p.id,requestKey:'owned'};
 assert.equal((await f.call('/api/manual/order',data,other)).status,404);
 f.store.put('manual-previews',{...f.store.get('manual-previews',p.id),expiresAt:Date.now()-1});assert.equal((await f.call('/api/manual/order',data,s)).status,409);
 assert.equal((await f.call('/api/manual/preview',{token:TOKEN,side:'buy',unit:'USD',amount:'1000'},s)).status,400);
 assert.equal((await f.call('/api/manual/preview',{token:TOKEN,side:'sell',amount:'1'},s)).status,400);
 assert.equal((await f.call('/api/manual/lookup',{token:OTHER},s)).status,503);
 const good=await f.preview(s),order=(await f.call('/api/manual/order',{previewId:good.id,requestKey:'cancel-me'},s)).value;
 assert.equal((await f.call('/api/manual/cancel',{id:order.id},other)).status,404);
 assert.equal((await f.call('/api/manual/cancel',{id:order.id},s)).status,200);await f.fill(order);assert.equal(f.app.paper.fills().length,0);
 assert.equal((await f.call('/api/manual',undefined,s)).value.account.balanceUsd,1000);
});
test('manual confirmation binds the preview minimum across repricing; failed execution is recorded safely and cannot invent a fill',async t=>{
 const f=await fixture(t),s=await f.owner();await f.start(s);const p=await f.preview(s);
 f.g.factor=60n;const r=await f.call('/api/manual/order',{previewId:p.id,requestKey:'price-changed'},s);assert.equal(r.status,200);await f.fill(r.value);
 assert.equal(f.app.paper.orders()[0].status,'failed');assert.equal(f.app.paper.fills().length,0);assert.equal((await f.call('/api/manual',undefined,s)).value.account.balanceUsd,1000);
 f.g.factor=100n;const second=await f.preview(s);f.g.bad=true;
 const failed=await f.call('/api/manual/order',{previewId:second.id,requestKey:'provider-failed'},s);assert.equal(failed.status,503);assert.doesNotMatch(JSON.stringify(failed),/private provider/);
 const v=(await f.call('/api/manual',undefined,s)).value;assert.equal(v.orders.length,2);assert.ok(v.orders.every(o=>o.failed));assert.doesNotMatch(JSON.stringify(v),/private provider|private fee/);assert.equal(v.account.balanceUsd,1000);
});
