import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isIP} from 'node:net';
import {createTrialRuntime} from '../paper-trial/runner.mjs';
import {SharedGateway} from '../paper-trial/gateway.mjs';
import {decisionBoard} from '../paper-trial/explain.mjs';
import {studyMetrics} from '../paper-trial/exit-study.mjs';
import {RULES,RISK,ACCOUNTS} from '../paper-trial/policy.mjs';

const here=dirname(fileURLToPath(import.meta.url)),assets=resolve(here,'../paper-trial');
const COOKIE='bi_trade_session',TTL=30*86400000;
const digest=v=>createHash('sha256').update(v).digest('hex');
const safeEqual=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);};
function validOrigin(value){
 const u=new URL(value);
 if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw Error('公开站点必须使用HTTPS；本机预览可用HTTP');
 return u.origin;
}
function cookieToken(req){
 const value=String(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
 return value&&/^[A-Za-z0-9_-]{43}$/.test(value)?value:null;
}
export function fillCsv(rows){
 const keys=['id','accountId','chain','token','side','tokenRaw','nativeRaw','usd','costBasisUsd','netUsd','at','block','priceUsd','reason'];
 const cell=v=>'"'+(typeof v==='string'?v.replace(/^[=+@-]/,"'$&"):String(v??'')).replaceAll('"','""')+'"';
 return '\ufeff'+keys.map(cell).join(',')+'\r\n'+rows.map(r=>keys.map(k=>cell(r[k])).join(',')).join('\r\n');
}
const blank=()=>({events:0,verifiedTrades:0,liveTrades:0,replayedTrades:0,delayedTrades:0,signals:0,submitted:0,rejected:0});

export async function createPublicApp(options={}){
 let origin=options.origin?validOrigin(options.origin):null;
 const dataDir=resolve(options.dataDir??resolve(here,'data'));mkdirSync(dataDir,{recursive:true});
 const sessions=new DatabaseSync(resolve(dataDir,'sessions.sqlite'));
 sessions.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,tokenHash TEXT UNIQUE NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL)');
 const books=new Map(),loading=new Map(),quotas=new Map();let closing=false,pendingCreations=0;
 const reset=(chain,invalidate)=>{for(const b of books.values())b.onGap(chain,invalidate);};
 const gateway=options.gateway??new SharedGateway(undefined,c=>reset(c,true),c=>reset(c,false));
 const factory=options.makeRuntime??createTrialRuntime,maxUsers=options.maxUsers??100,maxNewSessions=options.maxNewSessions??10;
 async function load(row){
  if(books.has(row.id))return books.get(row.id);if(loading.has(row.id))return loading.get(row.id);
  if(!/^[a-f0-9]{32}$/.test(row.id))throw Error('实验室标识无效');
  const p=factory({dataDir:resolve(dataDir,'users',row.id),gateway,server:false,executionCheck:false,chains:['bsc'],accounts:ACCOUNTS.filter(a=>a.chain==='bsc'),enabledChains:['bsc']});
  loading.set(row.id,p);try{const b=await p;books.set(row.id,b);return b;}finally{loading.delete(row.id);}
 }
 function session(req){
  const token=cookieToken(req);if(!token)return null;
  return sessions.prepare('SELECT id,createdAt,expiresAt FROM sessions WHERE tokenHash=? AND expiresAt>?').get(digest(token),Date.now())??null;
 }
 function allow(address,kind,limit,windowMs){
  const now=Date.now(),key=kind+':'+address,prior=quotas.get(key),q=!prior||now-prior.start>=windowMs?{start:now,count:0}:prior;
  q.count++;quotas.set(key,q);if(quotas.size>5000)for(const [k,v] of quotas)if(now-v.start>=3600000)quotas.delete(k);
  return q.count<=limit;
 }
 function guestState(){
  const now=Date.now(),chains=gateway.statuses().filter(c=>c.chain==='bsc'),counters=blank();
  if(!chains.length)chains.push({chain:'bsc',connected:false,head:0,headAt:0,gaps:0});
  const board=decisionBoard({chain:'bsc',now,source:gateway.state,sourceAt:gateway.receivedAt,status:chains[0],accounts:[],positions:[],orders:[],counters,coverageStart:now,lastReceivedAt:0,trialUntil:now+86400000,checksPassed:true});
  board.summary='创建独立实验室后，开始观察BSC真实行情。';
  return {app:'bi-trade',mode:'paper',virtualOnly:true,validated:false,at:now,csrf:null,chains,sourceConnected:gateway.connected,sourceAt:gateway.receivedAt,accounts:[],positions:[],orders:[],fills:[],audit:[],rules:RULES,risk:RISK,counters,chainTrials:[{chain:'bsc',paused:true,counters,latestDecision:board.summary,entryWindowUntil:null}],ledger:{passed:true},decisionBoards:{bsc:{...board,timeline:[]}},exitStudies:{bsc:studyMetrics([])},session:null,capabilities:{sessions:true,executionCheck:false},product:{name:'bi trade',meaning:'Binance AI Trade',chain:'bsc',publicBeta:true}};
 }
 function privateState(row,book){
  const value=book.state();
  value.app='bi-trade';value.session={label:'BSC · '+row.id.slice(0,8),createdAt:row.createdAt,expiresAt:row.expiresAt};
  value.capabilities={sessions:true,executionCheck:false};value.product={name:'bi trade',meaning:'Binance AI Trade',chain:'bsc',publicBeta:true};
  // No database paths, owner trial accounts, source CSRF, cookie or session hash.
  delete value.runtimeId;delete value.processStartedAt;return value;
 }
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
  if(origin?.startsWith('https:'))res.setHeader('Strict-Transport-Security','max-age=31536000');
  const send=(value,code=200)=>{res.writeHead(code,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify(value));};
  try{
   if(closing)return send({error:'服务正在保存账本，请稍后重试'},503);
   if(req.headers.host!==new URL(origin).host)return send({error:'站点地址无效'},403);
   const url=new URL(req.url,origin),path=url.pathname,remote=req.socket.remoteAddress??'unknown';
   // Forwarded IPs affect quotas only and are accepted solely with explicit
   // trusted-proxy configuration from a loopback reverse proxy.
   const forwarded=typeof req.headers['x-forwarded-for']==='string'?req.headers['x-forwarded-for'].trim():'';
   const ip=options.trustProxy&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)&&isIP(forwarded)?forwarded:remote;
   if(req.url.length>2048)return send({error:'请求地址过长'},414);
   const row=session(req);
   if(path.startsWith('/api/')&&!allow(row?.id??ip,'read',600,60000))return send({error:'请求过于频繁，请稍后重试'},429);
   if(req.method==='GET'){
    if(path==='/api/health')return send({app:'bi-trade',mode:'paper',virtualOnly:true,at:Date.now(),sourceConnected:gateway.connected});
    if(path==='/api/state')return send(row?privateState(row,await load(row)):guestState());
    if(path==='/api/export'){
     if(!row)return send({error:'请先创建模拟实验室'},401);
     const b=await load(row),ids=new Set(b.state().accounts.map(a=>a.id));
     res.writeHead(200,{'Content-Type':'text/csv;charset=utf-8','Content-Disposition':'attachment; filename="bi-trade-my-fills.csv"'});return res.end(fillCsv(b.broker.fills().filter(f=>ids.has(f.accountId))));
    }
    const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
    if(files[path]){res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript;charset=utf-8':path.endsWith('.css')?'text/css;charset=utf-8':'text/html;charset=utf-8'});return res.end(readFileSync(resolve(assets,files[path])));}
   }
   if(req.method==='POST'&&['/api/session','/api/pause'].includes(path)){
    if(req.headers.origin!==origin)return send({error:'请从bi trade页面操作'},403);
    if(req.headers['content-type']!=='application/json')return send({error:'请求格式无效'},415);
    if(!allow(row?.id??ip,'write',30,60000))return send({error:'操作过于频繁，请稍后重试'},429);
    let text='';for await(const chunk of req){text+=chunk;if(text.length>1024)return send({error:'请求过大'},413);}
    let body;try{body=JSON.parse(text);}catch{return send({error:'请求内容无效'},400);}
    if(!body||Array.isArray(body)||typeof body!=='object')return send({error:'请求内容无效'},400);
    if(path==='/api/session'){
     if(body.create!==true||Object.keys(body).some(k=>k!=='create'))return send({error:'创建设置无效'},400);
     if(row)return send({created:false,session:{label:'BSC · '+row.id.slice(0,8)}});
     if(!allow(ip,'new-session',maxNewSessions,3600000))return send({error:'本小时创建次数已达上限，请稍后重试'},429);
     if(Number(sessions.prepare('SELECT count(*) n FROM sessions').get().n)+pendingCreations>=maxUsers)return send({error:'本轮体验名额已满，请等待扩容'},503);
     const id=randomBytes(16).toString('hex'),token=randomBytes(32).toString('base64url'),now=Date.now();
     const record={id,createdAt:now,expiresAt:now+TTL};
     pendingCreations++;
     try{await load(record);sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(id,digest(token),record.createdAt,record.expiresAt);}
     catch(e){const b=books.get(id);if(b){await b.stop();books.delete(id);}throw e;}
     finally{pendingCreations--;}
     res.setHeader('Set-Cookie',COOKIE+'='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+TTL/1000+(origin.startsWith('https:')?'; Secure':''));
     return send({created:true,session:{label:'BSC · '+id.slice(0,8)}},201);
    }
    if(!row)return send({error:'请先创建模拟实验室'},401);
    const book=await load(row);
    if(!safeEqual(req.headers['x-csrf-token'],book.state().csrf))return send({error:'请刷新你的实验室后再操作'},403);
    if(typeof body.paused!=='boolean'||body.chain!==undefined&&body.chain!=='bsc'||Object.keys(body).some(k=>!['paused','chain'].includes(k)))return send({error:'只能切换自己BSC账户的新仓状态'},400);
    book.pause(body.paused,'bsc');return send({paused:body.paused,chain:'bsc'});
   }
   send({error:'页面不存在'},404);
  }catch(e){console.error('bi trade 请求未完成：'+e.message);send({error:'操作未完成，请稍后重试'},500);}
 });
 const port=options.port??8794;
 await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});
 if(!origin)origin='http://127.0.0.1:'+server.address().port;
 // Open existing books on restart even if the browser is closed: exit management continues.
 try{for(const row of sessions.prepare('SELECT id,createdAt,expiresAt FROM sessions ORDER BY createdAt').all())await load(row);}catch(e){await new Promise(r=>server.close(r));await Promise.allSettled([...books.values()].map(b=>b.stop()));sessions.close();throw e;}
 if(!options.gateway)void gateway.start();
 async function stop(){
  if(closing)return;closing=true;if(!options.gateway)gateway.stop();
  await new Promise(r=>server.close(r));await Promise.all([...loading.values()]);
  const results=await Promise.allSettled([...books.values()].map(b=>b.stop()));
  const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  sessions.exec('PRAGMA wal_checkpoint(TRUNCATE)');sessions.close();
 }
 return {server,origin,stop};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=await createPublicApp({origin:process.env.BI_TRADE_PUBLIC_ORIGIN,port:Number(process.env.BI_TRADE_PORT??8794),maxUsers:Number(process.env.BI_TRADE_MAX_USERS??100),trustProxy:process.env.BI_TRADE_TRUST_PROXY==='1'});
 mkdirSync(resolve(here,'data'),{recursive:true});writeFileSync(resolve(here,'data/runtime.json'),JSON.stringify({pid:process.pid,app:'bi-trade',port:app.server.address().port,origin:app.origin,project:here}));
 console.log('bi trade · BSC 独立模拟体验 '+app.origin+' · 仅虚拟资金');
 const shutdown=()=>void app.stop().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exitCode=1;});
 process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
