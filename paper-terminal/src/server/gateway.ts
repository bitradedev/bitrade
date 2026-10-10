import { randomUUID,randomBytes } from 'node:crypto';
import { mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { decodeEventLog,getEventSelector,type Address } from 'viem';
import type { Candle,Chain,ChainStatus,Market,MarketEvent,MarketGateway,Quote,QuoteRequest } from '../shared/domain.js';
import { ERC20,EVENTS,V1_LAUNCH,V2_ABI } from './adapters/abi.js';
import { GmgnReadQueue,unwrap,gmgnProxy } from './adapters/gmgn.js';
import { ReceiptGas } from './adapters/fees.js';
import { hexBlock,ReadRpc } from './adapters/rpc.js';
import {ConfirmedBscHeaders,readBscBlockReceipts} from './adapters/bsc-block-reader.js';
import {QuoteReferences,type QuoteReference} from './adapters/quote-reference.js';
import { Venues,poolId } from './adapters/venues.js';
import { impact,units,flapReserve,feeExcludedImpact } from './adapters/math.js';
import { normalizedTime,milliseconds } from './adapters/time.js';
import { scannerSeed,scannerFields,mergeScannerEvidence,invalidateScannerEvidence,type ScannerEvidence } from './adapters/scanner.js';
import {priceRefreshTargets} from './price-demand.js';
import {LiveWorkQueue} from './live-work-queue.js';
import { address,raw,capMap,CHAIN_CONFIG,FLAP,FOUR_MANAGER,ORDINARY_RECIPIENT,PONS_V2,ZERO,RouteBlocked,type GatewayOptions,type GasContext,type RepriceRequest,type Route,type Snapshot,type Wallet } from './adapters/types.js';
export type { GatewayOptions,GasContext,RepriceRequest,Snapshot } from './adapters/types.js';
export interface LiveQuote extends Quote {impactQuality:'verified'|'estimated';sourceFeeFrozenAt:number;}
export interface CandleStatus {source:'gmgn'|'verified-local'|'mixed'|'none';reason:string;pending:boolean;state:'ready'|'loading'|'empty'|'error'|'stopped';rows:number;historyAt:number|null;}
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const key=(chain:Chain,token:string)=>chain+':'+token.toLowerCase();
const TRANSFER=getEventSelector('Transfer(address,address,uint256)');
const TRADE_TOPICS=EVENTS.filter(e=>e.type==='event'&&!['TokenLaunched','Transfer','PoolGraduated','LaunchedToDEX'].includes(e.name)).map(e=>getEventSelector(e));
const safeJson=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
export class LiveGateway implements MarketGateway {
 readonly dataDir:string;readonly proxy:string;
 readonly rpc:Record<Chain,ReadRpc>;readonly venues:Record<Chain,Venues>;
 private gas:Record<Chain,ReceiptGas>;private gmgn:GmgnReadQueue;
 private tradeQuoteReferences:Record<Chain,QuoteReferences>;
 private walletLists:Record<Chain,Wallet[]>={bsc:[],robinhood:[]};
 private catalog=new Map<string,Market>();private routes=new Map<string,{block:number;route:Route}>();private metadata=new Map<string,{info:any;security:any;pool:any;at:number}>();
 private nativeFx=new Map<Chain,{usd:number;at:number;mono:number}>();private candleRows=new Map<string,Candle[]>();
 private historyRows=new Map<string,{rows:Candle[];at:number;mono:number;untilAt?:number}>();private historyPending=new Map<string,Promise<void>>();private historyAttempts=new Map<string,{mono:number;reason?:string}>();private candleRevision:Record<Chain,number>={bsc:0,robinhood:0};private lastLocalCandleAt=new Map<string,number>();private visibleTokens=new Map<Chain,string>();
 private chartDemand=new Map<Chain,number>();
 private status:Record<Chain,ChainStatus>={bsc:{chain:'bsc',connected:false,head:0,headAt:0,chainTime:0,gaps:0,reconnects:0,lastError:'等待启动',source:'PublicNode confirmed WS + 只读 HTTP'},robinhood:{chain:'robinhood',connected:false,head:0,headAt:0,chainTime:0,gaps:0,reconnects:0,lastError:'等待启动',source:'Robinhood 官方 HTTP 区块轮询'}};
 private headMono:Record<Chain,number>={bsc:0,robinhood:0};private scanHead:Record<Chain,number>={bsc:0,robinhood:0};
 private scanErrors:Record<Chain,string>={bsc:'',robinhood:''};private scanErrorAuditMono:Record<Chain,number>={bsc:-Infinity,robinhood:-Infinity};
 private hashes:Record<Chain,Map<number,string>>={bsc:new Map(),robinhood:new Map()};private seen=new Map<string,MarketEvent>();private receipts=new Map<string,Promise<any>>();private walletBuys=new Map<string,string>();private watchedTransactions=new Map<string,boolean>();
 private inAdds=new Map<string,Promise<Market>>();private hydration:string[]=[];private hydrating=false;private running=false;private generation=0;private emit:(e:MarketEvent)=>void=()=>{};private feed:any;
 private timers:ReturnType<typeof setInterval>[]=[];private busy:Record<Chain,boolean>={bsc:false,robinhood:false};private maintenanceBusy=false;private persistenceBusy=false;private emitQueue:Promise<void>=Promise.resolve();
 private displayRecipient=address('0x'+randomBytes(20).toString('hex'));
 private headBusy:Record<Chain,boolean>={bsc:false,robinhood:false};private rawHeads:Partial<Record<Chain,any>>={};
 private headTimes:Record<Chain,Map<number,number>>={bsc:new Map(),robinhood:new Map()};private quoteRevision:Record<Chain,number>={bsc:0,robinhood:0};
 private resolveQueue:string[]=[];private resolving=false;
 private buyPreviews=new Map<string,{block:number;output:bigint;route:Route}>();
 private priceBusy:Record<Chain,boolean>={bsc:false,robinhood:false};
 private tradePriceDemand=new Map<string,number>();
 private liveWork:LiveWorkQueue;
 private bscWork:LiveWorkQueue;
 private needsRecovery:Record<Chain,boolean>={bsc:true,robinhood:true};
 private attachedSocket:any;private bscHeaders=new ConfirmedBscHeaders();private loadingMetadata=new Map<string,Promise<any>>();
 private walletReceiptQueue:{tx:string;replayed:boolean}[]=[];private walletReceiptBusy=false;private walletReceiptSeen=new Map<string,boolean>();
 private selectedPools=new Map<string,string>();
 private fxPending=new Map<Chain,Promise<{usd:number;at:number;mono:number}>>();
 private stopped=false;private observedReceiveTimes=new Map<string,number>();
 private manualPins:Record<Chain,Map<string,true>>={bsc:new Map(),robinhood:new Map()};private retainedPins:Record<Chain,Set<string>>={bsc:new Set(),robinhood:new Set()};
 constructor(private options:GatewayOptions={}){
  this.liveWork=new LiveWorkQueue((e,job)=>this.audit('Robinhood 实时事件核验失败',{id:job.id,replayed:job.replayed,reason:e instanceof Error?e.message:String(e)}),job=>{
   this.audit('Robinhood 事件核验队列满，丢弃旧记录且不补造成交',{id:job.id,replayed:job.replayed});
   if(!job.replayed&&this.running){this.status.robinhood.gaps++;this.publish({id:'gap:proof:'+job.id,chain:'robinhood',kind:'gap',block:this.status.robinhood.head,at:this.status.robinhood.chainTime,receivedAt:Date.now(),payload:{reason:'实时回执队列溢出，丢弃的成交不能用于连续覆盖'}});}
  });
  this.bscWork=new LiveWorkQueue((e,job)=>this.audit('BSC 实时事件核验失败',{id:job.id,replayed:job.replayed,reason:e instanceof Error?e.message:String(e)}),job=>{
   this.audit('BSC 事件核验队列满，丢弃旧记录且不补造成交',{id:job.id,replayed:job.replayed});
   if(!job.replayed&&this.running){this.status.bsc.gaps++;this.publish({id:'gap:proof:'+job.id,chain:'bsc',kind:'gap',block:this.status.bsc.head,at:this.status.bsc.chainTime,receivedAt:Date.now(),payload:{reason:'实时回执队列溢出，丢弃的成交不能用于连续覆盖'}});}
  });
  this.proxy=gmgnProxy(options.proxy);this.dataDir=options.dataDir??resolve(workspace,'paper-terminal/src/server/adapters/runtime');
  const guardedAudit=(kind:string,message:string,details?:unknown)=>{if(!this.stopped)options.onAudit?.(kind,message,details);};this.rpc={bsc:new ReadRpc('bsc',this.proxy,guardedAudit),robinhood:new ReadRpc('robinhood',this.proxy,guardedAudit)};
  this.venues={bsc:new Venues(this.rpc.bsc),robinhood:new Venues(this.rpc.robinhood)};this.gas={bsc:new ReceiptGas(this.rpc.bsc),robinhood:new ReceiptGas(this.rpc.robinhood)};this.gmgn=new GmgnReadQueue(this.proxy,guardedAudit);
  const references=(chain:Chain)=>new QuoteReferences((quote,block)=>this.rpc[chain].withProofBudget(async()=>{
   const venue=this.venues[chain],route=await venue.conversion(quote,block);if(!route)throw new RouteBlocked('CONVERSION_UNKNOWN','报价币没有独立兑换路线');
   const quoteDecimals=await venue.decimals(quote,block),spot=await venue.spot(route,block);
   return {block,quoteDecimals,nativePerQuote:spot*10**(quoteDecimals-18)};
  },true));this.tradeQuoteReferences={bsc:references('bsc'),robinhood:references('robinhood')};
  for(const chain of ['bsc','robinhood'] as Chain[])this.setWallets(chain,options.wallets?.[chain]??[]);
 }
 statuses(){return (['bsc','robinhood'] as Chain[]).map(chain=>({...this.status[chain],scanHead:this.scanHead[chain],scanLagBlocks:Math.max(0,this.status[chain].head-this.scanHead[chain]),lastScanError:this.scanErrors[chain],connected:this.status[chain].connected&&performance.now()-this.headMono[chain]<15000,lastError:performance.now()-this.headMono[chain]>=15000&&this.status[chain].head?'新区块已过期':this.status[chain].lastError}));}
 private currentMarketFx(m:Market){const fx=this.nativeFx.get(m.chain);m.nativeUsd=fx&&performance.now()-fx.mono<90000?fx.usd:null;this.scanner(m);return m;}
 private scanner(m:Market,change?:ScannerEvidence){const old=(m.metadata?.scanner||{}) as ScannerEvidence,evidence=change?mergeScannerEvidence(old,change):old;if(change)m.metadata={...m.metadata,scanner:evidence};Object.assign(m,scannerFields(evidence,Date.now(),m.createdAt,rawAt=>this.frozenMarketTime(m,rawAt,'scanner')));}
 private scannerInvalidated(m:Market,from:number){const evidence=invalidateScannerEvidence((m.metadata?.scanner||{}) as ScannerEvidence,from);m.metadata={...m.metadata,scanner:evidence};m.stage=evidence.proof?.stage??'unknown';this.scanner(m);}
 private graduation(chain:Chain,token:string,block:number,rawAt=0){const m=this.discovered(chain,token,block,0);this.scanner(m,{event:{stage:'graduated',block,source:'protocol-graduation-log',rawAt:this.headTimes[chain].get(block)||rawAt||undefined}});void this.refreshToken(chain,token,block);}
 private trimPins(chain:Chain){const manual=this.manualPins[chain],retained=this.retainedPins[chain];while(new Set([...manual.keys(),...retained]).size>50){const oldest=[...manual.keys()].find(t=>!retained.has(t)&&t!==this.visibleTokens.get(chain))??[...manual.keys()].find(t=>!retained.has(t));if(!oldest)break;manual.delete(oldest);}}
 private pinManual(chain:Chain,token:string){const t=address(token),pins=this.manualPins[chain];pins.delete(t);pins.set(t,true);this.trimPins(chain);}
 retainTokens(chain:Chain,tokens:readonly string[]){const retained=new Set(tokens.map(address));if(retained.size>50)throw new RouteBlocked('RETENTION_LIMIT','每条链最多保留50个手动/持仓代币引用');this.retainedPins[chain]=retained;this.trimPins(chain);this.trimCatalog();}
 private trimCatalog(){for(const chain of ['bsc','robinhood'] as Chain[]){const rows=[...this.catalog.entries()].filter(([,m])=>m.chain===chain);let remaining=rows.length;for(const [k,m] of rows){if(remaining<=150)break;if(this.manualPins[chain].has(m.address)||this.retainedPins[chain].has(m.address))continue;this.catalog.delete(k);this.routes.delete(k);this.metadata.delete(k);remaining--;}}}
 markets(){return [...this.catalog.values()].map(m=>({...this.currentMarketFx(m),metadata:m.metadata?{...m.metadata}:undefined}));}
 getMarket(chain:Chain,token:string){const m=this.catalog.get(key(chain,token));return m?this.currentMarketFx(m):undefined;}
 selectToken(chain:Chain,token:string):Market {token=address(token);const m=this.catalog.get(key(chain,token));if(!m)throw new RouteBlocked('MARKET_UNKNOWN','目录没有该代币，请先添加合约并等待链上发现');this.pinManual(chain,token);this.visibleTokens.set(chain,token);this.chartDemand.set(chain,performance.now());if(this.running){this.chartHistoryLoop();if(!this.routes.has(key(chain,token)))this.queueResolve(chain,token);}return this.currentMarketFx(m);}
 private chartHistoryLoop(){if(!this.running||this.stopped)return;const now=performance.now();for(const [chain,token] of this.visibleTokens){if(now-(this.chartDemand.get(chain)??-Infinity)>=30000||!this.statuses().find(s=>s.chain===chain)?.connected)continue;const k=key(chain,token);if(this.historyPending.has(k)||this.historyPending.size<2)void this.requestHistory(chain,token);}}
 private nextVisible(queue:string[],fifo=false){const index=queue.findIndex(k=>{const [chain,token]=k.split(':') as [Chain,string];return this.visibleTokens.get(chain)===token;});return index>=0?queue.splice(index,1)[0]:fifo?queue.shift():queue.pop();}
 private chartRoutes(chain:Chain){const rows=[...this.routes.entries()].filter(([k])=>k.startsWith(chain+':')).reverse(),visible=this.visibleTokens.get(chain),selected=visible?rows.find(([k])=>k===key(chain,visible)):undefined;return [...(selected?[selected]:[]),...rows.filter(row=>row!==selected)].map(([,r])=>r.route);}
 setWallets(chain:Chain,wallets:Wallet[]){this.walletLists[chain]=wallets.map(w=>({address:address(w.address),name:w.name.slice(0,100)}));
  if(this.feed&&chain==='bsc'){// Existing feed provides receipt attribution, and reconnects subscriptions.
   this.feed.wallets=new Map(this.walletLists.bsc.map(w=>[w.address,w.name]));this.feed.ws?.close();
  }
 }
 private audit(message:string,details?:unknown){if(!this.stopped)this.options.onAudit?.('gateway',message,details);}
 private publish(e:MarketEvent){if(this.stopped)return;const rawAt=e.at,at=this.localTime(e.chain,rawAt,e.receivedAt);const clean=JSON.parse(safeJson({...e,at,payload:{...e.payload,rawChainAt:rawAt}})) as MarketEvent;if(clean.kind==='removed'){const removedEventId=String(clean.payload.removedEventId||clean.id);this.seen.delete(removedEventId);clean.id='removed:'+removedEventId+':'+(this.rawHeads[clean.chain]?.hash||randomUUID());clean.payload.removedEventId=removedEventId;this.emit(clean);return;}if(this.seen.has(clean.id))return;this.seen.set(clean.id,clean);capMap(this.seen,15000);this.emit(clean);}
 private localTime(chain:Chain,rawAt:number,receivedAt=Date.now()){const h=this.status[chain];return normalizedTime(rawAt,h.chainTime,h.headAt,receivedAt);}
 private frozenMarketTime(m:Market,rawAt:number,kind:'created'|'scanner'):number|undefined {if(!Number.isFinite(rawAt)||rawAt<=0)return;const clocks=m.metadata?.marketClock as Partial<Record<'created'|'scanner',{rawAt:number;at:number}>>|undefined,cached=clocks?.[kind];if(cached?.rawAt===rawAt&&Number.isFinite(cached.at)&&cached.at>0)return cached.at;const h=this.status[m.chain];if(!h.chainTime||!h.headAt)return;const at=this.localTime(m.chain,rawAt);m.metadata={...m.metadata,marketClock:{...clocks,[kind]:{rawAt,at}}};return at;}
 private createdTime(m:Market,rawAt:number){if(m.metadata?.rawCreatedAt!==rawAt)m.metadata={...m.metadata,rawCreatedAt:rawAt};m.createdAt=this.frozenMarketTime(m,rawAt,'created')??0;this.scanner(m);}
 async start(emit:(event:MarketEvent)=>void){
  if(this.stopped)throw Error('网关已关闭，请创建新的 LiveGateway 实例');if(this.running)return;this.running=true;const generation=++this.generation;this.emit=emit;await mkdir(this.dataDir,{recursive:true});
  try {const saved=JSON.parse(await readFile(resolve(this.dataDir,'gateway-catalog.json'),'utf8'));for(const chain of ['bsc','robinhood'] as Chain[])for(const token of saved.manualPins?.[chain]||[])if(typeof token==='string'&&/^0x[0-9a-f]{40}$/i.test(token))this.pinManual(chain,token);for(const m of saved.markets||[])if(['bsc','robinhood'].includes(m.chain)&&/^0x[0-9a-f]{40}$/i.test(m.address))this.catalog.set(m.id,{...m,quality:'unavailable',reason:'重启后等待实时验证'});for(const chain of ['bsc','robinhood'] as Chain[])this.scanHead[chain]=Number(saved.heads?.[chain]||0);for(const pair of saved.walletBuys||[])if(Array.isArray(pair)&&typeof pair[0]==='string'&&typeof pair[1]==='string')this.walletBuys.set(pair[0],pair[1]);this.trimCatalog();capMap(this.walletBuys,5000);}catch{}
  // No GMGN web page or signed account is accessed. Reuse the existing feed unchanged.
  const module=await import(pathToFileURL(resolve(workspace,'bsc-observer/chain-feed.mjs')).href);
  this.feed=new module.ChainFeed({proxy:this.proxy,wallets:this.walletLists.bsc,enrich:false});
  this.rpc.bsc.setLogReader(filter=>this.feed.rpc('eth_getLogs',[filter]));
  this.rpc.bsc.setBlockReceiptReader(block=>readBscBlockReceipts(this.running&&[...this.feed.subscriptions.values()].includes('heads')?this.feed.ws:undefined,block));
  this.feed.on('status',(s:any)=>{if(!this.running)return;this.attachFeedSocket();const block=Number(s.lastBlock||0);if(Number(s.reconnects||0)>this.status.bsc.reconnects)this.needsRecovery.bsc=true;Object.assign(this.status.bsc,{reconnects:s.reconnects||0,gaps:Math.max(this.status.bsc.gaps,s.gaps||0),lastError:s.lastError||'',connected:s.connection==='在线'});if(block&&block!==this.status.bsc.head)this.head('bsc',block,Number(s.chainTime||0)*1000);});
  this.feed.on('event',(e:any)=>{this.emitQueue=this.emitQueue.then(()=>this.bscEvent(e)).catch(err=>this.audit('BSC 事件处理失败',{reason:String(err.message).slice(0,200)}));});
  void this.feed.start().catch((e:any)=>this.audit('BSC 连接失败',{reason:e.message}));
  void this.maintenance();
  for(const chain of ['bsc','robinhood'] as Chain[]){void this.readHead(chain);this.timers.push(setInterval(()=>{if(this.running&&this.generation===generation)void this.readHead(chain);},2000));void this.poll(chain);this.timers.push(setInterval(()=>{if(this.running&&this.generation===generation)void this.poll(chain);},chain==='robinhood'?6000:2000));this.timers.push(setInterval(()=>{if(this.running)void this.priceLoop(chain);},5000));}
  this.timers.push(setInterval(()=>{if(this.running)void this.maintenance();},30000));this.timers.push(setInterval(()=>{if(this.running)void this.persist();},5000));this.timers.push(setInterval(()=>this.chartHistoryLoop(),1000));
 }
 private attachFeedSocket(){const socket=this.feed?.ws;if(!socket||socket===this.attachedSocket)return;this.attachedSocket=socket;this.bscHeaders.invalidate();socket.addEventListener('message',(event:any)=>{if(!this.running||socket!==this.feed.ws)return;try{const msg=JSON.parse(String(event.data));if(msg.method!=='eth_subscription')return;const log=msg.params.result,kind=this.feed.subscriptions.get(msg.params.subscription);if(kind==='heads')this.bscHeaders.observe(log);if(log.transactionHash&&!this.observedReceiveTimes.has(log.transactionHash)){this.observedReceiveTimes.set(log.transactionHash,Date.now());capMap(this.observedReceiveTimes,3000);}if(kind==='logs'&&TRADE_TOPICS.includes(log.topics?.[0])){this.queueLiveLog(log,false,()=>this.tradeLog('bsc',log,false),'bsc');void this.gas.bsc.observe(log.transactionHash,log.address?.toLowerCase()===FLAP?'flap':'four').catch(()=>{});}if(kind==='walletTransfers'&&!log.removed)this.queueWalletReceipt(log.transactionHash,false);}catch{}});}
 private queueWalletReceipt(tx:string,replayed:boolean){if(this.walletReceiptSeen.has(tx))return;this.walletReceiptSeen.set(tx,true);capMap(this.walletReceiptSeen,2000);this.watchedTransactions.set(tx,true);capMap(this.watchedTransactions,2000);if(this.walletReceiptQueue.length>=64){this.audit('钱包回执队列达到上限，跳过旧信号',{tx});return;}this.walletReceiptQueue.push({tx,replayed});void this.walletReceipts();}
 private async walletReceipts(){if(this.walletReceiptBusy)return;this.walletReceiptBusy=true;try{while(this.walletReceiptQueue.length&&this.running){const job=this.walletReceiptQueue.shift()!;await this.rpc.bsc.withPriority(async()=>{let pending=this.receipts.get(job.tx);if(!pending){pending=this.rpc.bsc.receipt(job.tx);this.receipts.set(job.tx,pending);capMap(this.receipts,1500);}const receipt=await pending;if(!receipt||receipt.status!=='0x1'||!this.walletLists.bsc.some(w=>w.address===receipt.from.toLowerCase()))return;const logs=receipt.logs.filter((l:any)=>TRADE_TOPICS.includes(l.topics[0]));
   for(const log of logs){if(![FLAP,FOUR_MANAGER].includes(log.address.toLowerCase())){try{const block=Number(BigInt(log.blockNumber)),pool=address(log.address);const [t0,t1]=await Promise.all([this.rpc.bsc.read<string>(pool,V2_ABI,'token0',[],block),this.rpc.bsc.read<string>(pool,V2_ABI,'token1',[],block)]);const candidates=[address(t0),address(t1)].filter(t=>t!==CHAIN_CONFIG.bsc.wrapped);const candidate=candidates.find(t=>this.catalog.has(key('bsc',t)))??candidates[0];if(!candidate)continue;const other=candidate===address(t0)?address(t1):address(t0),route=await this.venues.bsc.pool(candidate,other,pool,block);this.routes.set(key('bsc',candidate),{block,route});const market=this.discovered('bsc',candidate,block,0);if(market.decimals===null)market.decimals=await this.venues.bsc.decimals(candidate,block);market.quoteAddress=other;this.queueHydration('bsc',candidate);}catch{continue;}}
    await this.tradeLog('bsc',log,job.replayed);
   }
  }).catch(e=>this.audit('钱包回执核实失败',{reason:e.message}));}}finally{this.walletReceiptBusy=false;}}
 private head(chain:Chain,block:number,time:number){const s=this.status[chain];if(block<s.head)return;s.head=block;s.headAt=Date.now();s.chainTime=time||s.chainTime;if(time>0){this.headTimes[chain].set(block,time);capMap(this.headTimes[chain],256);}s.connected=true;s.lastError='';this.headMono[chain]=performance.now();for(const m of this.catalog.values())if(m.chain===chain&&m.metadata?.rawCreatedAt)this.createdTime(m,Number(m.metadata.rawCreatedAt));this.publish({id:`head:${chain}:${block}`,chain,kind:'head',block,at:s.chainTime,receivedAt:Date.now(),payload:{source:s.source}});}
 private async readHead(chain:Chain){if(this.headBusy[chain]||!this.running)return;this.headBusy[chain]=true;try{const b=await this.rpc[chain].block(undefined,true);if(!this.running)return;this.rawHeads[chain]=b;const previousHash=this.hashes[chain].get(b.number-1),sameHash=this.hashes[chain].get(b.number);if((previousHash&&previousHash!==b.parentHash)||(sameHash&&sameHash!==b.hash)){const canonical=await this.rpc[chain].block(b.number,true,true);if(canonical.hash===b.hash)await this.reorg(chain,Math.max(0,b.number-2));}this.hashes[chain].set(b.number,b.hash);capMap(this.hashes[chain],64);if(b.number>this.status[chain].head||!this.headMono[chain])this.head(chain,b.number,b.time);}catch(e:any){if(performance.now()-this.headMono[chain]>15000)this.needsRecovery[chain]=true;this.status[chain].lastError=String(e.message).slice(0,240);}finally{this.headBusy[chain]=false;}}
 private async poll(chain:Chain){if(this.busy[chain]||!this.running)return;this.busy[chain]=true;let range:{from:number;to:number}|undefined;
  try {const b=this.rawHeads[chain];if(!b)return;const old=this.status[chain].head;const previousHash=this.hashes[chain].get(b.number-1);const sameHash=this.hashes[chain].get(b.number);
   // A head response can be older than a concurrently delivered WS head.
   // Canonical hash checks belong to the independent readHead loop.
   this.hashes[chain].set(b.number,b.hash);capMap(this.hashes[chain],64);
   // A successful HTTP response for an unchanged block must not refresh freshness.
   // Head freshness is owned exclusively by readHead/WS, never by scanning.
   const scanned=this.scanHead[chain],startup=!scanned,limit=chain==='robinhood'?256:64,gap=scanned>0&&b.number-scanned>limit;
   if(gap){this.status[chain].gaps++;this.publish({id:`gap:${chain}:${scanned}:${b.number}`,chain,kind:'gap',block:b.number,at:b.time,receivedAt:Date.now(),replayed:true,payload:{from:scanned,to:b.number,reason:`缺口超过 ${limit} 区块，仅回放最近区块，期间交易状态未知`}});}
   if(!startup&&b.number<=scanned)return;
   const from=Math.max(0,startup?b.number-20:Math.max(scanned-1,b.number-limit));range={from,to:b.number};await this.scan(chain,from,b.number,startup||gap||this.needsRecovery[chain]);this.scanHead[chain]=b.number;this.needsRecovery[chain]=false;this.scanErrors[chain]='';
  }catch(e:any){const reason=String(e.message).slice(0,220),changed=reason!==this.scanErrors[chain];this.scanErrors[chain]=reason;this.status[chain].lastError='行情扫描：'+reason;const now=performance.now();if(changed||now-this.scanErrorAuditMono[chain]>=30000){this.scanErrorAuditMono[chain]=now;this.audit('行情扫描读取失败',{chain,...range,reason});}}
  finally{this.busy[chain]=false;}
 }
 private async priceLoop(chain:Chain){if(this.priceBusy[chain]||!this.running||!this.status[chain].head)return;this.priceBusy[chain]=true;try{const active=priceRefreshTargets([...this.catalog.values()],chain,this.visibleTokens.get(chain),this.tradePriceDemand,performance.now());await Promise.allSettled(active.map(m=>this.refresh(m,this.status[chain].head)));}finally{this.priceBusy[chain]=false;}}
 private async reorg(chain:Chain,from:number){this.quoteRevision[chain]++;this.candleRevision[chain]++;this.tradeQuoteReferences[chain].invalidate();if(chain==='bsc')this.bscHeaders.invalidate(from);for(const k of [...this.candleRows.keys()])if(k.startsWith(chain+':'))this.candleRows.delete(k);for(const k of [...this.historyRows.keys()])if(k.startsWith(chain+':'))this.historyRows.delete(k);this.routes.clear();this.rpc[chain].clearCache();this.venues[chain].invalidate();this.gas[chain].invalidate(from);for(const block of this.headTimes[chain].keys())if(block>=from)this.headTimes[chain].delete(block);for(const [k,p] of this.buyPreviews)if(k.startsWith(chain+':')&&p.block>=from)this.buyPreviews.delete(k);this.scanHead[chain]=Math.max(0,from-1);for(const [id,e] of [...this.seen])if(e.chain===chain&&e.block>=from&&e.kind!=='head'){this.publish({...e,kind:'removed',receivedAt:Date.now(),payload:{...e.payload,reason:'区块重组',removedEventId:e.id}});}
  for(const k of this.lastLocalCandleAt.keys())if(k.startsWith(chain+':'))this.lastLocalCandleAt.delete(k);for(const [k,id] of this.walletBuys)if(!this.seen.has(id))this.walletBuys.delete(k);this.receipts.clear();for(const m of this.catalog.values())if(m.chain===chain){this.scannerInvalidated(m,from);m.quality='unavailable';m.reason='区块重组，等待重新核实';}this.audit('检测到链重组',{chain,from});}
 private async scan(chain:Chain,from:number,to:number,replayed:boolean){return this.rpc[chain].withPriority(()=>this.scanLogs(chain,from,to,replayed));}
 private async scanLogs(chain:Chain,from:number,to:number,replayed:boolean){
  if(chain==='robinhood')return this.scanRobinhoodLogs(from,to,replayed);
  const addresses=[...new Set(this.chartRoutes(chain).flatMap(r=>r.curve?[r.curve]:r.pool?[r.pool]:[]))].filter(a=>![FLAP,FOUR_MANAGER].includes(a)).slice(0,100),range={fromBlock:hexBlock(from),toBlock:hexBlock(to)},chunks=[];
  // The public BSC node rejects the previous 19-address request even though
  // each identical filter succeeds in groups of 8, 8 and 3. Keep every pool
  // and the same block range; only partition the request's address list.
  for(let i=0;i<addresses.length;i+=8)chunks.push(addresses.slice(i,i+8));
  // Advance the BSC log cursor without waiting for every receipt. Fresh WS
  // events enter the same bounded proof queue and overtake queued history.
  const [creations,pools]=await Promise.all([
   this.rpc[chain].logs({...range,address:[FLAP,FOUR_MANAGER],topics:[[...TRADE_TOPICS,getEventSelector('LaunchedToDEX(address,address,uint256,uint256)')]]}),
   Promise.all(chunks.map(address=>this.rpc[chain].logs({...range,address,topics:[TRADE_TOPICS]}))),
  ]);
  if(this.stopped)return;
  for(const log of creations){try{
   if(TRADE_TOPICS.includes(log.topics[0]))this.queueLiveLog(log,replayed,()=>this.tradeLog(chain,log,replayed),chain);else if(log.topics[0]===getEventSelector('LaunchedToDEX(address,address,uint256,uint256)')){const d:any=decodeEventLog({abi:EVENTS,data:log.data,topics:log.topics});this.graduation(chain,d.args.token,Number(BigInt(log.blockNumber)));}
  }catch(e:any){this.audit('链上事件未解析',{chain,topic:log.topics[0],reason:e.message?.slice(0,120)});}}
  for(const log of pools.flat())this.queueLiveLog(log,replayed,()=>this.tradeLog(chain,log,replayed),chain);
 }
 private async scanRobinhoodLogs(from:number,to:number,replayed:boolean){
  const rpc=this.rpc.robinhood,range={fromBlock:hexBlock(from),toBlock:hexBlock(to)},owners=this.walletLists.robinhood.map(w=>'0x'+w.address.slice(2).padStart(64,'0'));
  const selected=this.chartRoutes('robinhood').filter(r=>r.state?.platform!=='pons-v1'),addresses=[...new Set(selected.flatMap(r=>r.curve?[r.curve]:r.pool?[r.pool]:[]))].slice(0,100),ids=selected.filter(r=>r.key).map(r=>poolId(r.key!));
  const chunks=[];for(let i=0;i<addresses.length;i+=20)chunks.push(addresses.slice(i,i+20));
  // Independent log reads share the same bounded foreground budget. Waiting
  // sequentially behind every historical proof made this cursor fall behind.
  const [transfers,creations,pools,v4]=await Promise.all([
   Promise.all(owners.length?[[TRANSFER,owners],[TRANSFER,null,owners]].map(topics=>rpc.logs({...range,topics})):[]),
   rpc.logs({...range,address:[PONS_V2]}),
   Promise.all(chunks.map(addresses=>rpc.logs({...range,address:addresses,topics:[TRADE_TOPICS]}))),
   ids.length?rpc.logs({...range,address:CHAIN_CONFIG.robinhood.v4Manager,topics:[getEventSelector('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),ids]}):Promise.resolve([]),
  ]);
  if(this.stopped)return;
  for(const log of transfers.flat())this.watchedTransactions.set(log.transactionHash,true);capMap(this.watchedTransactions,2000);
  for(const log of creations){try{const decoded:any=decodeEventLog({abi:EVENTS,data:log.data,topics:log.topics});
   if(decoded.eventName==='TokenLaunched')this.queueLiveLog(log,replayed,()=>this.creation('robinhood',decoded.args.token,Number(BigInt(log.blockNumber)),log,decoded.args,replayed));
   else if(decoded.eventName==='PoolGraduated')this.graduation('robinhood',decoded.args.token,Number(BigInt(log.blockNumber)));
   else this.queueLiveLog(log,replayed,()=>this.tradeLog('robinhood',log,replayed));
  }catch(e:any){this.audit('Robinhood 工厂事件未解析',{topic:log.topics[0],reason:e.message});}}
  for(const log of [...pools.flat(),...v4])this.queueLiveLog(log,replayed,()=>this.tradeLog('robinhood',log,replayed));
 }
 private queueLiveLog(log:any,replayed:boolean,work:()=>Promise<void>,chain:Chain='robinhood'){
  const id=`${chain}:${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
  // The factory subscription covers the whole chain. tradeLog already ignores
  // tokens outside this catalog; reject those before they can evict useful
  // receipt work. Wallet transfers have their own receipt path, and watched
  // transactions, creation logs and removed logs must still be processed.
  const watched=this.watchedTransactions.has(log.transactionHash);
  if(!log.removed&&!watched){
   if(this.seen.has(id))return;
   try{
    const decoded:any=decodeEventLog({abi:EVENTS,data:log.data,topics:log.topics});
    if(['TokenBought','TokenSold','TokenPurchase','TokenSale'].includes(decoded.eventName)&&!this.catalog.has(key(chain,decoded.args.token)))return;
    if(['CurveBuy','CurveSell'].includes(decoded.eventName)&&!this.chartRoutes(chain).some(r=>r.curve===log.address.toLowerCase()&&this.catalog.has(key(chain,r.token))))return;
    if(decoded.eventName==='Swap'&&!this.chartRoutes(chain).some(r=>(r.pool===log.address.toLowerCase()||r.key&&poolId(r.key)===decoded.args.id)&&this.catalog.has(key(chain,r.token))))return;
   }catch{/* Keep unknown/malformed ABI records on the existing audited path. */}
  }
  const revision=this.quoteRevision[chain];
  if(!this.observedReceiveTimes.has(log.transactionHash)){this.observedReceiveTimes.set(log.transactionHash,Date.now());capMap(this.observedReceiveTimes,3000);}
  const queue=chain==='bsc'?this.bscWork:this.liveWork;
  queue.add({id,replayed,run:async()=>{if(!this.running||this.stopped||revision!==this.quoteRevision[chain])return;await this.rpc[chain].withProofBudget(work,replayed);}});
 }
 private async creation(chain:Chain,token:string,block:number,log:any,payload:any,replayed:boolean){const id=`${chain}:${log.blockHash}:${log.transactionHash}:${log.logIndex}`;if(this.seen.has(id))return;const b=await this.rpc[chain].block(block);this.publish({id,chain,kind:'created',block,at:b.time,receivedAt:Date.now(),token:address(token),replayed,payload});const m=this.discovered(chain,token,block,b.time);m.metadata={...m.metadata,creationTransaction:log.transactionHash};this.scanner(m,{event:{stage:'new',block,rawAt:b.time,source:'protocol-creation-log'}});this.queueResolve(chain,token);}
 private async bscEvent(e:any){if(!this.running)return;const block=e.block||this.status.bsc.head;const id='bsc:'+e.key;if(e.kind==='removed'){this.routes.clear();for(const m of this.catalog.values())if(m.chain==='bsc')this.scannerInvalidated(m,block);this.publish({id,chain:'bsc',kind:'removed',block,at:Date.now(),receivedAt:Date.now(),token:e.token,replayed:e.replayed,payload:{removedEventId:id}});return;}
  if(e.kind==='buy'||e.kind==='sell')void this.gas.bsc.observe(e.transactionHash,e.platform==='flap'?'flap':'four').catch(()=>{});
  if(e.kind==='created'){const rawAt=(e.chainTimestamp||e.launchTime)*1000||this.status.bsc.chainTime;this.publish({id,chain:'bsc',kind:'created',block,at:rawAt,receivedAt:Date.now(),token:e.token,replayed:e.replayed,payload:e});const m=this.discovered('bsc',e.token,block,rawAt);m.name=e.name;m.symbol=e.symbol;this.scanner(m,{event:{stage:'new',block,rawAt,source:'protocol-creation-log'}});this.queueResolve('bsc',e.token);}
  else if(e.kind==='graduated')this.graduation('bsc',e.token,block,Number(e.chainTimestamp||0)*1000);
  else if((e.kind==='buy'||e.kind==='sell')&&e.attribution){this.watchedTransactions.set(e.transactionHash,true);capMap(this.watchedTransactions,2000);const receipt=await this.rpc.bsc.receipt(e.transactionHash);if(receipt)for(const log of receipt.logs)if(TRADE_TOPICS.includes(log.topics[0]))await this.tradeLog('bsc',log,!!e.replayed);}
 }
 private async tradeLog(chain:Chain,log:any,replayed:boolean){
  const revision=this.quoteRevision[chain];
  const id=`${chain}:${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
  if(log.removed){await this.reorg(chain,Number(BigInt(log.blockNumber)));return;}
  const duplicate=this.seen.has(id);if(duplicate&&!this.watchedTransactions.has(log.transactionHash))return;
  const d:any=decodeEventLog({abi:EVENTS,data:log.data,topics:log.topics}),a=d.args;let token:string|undefined=a.token,side:'buy'|'sell',tokenRaw:bigint,quoteRaw:bigint;
  if(d.eventName==='CurveBuy'||d.eventName==='CurveSell'){const r=this.chartRoutes(chain).find(r=>r.curve===log.address.toLowerCase());if(!r)return;token=r.token;side=d.eventName==='CurveBuy'?'buy':'sell';tokenRaw=BigInt(a.tokensOut??a.tokensIn);quoteRaw=BigInt(a.quoteIn??a.quoteOut);}
  else if(d.eventName==='Swap'){const r=this.chartRoutes(chain).find(r=>r.pool===log.address.toLowerCase()||(r.key&&poolId(r.key)===a.id));if(!r)return;token=r.token;let token0:boolean;if(r.key)token0=r.key.currency0===r.token;else token0=await this.venues[chain].poolToken0(r,Number(BigInt(log.blockNumber)))===r.token;
   let ta=a.amount0In!==undefined?BigInt(token0?a.amount0In:a.amount1In)-BigInt(token0?a.amount0Out:a.amount1Out):BigInt(token0?a.amount0:a.amount1),qa=a.amount0In!==undefined?BigInt(token0?a.amount1In:a.amount0In)-BigInt(token0?a.amount1Out:a.amount0Out):BigInt(token0?a.amount1:a.amount0);if(r.key){ta=-ta;qa=-qa;}side=ta<0n?'buy':'sell';tokenRaw=ta<0n?-ta:ta;quoteRaw=qa<0n?-qa:qa;
  }else if(['TokenBought','TokenSold','TokenPurchase','TokenSale'].includes(d.eventName)){side=['TokenBought','TokenPurchase'].includes(d.eventName)?'buy':'sell';tokenRaw=BigInt(a.amount);quoteRaw=BigInt(a.eth??a.cost);}else return;
  if(!token||!tokenRaw)return;const block=Number(BigInt(log.blockNumber));let m=this.getMarket(chain,token);if(!m){if(!this.watchedTransactions.has(log.transactionHash))return;try{m=await this.addToken(chain,token,true);}catch{return;}}if(m.decimals===null)m.decimals=await this.venues[chain].decimals(address(token),block).catch(()=>null);
  let receiptPromise=this.receipts.get(log.transactionHash);if(!receiptPromise){receiptPromise=this.rpc[chain].receipt(log.transactionHash,block);this.receipts.set(log.transactionHash,receiptPromise);capMap(this.receipts,1500);receiptPromise.catch(()=>this.receipts.delete(log.transactionHash));}
  const streamed=chain==='bsc'?this.bscHeaders.match(block,log.blockHash):undefined;
  const [b,receipt]=await Promise.all([streamed??this.rpc[chain].block(block),receiptPromise]);let amountUsd:number|undefined,priceUsd:number|undefined;
  let conversionError:string|undefined,quoteReference:QuoteReference|undefined;
  try{if(m.decimals===null)throw new RouteBlocked('DECIMALS_UNKNOWN','交易代币实际精度未核实');const fx=await this.fx(chain),route=this.routes.get(key(chain,token))?.route??await this.route(chain,address(token),block);let quoteNative=1,qDecimals:number;
   if(route.quote===ZERO||route.quote===CHAIN_CONFIG[chain].wrapped)qDecimals=await this.venues[chain].decimals(route.quote,block);
   else{const reference=this.tradeQuoteReferences[chain].read(route.quote,block);if(!reference.value)throw new RouteBlocked('QUOTE_REFERENCE_UNKNOWN',reference.reason!);quoteReference=reference.value;quoteNative=quoteReference.nativePerQuote;qDecimals=quoteReference.quoteDecimals;}
   amountUsd=units(quoteRaw,qDecimals)*quoteNative*fx.usd;priceUsd=amountUsd/units(tokenRaw,m.decimals);
  }catch(e:any){conversionError=String(e.message).slice(0,200);}
  const route=this.routes.get(key(chain,token))?.route;
  if(revision!==this.quoteRevision[chain]||this.stopped)return;
  const verified=!!route&&!!receipt&&(!b.hash||b.hash.toLowerCase()===log.blockHash.toLowerCase())&&receipt.status==='0x1'&&receipt.blockHash?.toLowerCase()===log.blockHash.toLowerCase()&&receipt.logs.some((l:any)=>l.address.toLowerCase()===log.address.toLowerCase()&&l.logIndex===log.logIndex&&l.topics[0]===log.topics[0])&&verifiedProtocolFlow(route,receipt.logs,side,tokenRaw);
  const e:MarketEvent={id,chain,kind:'trade',block,at:b.time,receivedAt:this.observedReceiveTimes.get(log.transactionHash)??Date.now(),token:address(token),side,replayed,priceUsd,amountUsd,payload:{...a,verified,transactionHash:log.transactionHash,blockHash:log.blockHash,tokenRaw:tokenRaw.toString(),quoteRaw:quoteRaw.toString(),quoteCurrency:route?.quote,conversionError,quoteReference,processedAt:Date.now(),priceQuality:'成交数量为链上值；美元换算使用当前真实原生币FX及15秒内已读取、非未来区块的报价币边际参考；具体订单另行按数量报价'}};
  if(!this.seen.has(id)){this.publish(e);if(verified&&priceUsd&&amountUsd)this.tick(chain,address(token),this.localTime(chain,b.time),priceUsd,amountUsd);void this.gas[chain].observe(log.transactionHash,this.routes.get(key(chain,token))?.route.kind).catch(()=>{});}
  const wallets=this.walletLists[chain];if(!wallets.length||!this.watchedTransactions.has(log.transactionHash))return;
  if(!verified||!receipt)return;
  const owner=receipt.from.toLowerCase();if(!wallets.some(w=>w.address===owner))return;
  const flows=receipt.logs.filter((l:any)=>l.address.toLowerCase()===token!.toLowerCase()&&l.topics[0]===TRANSFER&&l.topics.length===3);let delta=0n;
  for(const l of flows){const n=BigInt(l.data);if(l.topics[2].slice(-40).toLowerCase()===owner.slice(2))delta+=n;if(l.topics[1].slice(-40).toLowerCase()===owner.slice(2))delta-=n;}
  if(side==='buy'?delta<=0n:delta>=0n)return;
  const buyKey=key(chain,token)+':'+owner;let firstBuy=false,before:bigint|null=null;
  if(side==='buy'&&!replayed&&!this.walletBuys.has(buyKey)){before=await this.previousTokenBalance(chain,address(token),address(owner),block);if(before===0n){firstBuy=true;this.walletBuys.set(buyKey,id);capMap(this.walletBuys,5000);}}
  this.publish({...e,id:id+':wallet:'+owner,kind:'wallet',wallet:owner,firstBuy,priceUsd:amountUsd!==undefined&&m.decimals!==null?amountUsd/units(delta<0n?-delta:delta,m.decimals):undefined,payload:{...e.payload,verified:true,attribution:'receipt.from + 同币转账净流 + 已核实协议成交',walletTokenDeltaRaw:delta.toString(),balanceBeforeRaw:before?.toString()??null,firstBuyBasis:'本观察周期内首次、前一区块余额为零或代币合约尚未存在；历史读取失败不视为零，不声明终身首次'}});
 }
 private async previousTokenBalance(chain:Chain,token:Address,owner:Address,block:number):Promise<bigint|null>{try{return await this.rpc[chain].read<bigint>(token,ERC20,'balanceOf',[owner],block-1);}catch{const code=await this.rpc[chain].request<string>('eth_getCode',[token,hexBlock(block-1)]).catch(()=>null);return code==='0x'?0n:null;}}
 private tick(chain:Chain,token:string,at:number,price:number,volume:number){const k=key(chain,token),time=Math.floor(at/30000)*30;const rows=this.candleRows.get(k)||[];let c=rows.at(-1);if(c?.time===time){c.high=Math.max(c.high,price);c.low=Math.min(c.low,price);c.close=price;c.volume+=volume;}else rows.push({time,open:price,high:price,low:price,close:price,volume});this.candleRows.set(k,rows.slice(-1000));this.lastLocalCandleAt.set(k,Math.max(at,this.lastLocalCandleAt.get(k)||0));this.tradePriceDemand.set(k,performance.now());capMap(this.tradePriceDemand,300);capMap(this.candleRows,300);capMap(this.lastLocalCandleAt,300);const m=this.catalog.get(k);if(m){m.priceUsd=price;m.updatedAt=Date.now();const route=this.routes.get(k)?.route,verifiedCurve=route&&(route.factory===PONS_V2||route.kind==='pons-v2'||chain==='bsc'&&['flap','four'].includes(route.kind));if(verifiedCurve){m.quality='verified';m.metadata={...m.metadata,route:route.kind};if(chain==='bsc')m.platform=route.kind;m.reason='最近已核实协议成交的参考价格；具体数量与费用仍须实时买卖报价';}}}
 private async maintenance(){if(this.maintenanceBusy||!this.running)return;this.maintenanceBusy=true;
  try{for(const chain of ['bsc','robinhood'] as Chain[]){try{await this.fx(chain,true);}catch(e:any){this.audit('原生币美元价格不可用',{chain,reason:e.message});}}
   for(const chain of ['bsc','robinhood'] as Chain[]){if(!this.running)return;try{this.seedMarkets(chain,unwrap(await this.gmgn.seeds(chain)));}catch(e:any){this.audit('GMGN 种子发现不可用',{chain,reason:e.message});}}
  }finally{this.maintenanceBusy=false;}
 }
 private seedMarkets(chain:Chain,data:any){const observedAt=Date.now();for(const [bucket,rows] of Object.entries(data||{})){if(!Array.isArray(rows))continue;for(const item of rows.filter(x=>{if(!x||typeof x!=='object'||x.chain&&x.chain!==chain)return false;const p=String(x.launchpad_platform||'').toLowerCase();return chain==='bsc'?/flap|fourmeme|pool_pancake/.test(p):/pons|pool_uniswap/.test(p);}).slice(0,5)){const seed=scannerSeed(bucket,item,observedAt);if(!seed||!/^0x[0-9a-f]{40}$/i.test(String(item.address)))continue;const known=this.catalog.get(key(chain,item.address));const m=this.discovered(chain,item.address,this.status[chain].head,known?.metadata?.rawCreatedAt?0:seed.rawCreatedAt||0);m.symbol=String(item.symbol||m.symbol);m.name=String(item.name||m.name);if((!m.platform||m.platform==='待核实')&&typeof item.launchpad_platform==='string')m.platform=item.launchpad_platform;this.scanner(m,{seed});this.queueResolve(chain,item.address);}}}
 private discovered(chain:Chain,token:string,block:number,rawAt:number){token=address(token);const k=key(chain,token);let m=this.catalog.get(k);if(!m){m={id:k,chain,address:token,name:token.slice(0,10),symbol:token.slice(0,10),platform:'待核实',stage:'unknown',createdAt:0,priceUsd:null,nativeUsd:this.nativeFx.get(chain)?.usd??null,quoteAddress:ZERO,decimals:null,liquidityUsd:null,volumeUsd:null,buyTaxPct:null,sellTaxPct:null,updatedAt:Date.now(),block,quality:'unavailable',reason:'已发现，后台正在核实路线与报价'};this.catalog.set(k,m);this.trimCatalog();}if(rawAt>0)this.createdTime(m,rawAt);return m;}
 private queueResolve(chain:Chain,token:string){const k=key(chain,token);if(!this.resolveQueue.includes(k)&&!this.inAdds.has(k)){this.resolveQueue.push(k);if(this.resolveQueue.length>24)this.resolveQueue.shift();}void this.resolveNext();}
 private async resolveNext(){if(this.resolving)return;this.resolving=true;try{while(this.resolveQueue.length&&this.running){const k=this.nextVisible(this.resolveQueue)!,[chain,token]=k.split(':') as [Chain,string];await this.addToken(chain,token,true).catch(()=>{});}}finally{this.resolving=false;}}
 private queueHydration(chain:Chain,token:string){const k=key(chain,token);if(this.hydration.length<30&&!this.hydration.includes(k))this.hydration.push(k);void this.hydrate();}
 private async loadMetadata(chain:Chain,token:string){const k=key(chain,token),pending=this.loadingMetadata.get(k);if(pending)return pending;const task=(async()=>{const info=unwrap(await this.gmgn.info(chain,token));if(this.stopped)throw Error('网关已停止');const security=unwrap(await this.gmgn.security(chain,token));if(this.stopped)throw Error('网关已停止');const pool=unwrap(await this.gmgn.pool(chain,token));const result={info,security,pool,at:Date.now()};this.metadata.set(k,result);capMap(this.metadata,300);return result;})();this.loadingMetadata.set(k,task);try{return await task;}finally{this.loadingMetadata.delete(k);}}
 private async hydrate(){if(this.hydrating)return;this.hydrating=true;try{while(this.hydration.length&&this.running){const k=this.nextVisible(this.hydration,true)!,[chain,token]=k.split(':') as [Chain,string];try{await this.loadMetadata(chain,token);await this.refreshToken(chain,token,this.status[chain].head);}catch{}}}finally{this.hydrating=false;}}
 private async fx(chain:Chain,force=false){const cached=this.nativeFx.get(chain);if(cached&&!force&&performance.now()-cached.mono<90000)return cached;
  // Foreground must never wait behind the single global CLI metadata queue.
  // Missing/expired FX is a visible admission block, not a guessed dollar rate.
  if(!force&&this.running&&this.rpc[chain].isForeground()){void this.rpc[chain].withBackground(()=>this.fx(chain,true)).catch(e=>this.audit('后台原生币价格刷新失败',{chain,reason:e.message}));throw new RouteBlocked(cached?'FX_STALE':'FX_NOT_READY','原生币美元价格尚未就绪或已过期，后台刷新后再报价');}
  const pending=this.fxPending.get(chain);if(pending)return pending;
  const task=(async()=>{const info=unwrap(await this.gmgn.info(chain,CHAIN_CONFIG[chain].wrapped,{priority:'interactive'}));const usd=Number(info.price?.price);if(!(usd>0)||!Number.isFinite(usd))throw new RouteBlocked('FX_UNKNOWN','没有真实原生币美元价格');const next={usd,at:Date.now(),mono:performance.now()};this.nativeFx.set(chain,next);for(const m of this.catalog.values())if(m.chain===chain)m.nativeUsd=usd;return next;})();this.fxPending.set(chain,task);try{return await task;}finally{this.fxPending.delete(chain);}
 }
 async nativePrice(chain:Chain){return (await this.fx(chain)).usd;}
 async addToken(chain:Chain,token:string,background=false):Promise<Market>{token=address(token);if(!background)this.pinManual(chain,token);const rpc=this.rpc[chain];return background?rpc.withBackground(()=>this.addTokenMarket(chain,token)):rpc.withPriority(()=>this.addTokenMarket(chain,token));}
 private async addTokenMarket(chain:Chain,token:string):Promise<Market>{token=address(token);const k=key(chain,token),known=this.catalog.get(k),knownRoute=this.routes.get(k)?.route;
  // A page selecting an already proved protocol must not join a slow resolver
  // or await display/security hydration. The exact quote still proves current
  // fees, route phase and size; no price/timestamp is invented by this shortcut.
  if(known&&known.decimals!==null&&knownRoute&&(knownRoute.factory===PONS_V2||knownRoute.state?.platform==='pons-v1'))return this.currentMarketFx(known);
  const inflight=this.inAdds.get(k);if(inflight)return this.currentMarketFx(await inflight);
  const task=(async()=>{const b=await this.rpc[chain].block();let m=this.catalog.get(k);if(!m)m=this.discovered(chain,token,b.number,0);if(m.decimals===null){const [decimals,symbol,name]=await Promise.all([this.venues[chain].decimals(address(token),b.number),this.rpc[chain].read<string>(address(token),ERC20,'symbol',[],b.number).catch(()=>m!.symbol),this.rpc[chain].read<string>(address(token),ERC20,'name',[],b.number).catch(()=>m!.name)]);m.decimals=decimals;m.symbol=symbol.slice(0,32);m.name=name.slice(0,160);}await this.refresh(m,b.number);if(!this.routes.get(k)?.route.state||m.quoteAddress!==ZERO&&m.quoteAddress!==CHAIN_CONFIG[chain].wrapped)this.queueHydration(chain,token);return this.currentMarketFx(m);})();this.inAdds.set(k,task);try{return await task;}finally{this.inAdds.delete(k);}
 }
 private async route(chain:Chain,token:Address,block:number){const revision=this.quoteRevision[chain],k=key(chain,token),cached=this.routes.get(k);if(cached?.block===block)return cached.route;
  // This is the first block at which the factory/pool identity was proved,
  // not the most recent price refresh. Advancing it forces RH's slightly
  // older fixed-block quotes to resolve every factory again while heads move.
  if(cached&&['v2','v3','v4'].includes(cached.route.kind)&&block>=cached.block)return cached.route;
  const md=this.metadata.get(k),hint=this.selectedPools.get(k)??md?.info?.biggest_pool_address??md?.pool?.pool_address??md?.pool?.address;const route=await this.venues[chain].resolve(token,block,hint);if(revision!==this.quoteRevision[chain])throw new RouteBlocked('QUOTE_REORG','核实路线期间发生重组');this.routes.set(k,{block,route});capMap(this.routes,300);return route;}
 async selectPool(chain:Chain,token:string,pool:string){const t=address(token),p=address(pool),b=await this.rpc[chain].block();const [t0,t1]=await Promise.all([this.rpc[chain].read<string>(p,V2_ABI,'token0',[],b.number),this.rpc[chain].read<string>(p,V2_ABI,'token1',[],b.number)]);if(address(t0)!==t&&address(t1)!==t)throw new RouteBlocked('POOL_ASSETS_UNKNOWN','指定池不包含该代币');const quote=address(t0)===t?address(t1):address(t0),route=await this.venues[chain].pool(t,quote,p,b.number);this.selectedPools.set(key(chain,t),p);capMap(this.selectedPools,300);this.routes.set(key(chain,t),{block:b.number,route});return this.addToken(chain,t);}
 private async refreshToken(chain:Chain,token:string,block:number){const m=this.getMarket(chain,token);if(m)await this.refresh(m,block);}
 private async refresh(m:Market,block:number){return this.rpc[m.chain].withBackground(()=>this.refreshMarket(m,block));}
 private async refreshMarket(m:Market,block:number){if(!block)return;try{const r=await this.route(m.chain,address(m.address),block);m.platform=String(r.state?.platform||(r.kind==='v3'?(m.chain==='bsc'?'pancake-v3':'uniswap-v3'):r.kind));m.stage=['flap','four','pons-v2'].includes(r.kind)?'curve':'dex';this.scanner(m,{proof:{stage:m.stage as 'curve'|'dex',block,source:r.kind,ready:r.state?.readyToGraduate===true}});m.quoteAddress=r.quote;m.pool=r.pool??(r.key?poolId(r.key):undefined);m.buyTaxPct=Number(r.state?.buyTaxRate??r.state?.creatorTaxBps??0)/100;m.sellTaxPct=Number(r.state?.sellTaxRate??r.state?.creatorTaxBps??0)/100;m.block=block;m.updatedAt=Date.now();m.metadata={...m.metadata,route:r.kind,factory:r.factory,curve:r.curve,poolKey:r.key,ordinaryRecipient:ORDINARY_RECIPIENT};
   const md=this.metadata.get(m.id);if(md){m.liquidityUsd=finite(md.info.liquidity);m.volumeUsd=finite(md.info.price?.volume_24h);if(!m.metadata?.rawCreatedAt&&Number(md.info.creation_timestamp)>0)this.createdTime(m,milliseconds(Number(md.info.creation_timestamp)));}
   if(r.quote!==ZERO&&r.quote!==CHAIN_CONFIG[m.chain].wrapped&&!this.metadata.has(key(m.chain,r.quote)))this.queueHydration(m.chain,r.quote);
   const fx=this.nativeFx.get(m.chain);m.nativeUsd=fx?.usd??null;m.quality='unavailable';m.reason='路线已找到，等待具体金额的报价及费用验证';
   if(fx&&performance.now()-fx.mono<90000){const v=this.venues[m.chain],spot=await v.spot(r,block),qDecimals=await v.decimals(r.quote,block),conversion=await v.conversion(r.quote,block);let quoteUsd=fx.usd;if(conversion){this.verifyExternalTaxes(m.chain,conversion.token,conversion);const cv=await v.quote(conversion,'sell',10n**BigInt(qDecimals),block,this.displayRecipient);quoteUsd=units(cv.out,18)*fx.usd;}
    const price=spot*10**(m.decimals!-qDecimals)*quoteUsd;if(!(price>0)||!Number.isFinite(price))throw new RouteBlocked('PRICE_UNKNOWN','链上价格不可核实');m.priceUsd=price;m.updatedAt=Date.now();m.metadata={...m.metadata,priceSource:'真实链上储备/slot0 的边际价格，具体金额另行报价'};
    this.verifyExternalTaxes(m.chain,m.address,r);if(['v2','v3'].includes(r.kind)&&(BigInt(r.state?.buyTaxRate||0)||BigInt(r.state?.sellTaxRate||0)))throw new RouteBlocked('TRANSFER_TAX_UNVERIFIED','价格已知，外盘转账税清算尚未核实，交易报价阻断');m.quality='verified';m.reason='价格、路线已核实；具体成交必须通过确切数量、费用与 Gas 报价';
   }
  }catch(e:any){if(e instanceof RouteBlocked&&e.code==='PONS_SWEPT'){this.scanner(m,{proof:{stage:'curve',block,source:'pons-v2-phase-1',ready:true}});}m.quality='unavailable';m.reason=String(e.message).slice(0,260);m.block=block;}
  if(this.running)this.publish({id:`market:${m.id}:${block}`,chain:m.chain,kind:'market',block,at:this.status[m.chain].chainTime||Date.now(),receivedAt:Date.now(),token:m.address,payload:{market:{...m}}});
 }
 private verifyExternalTaxes(chain:Chain,token:string,r:Route){if(!['v2','v3'].includes(r.kind)||r.state?.platform)return;const md=this.metadata.get(key(chain,token));if(!md||Date.now()-md.at>120000)throw new RouteBlocked('TAX_UNKNOWN','外盘代币安全及转账税字段尚未核实');const s=md.security;const buy=finite(s.buy_tax),sell=finite(s.sell_tax);if(buy===null||sell===null)throw new RouteBlocked('TAX_UNKNOWN','外盘买卖税字段缺失');if(buy!==0||sell!==0)throw new RouteBlocked('TRANSFER_TAX_UNVERIFIED','该外盘币有转账税，需要进一步验证真实转账路线');if(s.is_honeypot==='yes'||s.is_honeypot===true)throw new RouteBlocked('SELL_BLOCKED','安全数据报告无法卖出');}
 async quote(request:QuoteRequest):Promise<LiveQuote>{if(!['bsc','robinhood'].includes(request.chain))throw new RouteBlocked('CHAIN_UNKNOWN','不支持此链');if(!request.background)this.pinManual(request.chain,request.token);const rpc=this.rpc[request.chain];return request.background?rpc.withBackground(()=>this.quoteLive(request)):rpc.withPriority(()=>this.quoteLive(request));}
 private async quoteLive(request:QuoteRequest):Promise<LiveQuote>{
  const chain=request.chain,revision=this.quoteRevision[chain],token=address(request.token),recipient=address(request.recipient);
  if(recipient===ZERO||Object.values(this.walletLists).flat().some(w=>w.address===recipient))throw new RouteBlocked('SOURCE_RECIPIENT','使用独立虚拟账户地址，不能继承观察钱包的豁免');
  if(request.side!=='buy'&&request.side!=='sell')throw Error('Invalid quote side');if(request.block!==undefined)hexBlock(request.block);
  const status=this.statuses().find(s=>s.chain===chain)!;if(this.running&&!status.connected)throw new RouteBlocked('STALE_HEAD','新区块不新鲜，暂停报价');
  // A confirmed WS head may be ahead of the HTTP poll. Keep its actual time;
  // exact-block eth_call still proves that the requested state is readable.
  const known=this.running&&request.block!==undefined&&request.block<=status.head;
  const rawHead=this.rawHeads[chain],b=known?{number:status.head,time:rawHead?.number===status.head?rawHead.time:status.chainTime}:await this.rpc[chain].block();
  const block=request.block??b.number;if(block>b.number)throw new RouteBlocked('FUTURE_BLOCK','不能引用未来区块');
  let chainTime=this.rpc[chain].knownBlock(block)?.time??this.headTimes[chain].get(block)??(block===b.number?b.time:undefined);
  if(chainTime===undefined)chainTime=(await this.rpc[chain].block(block)).time;
  if(request.block!==undefined&&b.time-chainTime>120000)throw new RouteBlocked('HISTORIC_FX_UNKNOWN','旧区块需使用保存了当时 FX 和 Gas 的快照，不能用当前价格补填');
  const candidate=await this.route(chain,token,block);if(['v2','v3'].includes(candidate.kind)&&!candidate.state?.platform&&(!this.metadata.has(key(chain,token))||Date.now()-this.metadata.get(key(chain,token))!.at>120000))await this.loadMetadata(chain,token);
  const conversion=await this.venues[chain].conversion(candidate.quote,block);if(conversion&&(!this.metadata.has(key(chain,conversion.token))||Date.now()-this.metadata.get(key(chain,conversion.token))!.at>120000))await this.loadMetadata(chain,conversion.token);
  if(this.running&&!this.statuses().find(s=>s.chain===chain)!.connected)throw new RouteBlocked('STALE_HEAD','新区块不新鲜，暂停报价');
  const fx=await this.fx(chain),result=await this.quoteInternal({...request,token,recipient,block},fx);
  if(revision!==this.quoteRevision[chain])throw new RouteBlocked('QUOTE_REORG','报价期间发生区块重组，请重新报价');
  if(this.running){const current=this.statuses().find(s=>s.chain===chain)!;if(!current.connected)throw new RouteBlocked('STALE_HEAD','读取期间新区块已过期');if(current.chainTime-chainTime>15000)throw new RouteBlocked('STALE_QUOTE','读取期间报价区块已过期，等待当前新区块重新报价');}
  return result;
 }
 private async quoteInternal(request:QuoteRequest,fx:{usd:number;at:number;mono:number},gasContext?:GasContext):Promise<LiveQuote>{
  const {chain,side}=request,revision=this.quoteRevision[chain],block=request.block!,token=address(request.token),recipient=address(request.recipient),input=raw(side==='buy'?request.nativeAmountRaw:request.tokenAmountRaw);let r=await this.route(chain,token,block);this.verifyExternalTaxes(chain,token,r);
  const previewKey=key(chain,token)+':'+recipient;const preview=this.buyPreviews.get(previewKey);let counterfactual=false;
  if(side==='sell'&&r.kind==='flap'&&BigInt(r.state!.circulatingSupply)<input&&preview?.block===block&&preview.output>=input){r=preview.route;counterfactual=true;}
  const v=this.venues[chain],decimals=await v.decimals(token,block),quoteDecimals=await v.decimals(r.quote,block),conversion=await v.conversion(r.quote,block);
  if(conversion)this.verifyExternalTaxes(chain,conversion.token,conversion);
  let quoteInput=input,conversionUsd=0,conversionSpot=1,legs=1,notes:string[]=[],conversionImpact=0;
  if(conversion){legs++;const unit=await v.quote(conversion,'sell',10n**BigInt(quoteDecimals),block);conversionSpot=unit.spot*10**(quoteDecimals-18);if(!(conversionSpot>0))throw new RouteBlocked('CONVERSION_UNKNOWN','报价币兑原生币路线无流动性');
   if(side==='buy'){const cv=await v.quote(conversion,'buy',input,block,recipient);quoteInput=cv.out;conversionUsd=units(cv.protocol,18)*fx.usd;conversionImpact+=cv.impactPct??feeExcludedImpact(conversion,'buy',cv);notes.push(...cv.notes);}}
  const core=await v.quote(r,side,quoteInput,block,recipient);let output=core.out,spent=core.spent,refund=core.refund;
  if(side==='buy'&&r.kind==='flap'&&!conversion){const s=r.state!,cs={reserve:s.reserve,supply:s.circulatingSupply,r:s.r,h:s.h,k:s.k,threshold:s.dexSupplyThresh,quoteDecimals,feeBps:BigInt(s.buyFeeBps),taxBps:BigInt(s.buyTaxRate)};const nextSupply=BigInt(s.circulatingSupply)+core.out;this.buyPreviews.set(previewKey,{block,output:core.out,route:{...r,state:{...s,circulatingSupply:nextSupply,reserve:flapReserve(cs,nextSupply),virtualPreview:true}}});capMap(this.buyPreviews,1000);}
  if(conversion){const quoteUsd=conversionSpot*fx.usd;
   if(side==='sell'){const cv=await v.quote(conversion,'sell',core.out,block,recipient);output=cv.out;spent=input;refund=0n;conversionUsd=units(cv.protocol,18)*fx.usd;conversionImpact+=cv.impactPct??feeExcludedImpact(conversion,'sell',cv);notes.push(...cv.notes);}
   else{spent=input;refund=0n;if(core.refund>0n)throw new RouteBlocked('PARTIAL_CONVERSION_UNVERIFIED','跨报价币的部分成交需在转换后的池状态退款；该复合路线尚未逐步核实，拒绝虚构原生币退款');}
   notes.push(`报价币精度 ${quoteDecimals}；已核实池 ${conversion.pool}，美元换算使用实际原生币价格`);
  }
  if(output<=0n||spent<=0n||spent>input||refund<0n)throw new RouteBlocked('ZERO_QUOTE','报价返回零数量或不合法金额');
  const gas=await this.gas[chain].estimate(r,block,side,fx.usd,legs,gasContext);const quoteUsd=(conversion?conversionSpot:1)*fx.usd;
  if(revision!==this.quoteRevision[chain])throw new RouteBlocked('QUOTE_REORG','报价期间发生区块重组，请重新报价');
  const tokenQty=units(side==='buy'?output:input,decimals),nativeQty=units(side==='buy'?spent:output,18),priceUsd=nativeQty*fx.usd/tokenQty;
  const impactPct=(core.impactPct??feeExcludedImpact(r,side,core))+conversionImpact,impactQuality=core.impactQuality==='estimated'||counterfactual?'estimated':'verified';
  return {id:randomUUID(),chain,token,side,block,at:Date.now(),sourceFeeFrozenAt:gas.sourceFeeFrozenAt,inputRaw:input.toString(),outputRaw:output.toString(),spentInputRaw:spent.toString(),refundRaw:refund.toString(),tokenDecimals:decimals,nativeUsd:fx.usd,priceUsd,priceImpactPct:impactPct,impactQuality,fees:{gasUsd:gas.gasUsd,approvalUsd:gas.approvalUsd,protocolUsd:units(core.protocol,quoteDecimals)*quoteUsd,taxUsd:units(core.tax,quoteDecimals)*quoteUsd,conversionUsd,includedInOutput:true,quality:'estimated',notes:[...core.notes,...notes,...gas.notes,`流动性冲击排除已知协议/创作者/反狙击费；多步兑换冲击保守相加，归因 ${impactQuality}`,`原生币美元价格：GMGN ${new Date(fx.at).toISOString()}；模拟收款地址 ${recipient}，不继承目标钱包豁免`]},quality:counterfactual?'estimated':'verified',venue:r.kind,reason:counterfactual?'虚拟买入后即时反向数量预览；不可用于正式研究启用门槛':'按固定区块和确切金额的链上报价；Gas 与费用美元归因估计，费用已含在报价内'};
 }
 async snapshot(chain:Chain,token:string):Promise<Snapshot>{return this.rpc[chain].withBackground(async()=>{const market=await this.addToken(chain,token,true);const fx=await this.fx(chain);const b=await this.rpc[chain].block();const route=await this.route(chain,address(token),b.number);const gasContext=await this.gas[chain].context(route,b.number);return {chain,token:address(token),block:b.number,blockHash:b.hash,chainTime:b.time,capturedAt:Date.now(),gasContext,market:{...market,nativeUsd:fx.usd,metadata:{...market.metadata,fxCapturedAt:fx.at}}};});}
 async reprice(snapshot:Snapshot,request:RepriceRequest){return this.rpc[snapshot.chain].withBackground(async()=>{const b=await this.rpc[snapshot.chain].block(snapshot.block,false,true);if(b.hash!==snapshot.blockHash)throw new RouteBlocked('SNAPSHOT_REORG','研究快照区块已重组');const usd=snapshot.market.nativeUsd;if(!usd||usd<=0)throw new RouteBlocked('FX_UNKNOWN','快照没有真实原生币美元价格');if(!snapshot.gasContext)throw new RouteBlocked('HISTORIC_GAS_UNKNOWN','快照未保存当时 Gas 数据，不能用未来费用补填');const recipient=address(request.recipient);if(recipient===ZERO||Object.values(this.walletLists).flat().some(w=>w.address===recipient))throw new RouteBlocked('SOURCE_RECIPIENT','不能用观察钱包作为模拟账户');return this.quoteInternal({...request,chain:snapshot.chain,token:snapshot.token,recipient,block:snapshot.block},{usd,at:snapshot.capturedAt,mono:performance.now()},snapshot.gasContext);});}
 private cachedCandleData(chain:Chain,token:string){const k=key(chain,token),history=this.historyRows.get(k),local=this.candleRows.get(k)||[],map=new Map((history?.rows||[]).map(c=>[c.time,{...c}]));for(const c of local)if(!map.has(c.time))map.set(c.time,{...c});const rows=[...map.values()].sort((a,b)=>a.time-b.time).slice(-1000),newest=local.reduce<Candle|undefined>((last,c)=>!last||c.time>last.time?c:last,undefined);let partialLocalBar=false;
  // Only the most recent real local bar may supersede the historical bar when
  // it contains trades after the requested history end. Never add the two
  // volumes: the provider and collector can contain the same transactions.
  if(newest&&newest.time===rows.at(-1)?.time&&(this.lastLocalCandleAt.get(k)||0)>(history?.untilAt??history?.at??0)){const index=rows.findIndex(c=>c.time===newest.time);if(index>=0)rows[index]={...newest};partialLocalBar=true;}
  return {rows,partialLocalBar};}
 cachedCandles(chain:Chain,token:string):Candle[]{return this.cachedCandleData(chain,address(token)).rows;}
 candleStatus(chain:Chain,token:string):CandleStatus {token=address(token);const k=key(chain,token),history=this.historyRows.get(k),local=this.candleRows.get(k),pending=this.historyPending.has(k)&&!this.stopped,data=this.cachedCandleData(chain,token),rows=data.rows.length,error=this.historyAttempts.get(k)?.reason,source:CandleStatus['source']=history?.rows.length?local?.length?'mixed':'gmgn':local?.length?'verified-local':'none';
  return {source,rows,pending,state:this.stopped?'stopped':rows?'ready':pending?'loading':error?'error':'empty',historyAt:history?.at??null,reason:this.stopped?'服务已停止，显示最后已取得的数据':pending?rows?'显示已取得的真实K线，历史数据正在优先补充':'历史K线正在优先排队/读取；当前没有已采集的可核实成交':error?`历史K线暂不可用：${error}${rows?'；显示已取得的数据':''}`:data.partialLocalBar?'末根包含新采集的已核实成交，成交量仅为本机已采集部分；不补造缺口':rows?'真实历史K线或已核实成交；未覆盖时段不补造':history?'历史服务未返回K线，当前也未采集到可核实成交':'尚未取得历史K线或可核实成交'};
 }
 private requestHistory(chain:Chain,token:string):Promise<void>|undefined {const k=key(chain,token),pending=this.historyPending.get(k);if(pending)return pending;if(this.stopped)return;const cached=this.historyRows.get(k),attempt=this.historyAttempts.get(k),now=performance.now();if(cached&&now-cached.mono<15000||attempt?.reason&&now-attempt.mono<15000)return;
  const revision=this.candleRevision[chain],untilAt=this.status[chain].headAt||Date.now();this.historyAttempts.set(k,{mono:now});capMap(this.historyAttempts,100);
  const task=(async()=>{try{const raw=await this.gmgn.candles(chain,token,this.status[chain].chainTime,{timeoutMs:45000});if(this.stopped||revision!==this.candleRevision[chain])return;const h=this.status[chain],rows=raw.map(c=>({...c,time:h.chainTime&&h.headAt?Math.floor(this.localTime(chain,c.time*1000)/1000):c.time}));this.historyRows.set(k,{rows,at:Date.now(),mono:performance.now(),untilAt});capMap(this.historyRows,100);}catch(e:any){if(!this.stopped){this.historyAttempts.set(k,{mono:performance.now(),reason:String(e.message).slice(0,200)});capMap(this.historyAttempts,100);this.audit('K线历史数据不可用',{chain,token,reason:e.message});}}})();this.historyPending.set(k,task);void task.finally(()=>{if(this.historyPending.get(k)===task)this.historyPending.delete(k);});return task;
 }
 async candles(chain:Chain,token:string):Promise<Candle[]>{token=address(token);if(this.visibleTokens.get(chain)===token)this.chartDemand.set(chain,performance.now());const pending=this.requestHistory(chain,token),available=this.cachedCandles(chain,token);if(available.length||!pending)return available;let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([pending,new Promise<void>(resolve=>{timer=setTimeout(resolve,1500);})]);}finally{if(timer)clearTimeout(timer);}return this.cachedCandles(chain,token);}
 private async persist(){if(this.persistenceBusy)return;this.persistenceBusy=true;try{const path=resolve(this.dataDir,'gateway-catalog.json');await writeFile(path+'.tmp',safeJson({version:2,heads:this.scanHead,manualPins:{bsc:[...this.manualPins.bsc.keys()],robinhood:[...this.manualPins.robinhood.keys()]},walletBuys:[...this.walletBuys],markets:[...this.catalog.values()].map(m=>({...m,metadata:{...m.metadata}}))}));await rename(path+'.tmp',path);}finally{this.persistenceBusy=false;}}
 async stop(){this.stopped=true;this.liveWork.close();this.bscWork.close();this.gmgn.close();for(const refs of Object.values(this.tradeQuoteReferences))refs.close();if(!this.running){await Promise.allSettled(Object.values(this.rpc).map(r=>r.close()));return;}this.running=false;this.generation++;for(const timer of this.timers)clearInterval(timer);this.timers=[];await this.feed?.stop();await this.persist();await Promise.allSettled(Object.values(this.rpc).map(r=>r.close()));for(const s of Object.values(this.status)){s.connected=false;s.lastError='已停止';}}
}
function finite(value:unknown):number|null {if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;}
export function verifiedProtocolFlow(route:Route,logs:any[],side:'buy'|'sell',eventTokenRaw:bigint){
 const venues=new Set([route.pool,route.curve,...(route.kind==='flap'?[FLAP,ZERO]:route.kind==='four'?[route.factory||FOUR_MANAGER]:route.kind==='v4'?[CHAIN_CONFIG.robinhood.v4Manager]:[])].filter(Boolean).map(x=>x!.toLowerCase()));
 let delta=0n;for(const l of logs){if(l.address.toLowerCase()!==route.token||l.topics?.[0]!==TRANSFER||l.topics.length!==3||!/^0x[0-9a-f]+$/i.test(l.data))continue;const from='0x'+l.topics[1].slice(-40).toLowerCase(),to='0x'+l.topics[2].slice(-40).toLowerCase(),value=BigInt(l.data);if(venues.has(from))delta-=value;if(venues.has(to))delta+=value;}
 const actual=side==='buy'?-delta:delta;
 // For taxed outputs the receiver obtains less, but the aggregate protocol
 // transfer still corresponds to the pool/curve event's quantity.
 return actual>0n&&actual===eventTokenRaw;
}
