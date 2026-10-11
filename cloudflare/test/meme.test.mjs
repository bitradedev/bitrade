import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync,mkdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {keccak256,encodeAbiParameters,parseAbiParameters} from 'viem';
import {CloudStore} from '../store.mjs';
import {PublicBscData} from '../public-data.mjs';
import {CloudRpc} from '../rpc.mjs';
import {TokenRiskGuard} from '../../bi-trade/lib/token-risk-core.mjs';
import {PaperDesk} from '../../bi-trade/lib/paper-desk.mjs';
import {runScheduledRound} from '../scheduler.mjs';
const require=createRequire(realpathSync('node_modules/wrangler/package.json')),{build}=require('esbuild');
mkdirSync('.cloud-test-build',{recursive:true});
await build({entryPoints:['cloudflare/meme-data.mjs','cloudflare/market.ts'],bundle:true,platform:'node',format:'esm',outdir:'.cloud-test-build/meme-tests',outExtension:{'.js':'.mjs'}});
const {MemeBscData,fourCandidates,geckoPair,selectDexPair,transferClusters,migrationCandidates,MEME_BOOTSTRAP,swapTurnover}=await import('../../.cloud-test-build/meme-tests/meme-data.mjs');
const {CloudMarket}=await import('../../.cloud-test-build/meme-tests/market.mjs');
const TOKEN='0x'+'11'.repeat(20),POOL='0x'+'22'.repeat(20),OTHER='0x'+'33'.repeat(20),OWNER='0x'+'44'.repeat(20),WBNB='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',FACTORY='0xca143ce32fe78f1f7019d7d551a6402fc5350c73',MANAGER='0x5c952063c7fc8610ffdb798152d69f0b9550762b';
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());const sql={exec(query,...args){if(!args.length&&query.split(';').filter(x=>x.trim()).length>1){db.exec(query);return {toArray:()=>[],rowsWritten:0};}const s=db.prepare(query);if(/^(?:CREATE|DELETE|INSERT|UPDATE)/i.test(query.trim())){const r=s.run(...args);return {toArray:()=>[],rowsWritten:r.changes};}return {toArray:()=>s.all(...args),rowsWritten:0};}};return new CloudStore({sql,transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}});}
const fourRow=(tokenAddress=TOKEN)=>({tokenAddress,networkCode:0,status:'TRADE',symbol:'BNB',shortName:'Meme',tag:'Meme',day1Vol:5000});
const pair=()=>({chainId:'bsc',dexId:'pancakeswap',pairAddress:POOL,baseToken:{address:TOKEN},quoteToken:{address:WBNB},labels:['v2'],priceUsd:'1',liquidity:{usd:20000},volume:{h24:5000},priceChange:{h24:1},txns:{h24:{buys:10,sells:8}}});
const check=()=>({chain:{id:'56'},token:{address:TOKEN,symbol:'Meme',totalHolders:200},pair:{chainId:'56',pair:{address:POOL}},simulationSuccess:true,simulationResult:{buyTax:0,sellTax:0,transferTax:0},honeypotResult:{isHoneypot:false},contractCode:{isProxy:false,hasProxyCalls:false,openSource:true,rootOpenSource:true},summary:{riskLevel:0,flags:[]}});
const holders=()=>({totalSupply:'1000000',holders:[{address:POOL,balance:'500000',isContract:true},...Array.from({length:50},(_,i)=>({address:'0x'+(100+i).toString(16).padStart(40,'0'),balance:'10000',isContract:false}))]});
function rpcFixture(){let head=100;const calls=[];return {chain:'bsc',calls,setHead:n=>head=n,knownBlock:()=>null,block:async n=>({number:n??head,time:Date.now(),hash:'canonical',transactions:[]}),request:async(method)=>{calls.push(method);if(method==='eth_getCode')return '0x6000';if(method==='eth_getLogs')return [];throw Error('Unexpected RPC');},read:async(_to,_abi,name,args)=>{calls.push(name);if(name==='getTokenInfo'){const f=Array(12).fill(0);f[0]=2;f[1]=MANAGER;f[2]='0x'+'00'.repeat(20);f[11]=true;return f;}if(name==='token0')return TOKEN;if(name==='token1')return WBNB;if(name==='factory')return FACTORY;if(name==='getPair')return POOL;if(name==='totalSupply')return 1000000n;if(name==='balanceOf')return args[0]===POOL?500000n:0n;if(name==='decimals')return 18;if(name==='getReserves')return [1000000n*10n**18n,1000n*10n**18n,0];throw Error('Unexpected '+name);}};}
function sourceFixture(t){const store=fixture(t),rpc=rpcFixture(),data=new MemeBscData(store,rpc);store.put('cloud-meme-candidates',{id:TOKEN,address:TOKEN,symbol:'Meme',category:'meme',active:true,entryRank:0});data.chart=async()=>({pair:pair(),at:Date.now()});data.read=async(_service,path)=>({at:Date.now(),value:path.includes('TopHolders')?holders():check()});return {store,rpc,data};}

