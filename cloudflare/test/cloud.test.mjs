import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {readFileSync,mkdirSync,realpathSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {CloudStore} from '../store.mjs';
import {CloudRpc} from '../rpc.mjs';
import {GmgnHTTP} from '../gmgn.mjs';
import {NativePrice,BNB_USD_FEED} from '../native-price.mjs';
import {EncryptedVault} from '../../bi-trade/lib/vault-core.mjs';
import {PaperDesk} from '../../bi-trade/lib/paper-desk.mjs';
import {mergeLedger} from '../import.mjs';
import {TokenRiskGuard} from '../../bi-trade/lib/token-risk-core.mjs';
import {PublicBscData} from '../public-data.mjs';
import {ESTABLISHED_ASSETS} from '../../bi-trade/lib/established-risk.mjs';
import {OwnerAuth,COOKIE} from '../../bi-trade/lib/auth.mjs';
const requireTool=createRequire(realpathSync('node_modules/wrangler/package.json')),{build}=requireTool('esbuild'),{Miniflare,convertV4MiniflareOptions}=requireTool('miniflare');
mkdirSync('.cloud-test-build',{recursive:true});
await build({entryPoints:['cloudflare/market.ts'],bundle:true,platform:'node',format:'esm',outfile:'.cloud-test-build/market.mjs'});
await build({entryPoints:['cloudflare/test/runtime-worker.ts'],bundle:true,platform:'neutral',format:'esm',external:['cloudflare:workers','node:*'],conditions:['workerd','worker'],outfile:'.cloud-test-build/worker.mjs'});
const {CloudMarket}=await import('../../.cloud-test-build/market.mjs');
const TOKEN='0x1111111111111111111111111111111111111111',RECIPIENT='0x2222222222222222222222222222222222222222',vaultKey=Buffer.alloc(32,7);
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());const sql={exec(query,...args){if(!args.length&&query.split(';').filter(x=>x.trim()).length>1){db.exec(query);return {toArray:()=>[],rowsWritten:0};}const s=db.prepare(query);if(/^(?:CREATE|DELETE|INSERT|UPDATE)/i.test(query.trim())){const r=s.run(...args);return {toArray:()=>[],rowsWritten:r.changes};}const rows=s.all(...args);return {toArray:()=>rows,rowsWritten:0};}};
 const store=new CloudStore({sql,transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}});return {db,store};}
test('Cloud ledger rolls back all writes and keeps rate limits across repository reconstruction',t=>{const {store}=fixture(t);assert.throws(()=>store.transaction(()=>{store.put('test',{id:'one'});throw Error('abort');}));assert.equal(store.get('test','one'),null);const req={socket:{remoteAddress:'test-ip'}};store.rateLimit(req,'session',1,60000);assert.throws(()=>store.rateLimit(req,'session',1,60000),/频繁/);assert.equal(store.db.prepare('SELECT n FROM rate_limits').get().n,2);});

test('Storage protection waits for a ledger transaction to finish and checkpoints its count before pausing',t=>{
 const {store}=fixture(t);store.budget.rows=79999;
 store.transaction(()=>{store.put('test',{id:'first'});assert.equal(store.readOnly,false);store.put('test',{id:'second'});});
 assert.ok(store.budget.rows>=80001);assert.equal(store.get('test','second').id,'second');
 store.prepareWriteBudget();assert.equal(store.readOnly,true);assert.ok(store.get('cloud-settings','storage-write-budget').rows>=80000);
 assert.throws(()=>store.put('test',{id:'third'}),/只读/);assert.equal(store.get('test','first').id,'first');
});
test('Cloud wallet binding rolls back ownership and old-session revocation if issuing the replacement session fails',async t=>{
 const {store}=fixture(t),auth=new OwnerAuth(store,'https://bitrade.site'),issued=auth.guest(),req={headers:{cookie:COOKIE+'='+issued.token}},current=auth.session(req),old=store.get('owners',issued.owner.id);
 store.put('paper-fills',{id:'retained-history',agentId:'retained-agent',usd:20,netUsd:-1});
 auth.verify=async()=>TOKEN;auth.issue=()=>{throw Error('replacement session unavailable');};
 await assert.rejects(auth.login('valid-verified-nonce','valid-signature',current),/replacement session unavailable/);
 assert.deepEqual(store.get('owners',old.id),old);assert.equal(store.all('owners').length,1);assert.equal(auth.session(req).owner.id,old.id);assert.equal(auth.session(req).owner.address,null);
 assert.deepEqual(store.get('paper-fills','retained-history'),{id:'retained-history',agentId:'retained-agent',usd:20,netUsd:-1});
});
test('Cloud eviction preserves queued orders, cancels interrupted quotes and never fabricates a fill',t=>{const {store}=fixture(t);store.put('paper-orders',{id:'queued',status:'queued'});store.put('paper-orders',{id:'quoting',status:'quoting'});new PaperDesk(store,{},{preserveQueued:true});assert.equal(store.get('paper-orders','queued').status,'queued');assert.equal(store.get('paper-orders','quoting').status,'cancelled');assert.equal(store.all('paper-fills').length,0);});
test('Meme-only scope excludes mature assets from new entries while retaining them for exits',t=>{
 const {store}=fixture(t),market=new CloudMarket(store,{memeOnly:true,publicData:{candidates:()=>ESTABLISHED_ASSETS,supports:()=>true},gmgn:{status:()=>({limited:true})}});
 const old=ESTABLISHED_ASSETS[0];market.catalog.set(old.address,{address:old.address,category:'meme'});market.catalog.set(TOKEN,{address:TOKEN,category:'meme'});
 assert.equal(market.marketScope().kind,'meme');assert.equal(market.isEntryCandidate(old.address),false);assert.throws(()=>market.assertEntry(old.address),/仅允许.*Meme/);
 assert.equal(market.getMarket('bsc',old.address).address,old.address);assert.equal(market.isEntryCandidate(TOKEN),true);assert.doesNotThrow(()=>market.assertEntry(TOKEN));
});

