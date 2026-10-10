import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseAbi,encodeAbiParameters,getEventSelector } from 'viem';
import { LiveGateway,verifiedProtocolFlow } from '../src/server/gateway.js';
import { quotePons,v2Quote,ceilDiv,flapSpent,flapVirtualSell,WAD,feeExcludedImpact } from '../src/server/adapters/math.js';
import { assertReadOnly,ReadRpc } from '../src/server/adapters/rpc.js';
import { GmgnReadQueue,normalizeCandles,validateCliArgs } from '../src/server/adapters/gmgn.js';
import { CliScheduler,CliWait } from '../src/server/adapters/cli-scheduler.js';
import { Venues,poolId } from '../src/server/adapters/venues.js';
import { ReceiptGas } from '../src/server/adapters/fees.js';
import { RpcScheduler } from '../src/server/adapters/scheduler.js';
import { address,raw,ORDINARY_RECIPIENT,ZERO,CHAIN_CONFIG,type Route } from '../src/server/adapters/types.js';
import { normalizedTime } from '../src/server/adapters/time.js';
import { scannerBucketStage,scannerSeed,scannerFields,mergeScannerEvidence,invalidateScannerEvidence,SCANNER_SEED_TTL } from '../src/server/adapters/scanner.js';
import { scannerStage as frontendScannerStage } from '../src/client/Scanner.js';
const token=address('0x1000000000000000000000000000000000000000');
const base={quoteReserve:100n*WAD,tokenReserve:1000000n*WAD,sellable:700000n*WAD,feeBps:100n,creatorTaxBps:300n,snipeBps:0n,ready:false,graduated:false};
test('Robinhood scan cursor advances without waiting for slow live receipt verification',async()=>{
 const g=new LiveGateway({proxy:''}) as any;let release!:()=>void;const held=new Promise<void>(r=>release=r);let verified=false;
 g.running=true;g.persist=async()=>{};g.scanHead.robinhood=100;g.rawHeads.robinhood={number:101,hash:'hash',time:Date.now()};g.rpc.robinhood.withPriority=async(fn:()=>Promise<void>)=>fn();
 g.scanLogs=async()=>g.queueLiveLog({blockHash:'hash',transactionHash:'tx',logIndex:'0x1'},false,async()=>{await held;verified=true;});
 try{await g.poll('robinhood');assert.equal(g.scanHead.robinhood,101);assert.equal(verified,false);assert.equal(g.liveWork.busy,true);assert.equal(g.status.robinhood.gaps,0);release();await held;}finally{release();await g.stop();}
});
test('Robinhood log batches begin concurrently without sequentially waiting for wallet or pool reads',async()=>{
 const g=new LiveGateway({proxy:''}) as any;let release!:()=>void;const gate=new Promise<void>(r=>release=r),requests:any[]=[];
 g.walletLists.robinhood=[{address:token,name:'watched'}];g.routes.set('robinhood:'+token,{block:1,route:{kind:'pons-v2',token,quote:ZERO,curve:token}});
 g.rpc.robinhood.logs=async(filter:any)=>{requests.push(filter);await gate;return [];};
 const scanning=g.scanRobinhoodLogs(100,101,false);
 try{assert.equal(requests.length,4);assert.ok(requests.every(r=>r.fromBlock==='0x64'&&r.toBlock==='0x65'));release();await scanning;}finally{release();await g.stop();}
});
test('BSC scan cursor and Robinhood proofs are independent of a slow BSC receipt',async()=>{
 const g=new LiveGateway({proxy:''}) as any;let release!:()=>void;const gate=new Promise<void>(r=>release=r);let bscVerified=false,rhVerified=false;
 g.running=true;g.persist=async()=>{};g.scanHead.bsc=100;g.rawHeads.bsc={number:101,hash:'hash',time:Date.now()};g.needsRecovery.bsc=false;
 g.rpc.bsc.withPriority=async(fn:()=>Promise<void>)=>fn();g.rpc.robinhood.withPriority=async(fn:()=>Promise<void>)=>fn();
 g.rpc.bsc.logs=async()=>[{blockHash:'hash',transactionHash:'tx',logIndex:'0x1',topics:[getEventSelector('TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)')]}];
 g.tradeLog=async()=>{await gate;bscVerified=true;};
 try{await g.poll('bsc');assert.equal(g.scanHead.bsc,101);assert.equal(bscVerified,false);assert.equal(g.bscWork.busy,true);
  g.queueLiveLog({blockHash:'hash',transactionHash:'rh',logIndex:'0x1'},false,async()=>{rhVerified=true;});await Promise.resolve();assert.equal(rhVerified,true);assert.equal(g.status.bsc.gaps,0);
  release();await gate;
 }finally{release();await g.stop();}
});
test('BSC log batches start together and historical proofs keep their replay marker',async()=>{
 const g=new LiveGateway({proxy:''}) as any;let release!:()=>void;const gate=new Promise<void>(r=>release=r),requests:any[]=[],queued:any[]=[];
 g.routes.set('bsc:'+token,{block:1,route:{kind:'v2',token,quote:ZERO,pool:token}});
 g.rpc.bsc.logs=async(filter:any)=>{requests.push(filter);await gate;return [{blockHash:'hash',transactionHash:'tx',logIndex:'0x1',topics:[getEventSelector('TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)')]}];};
 g.queueLiveLog=(_log:any,replayed:boolean,_work:any,chain:string)=>queued.push({replayed,chain});
 const scanning=g.scanLogs('bsc',100,101,true);
 try{assert.equal(requests.length,2);assert.ok(requests.every(r=>r.fromBlock==='0x64'&&r.toBlock==='0x65'));release();await scanning;assert.equal(queued.length,2);assert.ok(queued.every(v=>v.replayed&&v.chain==='bsc'));}finally{release();await g.stop();}
});
test('bounded background receipt work expires before it can stall live processing',async()=>{
 const rpc=new ReadRpc('bsc','');
 try{await assert.rejects(rpc.withBackground(()=>new Promise(()=>{}),10),/background.*预算/);}finally{await rpc.close();}
});

test('whole-chain untracked trade floods cannot evict catalog or watched-wallet proofs',async()=>{
 const g=new LiveGateway({proxy:''}) as any;let release!:()=>void;const gate=new Promise<void>(r=>release=r),ran:string[]=[],unknown=address('0x2000000000000000000000000000000000000000');
 const log=(t:string,tx:string)=>({address:token,blockHash:'hash',blockNumber:'0x64',transactionHash:tx,logIndex:'0x1',topics:[getEventSelector('TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)')],data:encodeAbiParameters([{type:'address'},{type:'address'},...Array.from({length:6},()=>({type:'uint256'}))] as any,[t,token,1n,2n,3n,4n,5n,6n] as any)});
 g.running=true;g.persist=async()=>{};g.discovered('bsc',token,100,0);g.rpc.bsc.withPriority=async(fn:()=>Promise<void>)=>fn();
 try{
  g.queueLiveLog(log(token,'held'),false,async()=>{await gate;ran.push('catalog');},'bsc');
  for(let i=0;i<500;i++)g.queueLiveLog(log(unknown,'unknown-'+i),false,async()=>{ran.push('untracked');},'bsc');
  assert.equal(g.bscWork.pending,0);assert.equal(g.status.bsc.gaps,0);
  g.watchedTransactions.set('wallet',true);g.queueLiveLog(log(unknown,'wallet'),false,async()=>{ran.push('wallet');},'bsc');
  const done=log(token,'already-published');g.seen.set('bsc:hash:already-published:0x1',{});g.queueLiveLog(done,false,async()=>{ran.push('duplicate');},'bsc');assert.equal(g.bscWork.pending,1);
  release();await gate;for(let i=0;i<8&&g.bscWork.busy;i++)await new Promise(r=>setImmediate(r));assert.deepEqual(ran,['catalog','wallet']);assert.equal(g.status.bsc.gaps,0);
 }finally{release();await g.stop();}
});

test('a removed previously published trade still invalidates its block instead of disappearing as a duplicate',async()=>{
 const g=new LiveGateway({proxy:''}) as any;let invalidated=0;g.seen.set('bsc:hash:tx:0x1',{});g.reorg=async(chain:string,block:number)=>{assert.equal(chain,'bsc');assert.equal(block,100);invalidated++;};
 try{await g.tradeLog('bsc',{blockHash:'hash',transactionHash:'tx',logIndex:'0x1',blockNumber:'0x64',removed:true},false);assert.equal(invalidated,1);}finally{await g.stop();}
});
test('verified reference update time belongs to completion of actual price reads',async t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);
 const g=new LiveGateway({proxy:''}) as any,market={id:'robinhood:'+token,chain:'robinhood',address:token,decimals:18,createdAt:0,metadata:{},priceUsd:null};
 g.route=async()=>({kind:'pons-v2',token,quote:ZERO,state:{platform:'pons-v2'}});
 g.nativeFx.set('robinhood',{usd:2000,at:1000,mono:performance.now()});
 g.venues.robinhood.spot=async()=>{now=4000;return 1;};g.venues.robinhood.decimals=async()=>{now=6000;return 18;};g.venues.robinhood.conversion=async()=>null;
 try{await g.refreshMarket(market,10);assert.equal(market.quality,'verified');assert.equal(market.priceUsd,2000);assert.equal(market.updatedAt,6000);}finally{await g.stop();t.mock.restoreAll();}
});

