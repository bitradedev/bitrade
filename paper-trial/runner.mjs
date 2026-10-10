import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {Store} from '../paper-terminal/dist/server/store.js';
import {TrialBroker} from './broker.mjs';
import {SharedGateway} from './gateway.mjs';
import {CHAINS as DEFAULT_CHAINS,ACCOUNTS as DEFAULT_ACCOUNTS,RULES,RISK,INITIAL_CAPITAL_USD,MAX_ORDER_USD,EXTERNAL_WINDOW_MS,EXTERNAL_SIGNAL_AGE_MS,INNER_SIGNAL_AGE_MS,entryAttempt,retainedTrades,signalDeadline,eligibleMarket,decision,admission,budgets} from './policy.mjs';
import {decisionBoard,explainEvent,DecisionJournal,signalSummary} from './explain.mjs';
import {ExitStudy} from './exit-study.mjs';
import {ExecutionCheck,CHECK_ACCOUNT} from './execution-check.mjs';
import {SignalInbox} from './signal-inbox.mjs';

// Each public simulation owns its Store, Broker, inbox, controls and journal.
// Only read-only market data is shared. The existing private trial uses defaults.
export async function createTrialRuntime(options={}){
const CHAINS=options.chains??DEFAULT_CHAINS,ACCOUNTS=options.accounts??DEFAULT_ACCOUNTS;
if(!CHAINS.length||CHAINS.some(c=>!DEFAULT_CHAINS.includes(c))||ACCOUNTS.some(a=>!CHAINS.includes(a.chain)))throw Error('模拟账户链配置无效');
const here=dirname(fileURLToPath(import.meta.url)),dataDir=options.dataDir??resolve(here,'data');
mkdirSync(dataDir,{recursive:true});
const sourcePath=options.sourcePath??resolve(here,'../paper-terminal/data/terminal.sqlite');
let source=null,cursor=0;
function connectSource(){
 if(source)return true;if(!existsSync(sourcePath))return false;
 const candidate=new DatabaseSync(sourcePath,{readOnly:true});
 try{cursor=Number(candidate.prepare('SELECT coalesce(max(rowid),0) n FROM market_events').get().n);source=candidate;return true;}
 catch(e){candidate.close();throw e;}
}
connectSource();
const store=new Store(dataDir),csrf=randomUUID(),runtimeId=randomUUID(),processStartedAt=Date.now();
let coverageStart={bsc:processStartedAt,robinhood:processStartedAt},ticks=new Map(),running=false,stopping=false,study=null;
const inbox=new SignalInbox();
function resetCoverage(chain=null,invalidateQuotes=true){
  inbox.reset(chain);
  for(const c of chain?[chain]:CHAINS){coverageStart[c]=Date.now();for(const key of ticks.keys())if(key.startsWith(c+':'))ticks.delete(key);if(invalidateQuotes)study?.onGap(c);}
  if(!invalidateQuotes)return;
  if(!chain)broker.invalidateGeneration('来源断连或重启：旧订单失效，不回填历史成交');
  else for(const o of broker.orders().filter(o=>o.chain===chain&&['waiting','queued','quoting'].includes(o.status)))if(!broker.inFlight.has(o.id))broker.cancel(o.id,'此链行情缺口或重组，旧订单失效');
}
const gateway=options.gateway??new SharedGateway(undefined,chain=>resetCoverage(chain,true),chain=>resetCoverage(chain,false));
const broker=new TrialBroker(store,gateway);
broker.risk=structuredClone(RISK);store.setMeta('risk',RISK);
for(const a of ACCOUNTS)broker.ensureAccount(a.id,a.name,a.chain,'research');
for(const config of ACCOUNTS){const account=broker.account(config.id);account.name=config.name;store.put('accounts',account);}
if(!store.meta('capital200Migration')){
 store.transaction(()=>{
  for(const config of ACCOUNTS){const account=broker.account(config.id);
   if(account.nativeBalanceRaw!==null||broker.fills().some(f=>f.accountId===account.id)||broker.orders().some(o=>o.accountId===account.id))throw Error('已有成交账本须另建本金版本，未覆盖历史交易');
   account.initialCapitalUsd=INITIAL_CAPITAL_USD;account.cashUsd=INITIAL_CAPITAL_USD;account.equityUsd=INITIAL_CAPITAL_USD;account.conservativeEquityUsd=INITIAL_CAPITAL_USD;account.dayStartEquityUsd=INITIAL_CAPITAL_USD;
   store.put('accounts',account);
  }
  store.setMeta('capital200Migration',true);store.setMeta('capital200MigrationAt',Date.now());store.audit('configuration',options.enabledChains?'设置独立策略账户：每组200U虚拟本金，单次含费用最多40U':'用户将尚未成交的试验本金改为每组200美元，单次投入上限40美元；Robinhood仅观察Pons V2');
 });
}
// One-time migration for this requested chain switch; later restarts retain user pause choices.
if(!store.meta('robinhoodTrialEnabled')){
  for(const a of ACCOUNTS)broker.pauseAccount(a.id,options.enabledChains?!options.enabledChains.includes(a.chain):a.chain==='bsc');
  store.setMeta('robinhoodTrialEnabled',true);store.audit('operator',options.enabledChains?'初始化独立BSC模拟账户；仅虚拟本金':'启用Robinhood独立模拟；BSC暂停新仓，历史记录保留');
}
const startedAt=store.meta('trialStartedAt')??processStartedAt;
const starts={bsc:startedAt,robinhood:store.meta('trialStartedAt:robinhood')??processStartedAt};
const untilByChain=Object.fromEntries(CHAINS.map(c=>[c,starts[c]+86400000])),until=Math.max(...Object.values(untilByChain));
store.setMeta('trialStartedAt',startedAt);
store.setMeta('trialStartedAt:robinhood',starts.robinhood);
const configuration={chains:CHAINS,accounts:ACCOUNTS,rules:RULES,risk:RISK,initialCapitalPerAccount:INITIAL_CAPITAL_USD,maxOrderUsd:MAX_ORDER_USD,...(CHAINS.includes('robinhood')?{robinhoodPlatform:'pons-v2-and-verified-dex'}:{}),externalWindowMs:EXTERNAL_WINDOW_MS,externalSignalAgeMs:EXTERNAL_SIGNAL_AGE_MS,innerSignalAgeMs:INNER_SIGNAL_AGE_MS,validated:false,entryWindowUntil:untilByChain};
if(JSON.stringify(store.meta('configuration'))!==JSON.stringify(configuration)||!store.meta('configurationChangedAt')){
 store.setMeta('configurationChangedAt',processStartedAt);store.audit('configuration',options.enabledChains?'BSC模拟配置：每组200U、单次含费用最多40U；已核实内盘与外盘；三组配对退出对照':'自主模拟配置：每组200美元、单次最多40美元、放宽计划风险预算至5%；Pons V2内盘与已核实外盘；三组配对退出对照',configuration);
}
store.setMeta('configuration',configuration);
store.audit('startup','独立实时模拟试跑启动：策略未验证；仅虚拟资金；跳过启动前成交',{runtimeId,cursor});
const seen=new Set(store.meta('consumedTrialSignals')??[]);
const detected=new Set(store.meta('detectedTrialSignals')??[]);
const blank=()=>({events:0,verifiedTrades:0,liveTrades:0,replayedTrades:0,delayedTrades:0,signals:0,submitted:0,rejected:0});
const counters={bsc:{...blank(),...store.meta('trialCounters:bsc')??store.meta('trialCounters')},robinhood:{...blank(),...store.meta('trialCounters:robinhood')}};
const journal=new DecisionJournal(store);
const checkEnabled=options.executionCheck!==false;
const executionCheck=checkEnabled?new ExecutionCheck(store,broker,gateway):{busy:false,state:()=>null};
const displayAccounts=checkEnabled?[...ACCOUNTS,CHECK_ACCOUNT]:ACCOUNTS;
study=new ExitStudy(store,broker);
let lastError='',latestDecision={bsc:options.enabledChains?.includes('bsc')?'等待BSC新收到的已核实成交':'BSC已暂停新仓',robinhood:'等待Robinhood新收到的已核实成交'},lastReceivedAt={bsc:0,robinhood:0};
const totals=()=>Object.fromEntries(Object.keys(blank()).map(k=>[k,CHAINS.reduce((n,c)=>n+counters[c][k],0)]));
function saveCounters(){for(const c of CHAINS)store.setMeta('trialCounters:'+c,counters[c]);}
function remember(e){
  if(e.kind!=='trade'||!e.token||!e.side||!e.priceUsd||!e.amountUsd||e.payload?.verified!==true||e.replayed)return;
  if(!eligibleMarket(gateway.getMarket(e.chain,e.token)))return;
  if(e.at<coverageStart[e.chain]||e.at>Date.now()||e.receivedAt>Date.now())return;
  const key=e.chain+':'+e.token,list=ticks.get(key)??[];
  list.push({id:e.id,at:e.at,receivedAt:e.receivedAt,priceUsd:e.priceUsd,amountUsd:e.amountUsd,side:e.side,verified:true});
  ticks.set(key,retainedTrades(list,Date.now()));
  if(ticks.size>300)ticks.delete(ticks.keys().next().value);
}
async function consider(a,e){
  const chain=a.chain,totals=counters[chain],now=Date.now(),market=gateway.getMarket(chain,e.token),head=broker.head(chain);
  if(!eligibleMarket(market))return;
  const wallets=gateway.state.strategies.filter(s=>s.chain===chain&&s.family==='wallet').flatMap(s=>s.wallets.map(w=>w.address));
  const d=decision({chain,family:a.family,event:e,market,now,coverageStart:coverageStart[chain],hasGap:now-coverageStart[chain]<60000,trades:ticks.get(chain+':'+e.token)??[],wallets});
  const blocked=broker.account(a.id).paused?'用户已暂停该链新仓':!head?.connected?'链头过期或断连，等待新鲜数据':null;
  journal.record(explainEvent({account:a,event:e,market,now,coverageStart:coverageStart[chain],trades:ticks.get(chain+':'+e.token)??[],wallets,result:d,blocked}),d.eligible?0:15000);
  if(blocked)return;
  if(!d.eligible)return;
  const key=a.id+':'+(a.family==='wallet'?e.wallet+':'+e.token:e.token+':'+Math.floor(now/600000));
  const prefix='trial:'+createHash('sha256').update(key).digest('hex'),attempt=entryAttempt(broker.orders(),prefix);
  // A rejected/cancelled order is not a purchase. Permit bounded attempts on
  // a fresh signal, with a new idempotency key and no duplicate open order.
  if(!attempt.allowed)return;
  if(seen.delete(key))store.setMeta('consumedTrialSignals',[...seen].slice(-30000));
  if(!detected.has(key)){detected.add(key);store.setMeta('detectedTrialSignals',[...detected].slice(-30000));totals.signals++;}
  latestDecision[chain]=a.name+'：'+signalSummary(d.reason);
  store.audit('signal','试验捕获信号，尚未证明策略有效',{account:a.id,token:e.token,eventId:e.id,reason:d.reason,observedAt:now});
  const block=admission(broker.revalueAccount(a.id),broker.positions(),broker.orders(),now,untilByChain[chain]);
  if(block){totals.rejected++;store.audit('rejected',block,{account:a.id,token:e.token});journal.record({chain,at:Date.now(),module:'RISK',accountId:a.id,token:e.token,stage:'risk-check',outcome:'blocked',summary:block},0);return;}
  if(broker.positions().some(p=>p.accountId===a.id&&p.token===e.token&&!p.closedAt))return;
  const expires=signalDeadline(a.family,market,e.at);
  let error='';
  for(const budget of budgets(broker.account(a.id).conservativeEquityUsd)){
    if(Date.now()>=expires){error='准备报价期间信号已过期';break;}
    try{
      const h=broker.fresh(chain),q=await broker.quoteBudget(a.id,e.token,budget,h.head);
      const reverse=await broker.getQuote(a.id,{chain,token:e.token,side:'sell',recipient:broker.recipient(a.id),tokenAmountRaw:q.outputRaw,block:q.block});
      journal.record({chain,at:Date.now(),module:'SIZE',accountId:a.id,token:e.token,stage:'quote-check',outcome:'quoted',summary:`已取得${budget.toFixed(2)}美元预算的买入及整仓反向报价，交给费用与风险检查`,checks:[{label:'预算USD',value:budget,status:'pass',threshold:`单次投入上限40美元，计划净损失预算${RISK.riskPct}%`},{label:'报价费用',value:q.fees,status:q.fees.quality==='unavailable'?'unknown':'pass',threshold:'保留Gas、授权和报价内费用的估计依据'}]},0);
      const order=await broker.submit({clientId:prefix+':'+attempt.index,accountId:a.id,token:e.token,side:'buy',
        amountUsd:Number(BigInt(q.inputRaw))/1e18*q.nativeUsd,slippagePct:3,rules:structuredClone(RULES),reason:d.reason,
        source:'unvalidated-trial:'+a.family,signalAt:e.at,signalExpiresAt:expires,
        maxEntryPriceUsd:(a.family==='wallet'?e.priceUsd:market.priceUsd)*1.1},{reference:q,reverse});
      seen.add(key);store.setMeta('consumedTrialSignals',[...seen].slice(-30000));inbox.complete(e);
      totals.submitted++;store.audit('trial-entry','提交独立虚拟订单，等待500毫秒及后续区块',{id:order.id,account:a.id,budget});journal.record({chain,at:Date.now(),module:'EXEC',accountId:a.id,token:e.token,stage:'order-submit',outcome:'queued',summary:'费用与风控检查通过，已提交虚拟订单；等待500毫秒和后续区块，尚未成交'},0);return;
    }catch(err){error=err.message;store.audit('preflight','试验报价或风险检查未通过',{account:a.id,token:e.token,budget,error});
      if(!/风险预算|含费用|费用已超过/.test(error))break;
    }
  }
  totals.rejected++;latestDecision[chain]='跳过信号：'+error;store.audit('rejected',latestDecision[chain],{account:a.id,token:e.token});
  journal.record({chain,at:Date.now(),module:'EXEC',accountId:a.id,token:e.token,stage:'quote-check',outcome:'blocked',summary:latestDecision[chain]},0);
}
async function cycle(){
  if(running||stopping)return;running=true;
  try{
    if(!connectSource()){lastError='共享行情数据库尚未就绪，等待行情服务；未生成成交';return;}
    const rows=source.prepare('SELECT rowid seq,payload FROM market_events WHERE rowid>? ORDER BY rowid LIMIT 1000').all(cursor);
    for(const row of rows){cursor=Number(row.seq);const e=JSON.parse(row.payload);if(!CHAINS.includes(e.chain))continue;const totals=counters[e.chain];totals.events++;
      if(e.kind==='gap'){gateway.noticeGap(e.chain);continue;}
      if(e.kind==='removed'){gateway.reset(e.chain);continue;}
      if(e.token&&!eligibleMarket(gateway.getMarket(e.chain,e.token)))continue;
      if(e.kind==='trade'&&e.payload?.verified===true){totals.verifiedTrades++;lastReceivedAt[e.chain]=Date.now();
        if(e.replayed)totals.replayedTrades++;else totals.liveTrades++;
        if(Date.now()-e.at>5000){totals.delayedTrades++;latestDecision[e.chain]='成交记录保留实际延迟；内盘信号≤30秒，外盘与钱包≤60秒，执行报价仍须5秒内核实';}
      }
      remember(e);
      if(['trade','wallet'].includes(e.kind)&&e.token&&e.at>=coverageStart[e.chain]&&e.receivedAt>=processStartedAt)inbox.offer(e,gateway.getMarket(e.chain,e.token),Date.now());
      else if(['trade','wallet'].includes(e.kind)&&e.token){
        journal.record({chain:e.chain,at:Date.now(),module:'SCOUT',token:e.token,stage:'observation-skip',outcome:'ignored',sourceAt:e.at,receivedAt:e.receivedAt,
          summary:e.replayed?'收到历史回放，只记录观察，不作为实时买入信号':'成交发生在本轮连续观察之前或已过期，保留记录，不追买',
          checks:[{label:'成交发生时间',status:'unknown',value:e.at,threshold:'本轮连续观察期间的新信号'},{label:'本机收到时间',status:'pass',value:e.receivedAt,threshold:'保留实际接收时间'}]},15000);
      }
    }
    // Process only currently fresh signals; do not replay a backlog as live trades.
    // SQLite events may arrive before the next shared market snapshot. Retry
    // within the original deadline rather than permanently discard that race.
    if(!executionCheck.busy)for(const e of inbox.due(Date.now(),4))for(const a of ACCOUNTS.filter(a=>a.chain===e.chain&&a.family===(e.kind==='wallet'?'wallet':'momentum')))await consider(a,e);
    saveCounters();lastError='';
  }catch(e){lastError=e.message;store.audit('error','试验采集失败，未假定成交',{error:lastError});}
  finally{running=false;}
}
function board(chain){
  return decisionBoard({chain,now:Date.now(),source:gateway.state,sourceAt:gateway.receivedAt,status:gateway.statuses().find(s=>s.chain===chain),
    accounts:ACCOUNTS.filter(a=>a.chain===chain).map(a=>broker.account(a.id)),positions:broker.positions().filter(p=>p.chain===chain),orders:broker.orders().filter(o=>o.chain===chain),
    counters:counters[chain],coverageStart:coverageStart[chain],lastReceivedAt:lastReceivedAt[chain],trialUntil:untilByChain[chain],latest:journal.recent(chain).find(r=>r.stage==='signal-check'),checksPassed:broker.checks().passed});
}
function observeModules(){
  if(!gateway.state)return;
  for(const chain of CHAINS){const view=board(chain);for(const module of view.modules)journal.record({chain,at:view.at,module:module.id,stage:'module-check',outcome:module.status,summary:module.summary,facts:module.facts,next:module.next},15000);}
}
function state(){
  const accounts=displayAccounts.map(a=>broker.account(a.id)),positions=broker.positions().filter(p=>displayAccounts.some(a=>a.id===p.accountId));
  return {app:'paper-trial',mode:'paper',validated:false,virtualOnly:true,at:Date.now(),csrf,runtimeId,startedAt,processStartedAt,entryWindowUntil:until,
    configuration:store.meta('configuration'),configurationChangedAt:store.meta('configurationChangedAt')??processStartedAt,
    entryWindowClosed:Date.now()>=until,chain:CHAINS.includes('robinhood')?'robinhood':'bsc',chains:gateway.statuses().filter(c=>CHAINS.includes(c.chain)),sourceConnected:gateway.connected,sourceAt:gateway.receivedAt,sourceError:gateway.lastError,
    chainTrials:CHAINS.map(chain=>({chain,startedAt:starts[chain],entryWindowUntil:untilByChain[chain],entryWindowClosed:Date.now()>=untilByChain[chain],paused:accounts.filter(a=>a.chain===chain).every(a=>a.paused),counters:counters[chain],latestDecision:latestDecision[chain],lastReceivedAt:lastReceivedAt[chain]})),
    accounts,positions,orders:broker.orders().filter(o=>displayAccounts.some(a=>a.id===o.accountId)).slice(-300).reverse(),fills:broker.fills().filter(f=>displayAccounts.some(a=>a.id===f.accountId)).slice(-300).reverse(),executionCheck:executionCheck.state(),capabilities:{executionCheck:checkEnabled},
    counters:totals(),rules:RULES,risk:RISK,lastReceivedAt,lastError,latestDecision,audit:store.auditRows(30),ledger:broker.checks(),
    decisionBoards:Object.fromEntries(CHAINS.map(chain=>[chain,{...board(chain),timeline:journal.recent(chain).filter(r=>r.at>=(store.meta('configurationChangedAt')??0)&&(!r.token||eligibleMarket(gateway.getMarket(chain,r.token))))}])),
    exitStudies:Object.fromEntries(CHAINS.map(chain=>[chain,study.state(chain)])),
    curves:Object.fromEntries(ACCOUNTS.map(a=>[a.id,store.curve(a.id,300)]))};
}
function report(){
  const value=state();delete value.csrf;writeFileSync(resolve(dataDir,'latest-report.json'),JSON.stringify(value,null,2));
}
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  const send=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify(v));};
  try{
    if(!['127.0.0.1:8793','localhost:8793'].includes(req.headers.host))return send({error:'仅允许本机访问'},403);
    const path=new URL(req.url,'http://127.0.0.1:8793').pathname;
    if(req.method==='GET'){
      if(path==='/api/state')return send(state());
      if(path==='/api/health')return send({app:'paper-trial',mode:'paper',virtualOnly:true,runtimeId,at:Date.now(),sourceConnected:gateway.connected,counters:totals(),ledgerPassed:broker.checks().passed});
      if(path==='/api/export'){
        const rows=broker.fills(),keys=['id','accountId','chain','token','side','tokenRaw','nativeRaw','usd','costBasisUsd','netUsd','at','block','priceUsd','reason'];
        const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
        res.writeHead(200,{'Content-Type':'text/csv;charset=utf-8','Content-Disposition':'attachment; filename="independent-paper-fills.csv"'});
        return res.end('\ufeff'+keys.map(cell).join(',')+'\r\n'+rows.map(r=>keys.map(k=>cell(r[k])).join(',')).join('\r\n'));
      }
      const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
      if(files[path]){res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript;charset=utf-8':path.endsWith('.css')?'text/css;charset=utf-8':'text/html;charset=utf-8'});return res.end(readFileSync(resolve(here,files[path])));}
    }
    if(req.method==='POST'&&['/api/pause','/api/stop','/api/check'].includes(path)){
      if(req.headers.origin&&!['http://127.0.0.1:8793','http://localhost:8793'].includes(req.headers.origin))return send({error:'来源不允许'},403);
      const token=req.headers['x-csrf-token'];if(typeof token!=='string'||token.length!==csrf.length||!timingSafeEqual(Buffer.from(token),Buffer.from(csrf)))return send({error:'请刷新页面'},403);
      if(req.headers['content-type']!=='application/json')return send({error:'请求格式无效'},415);
      let text='';for await(const chunk of req){text+=chunk;if(text.length>1000)return send({error:'请求过大'},413);}
      const body=JSON.parse(text);
      if(path==='/api/check'){if(body.check!==true)throw Error('验证设置无效');if(executionCheck.busy)throw Error('正在验证，请稍候');send({accepted:true},202);void executionCheck.run().catch(e=>{store.audit('execution-check','运行验证未启动',{reason:e.message});});return;}
      if(path==='/api/stop'){if(body.stop!==true)throw Error('停止设置无效');send({stopping:true});setTimeout(()=>void stop(),50);return;}
      const {paused,chain}=body;if(typeof paused!=='boolean'||chain!==undefined&&!CHAINS.includes(chain))throw Error('暂停设置无效');
      for(const a of displayAccounts.filter(a=>chain===undefined||a.chain===chain))broker.pauseAccount(a.id,paused);
      store.audit('operator',(chain??'全部链')+(paused?'暂停新仓；已有持仓继续退出':'恢复独立虚拟试验新仓'),{chain});report();return send({paused,chain:chain??'all'});
    }
    send({error:'此试验仅有虚拟账本与暂停操作'},404);
  }catch(e){send({error:e.message},400);}
});
if(options.server!==false){
 await new Promise((accept,reject)=>{server.once('error',reject);server.listen(8793,'127.0.0.1',accept);});
 writeFileSync(resolve(dataDir,'runtime.json'),JSON.stringify({pid:process.pid,project:here,port:8793,runtimeId,startedAt}));
}
const timers=[setInterval(()=>void cycle(),500),setInterval(()=>void broker.tick().catch(e=>{lastError=e.message;}),500),setInterval(observeModules,5000),
  setInterval(()=>void study.tick().catch(e=>{lastError=e.message;store.audit('exit-study-error','止盈止损研究未完成，本次不记录虚构成交',{reason:e.message});}),10000),
  setInterval(()=>{const checks=broker.checks();if(!checks.passed){for(const a of displayAccounts)broker.pauseAccount(a.id,true);store.audit('ledger','对账失败，暂停新仓',checks);}saveCounters();report();},10000)];