test('Private migration merges without deleting new users or sessions and refuses to overwrite cloud fills',t=>{const {store}=fixture(t),vault=new EncryptedVault(vaultKey),id='showcase-trend',agent={id,ownerId:'platform-showcase',source:'builtin',...vault.create(id)};
 store.put('owners',{id:'new-cloud-owner'});store.db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?)').run('keep','owner','new-cloud-owner',null,Date.now()+10000,'keep-csrf');store.put('agents',{id:'new-user-agent',ownerId:'new-cloud-owner'});
 const snapshot={version:1,entities:[{kind:'agents',id,payload:JSON.stringify(agent)}],intents:[],audit:[]};mergeLedger(store,vault,snapshot,'test');assert.equal(store.get('agents','new-user-agent').ownerId,'new-cloud-owner');assert.equal(store.db.prepare('SELECT hash FROM credentials').get().hash,'keep');assert.equal(store.get('agents',id).address,agent.address);
 store.put('paper-fills',{id:'real-cloud-fill',agentId:id});assert.throws(()=>mergeLedger(store,vault,snapshot,'second'),/already has fills/);assert.equal(store.get('paper-fills','real-cloud-fill').agentId,id);
});
test('GMGN rate-limit cooldown is persisted and blocks repeated requests until the actual reset',async t=>{const {store}=fixture(t);let calls=0;const now=Date.now(),fetchImpl=async()=>{calls++;return Response.json({reset_at:Math.floor(now/1000)+60},{status:429});};const first=new GmgnHTTP('dummy',{store,now:()=>now,fetchImpl});await assert.rejects(first.info('bsc',TOKEN),/限频/);const second=new GmgnHTTP('dummy',{store,now:()=>now+1,fetchImpl});await assert.rejects(second.info('bsc',TOKEN),/限频/);assert.equal(calls,1);});
test('Cached risk reads keep their original age and cannot be made fresh by a new report',async t=>{const {store}=fixture(t),now=Date.now(),at=now-121000,source={info:async()=>({data:{address:TOKEN},_bitradeReadAt:at}),holders:async()=>({data:{list:[]},_bitradeReadAt:now}),security:async()=>({data:{address:TOKEN},_bitradeReadAt:now})};const guard=new TokenRiskGuard(store,{source,now:()=>now});const report=await guard.refresh(TOKEN);assert.equal(report.fetchedAt,at);assert.equal(report.buyAllowed,false);assert.match(report.reasons[0],/过期/);});
test('A price RPC cooldown disconnects stale market data, exposes its own retry deadline and cannot produce a paper fill',async t=>{
 const {store}=fixture(t),now=Date.now();let calls=0;
 const rpc=new CloudRpc('https://price.example',{store,now:()=>now,fetchImpl:async(_url,opts)=>{calls++;return JSON.parse(opts.body).method==='eth_chainId'?Response.json({result:'0x38'}):Response.json({}, {status:429,headers:{'Retry-After':'60'}});}});
 const market=new CloudMarket(store,{rpc,gmgn:{status:()=>({limited:true,retryAt:now+3600000})},publicData:{status:()=>[{limited:true,retryAt:now+300000}]}});
 await market.refresh();assert.equal(market.statuses()[0].connected,false);assert.deepEqual(market.marketWait(),{retryAt:now+65000});
 const paper=new PaperDesk(store,market);assert.throws(()=>paper.head(),/过期/);
 await assert.rejects(paper.quote({id:'isolated-account',address:RECIPIENT},'sell',TOKEN,'1',100),/冷却/);assert.equal(calls,2);assert.equal(store.all('paper-fills').length,0);
});
test('BSC RPC denies financial methods, validates the chain and includes the actual simulation recipient',async()=>{const calls=[],rpc=new CloudRpc('https://rpc.example.com',{fetchImpl:async(_url,opts)=>{const body=JSON.parse(opts.body);calls.push(body);return Response.json({result:body.method==='eth_chainId'?'0x38':body.method==='eth_call'?'0x'+(18n).toString(16).padStart(64,'0'):{number:'0x64',hash:'0x'+'10'.repeat(32),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:[]}});}});
 await assert.rejects(rpc.request('eth_sendRawTransaction',['secret']),/read-only/);await rpc.block();await rpc.read(TOKEN,[{type:'function',name:'decimals',stateMutability:'view',inputs:[],outputs:[{type:'uint8'}]}],'decimals',[],100,RECIPIENT);assert.equal(calls.at(-1).params[0].from,RECIPIENT);assert.equal(calls.at(-1).params[1],'0x64');
 const wrong=new CloudRpc('https://rpc.example.com',{fetchImpl:async()=>Response.json({result:'0x1'})});await assert.rejects(wrong.block(),/主网/);
});
test('Independent receipt RPC verifies BSC chain, transaction identity and identical canonical blocks before using fee samples',async()=>{
 const hash='0x'+'12'.repeat(32),blockHash='0x'+'34'.repeat(32),calls=[];let bad=false,wrongChain=false;
 const rpc=new CloudRpc('https://price.example',{receiptUrl:'https://receipts.example',fetchImpl:async(url,opts)=>{const q=JSON.parse(opts.body);calls.push({url,method:q.method});return Response.json({result:q.method==='eth_chainId'?(wrongChain?'0x1':'0x38'):q.method==='eth_getTransactionReceipt'?{transactionHash:hash,blockNumber:'0x64',blockHash,status:'0x1',gasUsed:'0x100',logs:[]}:{number:'0x64',hash:bad&&url.includes('receipts')?'0x'+'56'.repeat(32):blockHash,timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:[]}});}});
 assert.equal((await rpc.receipt(hash)).transactionHash,hash);assert.ok(calls.filter(c=>c.method==='eth_getTransactionReceipt').every(c=>c.url.includes('receipts')));
 await assert.rejects(rpc.receipt('0x'+'aa'.repeat(32)),/身份/);
 rpc.cache.clear();rpc.receiptRpc.cache.clear();bad=true;await assert.rejects(rpc.receipt(hash),/不一致/);
 rpc.cache.clear();rpc.receiptRpc.cache.clear();rpc.receiptRpc.verified=false;bad=false;wrongChain=true;await assert.rejects(rpc.receipt(hash),/主网/);
});
test('Receipt batches use one network call, match IDs independent of response order and reject duplicates or substituted receipts',async()=>{
 const hashes=['0x'+'11'.repeat(32),'0x'+'22'.repeat(32)],blockHash='0x'+'33'.repeat(32);let batches=0,bad=false;
 const rpc=new CloudRpc('https://price.example',{receiptUrl:'https://receipts.example',fetchImpl:async(_url,opts)=>{const q=JSON.parse(opts.body);if(Array.isArray(q)){batches++;return Response.json(q.map((v,i)=>({id:bad?q[0].id:v.id,result:{transactionHash:v.params[0],blockNumber:'0x64',blockHash,status:'0x1',gasUsed:'0x100',logs:[]}})).reverse());}return Response.json({result:q.method==='eth_chainId'?'0x38':{number:'0x64',hash:blockHash,timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:hashes}});}});
 const rows=await rpc.receipts(hashes);assert.equal(batches,1);assert.deepEqual(rows.map(r=>r.transactionHash),hashes);
 bad=true;await assert.rejects(rpc.receipts(hashes),/身份/);await assert.rejects(rpc.receipts([...hashes,...hashes]),/无效/);
});
test('GMGN HTTP uses the existing read-only API schema and never sends private signing credentials',async()=>{const calls=[],g=new GmgnHTTP('dummy-api',{now:()=>Date.now()+10000* calls.length,fetchImpl:async(url,opts)=>{calls.push({url:String(url),opts});return Response.json({code:0,data:{}});}});await g.info('bsc',TOKEN);await g.holders('bsc',TOKEN);await g.trenches();assert.ok(calls.every(c=>c.opts.headers['X-APIKEY']==='dummy-api'&&!c.opts.headers['X-Signature']));assert.equal(new URL(calls[1].url).pathname,'/v1/market/token_top_holders');const body=JSON.parse(calls[2].opts.body);assert.equal(body.version,'v2');assert.equal(body.completed.limit,8);assert.ok(body.completed.quote_address_type.includes(6));});
test('Repeated GMGN bans persist increasing backoff, honor both server deadlines and block all consumers',async t=>{
 const {store}=fixture(t);let now=1000000,calls=0;
 const fetchImpl=async()=>{calls++;return Response.json({code:429,error:'RATE_LIMIT_BANNED',reset_at:(now+700000)/1000},{status:429,headers:{'Retry-After':'800'}});};
 let g=new GmgnHTTP('test',{store,now:()=>now,fetchImpl});
 await Promise.allSettled([g.info('bsc',TOKEN),g.holders('bsc',TOKEN),g.security('bsc',TOKEN)]);
 assert.equal(calls,1);assert.equal(g.status().retryAt,now+805000);
 g=new GmgnHTTP('test',{store,now:()=>now,fetchImpl});await assert.rejects(g.trenches(),/限频/);assert.equal(calls,1);
 now=g.cooldown;await assert.rejects(g.info('bsc',TOKEN),/限频/);assert.equal(g.failures,2);
 // Third ban's own backoff exceeds the server deadline.
 now=g.cooldown;await assert.rejects(g.info('bsc',TOKEN),/限频/);assert.equal(g.cooldown,now+1200000);
 assert.equal(store.get('cloud-settings','gmgn-budget').errorCode,'RATE_LIMIT_BANNED');
});
test('GMGN success clears the limit and persistent cache keeps the original evidence time across eviction',async t=>{
 const {store}=fixture(t);let now=1000000,calls=0;
 const fetchImpl=async()=>{calls++;return Response.json({code:0,data:{address:TOKEN}});};
 let g=new GmgnHTTP('test',{store,now:()=>now,fetchImpl});
 const rows=await Promise.all([g.info('bsc',TOKEN),g.info('bsc',TOKEN)]);assert.equal(calls,1);assert.equal(rows[0]._bitradeReadAt,now);
 now+=1000;g=new GmgnHTTP('test',{store,now:()=>now,fetchImpl});
 assert.equal((await g.info('bsc',TOKEN))._bitradeReadAt,now-1000);assert.equal(calls,1);
 now+=60000;await g.info('bsc',TOKEN);assert.equal(calls,2);
 assert.equal(g.status().errorCode,null);assert.equal(g.status().lastSuccessAt,now);
 // A replacement key cannot reuse the previous credential's response.
 now+=10000;await new GmgnHTTP('other',{store,now:()=>now,fetchImpl}).info('bsc',TOKEN);assert.equal(calls,3);
});
test('Application-level 429 and malformed reset dates cannot bypass the GMGN circuit breaker',async()=>{
 const g=new GmgnHTTP('test',{now:()=>1000000,fetchImpl:async()=>Response.json({code:429,error:'RATE_LIMIT_BANNED',reset_at:'bad'})});
 await assert.rejects(g.info('bsc',TOKEN),/限频/);assert.equal(g.cooldown,1300000);assert.equal(g.status().limited,true);
});
test('Successful recovery gradually restores bounded pacing and persists it instead of starving fresh risk reads',async t=>{
 const {store}=fixture(t);let now=1000000;store.put('cloud-settings',{id:'gmgn-budget',lastAt:0,cooldown:0,spacing:15000,failures:3});
 const g=new GmgnHTTP('test',{store,now:()=>now,fetchImpl:async()=>Response.json({code:0,data:{}})});
 await g.info('bsc',TOKEN);assert.equal(g.spacing,12000);assert.equal(g.failures,0);
 for(let n=0;n<10;n++){now+=20000;await g.security('bsc','0x'+String(n+1).padStart(40,'0'));}
 assert.equal(g.spacing,3000);assert.equal(store.get('cloud-settings','gmgn-budget').spacing,3000);
});
test('Concurrent Agent consumers share one serial GMGN queue with a one-second hard minimum even for an old zero spacing setting',async t=>{
 const {store}=fixture(t);let now=1000000,active=0,peak=0;const times=[];
 store.put('cloud-settings',{id:'gmgn-budget',lastAt:999800,cooldown:0,spacing:0});
 const g=new GmgnHTTP('test',{store,now:()=>now,sleep:async ms=>{now+=ms;},fetchImpl:async()=>{times.push(now);active++;peak=Math.max(peak,active);await Promise.resolve();active--;return Response.json({code:0,data:{}});}});
 await Promise.all([g.info('bsc',TOKEN),g.security('bsc',TOKEN),g.holders('bsc',TOKEN)]);
 assert.equal(peak,1);assert.equal(times.length,3);assert.ok(times[0]-999800>=1000);assert.ok(times.slice(1).every((at,i)=>at-times[i]>=1000));assert.equal(g.status().sharedQueue,true);assert.equal(g.status().minimumSpacingMs,1000);
 const restart=new GmgnHTTP('test',{store,now:()=>now,sleep:async ms=>{now+=ms;},fetchImpl:async()=>{times.push(now);return Response.json({code:0,data:{}});}});await restart.trenches();assert.ok(times[3]-times[2]>=1000);
});
test('Native BNB price verifies oracle identity, rounds and source age without calling GMGN',async()=>{
 const now=1000000,calls=[];let round=[4n,76000000000n,990n,995n,4n];
 const rpc={block:async()=>({number:42,time:now}),read:async(to,_abi,fn,_args,block)=>{calls.push({to,fn,block});return fn==='description'?'BNB / USD':fn==='decimals'?8:round;}};
 const price=new NativePrice(rpc,{now:()=>now});const [a,b]=await Promise.all([price.read(),price.read()]);
 assert.equal(a.usd,760);assert.equal(a.at,995000);assert.equal(a.readAt,now);assert.equal(a,b);assert.ok(calls.every(c=>c.to===BNB_USD_FEED&&c.block===42));assert.equal(calls.length,3);
 for(const bad of [[4n,0n,990n,995n,4n],[4n,1n,1n,1n,4n],[4n,1n,1001n,1001n,4n],[4n,1n,990n,995n,3n]]){
  round=bad;await assert.rejects(price.read(),/无效或已过期/);
 }
 await assert.rejects(new NativePrice({...rpc,read:async()=> 'OTHER / USD'},{now:()=>now}).read(),/身份/);
});
test('GMGN cooldown cannot mark a healthy BSC chain disconnected or manufacture token candidates',async t=>{
 const {store}=fixture(t);let gmgnCalls=0;const now=Date.now();
 const rpc={chain:'bsc',block:async()=>({number:100,time:Date.now(),hash:'original',transactions:[]})};
 const market=new CloudMarket(store,{rpc,gmgn:{status:()=>({limited:true}),trenches:async()=>{gmgnCalls++;throw Error();}}});
 market.nativePrice={read:async()=>({id:'native-fx',usd:760,at:now,readAt:now,source:'Chainlink test'})};
 await market.refresh();assert.equal(gmgnCalls,0);assert.equal(market.statuses()[0].connected,true);assert.equal(market.fxValue.usd,760);assert.equal(market.markets().length,0);assert.match(market.marketReason(),/限频/);
});
test('Paper accounts use the independent native reference even with zero GMGN candidates and reject stale or future prices',t=>{
 const {store}=fixture(t),market=new CloudMarket(store,{rpc:{chain:'bsc'},gmgn:{}}),paper=new PaperDesk(store,market),now=Date.now();
 market.head={chain:'bsc',connected:true,head:100,headAt:now,chainTime:now};
 market.fxValue={usd:750,at:now,source:'Chainlink test'};
 assert.equal(market.markets().length,0);assert.equal(paper.fx(),750);paper.seed('native-test',paper.fx());assert.ok(Math.abs(paper.view('native-test').balanceUsd-1000)<.00001);assert.equal(paper.fills().length,0);
 market.fxValue.at=now-90001;assert.equal(paper.fx(),null);market.fxValue.at=now+60000;assert.equal(paper.fx(),null);market.fxValue.at=now;market.head.connected=false;assert.equal(paper.fx(),null);
});
test('Mature independent markets and risk reports continue during GMGN bans without touching its cooldown',async t=>{
 const {store}=fixture(t);let gmgnCalls=0;const token='0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',pool='0x0ed7e52944161450477ee417de9cd3a859b14fd0',now=Date.now();
 const rpc={chain:'bsc',block:async()=>({number:100,time:Date.now(),hash:'original',transactions:[]})};
 const md={id:token,at:now,source:'public-bsc',info:{address:token,symbol:'CAKE',biggest_pool_address:pool,liquidity:1000000,price:{volume_24h:100000,price:1}},security:{address:token,buy_tax:0,sell_tax:0,is_honeypot:false,verifiedPool:pool}};
 const publicData={supports:t=>t===token,candidates:()=>[{address:token,symbol:'CAKE'}],metadata:async()=>md,status:()=>[]};
 const market=new CloudMarket(store,{rpc,publicData,gmgn:{status:()=>({limited:true,retryAt:now+3600000}),trenches:async()=>{gmgnCalls++;throw Error();}}});
 market.nativePrice={read:async()=>({id:'native-fx',usd:750,at:now,readAt:now,source:'Chainlink test'})};
 market.venues.bsc={pool:async(t,q,p)=>({kind:'v2',token:t,quote:q,pool:p}),decimals:async()=>18,spot:async()=>1/750,conversion:async()=>null};
 await market.refresh();assert.equal(gmgnCalls,0);assert.equal(market.markets().length,1);assert.equal(market.markets()[0].quality,'verified');assert.equal(market.markets()[0].priceUsd,1);assert.equal(market.markets()[0].dataSource,'BSC RPC · DEX Screener · Honeypot.is');assert.equal(market.marketWait(),null);
 assert.throws(()=>market.verifyExternalTaxes('bsc',token,{kind:'v2',pool:TOKEN}),/不一致/);
});
test('Cloud market quotes exact reserves and real gas evidence; unknown taxes and reorgs reject',async t=>{const {store}=fixture(t),now=Date.now(),route={kind:'v2',token:TOKEN,quote:'0x0000000000000000000000000000000000000000',pool:RECIPIENT,fee:25};let fork=false,gaps=0;
 const rpc={chain:'bsc',block:async(n)=>({number:n??100,time:Date.now(),hash:fork?'fork':'original',transactions:[]}),knownBlock:()=>null,read:async(_to,_abi,name)=>name==='decimals'?18:name==='getReserves'?[1000000n*10n**18n,1000n*10n**18n,0]:name==='token0'?TOKEN:null};
 const market=new CloudMarket(store,{rpc,gmgn:{},onGap:()=>gaps++});market.fxValue={usd:500,at:now};market.metadata.set(TOKEN,{at:now,security:{buy_tax:0,sell_tax:0}});market.routes.set(TOKEN,{block:90,route});market.venues.bsc.poolToken0=async()=>TOKEN;
 market.gas.bsc.estimate=async()=>({gasUsd:.01,approvalUsd:0,sourceFeeFrozenAt:now,notes:['test receipt evidence']});
 const q=await market.quote({chain:'bsc',side:'buy',token:TOKEN,recipient:RECIPIENT,nativeAmountRaw:'100000000000000000',block:100});assert.equal(q.inputRaw,'100000000000000000');assert.ok(BigInt(q.outputRaw)>0n);assert.equal(q.fees.includedInOutput,true);assert.equal(q.venue,'v2');
 market.metadata.get(TOKEN).security.buy_tax=null;await assert.rejects(market.quote({chain:'bsc',side:'buy',token:TOKEN,recipient:RECIPIENT,nativeAmountRaw:q.inputRaw,block:100}),/税字段缺失/);
 fork=true;await market.updateHead();assert.equal(gaps,1);assert.equal(market.routes.size,0);
});

