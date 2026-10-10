import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {readFileSync,existsSync,writeFileSync,readdirSync,createReadStream,createWriteStream,unlinkSync} from 'node:fs';import {resolve,dirname,sep} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {timingSafeEqual,createHash,randomUUID} from 'node:crypto';import {Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
import {Store,MAX_BACKUP_BYTES} from './store.js';import {Engine} from './engine.js';import {LiveGateway} from './gateway.js';import {validAddress} from './money.js';
import type {Chain,MarketGateway,Account} from '../shared/domain.js';
import type {AppState} from '../shared/domain.js';
import {stateChange} from '../shared/state-stream.js';
import {rpcScheduler} from './adapters/scheduler.js';

export function makeServer(engine:Engine,webRoot:string,port:number){const clients=new Set<ServerResponse>(),candleClients=new Set<ServerResponse>(),draining=new Set<ServerResponse>(),dirty=new Set<ServerResponse>(),sentAt=new Map<ServerResponse,number>(),deltaClients=new Map<ServerResponse,{streamId:string;revision:number;state:AppState}>();let stateRevision=0,broadcastTimer:ReturnType<typeof setTimeout>|undefined,scheduledFor=Infinity,uploadActive=false;
 const stringify=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
 const send=(res:ServerResponse,value:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json;charset=utf-8'});res.end(stringify(value));};
 const snapshot=():AppState=>({...engine.state(),stateRevision:++stateRevision});
 const schedule=(wait:number)=>{const delay=Math.max(0,wait),deadline=performance.now()+delay;if(broadcastTimer&&scheduledFor<=deadline)return;if(broadcastTimer)clearTimeout(broadcastTimer);scheduledFor=deadline;broadcastTimer=setTimeout(()=>{broadcastTimer=undefined;scheduledFor=Infinity;broadcast();},delay);};
 const writeState=(res:ServerResponse,message:string)=>{sentAt.set(res,performance.now());if(!res.write(message)){draining.add(res);res.once('drain',()=>{draining.delete(res);broadcast();});}};
 const broadcast=()=>{const ready=[...dirty].filter(res=>!draining.has(res)&&!res.destroyed);if(!ready.length)return;const now=performance.now(),remaining=(res:ServerResponse)=>(deltaClients.has(res)?1000:2000)-(now-(sentAt.get(res)??-Infinity)),wait=Math.min(...ready.map(remaining));if(wait>0){schedule(wait);return;}if(broadcastTimer){clearTimeout(broadcastTimer);broadcastTimer=undefined;scheduledFor=Infinity;}const next=snapshot();let legacy:string|undefined,deferred=Infinity;
  for(const res of ready){const delay=remaining(res);if(delay>0){deferred=Math.min(deferred,delay);continue;}dirty.delete(res);const prior=deltaClients.get(res);if(!prior){legacy??='data: '+stringify({type:'state',state:next})+'\n\n';writeState(res,legacy);continue;}
   const revision=prior.revision+1,patch=stateChange(prior.state,next);const delta=stringify({type:'state-delta',streamId:prior.streamId,baseRevision:prior.revision,revision,patch}),full=stringify({type:'state-snapshot',streamId:prior.streamId,revision,state:next});
   // write(false) still accepts the entire frame. Advance that client's
   // baseline once; while blocked, skip frames and diff from it on drain.
   prior.state=next;prior.revision=revision;writeState(res,'data: '+(delta.length<full.length*.85?delta:full)+'\n\n');
  }
  if(Number.isFinite(deferred))schedule(deferred);
 };engine.setChanged(()=>{for(const res of clients)dirty.add(res);broadcast();});
 const server=createServer(async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  try{
   if(req.headers.host!==`127.0.0.1:${port}`&&req.headers.host!==`localhost:${port}`){send(res,{error:'仅允许本机访问'},403);return;}
   const url=new URL(req.url??'/',`http://127.0.0.1:${port}`),path=url.pathname;
   if(req.method==='POST'){
    const origin=req.headers.origin;if(origin&&origin!==`http://127.0.0.1:${port}`&&origin!==`http://localhost:${port}`){send(res,{error:'来源不允许'},403);return;}
    const token=req.headers['x-csrf-token'];if(typeof token!=='string'||token.length!==engine.csrf.length||!timingSafeEqual(Buffer.from(token),Buffer.from(engine.csrf))){send(res,{error:'请刷新页面再操作'},403);return;}
    const contentType=req.headers['content-type']?.split(';')[0];if(contentType!=='application/json'&&!(path==='/api/restore'&&['application/vnd.sqlite3','application/octet-stream'].includes(contentType??''))){send(res,{error:'请求格式不支持'},415);return;}
   }else if(req.method!=='GET'){send(res,{error:'不支持该操作'},405);return;}
   if(req.method==='GET'){
    if(path==='/api/state'){send(res,snapshot());return;}
    if(path==='/api/strategies'){send(res,{strategies:engine.broker.strategies(),diagnostics:engine.diagnostics()});return;}
    if(path==='/api/research/runs'){send(res,{runs:engine.researchRuns()});return;}
    if(path==='/api/health'){send(res,{app:'paper-terminal',mode:'paper',status:'running',at:Date.now(),runtimeId:engine.runtimeId,codeHash:engine.codeHash,chains:engine.gateway.statuses(),rpcQueue:rpcScheduler.stats(),ledger:engine.broker.checks(),soak:engine.store.meta('soak')});return;}
    if(path==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});clients.add(res);const state=snapshot(),delta=url.searchParams.get('delta')==='1';if(delta){const streamId=randomUUID();deltaClients.set(res,{streamId,revision:0,state});writeState(res,'data: '+stringify({type:'state-snapshot',streamId,revision:0,state})+'\n\n');}else writeState(res,'data: '+stringify({type:'state',state})+'\n\n');const heartbeat=setInterval(()=>{if(!draining.has(res)&&!res.destroyed)res.write(': heartbeat\n\n');},15000);req.on('close',()=>{clients.delete(res);deltaClients.delete(res);dirty.delete(res);sentAt.delete(res);draining.delete(res);clearInterval(heartbeat);});return;}
    if(path==='/api/candles/events'){
     const chain=readChain(url.searchParams.get('chain')),token=validAddress(url.searchParams.get('token'));res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});candleClients.add(res);void engine.gateway.candles(chain,token).catch(()=>{});
     let prior='',firstTime:number|undefined,historyAt:unknown,priorRows=0,initial=true,waiting=false;
     const push=()=>{if(res.destroyed||waiting)return;const candles=engine.gateway.cachedCandles?.(chain,token)??[],status=engine.gateway.candleStatus?.(chain,token) as ({historyAt?:number}&Record<string,unknown>)|undefined,tail=candles.slice(-2),fingerprint=stringify({status,first:candles[0]?.time,length:candles.length,tail});if(fingerprint===prior)return;
      const full=initial||historyAt!==status?.historyAt||candles.length<priorRows||firstTime!==candles[0]?.time;prior=fingerprint;initial=false;historyAt=status?.historyAt;firstTime=candles[0]?.time;priorRows=candles.length;
      if(!res.write('data: '+stringify({type:'candles',chain,token,at:Date.now(),full,candles:full?candles:tail,...status})+'\n\n')){waiting=true;res.once('drain',()=>{waiting=false;push();});}
     };push();const ticker=setInterval(push,250),heartbeat=setInterval(()=>{if(!waiting&&!res.destroyed)res.write(': heartbeat\n\n');},15000);req.on('close',()=>{clearInterval(ticker);clearInterval(heartbeat);candleClients.delete(res);});return;
    }
    if(path==='/api/candles'){const chain=readChain(url.searchParams.get('chain')),token=validAddress(url.searchParams.get('token'));const candles=await engine.gateway.candles(chain,token);send(res,{candles,...engine.gateway.candleStatus?.(chain,token)});return;}
    if(path==='/api/paper/quote'){if(req.headers['x-csrf-token']!==engine.csrf)throw Error('报价查询需要当前本机页面标识');const chain=readChain(url.searchParams.get('chain')),token=validAddress(url.searchParams.get('token')),side=url.searchParams.get('side');if(side!=='buy'&&side!=='sell')throw Error('报价方向无效');const recipient=validAddress(url.searchParams.get('recipient')??engine.broker.recipient('manual-'+chain));const blockValue=url.searchParams.get('block'),block=blockValue===null?engine.broker.fresh(chain).head:Number(blockValue);if(!Number.isSafeInteger(block)||block<=0)throw Error('区块无效');send(res,{quote:await engine.broker.getQuote('quote-preview-'+chain,{chain,token,side,recipient,block,...(side==='buy'?{nativeAmountRaw:url.searchParams.get('nativeAmountRaw')??undefined}:{tokenAmountRaw:url.searchParams.get('tokenAmountRaw')??undefined})})});return;}
    if(path==='/api/research/grid'){const {exitGrid,legacyBaseline}=await import('./research.js');send(res,{short:exitGrid('short'),swing:exitGrid('swing'),baseline:legacyBaseline()});return;}
    if(path.startsWith('/api/research/runs/')){const id=path.slice('/api/research/runs/'.length);send(res,{run:engine.researchRuns().find(r=>r.id===id),details:engine.store.meta('researchDetails:'+id)??engine.store.evidence('training').find(r=>r.run?.id===id),forward:engine.store.meta('forwardResult:'+id)??engine.store.evidence('forward').find(r=>r.testWindow?.runId===id)});return;}
    if(path==='/api/export'){const kind=url.searchParams.get('kind')??'fills';const rows=kind==='orders'?engine.broker.orders():kind==='positions'?engine.broker.positions():engine.broker.fills();const fields=[...new Set(rows.flatMap(r=>Object.keys(r)))];const csv='\ufeff'+fields.map(csvCell).join(',')+'\r\n'+rows.map(row=>fields.map(f=>csvCell((row as unknown as Record<string,unknown>)[f])).join(',')).join('\r\n');res.writeHead(200,{'Content-Type':'text/csv;charset=utf-8','Content-Disposition':`attachment; filename="paper-${kind}.csv"`});res.end(csv);return;}
    if(path.startsWith('/api/')){send(res,{error:'此终端只提供行情和虚拟交易接口'},404);return;}
    const relative=path==='/'?'index.html':decodeURIComponent(path).replace(/^\/+/,''),file=resolve(webRoot,relative);if(!file.startsWith(resolve(webRoot)+sep)||!existsSync(file)||relative.includes('..')){send(res,{error:'页面不存在'},404);return;}const type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream';res.writeHead(200,{'Content-Type':type+';charset=utf-8'});res.end(readFileSync(file));return;
   }
   if(path==='/api/restore'&&!req.headers['content-type']?.startsWith('application/json')){
    if(uploadActive)throw Error('正在接收另一个备份，请稍后恢复');if(Number(req.headers['content-length']??0)>MAX_BACKUP_BYTES){send(res,{error:'网页恢复上限为8GB，请保留完整data目录迁移'},413);return;}
    uploadActive=true;const file=resolve(engine.store.dataDir,`restore-${randomUUID()}.sqlite`),hash=createHash('sha256');let size=0;
    try{const counter=new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>MAX_BACKUP_BYTES){callback(Error('备份超过8GB'));return;}hash.update(chunk);callback(null,chunk);}});await pipeline(req,counter,createWriteStream(file,{flags:'wx'}));await engine.restore(file,hash.digest('hex'));send(res,{restored:true});}
    finally{uploadActive=false;if(existsSync(file))unlinkSync(file);}return;
   }
   const body=await jsonBody(req,path==='/api/restore'?70*1024*1024:64*1024);
   if(path==='/api/markets/add'){send(res,{market:await engine.gateway.addToken(readChain(body.chain),validAddress(body.token))});return;}
   if(path==='/api/markets/select'){const chain=readChain(body.chain),token=validAddress(body.token),market=engine.gateway.selectToken?.(chain,token)??engine.gateway.getMarket(chain,token);if(!market)throw Error('市场暂不在列表中，请重新加入合约');send(res,{market});return;}
   if(path==='/api/paper/orders'){const account=engine.broker.account(String(body.accountId));if(account.kind!=='manual')throw Error('机器人账户仅由已验证策略提交虚拟订单');send(res,{order:await engine.broker.submit({...body,source:'manual'})});return;}
   if(path==='/api/strategies/stop'){send(res,{strategies:engine.stopRobots()});return;}
   let match=path.match(/^\/api\/paper\/orders\/([^/]+)\/cancel$/);if(match){send(res,{order:engine.broker.cancel(match[1])});return;}
   match=path.match(/^\/api\/accounts\/([^/]+)\/pause$/);if(match){if(typeof body.paused!=='boolean')throw Error('暂停设置无效');send(res,{account:engine.broker.pauseAccount(match[1],body.paused)});return;}
   match=path.match(/^\/api\/strategies\/([^/]+)\/experiment$/);if(match){send(res,{strategy:engine.createExperiment(match[1])});return;}
   match=path.match(/^\/api\/strategies\/([^/]+)$/);if(match){send(res,{strategy:engine.strategyChange(match[1],body)});return;}
   if(path==='/api/research/runs'){send(res,{run:await engine.requestResearch(String(body.strategyId))});return;}
   if(path==='/api/settings/risk'){engine.riskChange(body.risk);send(res,{risk:engine.broker.risk});return;}
   if(path==='/api/backup'){const file=await engine.store.backupFile();try{res.writeHead(200,{'Content-Type':'application/vnd.sqlite3','Content-Disposition':'attachment; filename="paper-terminal-backup.sqlite"'});await pipeline(createReadStream(file),res);}finally{if(existsSync(file))unlinkSync(file);}return;}
   if(path==='/api/restore'){if(typeof body.backup!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(body.backup))throw Error('备份内容无效');await engine.restore(Buffer.from(body.backup,'base64'));send(res,{restored:true});return;}
   send(res,{error:'没有真实交易、签名或广播接口'},404);
  }catch(e){if(!res.headersSent)send(res,{error:e instanceof Error?e.message:'操作失败'},400);else res.end();}
 });
 server.on('close',()=>{if(broadcastTimer)clearTimeout(broadcastTimer);for(const c of [...clients,...candleClients])c.end();clients.clear();deltaClients.clear();dirty.clear();sentAt.clear();candleClients.clear();});return server;
}
function readChain(input:unknown):Chain {if(input!=='bsc'&&input!=='robinhood')throw Error('请选择BSC或Robinhood');return input;}
function csvCell(value:unknown){let text=value===undefined||value===null?'':typeof value==='object'?JSON.stringify(value):String(value);if(/^[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';}
async function jsonBody(req:IncomingMessage,max:number):Promise<any>{let length=0;const chunks:Buffer[]=[];for await(const chunk of req){const b=Buffer.from(chunk);length+=b.length;if(length>max)throw Error('请求内容过大');chunks.push(b);}const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw Error('请求内容无效');return value;}
export async function launch(){const here=dirname(fileURLToPath(import.meta.url)),project=resolve(here,'../..'),port=8790,dataDir=resolve(project,'data');const store=new Store(dataDir);
 if(!store.meta('wallets')){const existing=resolve(project,'../wallet-analysis/comparison-20261006/wallets.json');if(existsSync(existing))store.setMeta('wallets',(JSON.parse(readFileSync(existing,'utf8')) as {id:string;address:string;name:string}[]).filter(w=>w.id!=='you').map(({address,name})=>({address,name})));}
 const wallets=store.meta<{address:string;name:string}[]>('wallets')??[];const gateway=new LiveGateway({dataDir,proxy:process.env.PAPER_PROXY??'http://127.0.0.1:7897',wallets:{bsc:wallets,robinhood:[]},onAudit:(kind,message,details)=>store.audit(kind,message,details)});const engine=new Engine(store,gateway);for(const s of engine.broker.strategies().filter(s=>s.chain==='robinhood'&&s.family==='wallet'&&s.wallets.length===0&&!store.meta('revision:'+s.id))){if(wallets.length){const initialised=engine.strategyChange(s.id,{wallets});initialised.reason='已接入默认观察钱包，正在采集该链的真实信号';store.put('strategies',initialised);}}const implementationFiles=(folder:string):string[]=>readdirSync(folder,{withFileTypes:true}).flatMap(item=>item.isDirectory()?implementationFiles(resolve(folder,item.name)):item.name.endsWith('.js')?[resolve(folder,item.name)]:[]);engine.codeHash=createHash('sha256').update(implementationFiles(here).sort().map(path=>readFileSync(path)).reduce((a,b)=>Buffer.concat([a,b]),Buffer.alloc(0))).digest('hex');writeFileSync(resolve(dataDir,'server-runtime.json'),JSON.stringify({pid:process.pid,project,port,runtimeId:engine.runtimeId,codeHash:engine.codeHash}));const server=makeServer(engine,resolve(project,'dist/web'),port);
 await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>accept());});console.log(`模拟交易终端 http://127.0.0.1:${port} · 仅虚拟资金 · 数据保存在本机`);void engine.start().catch(e=>engine.error('startup',e));
 let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;server.close();await engine.stop();const until=Date.now()+30000;while((engine.broker.busy||engine.broker.inFlight.size||engine.broker.activeSubmissions||store.activeBackups)&&Date.now()<until)await new Promise(r=>setTimeout(r,50));store.close();process.exit(0);};process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());return {server,engine,store};}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void launch().catch(e=>{console.error('启动失败：'+e.message);process.exitCode=1;});