test('scanner preserves actual GMGN category keys; unknown arrays are not new launches',()=>{
 assert.equal(scannerBucketStage('new_creation'),'new');assert.equal(scannerBucketStage('near_completion'),'near');assert.equal(scannerBucketStage('completed'),'graduated');
 for(const bucket of ['unknown','data','constructor','__proto__'])assert.equal(scannerBucketStage(bucket),undefined);
 assert.equal(scannerSeed('data',{progress:1},1000),undefined);
});
test('scanner uses documented fractional progress and never fills absent/unknown scales',()=>{
 assert.equal(scannerSeed('near_completion',{progress:0.933289486731419},1000)!.progressPct,93.3289486731419);
 assert.equal(scannerSeed('new_creation',{progress:0},1000)!.progressPct,0);
 assert.equal(scannerSeed('completed',{progress:'1'},1000)!.progressPct,100);
 for(const progress of [undefined,null,'',false,90,10n**18n,NaN,-1,Infinity])assert.equal(scannerSeed('new_creation',{progress},1000)!.progressPct,null);
 const fields=scannerFields({proof:{stage:'dex',block:4,source:'v3'}},1000,0,n=>n);assert.equal(fields.scannerStage,'graduated');assert.equal(fields.progressPct,null);assert.equal(fields.scannerAt,undefined);
});
test('scanner sorts by real creation/completion times and retains raw clock domains',()=>{
 const rawHead=1791276000000,localHead=1791275300000,normalize=(raw:number)=>normalizedTime(raw,rawHead,localHead,localHead);
 const seed=scannerSeed('new_creation',{created_timestamp:1791275900,progress:0},localHead)!;
 assert.equal(seed.rawCreatedAt,1791275900000);assert.equal(scannerFields({seed},localHead,0,normalize).scannerAt,localHead-100000);
 const graduated=scannerSeed('completed',{created_timestamp:1791270000,complete_timestamp:1791275950000,progress:1},localHead)!;
 assert.equal(scannerFields({seed:graduated},localHead,localHead-6000000,normalize).scannerAt,localHead-50000);
 assert.equal(scannerFields({seed},localHead,localHead-110000,normalize).scannerAt,localHead-110000);
});
test('market snapshots keep immutable creation/graduation mappings stable across jittering heads and getters',async()=>{
 const g=new LiveGateway({proxy:''}) as any;try{
  const rawHead=1791276000000;g.head('bsc',100,rawHead);const near=g.discovered('bsc',token,90,rawHead-120000),other=address('0x2000000000000000000000000000000000000000'),graduated=g.discovered('bsc',other,90,rawHead-180000);
  g.scanner(near,{proof:{stage:'curve',block:90,source:'flap'}});g.scanner(graduated,{proof:{stage:'dex',block:90,source:'v2'},seed:scannerSeed('completed',{complete_timestamp:(rawHead-60000)/1000,progress:1},Date.now())});
  near.priceUsd=2;near.updatedAt=1234;graduated.priceUsd=3;graduated.updatedAt=5678;const before=JSON.stringify(g.markets());
  for(let i=1;i<=8;i++){g.head('bsc',100+i,rawHead+i*815);g.getMarket('bsc',token);g.getMarket('bsc',other);assert.equal(JSON.stringify(g.markets()),before);}
  assert.equal(near.metadata.rawCreatedAt,rawHead-120000);assert.equal(graduated.metadata.scanner.seed.rawCompletedAt,rawHead-60000);
  g.scanner(graduated,{seed:scannerSeed('completed',{complete_timestamp:(rawHead-60000)/1000,progress:1},Date.now()+1)});assert.equal(graduated.scannerAt,JSON.parse(before)[1].scannerAt);
 }finally{await g.stop();}
});
test('unknown chain clock leaves creation age unknown then maps once when an actual head arrives',async()=>{
 const g=new LiveGateway({proxy:''}) as any;try{
  const rawHead=1791276000000,m=g.discovered('robinhood',token,90,rawHead-5000);g.scanner(m,{event:{stage:'new',block:90,rawAt:rawHead-5000,source:'protocol-creation-log'}});
  assert.equal(m.createdAt,0);assert.equal(m.scannerAt,undefined);assert.equal(m.metadata.rawCreatedAt,rawHead-5000);assert.equal(m.metadata.marketClock,undefined);
  g.head('robinhood',100,rawHead);const at=g.status.robinhood.headAt;assert.equal(m.createdAt,at-5000);assert.equal(m.scannerAt,m.createdAt);const frozen=JSON.stringify(g.markets());
  g.head('robinhood',101,rawHead+100);assert.equal(JSON.stringify(g.markets()),frozen);assert.equal(m.updatedAt,JSON.parse(frozen)[0].updatedAt);
 }finally{await g.stop();}
});
test('corrected raw times remap while actual price, update time and current FX changes remain visible',async()=>{
 const g=new LiveGateway({proxy:''}) as any;try{
  const rawHead=1791276000000;g.head('bsc',100,rawHead);const m=g.discovered('bsc',token,90,rawHead-60000);g.scanner(m,{proof:{stage:'dex',block:90,source:'v2'},event:{stage:'graduated',block:95,rawAt:rawHead-30000,source:'protocol-graduation-log'}});m.updatedAt=1234;g.nativeFx.set('bsc',{usd:700,at:Date.now(),mono:performance.now()});const before=JSON.parse(JSON.stringify(g.getMarket('bsc',token)));
  g.head('bsc',101,rawHead+815);g.createdTime(m,rawHead-55000);assert.equal(m.createdAt,g.localTime('bsc',rawHead-55000));assert.notEqual(m.createdAt,before.createdAt);
  g.scanner(m,{event:{stage:'graduated',block:96,rawAt:rawHead-25000,source:'protocol-graduation-log'}});assert.equal(m.scannerAt,g.localTime('bsc',rawHead-25000));assert.notEqual(m.scannerAt,before.scannerAt);const frozenCreated=m.createdAt,frozenScanner=m.scannerAt;
  g.tick('bsc',token,Date.now(),8,3);g.nativeFx.set('bsc',{usd:701,at:Date.now(),mono:performance.now()});const changed=g.getMarket('bsc',token);assert.equal(changed.priceUsd,8);assert.notEqual(changed.updatedAt,1234);assert.equal(changed.nativeUsd,701);assert.equal(changed.createdAt,frozenCreated);assert.equal(changed.scannerAt,frozenScanner);
  g.nativeFx.get('bsc').mono=performance.now()-90001;assert.equal(g.getMarket('bsc',token).nativeUsd,null);assert.equal(m.updatedAt,changed.updatedAt);
 }finally{await g.stop();}
});
test('scanner near requires a current category or verified readiness, not a percent threshold',()=>{
 const seed=scannerSeed('near_completion',{progress:0.0004754761904762},1000)!;
 const proof={stage:'curve' as const,block:10,source:'pons-v2'};
 assert.equal(scannerFields({seed,proof},1001,500,n=>n).scannerStage,'near');
 const expired=scannerFields({seed,proof},1000+SCANNER_SEED_TTL,500,n=>n);assert.equal(expired.scannerStage,'new');assert.equal(expired.progressPct,null);
 assert.equal(scannerFields({seed},1000+SCANNER_SEED_TTL,500,n=>n).scannerStage,undefined);
 assert.equal(scannerFields({proof:{...proof,ready:true}},1000,500,n=>n).scannerStage,'near');
 assert.equal(scannerFields({seed:scannerSeed('new_creation',{progress:.99},1000),proof},1001,500,n=>n).scannerStage,'new');
});
test('verified graduation overrides stale near/completed disagreement and lagging curve reads',()=>{
 const near=scannerSeed('near_completion',{progress:.9},1000)!;
 const graduated={proof:{stage:'dex' as const,block:20,source:'v2'},seed:near};
 let fields=scannerFields(graduated,1001,500,n=>n);assert.equal(fields.scannerStage,'graduated');assert.equal(fields.progressPct,null);
 const merged=mergeScannerEvidence(graduated,{seed:scannerSeed('near_completion',{progress:.95},1100),proof:{stage:'curve',block:21,source:'stale-curve'}});
 assert.equal(scannerFields(merged,1101,500,n=>n).scannerStage,'graduated');
 assert.equal(scannerFields({event:{stage:'graduated',block:20,source:'log',rawAt:800},proof:{stage:'curve',block:21,source:'curve'},seed:near},1001,500,n=>n).scannerAt,800);
 fields=scannerFields({proof:{stage:'curve',block:20,source:'flap'},seed:scannerSeed('completed',{progress:1},1000)},1001,500,n=>n);assert.equal(fields.scannerStage,'new');assert.equal(fields.progressPct,null);
 assert.equal(mergeScannerEvidence({proof:{stage:'curve',block:20,source:'flap'}},{proof:{stage:'curve',block:19,source:'lagging'}}).proof!.block,20);
});
test('reorg invalidates scanner proof and provider category without inventing an external stage',()=>{
 const old={proof:{stage:'dex' as const,block:20,source:'v4'},event:{stage:'new' as const,block:5,source:'log',rawAt:500},seed:scannerSeed('near_completion',{progress:.9},1000)};
 const evidence=invalidateScannerEvidence(old,20);assert.equal(evidence.proof,undefined);assert.equal(evidence.seed,undefined);assert.equal(scannerFields(evidence,1001,500,n=>n).scannerStage,'new');
 assert.equal(scannerFields(invalidateScannerEvidence(old,5),1001,500,n=>n).scannerStage,undefined);
});
test('gateway reorg JSON cannot become graduated through the frontend legacy stage fallback',async()=>{
 const g=new LiveGateway({proxy:''}) as any;try{
  const m=g.discovered('bsc',token,100,0);g.route=async()=>({kind:'v2',token,quote:ZERO});
  await g.refreshMarket(m,100);g.scanner(m,{seed:scannerSeed('completed',{progress:1,created_timestamp:1791270000,complete_timestamp:1791275900},Date.now())});
  let wire=JSON.parse(JSON.stringify(g.markets()[0]));assert.equal(wire.stage,'dex');assert.equal(frontendScannerStage(wire),'graduated');
  const legacy=g.discovered('bsc',address('0x4000000000000000000000000000000000000000'),100,0);legacy.stage='dex';
  await g.reorg('bsc',100);
  for(const row of JSON.parse(JSON.stringify(g.markets()))){assert.equal(row.stage,'unknown');assert.equal(row.scannerStage,undefined);assert.equal(row.scannerAt,undefined);assert.equal(row.progressPct,null);assert.equal(row.quality,'unavailable');assert.equal(frontendScannerStage(row),'unknown');}
  await g.refreshMarket(m,101);wire=JSON.parse(JSON.stringify(g.getMarket('bsc',token)));assert.equal(wire.stage,'dex');assert.equal(frontendScannerStage(wire),'graduated');
 }finally{await g.stop();}
});
test('gateway reorg preserves an older valid DEX proof despite clearing live route caches',async()=>{
 const g=new LiveGateway({proxy:''}) as any;try{
  const m=g.discovered('robinhood',token,90,0);g.route=async()=>({kind:'v3',token,quote:ZERO});await g.refreshMarket(m,90);
  await g.reorg('robinhood',100);const wire=JSON.parse(JSON.stringify(g.getMarket('robinhood',token)));assert.equal(wire.stage,'dex');assert.equal(wire.scannerStage,'graduated');assert.equal(frontendScannerStage(wire),'graduated');assert.equal(wire.quality,'unavailable');assert.equal(g.routes.size,0);
 }finally{await g.stop();}
});
test('actual gateway graduation overrides a pending curve view and reorg restores its older curve proof',async()=>{
 const g=new LiveGateway({proxy:''}) as any;try{
  const m=g.discovered('bsc',token,90,0);g.route=async()=>({kind:'flap',token,quote:ZERO});await g.refreshMarket(m,90);
  const rawHead=1791276000000,localHead=Date.now();g.status.bsc.chainTime=rawHead;g.status.bsc.headAt=localHead;g.scanner(m,{seed:scannerSeed('near_completion',{progress:.9},localHead)});
  assert.equal(frontendScannerStage(JSON.parse(JSON.stringify(g.getMarket('bsc',token)))),'near');
  // The protocol event arrives before its background route refresh completes.
  g.running=true;g.refreshToken=async()=>{};await g.bscEvent({kind:'graduated',token,block:100,chainTimestamp:1791275990,key:'protocol-graduation'});g.running=false;
  let wire=JSON.parse(JSON.stringify(g.getMarket('bsc',token)));assert.equal(wire.stage,'curve');assert.equal(wire.scannerStage,'graduated');assert.equal(wire.scannerAt,localHead-10000);assert.equal(wire.progressPct,null);assert.equal(frontendScannerStage(wire),'graduated');
  await g.reorg('bsc',100);wire=JSON.parse(JSON.stringify(g.getMarket('bsc',token)));assert.equal(wire.stage,'curve');assert.equal(wire.scannerStage,'new');assert.equal(wire.progressPct,null);assert.equal(frontendScannerStage(wire),'new');assert.equal(wire.quality,'unavailable');
 }finally{g.running=false;await g.stop();}
});
test('gateway seed ingestion retains three buckets, actual names/times, chain scope and quote gate',async()=>{
 const g=new LiveGateway({proxy:''}) as any;const rawHead=1791276000000,localHead=Date.now();g.status.bsc.chainTime=rawHead;g.status.bsc.headAt=localHead;g.queueResolve=()=>{};
 const near=address('0x2000000000000000000000000000000000000000'),complete=address('0x3000000000000000000000000000000000000000');
 const row=(address:string)=>({address,chain:'bsc',launchpad_platform:'flap',created_timestamp:1791275900,name:'Actual name',symbol:'REAL'});
 g.seedMarkets('bsc',{new_creation:[{...row(token),progress:0}],near_completion:[{...row(near),progress:.9}],completed:[{...row(complete),progress:1,complete_timestamp:1791275950}],other:[row(address('0x4000000000000000000000000000000000000000'))]});
 assert.equal(g.markets().length,3);assert.deepEqual(g.markets().map((m:any)=>m.scannerStage),['new','near','graduated']);
 assert.equal(g.getMarket('bsc',token).name,'Actual name');assert.equal(g.getMarket('bsc',token).scannerAt,localHead-100000);assert.equal(g.getMarket('bsc',complete).scannerAt,localHead-50000);
 assert(g.markets().every((m:any)=>m.quality==='unavailable'&&m.priceUsd===null));
 g.scanner(g.getMarket('bsc',near),{proof:{stage:'dex',block:20,source:'v3'}});g.seedMarkets('bsc',{near_completion:[{...row(near),progress:.95}]});assert.equal(g.getMarket('bsc',near).scannerStage,'graduated');assert.equal(g.getMarket('bsc',near).progressPct,null);
 g.seedMarkets('robinhood',{new_creation:[row(token)]});assert.equal(g.markets().filter((m:any)=>m.chain==='robinhood').length,0);
 await g.stop();
});
test('unresolved seed platform is displayed without upgrading price, route proof or quote quality',async()=>{
 const g=new LiveGateway({proxy:''}) as any;try{
  g.queueResolve=()=>{};const four=address('0x2000000000000000000000000000000000000000');
  g.seedMarkets('bsc',{new_creation:[{address:token,chain:'bsc',launchpad_platform:'flap'}],near_completion:[{address:four,chain:'bsc',launchpad_platform:'fourmeme'}]});
  g.seedMarkets('robinhood',{new_creation:[{address:token,chain:'robinhood',launchpad_platform:'pons'}]});
  assert.equal(g.getMarket('bsc',token).platform,'flap');assert.equal(g.getMarket('bsc',four).platform,'fourmeme');assert.equal(g.getMarket('robinhood',token).platform,'pons');
  for(const m of g.markets()){assert.equal(m.stage,'unknown');assert.equal(m.quality,'unavailable');assert.equal(m.priceUsd,null);assert.equal(m.decimals,null);assert.equal(m.metadata.scanner.proof,undefined);assert.equal(m.metadata.route,undefined);}assert.equal(g.routes.size,0);
  const m=g.getMarket('bsc',token);g.route=async()=>({kind:'v3',token,quote:ZERO});await g.refreshMarket(m,100);
  assert.equal(m.platform,'pancake-v3');assert.equal(m.quality,'unavailable');
  g.seedMarkets('bsc',{near_completion:[{address:token,chain:'bsc',launchpad_platform:'flap',progress:.9}]});const wire=JSON.parse(JSON.stringify(g.getMarket('bsc',token)));
  assert.equal(wire.platform,'pancake-v3');assert.equal(wire.stage,'dex');assert.equal(wire.scannerStage,'graduated');assert.equal(wire.quality,'unavailable');assert.equal(wire.priceUsd,null);assert.equal(wire.metadata.route,'v3');
 }finally{await g.stop();}
});
test('verified swept Pons appears near while remaining quote-ineligible',async()=>{
 const g=new LiveGateway({proxy:''}) as any;const m=g.discovered('robinhood',token,10,0);g.route=async()=>{throw new (await import('../src/server/adapters/types.js')).RouteBlocked('PONS_SWEPT','Pons 已清空曲线，等待创建毕业池');};
 await g.refreshMarket(m,10);assert.equal(g.getMarket('robinhood',token).scannerStage,'near');assert.equal(m.quality,'unavailable');assert.match(m.reason,/等待创建毕业池/);assert.equal(m.progressPct,null);await g.stop();
});
test('recorded real trenches preserve supported BSC/RH buckets and actual timestamp/progress fields',()=>{
 const proof=JSON.parse(readFileSync(new URL('../src/server/adapters/fixtures/live-verification.json',import.meta.url),'utf8'));let samples=0;
 for(const chain of ['bsc','robinhood']){const response=proof.chains[chain].seeds,data=response.data??response;
  for(const bucket of ['new_creation','near_completion','completed']){const item=data[bucket].find((x:any)=>x.chain===chain&&(chain==='bsc'?/flap|fourmeme|pool_pancake/:/pons|pool_uniswap/).test(x.launchpad_platform));if(!item)continue;
   const seed=scannerSeed(bucket,item,1000)!;assert.equal(seed.stage,scannerBucketStage(bucket));assert.equal(seed.rawCreatedAt,item.created_timestamp*1000);assert.equal(seed.progressPct,item.progress*100);
   if(bucket==='completed')assert.equal(seed.rawCompletedAt,item.complete_timestamp>0?item.complete_timestamp*1000:undefined);
   assert.equal(scannerFields({seed},1001,0,n=>n).scannerAt,seed.rawCompletedAt||seed.rawCreatedAt);samples++;
  }
 }
 // The preserved sample has BSC all three, RH near/completed; do not invent a
 // supported RH new creation when that observed category contains none.
 assert.equal(samples,5);
});
test('transport denies signing, broadcasts and wallet-management methods',()=>{for(const method of ['eth_sendRawTransaction','eth_sendTransaction','eth_sign','personal_sign','wallet_switchEthereumChain','eth_estimateGas'])assert.throws(()=>assertReadOnly(method),/只读/);assert.doesNotThrow(()=>assertReadOnly('eth_call'));});
test('ABI wrapper refuses state mutations before issuing any RPC',async()=>{const rpc=new ReadRpc('bsc','');await assert.rejects(rpc.read(token,parseAbi(['function approve(address,uint256) returns (bool)']),'approve',[token,1n]),/交易/);await rpc.close();});
test('CLI allowlist excludes all trade/config paths and malformed addresses',()=>{assert.throws(()=>validateCliArgs(['swap','quote','--chain','bsc']),/公开/);assert.throws(()=>validateCliArgs(['token','info','--chain','bsc','--address','oops']),/地址/);assert.doesNotThrow(()=>validateCliArgs(['token','security','--chain','robinhood','--address',token]));assert.doesNotThrow(()=>validateCliArgs(['token','holders','--chain','bsc','--address',token,'--limit','100']));assert.throws(()=>validateCliArgs(['token','holders','--chain','bsc','--address',token,'--private-key','secret']),/禁止/);});
test('Pons fee order floors each input fee separately; sell has no snipe tax',()=>{const q=quotePons({...base,snipeBps:9000n},'buy',10001n);const net=10001n-10001n*100n/10000n-10001n*300n/10000n-10001n*9000n/10000n;assert.equal(q.out,net*base.tokenReserve/(base.quoteReserve+net));const sell=quotePons({...base,snipeBps:9000n},'sell',1000n*WAD);const plain=quotePons(base,'sell',1000n*WAD);assert.deepEqual(sell,plain);});
test('Pons anti-snipe cap preserves at least 1% net input',()=>{const q=quotePons({...base,snipeBps:10000n},'buy',WAD);assert.equal(q.tax,WAD*300n/10000n+WAD*9500n/10000n);assert(q.out>0n);});
test('Pons graduation clamp uses exact-input inverse and refunds unused input',()=>{const s={...base,sellable:1n*WAD};const q=quotePons(s,'buy',WAD);assert.equal(q.out,s.sellable);assert(q.refund>0n);assert.equal(q.spent+q.refund,WAD);const net=s.sellable*s.quoteReserve/(s.tokenReserve-s.sellable)+1n;assert.equal(q.spent,ceilDiv(net*10000n,9600n));assert.equal(q.protocol,q.spent/100n);});
test('Pons sells stop at readyToGraduate even when graduated remains false',()=>{assert.throws(()=>quotePons({...base,ready:true},'sell',WAD),/等待毕业/);assert.throws(()=>quotePons({...base,sellable:0n},'buy',WAD),/关闭/);});
test('V2 exact-size prices reflect nonlinear price impact beyond safe integer range',()=>{const rin=10n**28n,rout=10n**32n,a=10n**27n;assert(v2Quote(a*2n,rin,rout)<v2Quote(a,rin,rout)*2n);assert.equal(v2Quote(a,rin,rout),a*9975n*rout/(rin*10000n+a*9975n));});
test('actual GMGN milliseconds and dollar-volume normalization keeps gaps',()=>{const c=normalizeCandles([{time:1791231400000,open:'2',close:'3',high:'3',low:'2',volume:'70',amount:'28'},{time:1791231460000,open:'3',close:'3',high:'3',low:'3',volume:'9'}]);assert.equal(c[0].time,1791231400);assert.equal(c[0].volume,70);assert.equal(c.length,2);assert.equal(c[1].time-c[0].time,60);});
test('raw integer and address validation rejects unsafe or negative input',()=>{assert.throws(()=>raw('0'));assert.throws(()=>raw('-1'));assert.throws(()=>raw('1.2'));assert.throws(()=>raw((1n<<256n).toString()));assert.equal(raw('900719925474099312345'),900719925474099312345n);});
test('V4 hook-adjusted output is not taxed twice by local math',async()=>{const rpc={chain:'robinhood',read:async(_address:any,_abi:any,name:string)=>name==='getSlot0'?[2n**96n,0,0,10000]:[9500n,100000n]} as unknown as ReadRpc;const v=new Venues(rpc);const route:Route={kind:'v4',token,quote:ZERO,key:{currency0:ZERO,currency1:token,fee:10000,tickSpacing:200,hooks:address('0x2000000000000000000000000000000000000044')},state:{hookFeeBps:100n,creatorTaxBps:400n}};const q=await v.quote(route,'buy',10000n,10);assert.equal(q.out,9500n);assert(q.protocol>0n&&q.tax>0n);assert.equal(poolId(route.key!).length,66);});
test('broker random synthetic recipient reaches recipient-specific snipe tax',async()=>{let observed='';const recipient=address('0x734521abcdef0000000000000000000000001234');const rpc={chain:'robinhood',read:async(_c:any,_a:any,name:string,args:any[])=>{if(name==='currentSnipeTaxBps'){observed=args[0];return 9000n;}return ({getReserves:[base.quoteReserve,base.tokenReserve],sellableTokens:base.sellable,feeBps:100n,creatorTaxBps:300n,readyToGraduate:false,graduated:false} as any)[name];}} as unknown as ReadRpc;const q=await new Venues(rpc).quote({kind:'pons-v2',token,quote:ZERO,curve:token},'buy',WAD,10,recipient);assert.equal(observed,recipient);assert.notEqual(observed,ORDINARY_RECIPIENT);assert(q.tax>WAD/2n);});
test('gateway native raw units, partial spend and gas outside quote amounts',async()=>{const g=new LiveGateway({proxy:''}) as any;const route:Route={kind:'pons-v2',token,quote:ZERO,curve:token};g.rpc.bsc.block=async()=>({number:100});g.fx=async()=>({usd:700,at:Date.now(),mono:performance.now()});g.route=async()=>route;g.gas.bsc.estimate=async()=>({gasUsd:.02,approvalUsd:.01,notes:[]});g.venues.bsc.decimals=async(a:string)=>a===ZERO?18:6;g.venues.bsc.conversion=async()=>null;g.venues.bsc.quote=async(_r:any,side:string,input:bigint)=>side==='buy'?{out:2000000n,spent:input/2n,refund:input/2n,protocol:input/100n,tax:input/50n,spot:1e9,notes:[]}:{out:1000000000000000n,spent:input,refund:0n,protocol:10000000000000n,tax:0n,spot:1e9,notes:[]};
 const buy=await g.quote({chain:'bsc',token,side:'buy',nativeAmountRaw:'2000000000000000',recipient:token});assert.equal(buy.spentInputRaw,'1000000000000000');assert.equal(buy.refundRaw,'1000000000000000');assert.equal(buy.outputRaw,'2000000');assert(Math.abs(buy.priceUsd-.35)<1e-12);assert.equal(buy.fees.includedInOutput,true);assert.equal(buy.fees.gasUsd,.02);
 const sell=await g.quote({chain:'bsc',token,side:'sell',tokenAmountRaw:buy.outputRaw,recipient:token});assert.equal(sell.outputRaw,'1000000000000000');assert.equal(sell.spentInputRaw,'2000000');await g.stop();
});
test('blocked routes produce errors rather than zero-price fake fills',async()=>{const rpc={chain:'bsc',read:async()=>ZERO} as unknown as ReadRpc;await assert.rejects(new Venues(rpc).dex(token,ZERO,1),/路线/);});
test('reorg removal invalidates state and duplicate events remain bounded',async()=>{const g=new LiveGateway({proxy:''}) as any;const events:any[]=[];g.emit=(e:any)=>events.push(e);const event={id:'x',chain:'bsc',kind:'trade',block:10,at:0,receivedAt:0,payload:{}};g.publish(event);g.publish(event);assert.equal(events.length,1);await g.reorg('bsc',9);assert.equal(events[1].kind,'removed');assert.equal(g.seen.has('x'),false);await g.stop();});
test('ahead-of-local chain timestamps preserve actual signal age',()=>{const local=1791274741396,chain=1791275433000;assert.equal(normalizedTime(chain,chain,local,local),local);assert.equal(normalizedTime(chain-5000,chain,local,local),local-5000);assert.equal(normalizedTime(chain+500,chain,local,local),local);});
test('gateway emits JSON-safe payloads and retains raw protocol time',async()=>{const g=new LiveGateway({proxy:''}) as any;g.status.bsc.chainTime=1000000;g.status.bsc.headAt=900000;let result:any;g.emit=(e:any)=>{result=e;assert.doesNotThrow(()=>JSON.stringify(e));};g.publish({id:'json',chain:'bsc',kind:'trade',block:10,at:999000,receivedAt:900000,payload:{value:10n}});assert.equal(result.at,899000);assert.equal(result.payload.rawChainAt,999000);assert.equal(result.payload.value,'10');await g.stop();});
test('observed source addresses cannot obtain simulated exemption',async()=>{const g=new LiveGateway({proxy:'',wallets:{bsc:[{address:token,name:'source'}]}});await assert.rejects(g.quote({chain:'bsc',token,side:'buy',nativeAmountRaw:'1',recipient:token}),/豁免/);await g.stop();});
test('head loop stays live while scan loop is occupied',async()=>{const g=new LiveGateway({proxy:''}) as any;g.running=true;g.busy.robinhood=true;g.rpc.robinhood.block=async()=>({number:999,time:Date.now()+691000,hash:'h',parentHash:'p'});await g.readHead('robinhood');assert.equal(g.statuses().find((s:any)=>s.chain==='robinhood').connected,true);assert.equal(g.status.robinhood.head,999);g.running=false;await g.stop();});
test('Four gross budget is re-quoted after taxes; no linear token scaling',async()=>{const calls:bigint[]=[];const rpc={chain:'bsc',read:async(_c:any,_a:any,_n:any,args:any[])=>{const f=BigInt(args[2]);calls.push(f);const cost=f*10000n/10100n,fee=cost/100n;return [token,ZERO,f*f,cost,fee,f,0n,f];}} as unknown as ReadRpc;const route:Route={kind:'four',token,quote:ZERO,state:{buyTaxRate:300n,sellTaxRate:300n,lastPrice:1n}};const q=await new Venues(rpc).quote(route,'buy',1000000n,1);assert(calls.length>1);assert(q.spent<=1000000n);assert.equal(q.out,calls.at(-1)!**2n);assert.equal(q.spent+q.refund,1000000n);});
test('Flap immediate virtual reverse uses a mathematically changed curve, never negative supply',()=>{const s={reserve:1n*WAD,supply:1000000n*WAD,r:6n*WAD,h:100000000n*WAD,k:6600000000n*WAD,threshold:800000000n*WAD,quoteDecimals:18,feeBps:100n,taxBps:300n};const q=flapVirtualSell(s,500000n*WAD);assert(q.out>0n);assert(q.protocol>0n);assert.throws(()=>flapVirtualSell(s,2000000n*WAD),/储备不足/);});
test('small 2% curve fees do not become liquidity impact; large sizes still do',()=>{const route:Route={kind:'pons-v2',token,quote:ZERO};const state={...base,feeBps:100n,creatorTaxBps:100n};const small=quotePons(state,'buy',100000000n),big=quotePons(state,'buy',20n*WAD);const smallImpact=feeExcludedImpact(route,'buy',{...small,spot:Number(state.quoteReserve)/Number(state.tokenReserve),notes:[]});const bigImpact=feeExcludedImpact(route,'buy',{...big,spot:Number(state.quoteReserve)/Number(state.tokenReserve),notes:[]});assert(smallImpact<.001);assert(bigImpact>10);assert(small.protocol+small.tax>0n);});
test('V3 fees alone produce zero impact in an unchanged marginal-price fixture',()=>{const route:Route={kind:'v3',token,quote:ZERO,fee:3000};const q={out:9970n,spent:10000n,refund:0n,protocol:30n,tax:0n,spot:1,notes:[]};assert.equal(feeExcludedImpact(route,'buy',q),0);assert(feeExcludedImpact(route,'buy',{...q,out:9000n})>9);});
test('protocol event verification requires exact aggregate token flow',()=>{const pool=address('0x2000000000000000000000000000000000000000'),owner=address('0x3000000000000000000000000000000000000000');const topic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';const logs=[{address:token,topics:[topic,'0x'+pool.slice(2).padStart(64,'0'),'0x'+owner.slice(2).padStart(64,'0')],data:'0x64'}];const route:Route={kind:'v2',token,quote:ZERO,pool};assert(verifiedProtocolFlow(route,logs,'buy',100n));assert(!verifiedProtocolFlow(route,logs,'sell',100n));assert(!verifiedProtocolFlow(route,logs,'buy',101n));});
test('removal has a distinct storage id and references original event',async()=>{const g=new LiveGateway({proxy:''}) as any;const out:any[]=[];g.emit=(e:any)=>out.push(e);g.rawHeads.bsc={hash:'new-canonical-hash'};g.publish({id:'old',chain:'bsc',kind:'trade',block:10,at:1,receivedAt:2,payload:{}});g.publish({id:'old',chain:'bsc',kind:'removed',block:10,at:2,receivedAt:3,payload:{removedEventId:'old'}});assert.notEqual(out[1].id,out[0].id);assert.equal(out[1].payload.removedEventId,'old');await g.stop();});
test('same-creation-block wallet entry has zero prior balance only when prior code is absent',async()=>{const g=new LiveGateway({proxy:''}) as any;g.rpc.bsc.read=async()=>{throw Error('empty eth_call result');};g.rpc.bsc.request=async()=> '0x';assert.equal(await g.previousTokenBalance('bsc',token,token,100),0n);g.rpc.bsc.request=async()=> '0x6080';assert.equal(await g.previousTokenBalance('bsc',token,token,100),null);await g.stop();});
test('gateway-produced verified first-buy event uses actual six decimals and passes JSON transport',async()=>{const owner=address('0x3000000000000000000000000000000000000000'),portal=address('0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0'),tx='0x'+'a'.repeat(64),hash='0x'+'b'.repeat(64);const g=new LiveGateway({proxy:'',wallets:{bsc:[{address:owner,name:'fixture'}]}}) as any;const events:any[]=[];g.emit=(e:any)=>events.push(e);g.discovered('bsc',token,100,0);g.routes.set('bsc:'+token,{block:100,route:{kind:'flap',token,quote:ZERO}});g.watchedTransactions.set(tx,true);g.fx=async()=>({usd:1000,at:Date.now(),mono:performance.now()});g.venues.bsc.decimals=async(a:string)=>a===token?6:18;g.venues.bsc.conversion=async()=>null;g.rpc.bsc.block=async()=>({number:100,time:Date.now()});g.rpc.bsc.read=async()=>0n;
 const log={address:portal,blockHash:hash,blockNumber:'0x64',transactionHash:tx,logIndex:'0x1',topics:[getEventSelector('TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)')],data:encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[1n,token,owner,2000000n,10000000000000000n,100000000000000n,1n])};
 const transfer={address:token,topics:[getEventSelector('Transfer(address,address,uint256)'),'0x'+ZERO.slice(2).padStart(64,'0'),'0x'+owner.slice(2).padStart(64,'0')],data:'0x'+(2000000n).toString(16)};g.rpc.bsc.receipt=async()=>({status:'0x1',from:owner,blockHash:hash,blockNumber:'0x64',transactionHash:tx,gasUsed:'0x5208',logs:[log,transfer]});await g.tradeLog('bsc',log,false);const wallet=events.find(e=>e.kind==='wallet');assert.equal(wallet.payload.verified,true);assert.equal(wallet.firstBuy,true);assert.equal(wallet.priceUsd,5);assert.equal(wallet.amountUsd,10);assert.doesNotThrow(()=>JSON.stringify(wallet));const market=g.getMarket('bsc',token);assert.equal(market.quality,'verified');assert.equal(market.platform,'flap');assert.equal(market.metadata.route,'flap');assert.equal(market.priceUsd,5);assert.match(market.reason,/具体数量与费用仍须/);await g.stop();});

test('14 sequential exact-size quotes freeze one gas price and same-venue receipt sample',async()=>{
 const g=new LiveGateway({proxy:''}) as any,at=Date.now(),route:Route={kind:'pons-v2',token,quote:ZERO,curve:token};let gasReads=0,blockReads=0;
 g.running=true;g.head('bsc',100,at);g.rpc.bsc.block=async()=>{blockReads++;throw Error('warm quote must not read latest or repeat the known block');};
 g.rpc.bsc.request=async(method:string)=>{assert.equal(method,'eth_gasPrice');gasReads++;return '0x3b9aca00';};
 g.gas.bsc.samples=[{block:99,gas:100000n,tx:'matching',venue:'pons-v2'},{block:99,gas:900000n,tx:'unrelated',venue:'market'}];
 g.fx=async()=>({usd:700,at,mono:performance.now()});g.route=async()=>route;g.venues.bsc.decimals=async()=>18;g.venues.bsc.conversion=async()=>null;
 g.venues.bsc.quote=async(_r:Route,side:'buy'|'sell',input:bigint)=>({...quotePons({...base,creatorTaxBps:100n},side,input),spot:Number(base.quoteReserve)/Number(base.tokenReserve),notes:[]});
 const results=[];for(let i=1;i<=7;i++){const buy=await g.quote({chain:'bsc',token,side:'buy',nativeAmountRaw:(BigInt(i)*10n**15n).toString(),recipient:token,block:100});results.push(buy,await g.quote({chain:'bsc',token,side:'sell',tokenAmountRaw:buy.outputRaw,recipient:token,block:100}));}
 assert.equal(gasReads,1);assert.equal(blockReads,0);assert.equal(new Set(results.map(q=>q.sourceFeeFrozenAt)).size,1);assert(results[0].sourceFeeFrozenAt>=at&&results[0].sourceFeeFrozenAt<=Date.now());assert.equal(results[0].fees.gasUsd,.07);assert.equal(new Set(results.filter(q=>q.side==='buy').map(q=>q.outputRaw)).size,7);
 g.gas.bsc.samples.push({block:100,gas:200000n,tx:'later-sample',venue:'pons-v2'});const frozen=await g.gas.bsc.context(route,100);assert.equal(frozen.gasUsedRaw,'100000');assert(Object.isFrozen(frozen));
 const other=await g.gas.bsc.context({...route,kind:'v2'},100);assert.equal(other.sourceFeeFrozenAt,frozen.sourceFeeFrozenAt);assert.equal(gasReads,1);
 await g.gas.bsc.context(route,101);assert.equal(gasReads,2);g.gas.bsc.invalidate(100);await g.gas.bsc.context(route,100);assert.equal(gasReads,3);g.running=false;await g.stop();
});

test('gas reorg rejects an inflight context and does not reuse an orphaned frozen price',async()=>{
 let reads=0,release!:(value:string)=>void;const rpc={chain:'bsc',promote:()=>{},linkPending:(p:any)=>p,request:async()=>{reads++;return reads===1?new Promise<string>(r=>{release=r;}):'0x2';}} as unknown as ReadRpc;
 const gas=new ReceiptGas(rpc) as any,route:Route={kind:'v2',token,quote:ZERO};gas.samples=[{block:99,gas:100000n,tx:'old',venue:'v2'}];
 const pending=gas.context(route,100),rejected=assert.rejects(pending,/重组/);gas.invalidate(100);release('0x1');await rejected;
 const fresh=await gas.context(route,100);assert.equal(fresh.gasPriceRaw,'2');assert.equal(reads,2);
});
test('Cloud fee warming consumes validated receipt batches without re-reading individual transactions',async()=>{
 const tx='0x'+'77'.repeat(32),pool='0x'+'88'.repeat(20);let batches=0;
 const rpc={chain:'bsc',block:async()=>({number:100,transactions:[tx]}),receipts:async()=>{batches++;return [{status:'0x1',blockNumber:'0x64',gasUsed:'0x186a0',transactionHash:tx,logs:[{address:pool,topics:[getEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')]}]}];},receipt:async()=>{throw Error('No duplicate receipt reads');},request:async()=> '0x3b9aca00',promote:()=>{},linkPending:(p:any)=>p} as unknown as ReadRpc;
 const gas=new ReceiptGas(rpc),result=await gas.context({kind:'v2',token,quote:ZERO,pool:pool as any},100);
 assert.equal(result.gasUsedRaw,'100000');assert.equal(result.sampleTransaction,tx);assert.equal(batches,1);
});

test('known WS head ahead of HTTP and previously observed block ages need no latest RPC',async()=>{
 const g=new LiveGateway({proxy:''}) as any,at=Date.now();g.running=true;g.head('bsc',100,at-2000);g.head('bsc',101,at);g.rawHeads.bsc={number:100,time:at-2000};
 g.rpc.bsc.block=async()=>{throw Error('unexpected latest/header read');};g.route=async()=>({kind:'pons-v2',token,quote:ZERO});g.venues.bsc.conversion=async()=>null;g.fx=async()=>({usd:700,at,mono:performance.now()});g.quoteInternal=async(r:any)=>({block:r.block});
 assert.equal((await g.quote({chain:'bsc',token,side:'buy',nativeAmountRaw:'1',recipient:token,block:101})).block,101);
 assert.equal((await g.quote({chain:'bsc',token,side:'buy',nativeAmountRaw:'1',recipient:token,block:100})).block,100);
 g.headMono.bsc=performance.now()-16000;await assert.rejects(g.quote({chain:'bsc',token,side:'buy',nativeAmountRaw:'1',recipient:token,block:100}),/不新鲜/);g.running=false;await g.stop();
});

test('fast live quotes still reject old FX, future blocks and quote-time reorgs',async()=>{
 const g=new LiveGateway({proxy:''}) as any,at=Date.now();g.running=true;g.head('bsc',10,at-121000);g.head('bsc',100,at);
 const request={chain:'bsc' as const,token,side:'buy' as const,nativeAmountRaw:'1',recipient:token};g.rpc.bsc.block=async()=>({number:100,time:at});
 await assert.rejects(g.quote({...request,block:10}),/当时 FX/);await assert.rejects(g.quote({...request,block:101}),/未来区块/);
 g.route=async()=>({kind:'pons-v2',token,quote:ZERO});g.venues.bsc.conversion=async()=>null;g.fx=async()=>({usd:700,at,mono:performance.now()});g.quoteInternal=async()=>{await g.reorg('bsc',99);return {};};
 await assert.rejects(g.quote({...request,block:100}),/重组/);g.running=false;await g.stop();
});

test('historical reprice forces a new canonical hash even if live header cache is warm',async()=>{
 const g=new LiveGateway({proxy:''}) as any;let force:any;g.rpc.bsc.block=async(n:number,p:boolean,f:boolean)=>{force={n,p,f};return {hash:'replacement'};};
 await assert.rejects(g.reprice({chain:'bsc',token,block:100,blockHash:'original',market:{nativeUsd:700}},{side:'buy',nativeAmountRaw:'1',recipient:token}),/快照区块已重组/);assert.deepEqual(force,{n:100,p:false,f:true});await g.stop();
});

test('clearing block cache discards pending orphan header instead of repopulating it',async()=>{
 const rpc=new ReadRpc('bsc','') as any;rpc.verify=async()=>{};let release!:(value:any)=>void;rpc.request=async()=>new Promise(r=>{release=r;});const pending=rpc.block(100);await Promise.resolve();rpc.clearCache();release({number:'0x64',timestamp:'0x1',hash:'old',parentHash:'parent',transactions:[]});await assert.rejects(pending,/缓存失效/);assert.equal(rpc.knownBlock(100),undefined);await rpc.close();
});

test('slow background scan leaves bounded foreground and head slots; priority is FIFO within lane',async()=>{
 const scheduler=new RpcScheduler(5),owner={},started:string[]=[],releases:(()=>void)[]=[];let peak=0;
 const run=(name:string)=>(_signal:AbortSignal)=>new Promise<string>(resolve=>{started.push(name);peak=Math.max(peak,scheduler.stats().active);releases.push(()=>resolve(name));});
 const a=scheduler.schedule(owner,'background',run('scan-running'));
 const b=scheduler.schedule(owner,'background',run('scan-waiting'));
 const c=scheduler.schedule(owner,'foreground',run('buy'));
 const d=scheduler.schedule(owner,'foreground',run('sell'));
 const e=scheduler.schedule(owner,'head',run('head'));
 await new Promise(r=>setTimeout(r,30));assert.deepEqual(started,['scan-running','head','buy']);assert.equal(scheduler.stats().backgroundActive,1);assert.equal(scheduler.stats().active,3);
 releases[2]();await c;await new Promise(r=>setTimeout(r,10));assert.equal(started[3],'sell');releases[0]();releases[1]();releases[3]();await Promise.all([a,d,e]);await new Promise(r=>setTimeout(r,10));assert.equal(started[4],'scan-waiting');releases[4]();await b;assert(peak<=3);
});

test('shared budget paces heads and foreground too, even across different owners',async()=>{
 const scheduler=new RpcScheduler(12),times:number[]=[];await Promise.all(Array.from({length:8},(_,i)=>scheduler.schedule({i},i%2?'head':'foreground',async()=>{times.push(performance.now());return i;})));
 for(let i=1;i<times.length;i++)assert(times[i]-times[i-1]>=10,`start spacing ${times[i]-times[i-1]}`);assert.equal(scheduler.stats().active,0);
});

test('queued shared background RPC promotes without duplicate send and respects original order',async()=>{
 const scheduler=new RpcScheduler(5),owner={},started:string[]=[];let release!:(value:string)=>void;
 const active=scheduler.schedule(owner,'background',()=>new Promise<string>(r=>{release=r;}));
 const older=scheduler.schedule(owner,'background',async()=>{started.push('older');return 'older';});
 const cached=scheduler.schedule(owner,'background',async()=>{started.push('shared');return 'shared';});const alias=cached.then(x=>x);scheduler.link(alias,cached);
 scheduler.promote(alias,'foreground',performance.now()+1000);assert.equal(await alias,'shared');assert.deepEqual(started,['shared']);release('done');await active;await older;assert.deepEqual(started,['shared','older']);
});

test('expired queues do not execute and stopping an owner rejects pending work',async()=>{
 const scheduler=new RpcScheduler(5),owner={};let release!:()=>void,ran=false;
 const active=scheduler.schedule(owner,'background',()=>new Promise<void>(r=>{release=r;}));
 const expired=scheduler.schedule(owner,'background',async()=>{ran=true;},performance.now()+15);await assert.rejects(expired,/时限|过期/);assert.equal(ran,false);
 const queued=scheduler.schedule(owner,'background',async()=>{}),a=assert.rejects(active,/停止/),q=assert.rejects(queued,/停止/);scheduler.cancel(owner);await Promise.all([a,q]);release();await new Promise(r=>setTimeout(r,5));assert.equal(scheduler.stats().active,0);
});

test('foreground default, explicit research background and refresh/snapshot priorities stay isolated',async()=>{
 const g=new LiveGateway({proxy:''}) as any,lanes:string[]=[];g.quoteLive=async()=>{lanes.push(g.rpc.bsc.priorityContext.getStore().priority);return {};};
 const request={chain:'bsc' as const,token,side:'buy' as const,nativeAmountRaw:'1',recipient:token};await g.quote(request);await g.quote({...request,background:true});assert.deepEqual(lanes,['foreground','background']);
 g.refreshMarket=async()=>{lanes.push(g.rpc.bsc.priorityContext.getStore().priority);};await g.rpc.bsc.withPriority(()=>g.refresh({chain:'bsc'},100));assert.equal(lanes[2],'background');await g.stop();
});

test('fresh foreground FX is immediate during slow refresh; missing FX blocks without waiting for CLI',async()=>{
 const g=new LiveGateway({proxy:''}) as any;g.running=true;const cached={usd:700,at:Date.now(),mono:performance.now()};g.nativeFx.set('bsc',cached);
 g.fxPending.set('bsc',new Promise(()=>{}));const start=performance.now();assert.equal(await g.rpc.bsc.withPriority(()=>g.fx('bsc')),cached);assert(performance.now()-start<100);
 g.nativeFx.delete('bsc');const blocked=performance.now();await assert.rejects(g.rpc.bsc.withPriority(()=>g.fx('bsc')),/后台刷新后/);assert(performance.now()-blocked<100);g.running=false;await g.stop();
});

test('RH DEX refresh never moves route proof past a valid older quote block',async()=>{
 const g=new LiveGateway({proxy:''}) as any,route:Route={kind:'v3',token,quote:ZERO,pool:token,fee:3000};let resolves=0;
 g.routes.set('robinhood:'+token,{block:100,route});g.venues.robinhood.resolve=async()=>{resolves++;return route;};
 assert.equal(await g.route('robinhood',token,200),route);assert.equal(await g.route('robinhood',token,150),route);assert.equal(resolves,0);assert.equal(g.routes.get('robinhood:'+token).block,100);
 await g.route('robinhood',token,99);assert.equal(resolves,1);await g.reorg('robinhood',99);await g.route('robinhood',token,150);assert.equal(resolves,2);await g.stop();
});

test('market getters use current real chain FX without fabricating a fresh token price or time',async()=>{
 const g=new LiveGateway({proxy:''}) as any,m=g.discovered('robinhood',token,100,0);m.nativeUsd=null;m.priceUsd=3;m.updatedAt=1234;m.quality='unavailable';
 g.nativeFx.set('robinhood',{usd:2000,at:Date.now(),mono:performance.now()});assert.equal(g.getMarket('robinhood',token).nativeUsd,2000);assert.equal(g.markets()[0].nativeUsd,2000);assert.equal(m.priceUsd,3);assert.equal(m.updatedAt,1234);assert.equal(m.quality,'unavailable');
 g.nativeFx.set('robinhood',{usd:2000,at:Date.now()-91000,mono:performance.now()-91000});assert.equal(g.getMarket('robinhood',token).nativeUsd,null);assert.equal(g.markets()[0].priceUsd,3);assert.equal(m.updatedAt,1234);await g.stop();
});

test('already proved Pons addToken bypasses background resolver and metadata wait',async()=>{
 const g=new LiveGateway({proxy:''}) as any,m=g.discovered('robinhood',token,100,0);m.decimals=18;m.updatedAt=1234;m.priceUsd=null;g.nativeFx.set('robinhood',{usd:2000,at:Date.now(),mono:performance.now()});
 g.routes.set('robinhood:'+token,{block:100,route:{kind:'v3',token,quote:ZERO,pool:token,state:{platform:'pons-v1'}}});g.inAdds.set('robinhood:'+token,new Promise(()=>{}));g.rpc.robinhood.block=async()=>{throw Error('unnecessary RPC');};g.loadMetadata=async()=>{throw Error('unnecessary CLI');};
 const started=performance.now(),result=await g.addToken('robinhood',token);assert(performance.now()-started<100);assert.equal(result.nativeUsd,2000);assert.equal(result.priceUsd,null);assert.equal(result.updatedAt,1234);await g.stop();
});

test('Pons V2 immutable fee proof is reused but recipient tax and graduation state stay live',async()=>{
 const calls:{name:string;block:number;recipient?:string}[]=[];let ready=false;
 const rpc={chain:'robinhood',read:async(_c:any,_abi:any,name:string,args:any[],block:number,from?:string)=>{calls.push({name,block,recipient:name==='currentSnipeTaxBps'?args[0]:from});if(name==='currentSnipeTaxBps')return args[0]===token?0n:9000n;return ({getReserves:[base.quoteReserve,base.tokenReserve],sellableTokens:base.sellable,feeBps:100n,creatorTaxBps:300n,readyToGraduate:ready,graduated:false} as any)[name];}} as unknown as ReadRpc;
 const v=new Venues(rpc),route:Route={kind:'pons-v2',token,quote:ZERO,curve:token},recipient=address('0x3000000000000000000000000000000000000000');
 await v.quote(route,'buy',WAD,100,token);const b=await v.quote(route,'buy',WAD,101,recipient);assert(b.tax>WAD/2n);assert.equal(calls.filter(c=>c.name==='feeBps').length,1);assert.equal(calls.filter(c=>c.name==='creatorTaxBps').length,1);assert.equal(calls.filter(c=>c.name==='currentSnipeTaxBps').length,2);
 const before=calls.length;await v.quote(route,'sell',WAD,102,recipient);assert.equal(calls.length-before,4);assert(!calls.slice(before).some(c=>c.name==='currentSnipeTaxBps'));assert(calls.slice(before).every(c=>c.block===102));
 ready=true;await assert.rejects(v.quote(route,'sell',WAD,103,recipient),/等待毕业/);ready=false;
 await v.quote(route,'buy',WAD,99,recipient);assert.equal(calls.filter(c=>c.name==='feeBps').length,2);v.invalidate();await v.quote(route,'buy',WAD,104,recipient);assert.equal(calls.filter(c=>c.name==='feeBps').length,3);
});

test('BSC discovery flood cannot evict Robinhood; each chain remains capped at 150',async()=>{
 const g=new LiveGateway({proxy:''}) as any;g.discovered('robinhood',token,10,0);
 for(let i=1;i<=600;i++)g.discovered('bsc','0x'+i.toString(16).padStart(40,'0'),i,0);
 assert(g.getMarket('robinhood',token));assert.equal(g.markets().filter((m:any)=>m.chain==='bsc').length,150);assert.equal(g.markets().filter((m:any)=>m.chain==='robinhood').length,1);
 for(let i=1;i<=600;i++)g.discovered('robinhood','0x'+i.toString(16).padStart(40,'0'),i,0);assert.equal(g.markets().length,300);await g.stop();
});

test('manual selection and restored position references survive same-chain discovery flood',async()=>{
 const g=new LiveGateway({proxy:''}) as any,held=address('0x2000000000000000000000000000000000000000');
 g.pinManual('robinhood',token);g.retainTokens('robinhood',[held]);const selected=g.discovered('robinhood',token,10,0),position=g.discovered('robinhood',held,10,0);selected.updatedAt=1234;position.updatedAt=1234;
 g.routes.set('robinhood:'+token,{block:10,route:{kind:'v3',token,quote:ZERO,pool:token,state:{platform:'pons-v1'}}});
 for(let i=1;i<=600;i++)g.discovered('robinhood','0x'+i.toString(16).padStart(40,'0'),i,0);
 assert.equal(g.getMarket('robinhood',token),selected);assert.equal(g.getMarket('robinhood',held),position);assert(g.routes.has('robinhood:'+token));assert.equal(selected.updatedAt,1234);assert.equal(position.updatedAt,1234);assert.equal(g.markets().length,150);await g.stop();
});

test('combined pin budget is bounded at 50; position references take precedence and release explicitly',async()=>{
 const g=new LiveGateway({proxy:''}) as any,retained=Array.from({length:10},(_,i)=>address('0x'+(i+1000).toString(16).padStart(40,'0')));g.retainTokens('bsc',retained);
 for(let i=1;i<=100;i++)g.pinManual('bsc','0x'+i.toString(16).padStart(40,'0'));
 assert.equal(new Set([...g.manualPins.bsc.keys(),...g.retainedPins.bsc]).size,50);assert.equal(g.retainedPins.bsc.size,10);assert.equal(g.manualPins.bsc.size,40);
 assert.throws(()=>g.retainTokens('bsc',Array.from({length:51},(_,i)=>'0x'+(i+2000).toString(16).padStart(40,'0'))),/50/);assert.equal(g.retainedPins.bsc.size,10);g.retainTokens('bsc',[]);assert.equal(g.retainedPins.bsc.size,0);await g.stop();
});

test('interactive CLI chart overtakes queued metadata with one shared paced worker and owner fairness',async()=>{
 const scheduler=new CliScheduler(10),ownerA={},ownerB={},started:string[]=[],times:number[]=[];let release!:()=>void;
 const active=scheduler.enqueue(ownerA,()=>new Promise<void>(r=>{release=r;}));const run=(name:string)=>async()=>{started.push(name);times.push(performance.now());return name;};
 const metadata1=scheduler.enqueue(ownerA,run('A1')),metadata2=scheduler.enqueue(ownerA,run('A2')),metadataB=scheduler.enqueue(ownerB,run('B1')),chart=scheduler.enqueue(ownerA,run('chart'),{priority:'interactive'});
 release();await Promise.all([active,metadata1,metadata2,metadataB,chart]);assert.deepEqual(started,['chart','B1','A1','A2']);for(let i=1;i<times.length;i++)assert(times[i]-times[i-1]>=8);assert.equal(scheduler.stats().active,0);
});

test('shared-lock wait yields priority selection instead of holding the CLI pipeline',async()=>{
 const scheduler=new CliScheduler(5),owner={},started:string[]=[];let attempts=0;
 const background=scheduler.enqueue(owner,async()=>{attempts++;if(attempts===1)throw new CliWait(15);started.push('metadata');});
 await Promise.resolve();const chart=scheduler.enqueue(owner,async()=>{started.push('chart');},{priority:'interactive'});await Promise.all([background,chart]);assert.deepEqual(started,['chart','metadata']);assert.equal(attempts,2);
});

test('CLI cancellation removes queued work and closing one owner preserves another',async()=>{
 const scheduler=new CliScheduler(5),ownerA={},ownerB={},controller=new AbortController();let release!:()=>void,ran=false;
 const active=scheduler.enqueue(ownerA,()=>new Promise<void>(r=>{release=r;})),queued=scheduler.enqueue(ownerA,async()=>{ran=true;},{signal:controller.signal}),other=scheduler.enqueue(ownerB,async()=>42);
 const cancelled=assert.rejects(queued,/取消/);controller.abort();await cancelled;const stopped=assert.rejects(active,/停止/);scheduler.cancel(ownerA);await stopped;release();assert.equal(await other,42);assert.equal(ran,false);
});

test('CLI queue is bounded per owner before issuing requests',async()=>{
 const scheduler=new CliScheduler(5,2),owner={};let release!:()=>void;const active=scheduler.enqueue(owner,()=>new Promise<void>(r=>{release=r;}));const a=scheduler.enqueue(owner,async()=>1),b=scheduler.enqueue(owner,async()=>2);await assert.rejects(scheduler.enqueue(owner,async()=>3),/队列已满/);release();await Promise.all([active,a,b]);
});

test('known chart selection pins synchronously without metadata or price refresh',async()=>{
 const g=new LiveGateway({proxy:''}) as any,m=g.discovered('bsc',token,1,0);m.updatedAt=123;g.nativeFx.set('bsc',{usd:700,at:Date.now(),mono:performance.now()});g.addToken=async()=>{throw Error('must not hydrate');};
 const selected=g.selectToken('bsc',token);assert.equal(selected.nativeUsd,700);assert.equal(selected.updatedAt,123);assert(g.manualPins.bsc.has(token));assert.throws(()=>g.selectToken('robinhood',token),/目录没有/);await g.stop();
});
test('visible chart prewarms once, refreshes within the same TTL and stops after its demand lease',async()=>{
 const g=new LiveGateway({proxy:''}) as any;try{
  g.discovered('bsc',token,100,0);g.queueResolve=()=>{};g.running=true;g.head('bsc',100,Date.now());let calls=0,release!:(rows:any[])=>void;g.gmgn.candles=async()=>{calls++;return new Promise<any[]>(r=>{release=r;});};
  const selected=g.selectToken('bsc',token);assert.equal(selected.priceUsd,null);assert.equal(calls,1);g.chartHistoryLoop();g.chartHistoryLoop();assert.equal(calls,1);
  const pending=g.historyPending.get('bsc:'+token);release([{time:Math.floor(Date.now()/30000)*30,open:2,high:3,low:2,close:3,volume:4}]);await pending;await g.candles('bsc',token);g.chartHistoryLoop();assert.equal(calls,1);
  const cached=g.historyRows.get('bsc:'+token);cached.mono=performance.now()-15001;g.chartHistoryLoop();assert.equal(calls,2);const refresh=g.historyPending.get('bsc:'+token);release([]);await refresh;
  g.historyRows.get('bsc:'+token).mono=performance.now()-15001;g.chartDemand.set('bsc',performance.now()-30001);g.chartHistoryLoop();assert.equal(calls,2);
  g.chartDemand.set('bsc',performance.now());g.headMono.bsc=performance.now()-16000;g.chartHistoryLoop();assert.equal(calls,2);
 }finally{g.running=false;await g.stop();}
});
test('prewarm is limited to selected chains and at most two pending histories; getters still do no IO',async()=>{
 const g=new LiveGateway({proxy:''}) as any;try{
  g.running=true;g.queueResolve=()=>{};for(const chain of ['bsc','robinhood']){g.discovered(chain,token,100,0);g.head(chain,100,Date.now());}
  const releases:(()=>void)[]=[];let calls=0;g.gmgn.candles=async()=>{calls++;return new Promise<any[]>(r=>releases.push(()=>r([])));};g.selectToken('bsc',token);g.selectToken('robinhood',token);assert.equal(calls,2);
  const other=address('0x2000000000000000000000000000000000000000');g.discovered('bsc',other,100,0);g.selectToken('bsc',other);g.chartHistoryLoop();assert.equal(calls,2);assert.equal(g.historyPending.size,2);
  g.cachedCandles('bsc',other);g.candleStatus('bsc',other);assert.equal(calls,2);const pending=[...g.historyPending.values()];releases.forEach(r=>r());await Promise.all(pending);
  g.chartHistoryLoop();assert.equal(calls,3);const next=[...g.historyPending.values()];releases.at(-1)!();await Promise.all(next);
 }finally{g.running=false;await g.stop();}
});
test('an old selected route stays inside the existing 100-address scan; chains and queued work stay isolated',async()=>{
 const g=new LiveGateway({proxy:''}) as any;try{
  const addresses:string[]=[];for(let i=0;i<150;i++){const t=address('0x'+(1000+i).toString(16).padStart(40,'0')),curve=address('0x'+(2000+i).toString(16).padStart(40,'0'));addresses.push(curve);g.routes.set('bsc:'+t,{block:1,route:{kind:'flap',token:t,quote:ZERO,curve}});}const chosen=address('0x'+(1000).toString(16).padStart(40,'0'));g.discovered('bsc',chosen,1,0);g.selectToken('bsc',chosen);
  g.routes.set('robinhood:'+token,{block:1,route:{kind:'pons-v2',token,quote:ZERO,curve:address('0x9999999999999999999999999999999999999999')}});const scans:any[]=[];g.rpc.bsc.logs=async(filter:any)=>{scans.push(filter);return [];};await g.scanLogs('bsc',1,2,false);
  const covered=scans.slice(1).flatMap(f=>f.address);assert.equal(covered.length,100);assert.equal(covered[0],addresses[0]);assert(covered.includes(addresses[149]));assert(!covered.includes(addresses[1]));assert(!covered.includes('0x9999999999999999999999999999999999999999'));
  const queue=['bsc:'+token,'bsc:'+chosen,'robinhood:'+token];assert.equal(g.nextVisible(queue,true),'bsc:'+chosen);assert.deepEqual(queue,['bsc:'+token,'robinhood:'+token]);assert.equal(g.nextVisible(queue,true),'bsc:'+token);assert.equal(g.nextVisible(queue),'robinhood:'+token);
 }finally{await g.stop();}
});
test('canonical pool asset proof removes redundant chart/spot reads without freezing reserves or earlier blocks',async()=>{
 const pool=address('0x2000000000000000000000000000000000000000'),native=address(CHAIN_CONFIG.bsc.wrapped),calls:{name:string;block:number}[]=[];
 const rpc={chain:'bsc',read:async(_c:any,_a:any,name:string,_args:any[],block:number)=>{calls.push({name,block});return ({factory:CHAIN_CONFIG.bsc.v2Factory,token0:token,token1:native,getPair:pool,getReserves:[100n,BigInt(block)*10n,0]} as any)[name];}} as unknown as ReadRpc;
 const v=new Venues(rpc),route=await v.pool(token,ZERO,pool,100);assert.equal(await v.poolToken0(route,101),token);assert.equal(await v.spot(route,101),10.1);assert.equal(await v.spot(route,102),10.2);assert.equal(calls.filter(c=>c.name==='token0').length,1);assert.deepEqual(calls.filter(c=>c.name==='getReserves').map(c=>c.block),[101,102]);
 await v.poolToken0(route,99);assert.equal(calls.filter(c=>c.name==='token0').length,2);v.invalidate();await v.poolToken0(route,103);await v.poolToken0(route,104);assert.equal(calls.filter(c=>c.name==='token0').length,4);
});
test('pool cache is not established by a failed canonical proof or an inflight reorg',async()=>{
 const pool=address('0x2000000000000000000000000000000000000000');let release!:(s:string)=>void;
 const rpc={chain:'bsc',read:async(_c:any,_a:any,name:string)=>name==='getPair'?new Promise<string>(r=>{release=r;}):({factory:CHAIN_CONFIG.bsc.v2Factory,token0:token,token1:CHAIN_CONFIG.bsc.wrapped} as any)[name]} as unknown as ReadRpc;
 const v=new Venues(rpc),pending=v.pool(token,ZERO,pool,100);const rejected=assert.rejects(pending,/重组/);await new Promise(r=>setTimeout(r,0));v.invalidate();release(pool);await rejected;assert.equal((v as any).poolAssets.size,0);
 const failed=v.pool(token,ZERO,pool,101);const mismatch=assert.rejects(failed,/不一致/);await new Promise(r=>setTimeout(r,0));release(ZERO);await mismatch;assert.equal((v as any).poolAssets.size,0);
});
test('cached pool orientation still requires each real receipt/hash/net-flow before a chart tick',async()=>{
 const g=new LiveGateway({proxy:''}) as any;try{
  const pool=address('0x2000000000000000000000000000000000000000'),owner=address('0x3000000000000000000000000000000000000000');let t0Reads=0,receiptReads=0;
  g.rpc.bsc.read=async(_c:any,_a:any,name:string)=>{if(name==='token0')t0Reads++;return ({factory:CHAIN_CONFIG.bsc.v2Factory,token0:token,token1:CHAIN_CONFIG.bsc.wrapped,getPair:pool} as any)[name];};
  const route=await g.venues.bsc.pool(token,ZERO,pool,100);g.routes.set('bsc:'+token,{block:100,route});const m=g.discovered('bsc',token,100,0);m.decimals=6;g.gas.bsc.observe=async()=>{};g.fx=async()=>({usd:1000,at:Date.now(),mono:performance.now()});g.venues.bsc.conversion=async()=>null;g.venues.bsc.decimals=async()=>18;g.rpc.bsc.block=async(n:number)=>({number:n,time:Date.now()});
  const events:any[]=[];g.emit=(e:any)=>events.push(e);let current:any;g.rpc.bsc.receipt=async()=>{receiptReads++;return current;};const topic=getEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)');
  for(let i=1;i<=3;i++){const hash='0x'+String(i).repeat(64),tx='0x'+String(i+3).repeat(64),log={address:pool,blockNumber:'0x'+(100+i).toString(16),blockHash:hash,transactionHash:tx,logIndex:'0x1',topics:[topic,'0x'+owner.slice(2).padStart(64,'0'),'0x'+owner.slice(2).padStart(64,'0')],data:encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[0n,10000000000000000n,2000000n,0n])};
   const transfer={address:token,topics:[getEventSelector('Transfer(address,address,uint256)'),'0x'+pool.slice(2).padStart(64,'0'),'0x'+owner.slice(2).padStart(64,'0')],data:'0x'+(i===3?1999999n:2000000n).toString(16)};
   current={status:'0x1',blockHash:hash,from:owner,transactionHash:tx,logs:[log,transfer]};await g.tradeLog('bsc',log,false);
  }
  assert.equal(t0Reads,1);assert.equal(receiptReads,3);assert.deepEqual(events.map(e=>e.payload.verified),[true,true,false]);assert(events.every(e=>e.priceUsd===5&&e.amountUsd===10));assert.equal(g.cachedCandles('bsc',token).reduce((sum:number,c:any)=>sum+c.volume,0),20);
 }finally{await g.stop();}
});

test('CLI candle args use supported 30s and Unix seconds; raw response shape is checked',async()=>{
 const reader=new GmgnReadQueue('') as any;let args:string[]=[],priority='';reader.request=async(a:string[],o:any)=>{args=a;priority=o.priority;return {data:{list:[{time:1791231400000,open:1,high:2,low:1,close:2,volume:7}]}};};
 const rows=await reader.candles('bsc',token,1791231400000);assert.equal(args[args.indexOf('--resolution')+1],'30s');assert.equal(args[args.indexOf('--to')+1],'1791231400');assert.equal(args[args.indexOf('--from')+1],'1791224200');assert.equal(priority,'interactive');assert.equal(rows[0].time,1791231400);
 reader.request=async()=>({data:{unrecognized:[]}});await assert.rejects(reader.candles('bsc',token),/未识别/);reader.close();
});

test('local verified candles return immediately while one deduplicated history request is pending',async()=>{
 const g=new LiveGateway({proxy:''}) as any;let calls=0,release!:(rows:any[])=>void;g.gmgn.candles=async()=>{calls++;return new Promise<any[]>(r=>{release=r;});};g.tick('bsc',token,30000,2,10);
 const at=performance.now(),local=await g.candles('bsc',token);assert(performance.now()-at<100);assert.equal(local[0].volume,10);assert.equal(g.candleStatus('bsc',token).source,'verified-local');assert.equal(g.candleStatus('bsc',token).pending,true);await g.candles('bsc',token);assert.equal(calls,1);
 release([{time:0,open:1,high:1,low:1,close:1,volume:5}]);await g.historyPending.get('bsc:'+token);const merged=await g.candles('bsc',token);assert.equal(merged.length,2);assert.equal(g.candleStatus('bsc',token).source,'mixed');assert.equal(calls,1);await g.stop();
});

test('cold chart returns bounded pending feedback, then real cached history without synthetic bars',async()=>{
 const g=new LiveGateway({proxy:''}) as any;let release!:(rows:any[])=>void;g.gmgn.candles=async()=>new Promise<any[]>(r=>{release=r;});const at=performance.now();const empty=await g.candles('robinhood',token);assert(performance.now()-at<1900);assert.deepEqual(empty,[]);assert.equal(g.candleStatus('robinhood',token).state,'loading');
 release([{time:30,open:2,high:3,low:2,close:3,volume:10},{time:90,open:3,high:4,low:3,close:4,volume:20}]);await g.historyPending.get('robinhood:'+token);const ready=await g.candles('robinhood',token);assert.equal(ready.length,2);assert.equal(ready[1].time-ready[0].time,60);assert.equal(g.candleStatus('robinhood',token).pending,false);await g.stop();
});

test('history error and genuinely empty history remain distinct and respect retry cooldown',async()=>{
 const g=new LiveGateway({proxy:''}) as any;let calls=0;g.gmgn.candles=async()=>{calls++;throw Error('rate limited');};assert.deepEqual(await g.candles('bsc',token),[]);assert.equal(g.candleStatus('bsc',token).state,'error');assert.match(g.candleStatus('bsc',token).reason,/rate limited/);await g.candles('bsc',token);assert.equal(calls,1);
 g.gmgn.candles=async()=>[];assert.deepEqual(await g.candles('robinhood',token),[]);assert.equal(g.candleStatus('robinhood',token).state,'empty');await g.stop();
});

test('light chart SSE cached lookup performs no IO and never creates reference-price bars',async()=>{
 const g=new LiveGateway({proxy:''}) as any,second=address('0x2000000000000000000000000000000000000000');g.discovered('bsc',token,1,0);g.discovered('bsc',second,1,0);g.discovered('robinhood',token,1,0);
 g.gmgn.candles=async()=>{throw Error('cached read must not fetch');};assert.deepEqual(g.cachedCandles('bsc',token),[]);g.selectToken('bsc',token);g.selectToken('bsc',second);g.selectToken('robinhood',token);g.getMarket('bsc',second).priceUsd=999;
 assert.deepEqual(g.cachedCandles('bsc',second),[]);assert.deepEqual(g.cachedCandles('robinhood',token),[]);assert.equal(g.historyPending.size,0);assert(g.manualPins.bsc.has(token)&&g.manualPins.bsc.has(second));await g.stop();
});

test('new verified local tail supersedes stale history only in the latest bar, without counting volume twice',async()=>{
 const g=new LiveGateway({proxy:''}) as any,at=Date.now(),time=Math.floor(at/30000)*30;g.discovered('bsc',token,1,0);g.selectToken('bsc',token);
 const old={time:time-30,open:1,high:2,low:1,close:2,volume:100},last={time,open:3,high:4,low:3,close:4,volume:200};g.historyRows.set('bsc:'+token,{rows:[old,last],at,mono:performance.now(),untilAt:at-2000});g.tick('bsc',token,at,5,10);g.getMarket('bsc',token).priceUsd=999;
 const live=g.cachedCandles('bsc',token);assert.equal(live.at(-1).close,5);assert.equal(live.at(-1).volume,10);assert.deepEqual(live[0],old);assert.match(g.candleStatus('bsc',token).reason,/已核实/);
 live[0].close=999;assert.equal(g.cachedCandles('bsc',token)[0].close,2);assert.equal(last.close,4);
 g.historyRows.get('bsc:'+token).untilAt=at+1000;assert.equal(g.cachedCandles('bsc',token).at(-1).close,4);assert.doesNotMatch(g.candleStatus('bsc',token).reason,/末根/);await g.stop();
});

test('cached SSE rows remain bounded at 1000 bars and visible pins survive other foreground activity',async()=>{
 const g=new LiveGateway({proxy:''}) as any;g.discovered('bsc',token,1,0);g.selectToken('bsc',token);g.historyRows.set('bsc:'+token,{rows:Array.from({length:1200},(_,i)=>({time:i*30,open:1,high:1,low:1,close:1,volume:1})),at:Date.now(),mono:performance.now()});
 for(let i=1;i<=100;i++)g.pinManual('bsc','0x'+i.toString(16).padStart(40,'0'));assert(g.manualPins.bsc.has(token));assert.equal(g.manualPins.bsc.size,50);assert.equal(g.cachedCandles('bsc',token).length,1000);await g.stop();
});