if(!options.gateway)void gateway.start();report();
async function stop(){if(stopping)return;stopping=true;for(const t of timers)clearInterval(t);broker.stopped=true;broker.invalidateGeneration();if(!options.gateway)gateway.stop();if(server.listening)server.close();
  const end=Date.now()+10000;while((broker.busy||broker.activeSubmissions||running||study.busy||executionCheck.busy)&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
  if(broker.busy||broker.activeSubmissions||running||study.busy||executionCheck.busy)throw Error('报价任务仍在结束，暂不关闭账本');
  saveCounters();study.save();report();source?.close();store.close();}
function pauseAccounts(paused,chain){
 if(typeof paused!=='boolean'||chain!==undefined&&!CHAINS.includes(chain))throw Error('暂停设置无效');
 for(const a of displayAccounts.filter(a=>!chain||a.chain===chain))broker.pauseAccount(a.id,paused);
 store.audit('operator',paused?'用户暂停自己的新仓；已有持仓继续管理':'用户恢复自己的模拟新仓',{chain:chain??'all'});report();
}
return {state,pause:pauseAccounts,stop,onGap:resetCoverage,broker,dataDir};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const runtime=await createTrialRuntime();
 console.log('bi trade 本机研究预览 http://127.0.0.1:8793 · 每组200U虚拟本金 · 单次上限40U');
 const shutdown=()=>void runtime.stop().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exitCode=1;});
 process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