test('Mature chain quotes and automatic exit prices continue during chart cooldown while entry screening stays blocked',async t=>{
 const {store}=fixture(t),a=ESTABLISHED_ASSETS[0],wrapped='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',factory='0xca143ce32fe78f1f7019d7d551a6402fc5350c73',now=Date.now();let outbound=0;
 store.put('cloud-settings',{id:'public-budget-dex',retryAt:now+300000,lastError:'HTTP 429'});
 const check={chain:{id:'56'},token:{address:a.address},pair:{chainId:'56',pair:{address:a.pool}},simulationSuccess:true,simulationResult:{buyTax:0,sellTax:0,transferTax:0},honeypotResult:{isHoneypot:false},contractCode:{isProxy:false,hasProxyCalls:false,openSource:true,rootOpenSource:true}};
 const rpc={chain:'bsc',block:async n=>({number:n??100,time:Date.now(),hash:'original',transactions:[]}),knownBlock:()=>null,read:async(_to,_abi,name)=>name==='decimals'?18:name==='getReserves'?[1000000n*10n**18n,1000n*10n**18n,0]:name==='token0'?a.address:name==='token1'?wrapped:name==='factory'?factory:name==='getPair'?a.pool:null};
 const data=new PublicBscData(store,rpc,{fetchImpl:async()=>{outbound++;throw Error('Unexpected HTTP request during chart cooldown');}});
 data.tradingEvidence=async()=>({at:now,check,proof:{pool:a.pool,codeHash:a.codeHash}});
 const market=new CloudMarket(store,{rpc,publicData:data,gmgn:{status:()=>({limited:true}),trenches:async()=>{throw Error('Do not bypass GMGN cooldown');}}});
 market.nativePrice={read:async()=>({id:'native-fx',usd:750,at:now,readAt:now,source:'Chainlink fixture'})};
 market.gas.bsc.estimate=async()=>({gasUsd:.01,approvalUsd:0,sourceFeeFrozenAt:now,notes:['isolated receipt fixture']});
 await market.refresh([a.address],{limit:1});let m=market.getMarket('bsc',a.address);
 assert.equal(m.quality,'verified');assert.equal(m.priceUsd,.75);assert.equal(m.marketDataAt,null);assert.equal(m.volumeUsd,null);assert.equal(m.priceChange,null);assert.equal(m.dataSource,'BSC RPC · Honeypot.is');
 const paper=new PaperDesk(store,market),q=await paper.quote({id:'isolated-exit',address:RECIPIENT},'sell',a.address,'1000000000000000000',100);
 assert.equal(q.spentInputRaw,q.inputRaw);assert.ok(BigInt(q.outputRaw)>0n);assert.equal(q.quality,'verified');assert.equal(q.nativeUsd,750);
 const guard=new TokenRiskGuard(store,{source:{riskReport:token=>data.riskReport(token)}});t.after(()=>guard.close());
 await assert.rejects(guard.assertBuy(a.address,{sizeUsd:10,marketPrice:m.priceUsd}),/风险|资料|冷却/);assert.equal(guard.snapshot(a.address).buyAllowed,false);assert.equal(outbound,0);assert.equal(data.status()[0].retryAt,now+300000);
 Object.assign(m,{marketDataAt:now-120001,liquidityUsd:1000000,volumeUsd:100000,priceChange:{h24:99},transactions:{h24:{buys:10,sells:1}}});
 await market.pulse(1);m=market.getMarket('bsc',a.address);assert.equal(m.quality,'verified');assert.equal(m.volumeUsd,null);assert.equal(m.transactions,null);assert.equal(m.marketDataAt,null);assert.equal(m.priceChange,null);
 check.simulationResult.sellTax=null;market.metadata.delete(a.address);await assert.rejects(paper.quote({id:'isolated-exit',address:RECIPIENT},'sell',a.address,q.inputRaw,100),/身份/);
 assert.equal(store.all('paper-fills').length,0);assert.equal(outbound,0);
});