test('A recovered price backup cannot mark unavailable launchpad events as recovered',async(t)=>{
 const store=fixture(t),now=1000000,calls=[];
 const rpc=new CloudRpc('https://primary.example',{store,now:()=>now,backupUrl:'https://backup.example',fetchImpl:async(url,options)=>{
  const q=JSON.parse(options.body);calls.push([url,q.method]);if(url.includes('primary'))return Response.json({}, {status:429,headers:{'Retry-After':'60'}});
  return Response.json({result:q.method==='eth_chainId'?'0x38':{number:'0x64',timestamp:'0x3e8',hash:'0x'+'11'.repeat(32),transactions:[]}});
 }});
 await rpc.block();assert.equal(rpc.status().limited,false);
 const data=new MemeBscData(store,rpc,{now:()=>now}),events=data.status().find(s=>s.source==='BSC launchpad events');
 assert.equal(events.limited,true);assert.equal(events.retryAt,1065000);
 assert.deepEqual(await data.scanMigrations(),[]);assert.equal(calls.filter(([u])=>u.includes('primary')).length,1);assert.ok(!calls.some(([u,m])=>u.includes('backup')&&m==='eth_getLogs'));
 assert.equal(store.get('cloud-settings','meme-chain-index').lastSuccessAt,undefined);
});