test('Actual Workerd SQLite isolates owners, survives eviction, locks money and serves unchanged page bytes',async t=>{
 let assetCalls=0,outboundCalls=0;const mf=new Miniflare(convertV4MiniflareOptions({name:'bitrade-test',modules:true,scriptPath:'.cloud-test-build/worker.mjs',compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],durableObjects:{PLATFORM:{className:'TradingPlatform',useSQLite:true},PROBE:{className:'NetworkProbe',useSQLite:true}},bindings:{SITE_ORIGIN:'https://bitrade.site',BI_TRADE_VAULT_KEY:vaultKey.toString('base64')},
  outboundService:async req=>{outboundCalls++;const host=new URL(req.url).host;return Response.json(host==='rpc.example.com'?{result:'0x38'}:host==='ai.example.com'?{status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({action:'hold',token:null,sizeUsd:null,reason:'观察',exit:{takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60}})}]}]}:{code:0,data:{address:TOKEN}});},serviceBindings:{ASSETS:async req=>{assetCalls++;const name=new URL(req.url).pathname.slice(1);try{return new Response(readFileSync(resolve('bi-trade/web',name)));}catch{return new Response(null,{status:404});}}}}));t.after(()=>mf.dispose());await mf.ready;
 const call=async(path,data,session,extra={})=>{const r=await mf.dispatchFetch('https://bitrade.site'+path,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{'Content-Type':'application/json',...(!['/api/agent','/mcp'].includes(path)?{Origin:'https://bitrade.site'}:{})}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:r.status,value:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const page=await mf.dispatchFetch('https://bitrade.site/');assert.equal(await page.text(),readFileSync('bi-trade/web/intro.html','utf8'));const home=await mf.dispatchFetch('https://bitrade.site/home');assert.equal(await home.text(),readFileSync('bi-trade/web/index.html','utf8'));assert.equal(assetCalls,2);assert.equal(outboundCalls,0);
 const health=await call('/api/health');assert.equal(health.value.liveEnabled,false);const pub=await call('/api/public');assert.equal(pub.value.agents.length,3);assert.ok(!JSON.stringify(pub.value).includes('encryptedKey'));
 const x=await call('/api/session',{}),y=await call('/api/session',{}),a={cookie:x.cookie,csrf:x.value.csrf},b={cookie:y.cookie,csrf:y.value.csrf};
 const p=await call('/api/pair',{},a);assert.equal((await call('/api/state',undefined,a)).value.agents.length,0);
 assert.equal((await call('/api/agent',{action:'register_dot',arguments:{pairingCode:p.value.pairingCode,name:'runtime'}},null,{Origin:'https://bitrade.site'})).status,403);
 const reg=await call('/api/agent',{action:'register_dot',arguments:{pairingCode:p.value.pairingCode,name:'runtime'}}),agent=reg.value.result;assert.equal(reg.status,200);
 assert.equal((await call('/api/control',{agentId:agent.agentId,paused:true},b)).status,404);
 assert.equal((await call('/api/state',undefined,b)).value.agents.length,0);
 await mf.unsafeEvictDurableObject('bitrade-test','TradingPlatform',{name:'bitrade-platform-v1'});
 const restored=(await call('/api/state',undefined,a)).value.agents[0];assert.equal(restored.address,agent.address);assert.equal(restored.paper.initialUsd,1000);
 assert.equal((await call('/api/withdraw',{id:'invalid',signature:'invalid'},a)).status,423);
 assert.equal((await call('/api/agent/close',{agentId:agent.agentId},a)).status,200);assert.equal((await call('/api/state',undefined,a)).value.archivedAgents.length,1);
 assert.equal((await call('/api/agent',{action:'get_account',arguments:{}},null,{Authorization:'Bearer '+agent.agentToken})).status,401);
 assert.equal((await mf.dispatchFetch('https://wrong.example/api/health')).status,403);
 const probe=await mf.getDurableObjectNamespace('PROBE'),result=await probe.get(probe.idFromName('probe')).fetch('https://test.example/probe');assert.equal(result.status,200);const native=await result.json();assert.equal(native.chain,'0x38');assert.equal(native.decision.action,'hold');assert.equal(outboundCalls,3);
});

test('Actual Workerd retains a model task after an alarm returns while later rounds keep their own budgets and exit checks',async t=>{
 let release,started;const ready=new Promise(r=>release=r),begin=new Promise(r=>started=r),calls=[];
 const mf=new Miniflare(convertV4MiniflareOptions({name:'scheduler-runtime-test',modules:true,scriptPath:'.cloud-test-build/worker.mjs',compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],durableObjects:{PLATFORM:{className:'TradingPlatform',useSQLite:true},PROBE:{className:'NetworkProbe',useSQLite:true},SCHEDULER:{className:'SchedulerProbe',useSQLite:true}},bindings:{SITE_ORIGIN:'https://bitrade.site'},outboundService:async req=>{const host=new URL(req.url).host;calls.push(host);if(host==='slow-ai.example.com'){started();await ready;}return Response.json({});},serviceBindings:{ASSETS:async()=>new Response('unused')}}));
 t.after(async()=>{release();await mf.dispose();});await mf.ready;
 const ns=await mf.getDurableObjectNamespace('SCHEDULER'),stub=ns.get(ns.idFromName('budget-probe'));
 const first=stub.fetch('https://probe.example/round');await begin;let timer;
 const completed=await Promise.race([first.then(async r=>r.json()),new Promise(r=>timer=setTimeout(()=>r(null),1000))]);clearTimeout(timer);
 try{
  assert.ok(completed,'the model must not hold the alarm response');assert.equal(completed.active,true);assert.equal(completed.decisionBudget.used,2);
  const second=await (await stub.fetch('https://probe.example/round')).json();assert.equal(second.active,true);assert.equal(second.refreshes,2);assert.equal(second.watches,1);assert.equal(second.matches,2);assert.equal(second.modelCalls,1);assert.equal(second.budget.used,1);
 }finally{release();await first;}
 const done=await (await stub.fetch('https://probe.example/finish')).json();assert.equal(done.active,false);assert.equal(done.decisionBudget.used,3);assert.ok(done.decisionBudget.completedAt>=done.decisionBudget.startedAt);assert.equal(done.budget.used,1);assert.deepEqual(calls,['price.example.com','slow-ai.example.com','price.example.com','after-ai.example.com']);
});