test('Four public candidates use explicit BSC and Meme evidence, not quote ticker or unrelated assets',()=>{
 const rows=[fourRow(),fourRow(),...['chain','tag','status','quote','tax','address'].map(k=>{const r=fourRow(OTHER);if(k==='chain')r.networkCode=1;if(k==='tag')r.tag='DeFi';if(k==='status')r.status='CREATE';if(k==='quote')r.symbol='USD1';if(k==='tax')r.taxFee='.01';if(k==='address')r.tokenAddress='invalid';return r;}),fourRow('0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82')];
 const r=fourCandidates({data:rows},100);assert.equal(r.length,1);assert.equal(r[0].symbol,'Meme');assert.equal(r[0].category,'meme');assert.equal(r[0].at,100);
 assert.equal(fourCandidates({data:[{...fourRow(OTHER),day1Vol:1},fourRow()]},100,true)[0].address,OTHER);
});
test('Direct launchpad migration candidates verify emitter, ABI and range, never accepting unrelated events',()=>{
 const topic=keccak256(new TextEncoder().encode('LiquidityAdded(address,uint256,address,uint256)')),log={address:MANAGER,blockNumber:'0x64',blockHash:'0x'+'ac'.repeat(32),transactionHash:'0x'+'bc'.repeat(32),topics:[topic],data:encodeAbiParameters(parseAbiParameters('address,uint256,address,uint256'),[TOKEN,10n,WBNB,1n])};
 const c=migrationCandidates([log],90,110,123)[0];assert.equal(c.address,TOKEN);assert.equal(c.discoveryBlock,100);assert.equal(c.at,123);assert.equal(c.category,'meme');assert.equal(migrationCandidates([{...log,removed:true}],90,110,123).length,0);
 for(const mutate of [l=>l.address=OWNER,l=>l.blockNumber='0x10',l=>l.data='0x',l=>l.address='0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0']){const wrong=structuredClone(log);mutate(wrong);assert.throws(()=>migrationCandidates([wrong],90,110,123));}
});
test('Public API denial preserves cooldown and falls back to on-chain discovery and only Meme bootstrap identities',async t=>{
 const store=fixture(t),rpc=rpcFixture(),now=Date.now(),data=new MemeBscData(store,rpc,{now:()=>now}),deadline=now+300000;store.put('cloud-settings',{id:'public-budget-four',retryAt:deadline,lastError:'HTTP 403'});store.put('cloud-settings',{id:'public-budget-gecko',retryAt:deadline,lastError:'HTTP 429'});let sent=0;data.fetch=async()=>{sent++;throw Error('Do not bypass cooldown');};
 const rows=await data.discover();assert.equal(rows.length,MEME_BOOTSTRAP.length);assert.ok(rows.some(c=>c.symbol==='B'));assert.ok(rows.every(c=>c.category==='meme'));assert.equal(store.get('cloud-settings','public-budget-four').retryAt,deadline);assert.equal(store.get('cloud-settings','public-budget-gecko').retryAt,deadline);assert.equal(sent,0);assert.ok(data.status().find(s=>s.source==='BSC launchpad events').lastSuccessAt);assert.ok(rpc.calls.includes('eth_getLogs'));assert.ok(rows.every(c=>c.priceUsd===undefined));
});
test('Chain pool turnover validates events and duplicates, keeping USD turnover a disclosed partial lower bound',async t=>{
 const topic=keccak256(new TextEncoder().encode('Swap(address,uint256,uint256,uint256,uint256,address)')),pad=a=>'0x'+'0'.repeat(24)+a.slice(2),log={address:POOL,blockNumber:'0x5a',blockHash:'0x'+'ac'.repeat(32),transactionHash:'0x'+'bc'.repeat(32),logIndex:'0x1',topics:[topic,pad(OWNER),pad(OWNER)],data:encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'),[0n,5n*10n**18n,100n,0n])};
 assert.equal(swapTurnover([log],POOL,0,96,false).quoteRaw,5n*10n**18n);assert.throws(()=>swapTurnover([log,log],POOL,0,96,false),/重复/);assert.throws(()=>swapTurnover([{...log,address:OWNER}],POOL,0,96,false),/身份/);
 const {store,rpc,data}=sourceFixture(t);store.put('cloud-settings',{id:'native-fx',source:'Chainlink BNB/USD · BSC',usd:750,at:Date.now()});const request=rpc.request;rpc.request=async(method,args)=>method==='eth_getLogs'?[log]:request(method,args);
 const c=await data.chainChart(TOKEN);assert.equal(c.pair.priceUsd,'0.75');assert.equal(c.pair.liquidity.usd,1500000);assert.equal(c.pair.volume.h24,3750);assert.equal(c.pair.priceChange,null);assert.equal(c.pair.txns,null);assert.equal(c.pair.volumeWindow.kind,'recent-swap-lower-bound');assert.equal(c.pair.volumeWindow.toBlock,96);
 store.put('cloud-settings',{id:'native-fx',source:'Chainlink BNB/USD · BSC',usd:750,at:Date.now()-90001});await assert.rejects(data.chainChart(TOKEN),/过期/);
});
test('A quiet recent page expands the bounded real turnover sample, preserves cache age and resamples after a fork',async t=>{
 const {store,rpc,data}=sourceFixture(t);rpc.setHead(8000);let calls=0,fork=false,now=Date.now();data.now=()=>now;
 const block=rpc.block;rpc.block=async(...args)=>({...await block(...args),time:now-5000,hash:fork?'fork':'original'});
 const topic=keccak256(new TextEncoder().encode('Swap(address,uint256,uint256,uint256,uint256,address)')),pad=a=>'0x'+'0'.repeat(24)+a.slice(2),log={address:POOL,blockNumber:'0x'+(5500).toString(16),blockHash:'0x'+'ac'.repeat(32),transactionHash:'0x'+'bc'.repeat(32),logIndex:'0x1',topics:[topic,pad(OWNER),pad(OWNER)],data:encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'),[0n,2n*10n**18n,100n,0n])};
 rpc.request=async(method,[q])=>{assert.equal(method,'eth_getLogs');calls++;const from=Number(BigInt(q.fromBlock)),to=Number(BigInt(q.toBlock));assert.ok(to-from+1<=1000);return from<=5500&&to>=5500?[log]:[];};
 const b=await rpc.block(),sample=await data.turnoverWindow(POOL,b,false,750);assert.equal(calls,3);assert.equal(sample.quoteRaw,'2000000000000000000');assert.equal(sample.fromBlock,4997);assert.equal(sample.toBlock,7996);assert.equal(sample.buys,1);
 now+=30000;const cached=await data.turnoverWindow(POOL,b,false,750);assert.equal(calls,3);assert.equal(cached.at,sample.at);fork=true;await data.turnoverWindow(POOL,b,false,750);assert.equal(calls,6);
});
test('Pair parsers reject wrong chains, quotes, DEXes and token identities',()=>{
 const p=pair();assert.equal(selectDexPair([p],TOKEN),p);
 for(const mutate of [p=>p.chainId='ethereum',p=>p.dexId='unverified',p=>p.baseToken.address=OTHER,p=>p.quoteToken.address=OTHER,p=>p.labels=['unknown']]){const q=pair();mutate(q);assert.equal(selectDexPair([q],TOKEN),null);}
 const value={data:[{attributes:{address:POOL,name:'Meme / WBNB',base_token_price_usd:'1',reserve_in_usd:'20000',volume_usd:{h24:'5000'}},relationships:{base_token:{data:{id:'bsc_'+TOKEN}},quote_token:{data:{id:'bsc_'+WBNB}},dex:{data:{id:'pancakeswap_v2'}}}}]};
 assert.equal(geckoPair(value,TOKEN).pairAddress,POOL);assert.equal(geckoPair(value,OTHER),null);value.data[0].relationships.quote_token.data.id='bsc_'+OTHER;assert.equal(geckoPair(value,TOKEN),null);
});
test('Meme prices fail over from limited DEX Screener to GeckoTerminal and then verified chain reserves without retrying a cooling provider',async t=>{
 const store=fixture(t),rpc=rpcFixture();let now=Date.now();const sent=[];
 const value={data:[{attributes:{address:POOL,name:'Meme / WBNB',base_token_price_usd:'1',reserve_in_usd:'20000',volume_usd:{h24:'5000'}},relationships:{base_token:{data:{id:'bsc_'+TOKEN}},quote_token:{data:{id:'bsc_'+WBNB}},dex:{data:{id:'pancakeswap_v2'}}}}]};
 const data=new MemeBscData(store,rpc,{now:()=>now,fetchImpl:async url=>{sent.push(String(url));return String(url).includes('dexscreener')?Response.json({}, {status:429,headers:{'Retry-After':'600'}}):Response.json(value);}});
 const chart=await data.chart(TOKEN);assert.equal(chart.pair.chartSource,'GeckoTerminal');assert.equal(chart.at,now);assert.equal(sent.length,2);const dexDeadline=store.get('cloud-settings','public-budget-dex').retryAt;assert.equal(dexDeadline,now+605000);
 now+=1000;const cached=await data.chart(TOKEN);assert.equal(sent.length,2);assert.equal(cached.at,chart.at);
 now+=60001;store.put('cloud-settings',{id:'public-budget-gecko',retryAt:now+300000});store.put('cloud-settings',{id:'native-fx',source:'Chainlink BNB/USD · BSC',usd:750,at:now});
 const block=rpc.block;rpc.block=async n=>({...await block(n),time:now});
 const fallback=await data.chart(TOKEN);assert.equal(fallback.pair.chartSource,'BSC RPC');assert.equal(fallback.pair.priceUsd,'0.75');assert.equal(sent.length,2);assert.equal(store.get('cloud-settings','public-budget-dex').retryAt,dexDeadline);assert.equal(fallback.pair.volumeWindow.kind,'recent-swap-lower-bound');assert.equal(fallback.pair.volume.h24,0);
});
test('POST discovery shares cache and cooldown with all read-only sources without provider credentials',async t=>{
 const store=fixture(t),now=Date.now(),sent=[],body={type:'VOL',tag:['Meme']};const first=new MemeBscData(store,{}, {now:()=>now,fetchImpl:async(url,opts)=>{sent.push({url,opts});return Response.json({code:0,data:[fourRow()]});}}),second=new PublicBscData(store,{}, {now:()=>now,sharedReader:first,fetchImpl:()=>{throw Error('Shared request should coalesce');}});
 const [a,b]=await Promise.all([first.read('four','/public/token/search',body),second.read('four','/public/token/search',body)]);assert.deepEqual(a,b);assert.equal(sent.length,1);assert.equal(sent[0].opts.method,'POST');assert.deepEqual(JSON.parse(sent[0].opts.body),body);assert.equal(sent[0].opts.headers.Authorization,undefined);assert.equal(sent[0].opts.headers.Cookie,undefined);
 store.put('cloud-settings',{id:'public-budget-four',retryAt:now+300000,lastError:'HTTP 429'});await assert.rejects(first.read('four','/public/token/search',{type:'NEW'}),/冷却/);assert.equal(sent.length,1);
});
test('An unindexed token 404 is isolated, retained across restart, and cannot pause another token or its exit checks',async t=>{
 const store=fixture(t);let now=Date.now(),calls=0;const fetchImpl=async url=>{calls++;return url.includes(OTHER)?Response.json({}, {status:404}):Response.json(check());},data=new PublicBscData(store,{}, {now:()=>now,fetchImpl});
 await assert.rejects(data.read('safety','/v2/IsHoneypot?address='+OTHER),/404/);now+=2001;await data.read('safety','/v2/IsHoneypot?address='+TOKEN);assert.equal(calls,2);assert.equal(data.status().find(s=>s.source==='Honeypot.is').limited,false);
 const restarted=new PublicBscData(store,{}, {now:()=>now,fetchImpl});await assert.rejects(restarted.read('safety','/v2/IsHoneypot?address='+OTHER),/404/);assert.equal(calls,2);assert.equal(store.get('cloud-settings','public-budget-safety').lastResourceFailure.status,404);
});
test('Discovery mixes recent and volume memes, preserves held routes and deactivates dropped entries',async t=>{
 const store=fixture(t),now=Date.now(),data=new MemeBscData(store,{}, {now:()=>now}),requests=[];
 store.put('cloud-meme-candidates',{id:OTHER,address:OTHER,category:'meme',active:true});store.put('paper-lots',{id:'keep',token:OTHER,remainingRaw:'1'});store.put('paper-fills',{id:'history',token:OTHER,netUsd:-5});
 data.read=async(_service,path,body)=>{requests.push(body.type);return {at:now,value:{code:0,data:Array.from({length:20},(_,i)=>fourRow('0x'+((body.type==='VOL'?1000:2000)+i).toString(16).padStart(40,'0')))}};};
 const rows=await data.discover();assert.equal(rows.length,12);assert.deepEqual(requests,['VOL','NEW']);assert.equal(rows[1].address,'0x'+(2000).toString(16).padStart(40,'0'));assert.equal(data.supports(OTHER),true);assert.equal(store.get('cloud-meme-candidates',OTHER).active,false);assert.equal(store.get('paper-fills','history').netUsd,-5);await data.discover();assert.equal(requests.length,2);
});
test('Fallback pool hints cannot discard already discovered memes before launch identity checks',async t=>{
 const {store,data}=sourceFixture(t);data.read=async service=>{if(service==='four')throw Error('Unavailable');return {at:Date.now(),value:{data:[{relationships:{base_token:{data:{id:'bsc_'+OTHER}},dex:{data:{id:'pancakeswap_v2'}}}}],included:[]}};};
 const rows=await data.discover();assert.ok(rows.some(c=>c.address===TOKEN));assert.ok(rows.some(c=>c.address===OTHER));assert.ok(rows.length<=12);assert.equal(store.get('cloud-meme-candidates',TOKEN).active,true);
});
test('Meme origin, official pool and runtime code must match even with valid-looking chart data',async t=>{
 for(const fault of ['origin','factory','pair','code']){
  const {rpc,data}=sourceFixture(t),read=rpc.read;rpc.read=async(...args)=>{if(fault==='origin'&&args[2]==='getTokenInfo')return Array(12).fill(0);if(fault==='factory'&&args[2]==='factory')return OTHER;if(fault==='pair'&&args[2]==='getPair')return OTHER;return read(...args);};if(fault==='code')rpc.request=async()=> '0x';
  await assert.rejects(data.metadata(TOKEN),/身份|工厂|代码/);
 }
});
test('Recent transfer links validate token, block range and transfer amounts without claiming full bundler detection',()=>{
 const topic=keccak256(new TextEncoder().encode('Transfer(address,address,uint256)')),to=a=>'0x'+'0'.repeat(24)+a.slice(2),tx='0x'+'ab'.repeat(32),log=a=>({address:TOKEN,blockNumber:'0x64',transactionHash:tx,topics:[topic,to(OWNER),to(a)],data:'0x'+'0'.repeat(63)+'1'}),list=[{address:OWNER},{address:OTHER}];
 assert.equal(transferClusters([log(OWNER),log(OTHER)],list,TOKEN,90,110).length,1);assert.equal(transferClusters([{...log(OWNER),data:'0x'+'0'.repeat(64)},log(OTHER)],list,TOKEN,90,110).length,0);
 assert.throws(()=>transferClusters([{...log(OWNER),address:POOL}],list,TOKEN,90,110),/身份/);assert.throws(()=>transferClusters([log(OWNER)],list,TOKEN,101,110),/区块/);
});
test('Meme screening runs through the buy guard without GMGN and keeps unavailable labels null',async t=>{
 const {store,data}=sourceFixture(t);let gmgn=0;const guard=new TokenRiskGuard(store,{source:{riskReport:token=>data.riskReport(token),info:()=>{gmgn++;throw Error();}}});t.after(()=>guard.close());
 const r=await guard.assertBuy(TOKEN,{sizeUsd:20,marketPrice:1});assert.equal(r.policy,'bsc-meme-paper-v1');assert.equal(r.state,'screened-limited');assert.equal(r.metrics.bundlerVolumeShare,null);assert.equal(r.metrics.linkedFunding,null);assert.equal(r.metrics.transferSample.available,true);assert.equal(gmgn,0);await assert.rejects(guard.assertBuy(TOKEN,{sizeUsd:201}),/1%/);
});
test('Chart failure retains verified Meme exits, but stale chart evidence cannot authorize new entries',async t=>{
 const {store,rpc,data}=sourceFixture(t);await data.metadata(TOKEN);store.put('cloud-public-cache',{id:'meme-trading:'+TOKEN,at:Date.now()-121000});const binding=store.get('cloud-meme-pools',TOKEN);store.put('cloud-meme-pools',{...binding,marketDataAt:Date.now()-121000});data.chart=async()=>{throw Error('Chart cooling down');};
 const md=await data.metadata(TOKEN);assert.ok(Date.now()-md.at<1000);assert.ok(Date.now()-md.marketDataAt>120000);
 const market=new CloudMarket(store,{rpc,memeData:data,memeOnly:true,gmgn:{status:()=>({limited:true})}});market.catalog.set(TOKEN,{address:TOKEN,category:'meme',chain:'bsc',symbol:'Meme'});market.nativePrice={read:async()=>({id:'native-fx',usd:750,at:Date.now(),readAt:Date.now()})};market.gas.bsc.estimate=async()=>({gasUsd:.01,approvalUsd:0,sourceFeeFrozenAt:Date.now(),notes:['isolated fee fixture']});
 await market.refresh([TOKEN],{onlyRequested:true});const m=market.getMarket('bsc',TOKEN);assert.equal(m.quality,'verified');assert.equal(m.marketDataAt,null);assert.equal(m.volumeUsd,null);
 const paper=new PaperDesk(store,market);const q=await paper.quote({id:'exit',address:OWNER},'sell',TOKEN,'1000000000000000000',100);assert.equal(q.spentInputRaw,q.inputRaw);assert.ok(BigInt(q.outputRaw)>0n);
 const guard=new TokenRiskGuard(store,{source:{riskReport:t=>data.riskReport(t)}});t.after(()=>guard.close());await assert.rejects(guard.assertBuy(TOKEN,{sizeUsd:20,marketPrice:m.priceUsd}),/过期/);
 Object.assign(m,{marketDataAt:Date.now()-121000,volumeUsd:5000,priceChange:{h24:99}});await market.pulse(1);assert.equal(market.getMarket('bsc',TOKEN).volumeUsd,null);assert.equal(store.all('paper-fills').length,0);
});
test('Meme scope gives fresh entry risk priority over legacy holdings and preserves the shared budget',async()=>{
 const risks=[],host={ctx:{storage:{setAlarm:async()=>{}},waitUntil:()=>{}},store:{all:()=>[{token:OTHER,remainingRaw:'1'}],put:()=>{},prune:()=>{}},io:{trackDecision:p=>p},market:{marketScope:()=>({kind:'meme'}),isEntryCandidate:token=>[TOKEN,POOL].includes(token),refresh:async()=>{},pulse:async()=>{}},risk:{tick:async tokens=>risks.push(tokens)},arm:async()=>{}};const app={paper:{orders:()=>[],tick:async()=>{}},showcase:{freshMarkets:()=>[{address:TOKEN,updatedAt:100},{address:POOL,updatedAt:90}],tick:()=>null}};host.initialize=async()=>app;await runScheduledRound(host);assert.deepEqual(risks,[[TOKEN,POOL]]);
});
test('An eligible Meme keeps its live price ahead of blocked candidates without freshening old risk data',async t=>{
 const store=fixture(t),rpc=rpcFixture(),market=new CloudMarket(store,{rpc,memeOnly:true,gmgn:{}}),now=Date.now(),spots=[];
 market.fxValue={usd:750,at:now};
 for(const token of [OTHER,TOKEN]){market.catalog.set(token,{id:token,address:token,category:'meme',chain:'bsc',quality:'verified',updatedAt:now-16001,priceUsd:.75,marketDataAt:now});market.metadata.set(token,{at:now,source:'meme-bsc',info:{},security:{buy_tax:0,sell_tax:0,verifiedPool:POOL}});market.routes.set(token,{block:90,route:{kind:'v2',token,quote:WBNB,pool:POOL}});}
 const report={id:TOKEN,token:TOKEN,policy:'bsc-meme-paper-v1',buyAllowed:true,fetchedAt:now,metrics:{referencePriceUsd:.75}};store.put('token-risk-reports',report);store.put('token-risk-reports',{...report,id:OTHER,token:OTHER,buyAllowed:false});
 market.venues.bsc={decimals:async()=>18,spot:async r=>{spots.push(r.token);return .001;},conversion:async()=>null};await market.pulse(1);assert.deepEqual(spots,[TOKEN]);assert.ok(market.getMarket('bsc',TOKEN).updatedAt>=now);assert.equal(market.getMarket('bsc',OTHER).updatedAt,now-16001);assert.equal(store.get('token-risk-reports',TOKEN).fetchedAt,now);
 store.put('token-risk-reports',{...report,fetchedAt:now-121000});spots.length=0;await market.pulse(1);assert.deepEqual(spots,[OTHER]);assert.equal(store.get('token-risk-reports',TOKEN).fetchedAt,now-121000);
});
test('Cloud discovery remains Meme-only during GMGN bans, resumes its saved cursor and retains held assets',async t=>{
 const store=fixture(t),now=Date.now();store.put('cloud-settings',{id:'market-cursor',next:1});store.put('cloud-markets',{id:OTHER,address:OTHER,category:'meme',symbol:'old'});store.put('paper-lots',{id:'keep',token:OTHER,remainingRaw:'1'});let gmgn=0;
 const data={candidates:()=>[{id:TOKEN,address:TOKEN,symbol:'Meme',category:'meme',at:now}],discover:async()=>data.candidates()};const market=new CloudMarket(store,{rpc:rpcFixture(),memeData:data,memeOnly:true,gmgn:{status:()=>({limited:true}),trenches:()=>{gmgn++;throw Error();}}});await market.discover();assert.equal(market.isEntryCandidate(OTHER),false);assert.equal(market.getMarket('bsc',OTHER).address,OTHER);assert.equal(market.cursor,1);assert.equal(gmgn,0);assert.equal(market.marketScope().tokens[0],'Meme');assert.equal(market.isEntryCandidate(TOKEN),true);
});
test('Isolated Meme paper orders use a later block, sell with FIFO fees, and reject mature queued buys without resetting losses',async t=>{
 const {store,rpc,data}=sourceFixture(t),market=new CloudMarket(store,{rpc,memeData:data,memeOnly:true,gmgn:{status:()=>({limited:true})}});
 data.chart=async()=>({pair:{...pair(),priceUsd:'.75'},at:Date.now()});
 market.catalog.set(TOKEN,{id:TOKEN,address:TOKEN,category:'meme',chain:'bsc',symbol:'Meme'});market.nativePrice={read:async()=>({id:'native-fx',usd:750,at:Date.now(),readAt:Date.now()})};market.gas.bsc.estimate=async()=>({gasUsd:.01,approvalUsd:0,sourceFeeFrozenAt:Date.now(),notes:['isolated receipt fixture']});await market.refresh([TOKEN],{onlyRequested:true});
 const guard=new TokenRiskGuard(store,{source:{riskReport:token=>data.riskReport(token)}});t.after(()=>guard.close());const paper=new PaperDesk(store,market,{buyGuard:async(_agent,token,{inputRaw,nativeUsd,marketPrice,refresh})=>{market.assertEntry(token);await guard.assertBuy(token,{sizeUsd:Number(inputRaw)/1e18*nativeUsd,marketPrice,refresh});}}),agent={id:'isolated-meme',address:OWNER,mode:'paper',paused:false};store.put('agents',agent);
 const buy=await paper.submit(agent,{id:'meme-buy',side:'buy',token:TOKEN,amount:'10000000000000000'});await paper.tick();assert.equal(paper.fills().length,0);store.put('paper-orders',{...buy,dueAt:Date.now()-1});rpc.setHead(101);await market.updateHead();await paper.tick();assert.equal(paper.fills().length,1);assert.equal(paper.fills()[0].block,101);
 const lot=paper.lots(agent.id)[0],sell=await paper.submit(agent,{id:'meme-sell',side:'sell',token:TOKEN,amount:lot.remainingRaw});store.put('paper-orders',{...sell,dueAt:Date.now()-1});rpc.setHead(102);await market.updateHead();await paper.tick();assert.equal(paper.fills().length,2);assert.equal(paper.lots(agent.id).length,0);assert.ok(paper.account(agent.id).realizedUsd<0);assert.ok(paper.account(agent.id).feesUsd>0);assert.equal(paper.fills()[1].costBasisUsd,lot.usdCost);
 const loss=paper.account(agent.id).realizedUsd;await assert.rejects(paper.submit(agent,{id:'mature',side:'buy',token:'0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',amount:'1000000000000000'}),/仅允许.*Meme/);assert.equal(paper.account(agent.id).realizedUsd,loss);assert.equal(paper.fills().length,2);
 const mature='0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',quote=market.quote.bind(market);market.quote=async request=>request.token===mature?{...buy.reference,token:mature,block:request.block,at:Date.now()}:quote(request);
 store.put('paper-orders',{...buy,id:'old-queued-mature',token:mature,dueAt:Date.now()-1,afterBlock:102,status:'queued'});rpc.setHead(103);await market.updateHead();await paper.tick();assert.equal(store.get('paper-orders','old-queued-mature').status,'failed');assert.match(store.get('paper-orders','old-queued-mature').error,/仅允许.*Meme/);assert.equal(paper.fills().length,2);assert.equal(paper.account(agent.id).realizedUsd,loss);
});