test('Actual Workerd read-only protection keeps agents and history visible without SQL writes, sessions, new funds or model calls', async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'read-only-test',
      modules: true,
      scriptPath: '.cloud-test-build/worker.mjs',
      compatibilityDate: '2026-10-09',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: { PLATFORM: { className: 'ReadOnlyProbe', useSQLite: true } },
      bindings: {
        SITE_ORIGIN: 'https://bitrade.site',
        BI_TRADE_VAULT_KEY: vaultKey.toString('base64'),
      },
      outboundService: async () => {
        throw Error('Read-only service must not make outbound calls');
      },
      serviceBindings: { ASSETS: async () => new Response('unused') },
    }),
  );
  t.after(() => mf.dispose());
  await mf.ready;
  const get = async (path) => {
    const r = await mf.dispatchFetch('https://bitrade.site' + path);
    assert.equal(r.status, 200);
    return r.json();
  };
  const before = await get('/api/public'),
    ns = await mf.getDurableObjectNamespace('PLATFORM');
  await ns.get(ns.idFromName('bitrade-platform-v1')).fetch('https://test.example/__test/protect');
  const after = await get('/api/public'),
    runtime = await get('/api/runtime');
  assert.equal(runtime.storageProtection.readOnly, true);
  assert.equal(after.agents.length, 3);
  for (const a of after.agents) {
    const b = before.agents.find((x) => x.id === a.id);
    assert.equal(a.address, b.address);
    assert.equal(a.realizedUsd, b.realizedUsd);
    assert.match(a.runtime.reason, /只读/);
  }
  const session = await mf.dispatchFetch('https://bitrade.site/api/session', {
    method: 'POST',
    headers: { Origin: 'https://bitrade.site', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(session.status, 503);
  assert.equal((await get('/api/leaderboard')).entries.length, 3);
});

test('Actual Workerd checkpoints write protection, preserves accounts and recovers on the next UTC day',async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:'budget-protection-test',modules:true,scriptPath:'.cloud-test-build/worker.mjs',compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],durableObjects:{PLATFORM:{className:'BudgetProbe',useSQLite:true}},bindings:{SITE_ORIGIN:'https://bitrade.site',BI_TRADE_VAULT_KEY:vaultKey.toString('base64')},outboundService:async()=>{throw Error('No outbound calls during read-only checks');},serviceBindings:{ASSETS:async()=>new Response('unused')}}));t.after(()=>mf.dispose());await mf.ready;
 const ns=await mf.getDurableObjectNamespace('PLATFORM'),stub=ns.get(ns.idFromName('bitrade-platform-v1'));
 const get=async path=>{const r=await mf.dispatchFetch('https://bitrade.site'+path);assert.equal(r.status,200);return r.json();};
 const before=await get('/api/public');await stub.fetch('https://test.example/__test/exhaust');
 const runtime=await get('/api/runtime');assert.equal(runtime.storageProtection.readOnly,true);assert.ok(runtime.storageProtection.writeBudget.rows>=80000);
 const readonly=await get('/api/public');assert.deepEqual(readonly.agents.map(a=>[a.id,a.address,a.realizedUsd]),before.agents.map(a=>[a.id,a.address,a.realizedUsd]));
 await mf.unsafeEvictDurableObject('budget-protection-test','BudgetProbe',{name:'bitrade-platform-v1'});
 assert.equal((await get('/api/runtime')).storageProtection.readOnly,true);
 await stub.fetch('https://test.example/__test/next-day');assert.equal((await get('/api/runtime')).storageProtection.readOnly,false);
 assert.deepEqual((await get('/api/public')).agents.map(a=>[a.id,a.address,a.realizedUsd]),before.agents.map(a=>[a.id,a.address,a.realizedUsd]));
});

test('Actual Workerd reports only a known future protection deadline and does not invent a new reset date after it passes',async t=>{
 for(const until of [Date.now()+3600000,Date.now()-3600000]){
  const mf=new Miniflare(convertV4MiniflareOptions({name:'storage-admission-test',modules:true,scriptPath:'.cloud-test-build/worker.mjs',compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],durableObjects:{PLATFORM:{className:'QuotaFailure',useSQLite:true}},bindings:{SITE_ORIGIN:'https://bitrade.site',BI_TRADE_STORAGE_READ_ONLY_UNTIL:new Date(until).toISOString()},serviceBindings:{ASSETS:async()=>new Response('static page')}}));t.after(()=>mf.dispose());await mf.ready;
  const r=await mf.dispatchFetch('https://bitrade.site/api/public'),j=await r.json();assert.equal(r.status,503);assert.equal(j.code,'STORAGE_DAILY_QUOTA');assert.equal(j.retryAt,until>Date.now()?until:null);assert.ok(Number(r.headers.get('Retry-After'))>0);if(until<Date.now())assert.equal(r.headers.get('Retry-After'),'300');assert.equal(j.agents,undefined);assert.equal(j.activity,undefined);
  assert.equal((await mf.dispatchFetch('https://bitrade.site/home')).status,200);
 }
});

test('An overdue wake after a prolonged outage gets a new persisted alarm while an upcoming alarm is retained',async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:'overdue-wake-test',modules:true,scriptPath:'.cloud-test-build/worker.mjs',compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],durableObjects:{PROBE:{className:'OverdueWakeProbe',useSQLite:true}}}));t.after(()=>mf.dispose());await mf.ready;
 const ns=await mf.getDurableObjectNamespace('PROBE'),stub=ns.get(ns.idFromName('existing-ledger'));
 const recovered=await(await stub.fetch('https://probe.example/recover')).json();assert.ok(recovered.previousAt<Date.now());assert.ok(recovered.nextAt>Date.now(),'Expired storage metadata must not permanently suppress the next wake');
 const pending=await(await stub.fetch('https://probe.example/upcoming')).json();assert.equal(pending.nextAt,pending.previousAt,'An upcoming earlier wake must keep its deadline');
});

test('Actual Workerd reuses duplicate entity reads without changing public ledger, ranking or risk evidence',async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:'entity-read-profile',modules:true,scriptPath:'.cloud-test-build/worker.mjs',compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],durableObjects:{PROBE:{className:'EntityReadProbe',useSQLite:true}}}));t.after(()=>mf.dispose());await mf.ready;
 const ns=await mf.getDurableObjectNamespace('PROBE'),stub=ns.get(ns.idFromName('isolated-profile'));
 const value=await(await stub.fetch('https://probe.example/profile')).json();
 assert.deepEqual(value.cached,value.baseline);
 assert.equal(value.uncachedWrites,0);assert.equal(value.cachedWrites,0);
 assert.ok(value.cachedRows<value.uncachedRows*0.65,`Repeated SQLite reads should be reduced: ${value.cachedRows}/${value.uncachedRows}`);
 console.log(JSON.stringify({profile:'public-ledger-and-meme-screening',uncachedRows:value.uncachedRows,cachedRows:value.cachedRows}));
});

test('Actual Workerd Flap pulses and discovery share bounded price checkpoints while invalidation and graduation persist immediately',async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:'market-write-profile',modules:true,scriptPath:'.cloud-test-build/worker.mjs',compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],durableObjects:{PROBE:{className:'MarketWriteProbe',useSQLite:true}}}));t.after(()=>mf.dispose());await mf.ready;
 const ns=await mf.getDurableObjectNamespace('PROBE'),value=await(await ns.get(ns.idFromName('isolated-price-profile')).fetch('https://probe.example/profile')).json();
 console.log(JSON.stringify({profile:'flap-pulse-discovery-and-fx',...value.profile}));
 assert.ok(value.profile.marketWrites<=2,`Repeated Flap pulses must not bypass minute checkpoints: ${value.profile.marketWrites}`);
 assert.ok(value.profile.fxWrites<=2,`USD feed polls must not force a checkpoint every 20 seconds: ${value.profile.fxWrites}`);
 for(const [i,f] of value.frames.entries()){assert.equal(f.live.updatedAt,f.at);assert.equal(f.liveFx.readAt,f.at);assert.equal(f.liveFx.usd,751+i);assert.ok(f.saved.updatedAt<=f.at);assert.ok(f.savedFx.readAt<=f.at);}
 assert.equal(value.frames[0].saved.updatedAt,value.start);assert.equal(value.frames[0].savedFx.readAt,value.start);
 assert.equal(value.frames[2].saved.updatedAt,value.frames[2].at);assert.equal(value.frames[2].savedFx.readAt,value.frames[2].at);
 assert.equal(value.rejected.quality,'unavailable');assert.equal(value.recovered.quality,'verified');assert.equal(value.migration.stage,'dex');assert.equal(value.migration.venue,'v2');
 assert.equal(value.excluded.entryActive,false);assert.equal(value.excluded.sellTaxPct,3);assert.equal(value.excluded.quoteProofMode,'scoped-transfers');assert.equal(value.added.address,'0x'+'15'.repeat(20));assert.equal(value.changedFeed.source,'isolated-backup-feed');assert.ok(value.changedFeed.readAt>value.migration.updatedAt);
 assert.deepEqual(value.rebuilt,value.excluded);assert.deepEqual(value.retained,{id:'preserved-fill',agentId:'preserved-agent',netUsd:-3});assert.equal(value.risk.fetchedAt,value.start);
});
