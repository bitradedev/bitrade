import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';import {randomUUID} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/server/store.js';import {Engine,exactExitQuantities} from '../src/server/engine.js';import {ENTRY_BUDGETS_USD,exitGrid,replayPortfolio,type ResearchSample} from '../src/server/research.js';import {usdNative,nativeUsd} from '../src/server/money.js';
import type {Chain,Market,MarketGateway,QuoteRequest,Quote,Strategy,ResearchRun,MarketEvent,PaperOrder} from '../src/shared/domain.js';
const TOKEN='0x1111111111111111111111111111111111111111';const WALLET='0x2222222222222222222222222222222222222222';
class TapeGateway implements MarketGateway {
 head=100;price=.001;fx=1000;requests:QuoteRequest[]=[];
  beforeQuote:((request:QuoteRequest)=>Promise<void>)|null=null;
 statuses(){return (['bsc','robinhood'] as Chain[]).map(chain=>({chain,connected:true,head:this.head,headAt:Date.now(),chainTime:Date.now(),gaps:0,reconnects:0,lastError:'',source:'isolated integration fixture'}));}
 markets():Market[]{return (['bsc','robinhood'] as Chain[]).map(chain=>({id:chain+':'+TOKEN,chain,address:TOKEN,name:'隔离验证',symbol:'TEST',platform:'fixture',stage:'curve',createdAt:Date.now()-120000,priceUsd:this.price,nativeUsd:this.fx,quoteAddress:'0x0000000000000000000000000000000000000000',decimals:18,liquidityUsd:100000,volumeUsd:10000,buyTaxPct:0,sellTaxPct:0,updatedAt:Date.now(),block:this.head,quality:'verified',reason:''}));}
 getMarket(c:Chain,t:string){return this.markets().find(m=>m.chain===c&&m.address===t);}
 async quote(r:QuoteRequest):Promise<Quote>{this.requests.push(structuredClone(r));if(this.beforeQuote)await this.beforeQuote(r);await new Promise(resolve=>setTimeout(resolve,1));const input=BigInt(r.side==='buy'?r.nativeAmountRaw!:r.tokenAmountRaw!);const value=r.side==='buy'?nativeUsd(input,this.fx):Number(input)/1e18*this.price;const out=r.side==='buy'?BigInt(Math.floor(value*.99/this.price*1e18)):usdNative(value*.99,this.fx);return {id:randomUUID(),chain:r.chain,token:r.token,side:r.side,block:r.block??this.head,at:Date.now(),inputRaw:String(input),spentInputRaw:String(input),refundRaw:'0',outputRaw:String(out),tokenDecimals:18,nativeUsd:this.fx,priceUsd:r.side==='buy'?value/(Number(out)/1e18):this.price*.99,priceImpactPct:1,fees:{gasUsd:.001,approvalUsd:0,protocolUsd:value*.01,taxUsd:0,conversionUsd:0,includedInOutput:true,quality:'estimated',notes:['fixture：当时已记录的gas']},quality:'verified',venue:'fixture',reason:''};}
 async candles(){return [];}async start(){}async stop(){}async addToken(c:Chain,t:string){return this.getMarket(c,t)!;}setWallets(){}
}
const directory=resolve('data/test-runs');mkdirSync(directory,{recursive:true});
function fixture(){const store=new Store(mkdtempSync(resolve(directory,'integration-'))),gateway=new TapeGateway(),engine=new Engine(store,gateway);return {store,gateway,engine};}

test('independent paper experiment preserves all formal books and is created only once',()=>{const {store,engine}=fixture();try{
 const accounts=structuredClone(engine.broker.accounts()),strategies=structuredClone(engine.broker.strategies());const trial=engine.createExperiment('bsc-wallet-short');
 assert.equal(trial.mode,'experiment');assert.equal(trial.state,'running');assert.equal(engine.broker.account(trial.accountId).kind,'research');assert.equal(engine.broker.account(trial.accountId).initialCapitalUsd,100);
 assert.deepEqual(engine.broker.accounts().filter(a=>a.kind!=='research'),accounts);assert.deepEqual(engine.broker.strategies().filter(s=>!s.mode),strategies);assert.equal(engine.createExperiment('bsc-wallet-short').id,trial.id);assert.equal(engine.broker.accounts().length,11);assert.equal(engine.broker.orders().length,0);
 assert.throws(()=>engine.createExperiment(trial.id),/正式实验组/);assert.throws(()=>engine.createExperiment('manual-bsc'),/正式实验组/);
 }finally{store.close();}});

test('experiment executes a delayed paper entry in its own book while the formal strategy remains blocked',async()=>{const {store,gateway,engine}=fixture();try{
 const trial=engine.createExperiment('bsc-momentum-short');await engine.startTape(trial,sourceTrade(gateway),'isolated experiment signal');const order=engine.broker.orders().find(o=>o.accountId===trial.accountId)!;assert.ok(order);assert.equal(order.status,'queued');assert.equal(engine.broker.fills().length,0);
 await afterDeadline(order);gateway.head++;await engine.broker.execute(order);assert.equal(store.get<PaperOrder>('orders',order.id)?.status,'filled');assert.equal(engine.broker.fills()[0].accountId,trial.accountId);assert.ok(engine.broker.account(trial.accountId).cashUsd<100);assert.equal(engine.broker.account('bsc-momentum-short').cashUsd,100);assert.equal(engine.broker.account('bsc-momentum-short').nativeBalanceRaw,null);
 const base=store.get<Strategy>('strategies','bsc-momentum-short')!;assert.equal(base.state,'waiting');assert.equal(base.researchRunId,null);await assert.rejects(engine.broker.submit({clientId:randomUUID(),accountId:base.accountId,token:TOKEN,side:'buy',amountUsd:1,rules:base.rules,reason:'isolated formal admission rejection'}),/未通过验证/);assert.equal(engine.broker.checks().passed,true);
 }finally{store.close();}});

test('pausing an experiment cancels its delayed admission and retains the same bankroll on resume',async()=>{const {store,gateway,engine}=fixture();try{
 const trial=engine.createExperiment('bsc-momentum-short');await engine.startTape(trial,sourceTrade(gateway),'isolated pause');const order=engine.broker.orders()[0];engine.strategyChange(trial.id,{action:'pause'});const balance=engine.broker.account(trial.accountId).nativeBalanceRaw;
 await afterDeadline(order);gateway.head++;await engine.broker.execute(order);assert.equal(engine.broker.fills().length,0);assert.equal(engine.broker.account(trial.accountId).reservedNativeRaw,'0');assert.equal(engine.broker.account(trial.accountId).feesUsd,0);assert.equal(engine.strategyChange(trial.id,{action:'resume'}).state,'running');assert.equal(engine.broker.account(trial.accountId).nativeBalanceRaw,balance);assert.equal(engine.broker.checks().passed,true);
 }finally{store.close();}});

test('experimental parameter changes create a paused version and invalidate old pending admission',async()=>{const {store,gateway,engine}=fixture();try{
 const trial=engine.createExperiment('bsc-momentum-short');await engine.startTape(trial,sourceTrade(gateway),'isolated revision');const order=engine.broker.orders()[0];const next=engine.strategyChange(trial.id,{rules:exitGrid('short')[0].rules});assert.equal(next.state,'paused');assert.notEqual(next.version,trial.version);engine.strategyChange(trial.id,{action:'resume'});await afterDeadline(order);gateway.head++;await engine.broker.execute(order);assert.equal(engine.broker.fills().length,0);assert.equal(engine.broker.account(trial.accountId).feesUsd,0);assert.equal(engine.broker.checks().passed,true);
 }finally{store.close();}});

test('experiments are excluded from formal research and global stop persists across reconstruction',async()=>{const {store,gateway,engine}=fixture();try{
 const trial=engine.createExperiment('bsc-momentum-short');await assert.rejects(engine.requestResearch(trial.id),/不作为正式研究/);await engine.autoResearch();assert.equal(store.all<ResearchRun>('research_runs').some(r=>r.strategyId===trial.id),false);
 engine.stopRobots();const restored=new Engine(store,gateway);assert.equal(restored.broker.strategies().find(s=>s.id===trial.id)?.state,'paused');assert.equal(restored.broker.account(trial.accountId).paused,true);assert.equal(restored.broker.isExperiment(store.get<Strategy>('strategies',trial.id)!),true);
 }finally{store.close();}});

test('a forged experimental marker on a formal account cannot bypass validation',async()=>{const {store,engine}=fixture();try{
 const base=store.get<Strategy>('strategies','bsc-momentum-short')!;base.mode='experiment';base.state='running';store.put('strategies',base);assert.equal(engine.broker.isExperiment(base),false);await assert.rejects(engine.broker.submit({clientId:randomUUID(),accountId:base.accountId,token:TOKEN,side:'buy',amountUsd:1,rules:base.rules,reason:'isolated forged mode rejection'}),/试运行.*无效/);assert.equal(engine.broker.fills().length,0);assert.equal(engine.broker.account(base.accountId).nativeBalanceRaw,null);
 }finally{store.close();}});

test('experiment backup restores exact holdings and funding while remaining explicitly unvalidated and paused',async()=>{const {store,gateway,engine}=fixture();try{
 const trial=engine.createExperiment('bsc-momentum-short');await engine.startTape(trial,sourceTrade(gateway),'isolated restore');const order=engine.broker.orders()[0];await afterDeadline(order);gateway.head++;await engine.broker.execute(order);const positions=structuredClone(engine.broker.positions()),fills=structuredClone(engine.broker.fills()),balance=engine.broker.account(trial.accountId).nativeBalanceRaw;
 await engine.restore(store.backup());assert.deepEqual(engine.broker.positions(),positions);assert.deepEqual(engine.broker.fills(),fills);assert.equal(engine.broker.account(trial.accountId).nativeBalanceRaw,balance);const restored=store.get<Strategy>('strategies',trial.id)!;assert.equal(restored.mode,'experiment');assert.equal(restored.state,'paused');assert.equal(restored.researchRunId,null);assert.equal(engine.broker.isExperiment(restored),true);assert.equal(engine.broker.checks().passed,true);
 }finally{store.close();}});

test('robot diagnostics count distinct ready samples, retain failures, and exclude other versions',()=>{const {store,engine}=fixture();try{
 const s=engine.broker.strategies()[0],context=engine.context(s),now=Date.now();store.sample({id:'current',strategyId:s.id,start:now,context,token:TOKEN,entryPreparations:[{at:now,status:'ready'},{at:now+1,status:'ready'},{at:now+2,status:'failed',reason:'fee unknown'},{at:now+3,status:'expired',reason:'signal expired'}]});store.sample({id:'old',strategyId:s.id,start:now+10,context:'older-version',token:WALLET,entryPreparations:[{at:now+10,status:'ready'}]});const row=engine.diagnostics().find(d=>d.strategyId===s.id)!;
 assert.equal(row.signals,1);assert.equal(row.tokens,1);assert.equal(row.readySamples,1);assert.equal(row.readyPairs,2);assert.equal(row.failedPreparations,1);assert.equal(row.expiredPreparations,1);assert.equal(row.latestPreparationReason,'signal expired');assert.equal(row.filledOrders,0);assert.equal(engine.diagnostics(),engine.diagnostics());assert.equal(engine.broker.orders().length,0);
 }finally{store.close();}});

test('a paper swing experiment retries one transient preparation sweep within the original signal window',async()=>{const {store,gateway,engine}=fixture();try{
 const trial=engine.createExperiment('bsc-wallet-swing');let failures=7;gateway.beforeQuote=async()=>{if(failures-->0)throw Error('RPC_DEADLINE: foreground 报价/链头读取超过5秒预算');};await engine.startTape(trial,sourceTrade(gateway),'isolated bounded retry');const sample=store.samples(trial.id)[0] as ResearchSample;assert.equal(sample.entryPreparations!.filter(p=>p.status==='failed').length,7);assert.ok(sample.entryPreparations!.some(p=>p.status==='ready'));assert.equal(engine.broker.orders().length,1);assert.equal(engine.broker.orders()[0].accountId,trial.accountId);assert.ok(engine.broker.orders()[0].signalExpiresAt!<=sample.signalAt+60000);assert.equal(engine.broker.checks().passed,true);
 }finally{store.close();}});

test('paper experiment retries cannot extend an expired signal or repeatedly probe an unsupported route',async()=>{const {store,gateway,engine}=fixture();try{
 const trial=engine.createExperiment('bsc-wallet-swing'),event=sourceTrade(gateway);event.at=Date.now()-60001;event.receivedAt=event.at;await engine.startTape(trial,event,'isolated expired trial');assert.equal(gateway.requests.length,0);gateway.beforeQuote=async()=>{throw Error('安全数据报告无法卖出');};await engine.startTape(trial,sourceTrade(gateway),'isolated unsupported route');assert.equal(gateway.requests.length,7);assert.equal(engine.broker.orders().length,0);assert.equal(engine.broker.account(trial.accountId).nativeBalanceRaw,null);
 }finally{store.close();}});

test('pausing a paper experiment during transient preparation stops the remaining retry probes',async()=>{const {store,gateway,engine}=fixture();try{
 const trial=engine.createExperiment('bsc-wallet-swing');gateway.beforeQuote=async()=>{engine.strategyChange(trial.id,{action:'pause'});throw Error('RPC_DEADLINE: foreground 报价/链头读取超过5秒预算');};await engine.startTape(trial,sourceTrade(gateway),'isolated pause during retry');assert.equal(gateway.requests.length,1);assert.equal(engine.broker.orders().length,0);assert.equal(engine.broker.account(trial.accountId).nativeBalanceRaw,null);
 }finally{store.close();}});

test('actual long chain signal IDs produce valid stable paper orders and cannot duplicate across restart',async()=>{const {store,gateway,engine}=fixture();try{
 const trial=engine.createExperiment('bsc-wallet-swing'),event=sourceTrade(gateway);event.id='bsc:0x4ecf8b9828bc1392b1160238b99f1f0bee87e44f452eb2cfa7eb18740dc17b8d:0x68cd5b45ff75feee6db3e4f9fee0763fc983a05cebdbefaedbf69a39122cc196:0x19:wallet:0xbf004bff64725914ee36d03b87d6965b0ced4903';event.priceUsd=.0011;
 assert.ok(('bot:'+trial.id+':'+event.id).length>128);await engine.startTape(trial,event,'isolated actual-format signal');const order=engine.broker.orders()[0];assert.ok(order);assert.match(order.clientId,/^bot:[a-f0-9]{64}$/);assert.equal(order.accountId,trial.accountId);assert.equal(engine.broker.orders().length,1);const reserved=engine.broker.account(trial.accountId).reservedNativeRaw;
 await engine.startTape(trial,event,'isolated actual-format signal');assert.equal(engine.broker.orders().length,1);assert.equal(engine.broker.account(trial.accountId).reservedNativeRaw,reserved);assert.equal(engine.broker.fills().length,0);
 const restored=new Engine(store,gateway);await restored.startTape(restored.broker.strategies().find(s=>s.id===trial.id)!,event,'isolated actual-format signal');assert.equal(restored.broker.orders().length,1);assert.equal(restored.broker.orders()[0].clientId,order.clientId);assert.equal(restored.broker.orders()[0].status,'cancelled');assert.equal(restored.broker.account(trial.accountId).reservedNativeRaw,'0');assert.equal(restored.broker.checks().passed,true);assert.equal(restored.broker.account('bsc-wallet-swing').cashUsd,100);
 }finally{store.close();}});

test('paper preparation cannot gain extra signal lifetime from a backward wall clock correction',async t=>{const {store,gateway,engine}=fixture();try{
 const trial=engine.createExperiment('bsc-wallet-swing'),wall=Date.now(),event=sourceTrade(gateway);event.at=wall-59990;event.receivedAt=event.at;let clockShift=0;t.mock.method(Date,'now',()=>wall+clockShift);gateway.beforeQuote=async()=>{clockShift=-60000;await new Promise(r=>setTimeout(r,20));};await engine.startTape(trial,event,'isolated monotonic expiry');assert.equal(engine.broker.orders().length,0);assert.equal(engine.broker.account(trial.accountId).nativeBalanceRaw,null);assert.equal((store.samples(trial.id)[0] as ResearchSample).entryPreparations!.at(-1)?.status,'expired');
 }finally{t.mock.restoreAll();store.close();}});

test('experiment HTTP creation requires local CSRF, is idempotent, and cannot turn its account into a manual order endpoint',async()=>{
 const {store,engine}=fixture();const {makeServer}=await import('../src/server/server.js');const {createServer}=await import('node:net');const reservation=createServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));const port=(reservation.address() as {port:number}).port;await new Promise<void>(r=>reservation.close(()=>r()));const server=makeServer(engine,resolve('dist/web'),port);await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});const url=`http://127.0.0.1:${port}`,headers={'host':`127.0.0.1:${port}`,'content-type':'application/json'};
 try{const path='/api/strategies/bsc-wallet-short/experiment';const bad=await fetch(url+path,{method:'POST',headers:{...headers,'x-csrf-token':'wrong'},body:'{}'});assert.equal(bad.status,403);assert.equal(engine.broker.accounts().length,10);
 const foreign=await fetch(url+path,{method:'POST',headers:{...headers,'x-csrf-token':engine.csrf,origin:'https://example.invalid'},body:'{}'});assert.equal(foreign.status,403);assert.equal(engine.broker.accounts().length,10);
 const validHeaders={...headers,'x-csrf-token':engine.csrf};const first=await fetch(url+path,{method:'POST',headers:validHeaders,body:'{}'});assert.equal(first.status,200);const trial=(await first.json() as {strategy:Strategy}).strategy;assert.equal(trial.mode,'experiment');const again=await fetch(url+path,{method:'POST',headers:validHeaders,body:'{}'});assert.equal(again.status,200);assert.equal(engine.broker.accounts().length,11);
 const denied=await fetch(url+'/api/paper/orders',{method:'POST',headers:validHeaders,body:JSON.stringify({clientId:randomUUID(),accountId:trial.accountId,token:TOKEN,side:'buy',amountUsd:1,reason:'isolated attempted manual access'})});assert.equal(denied.status,400);assert.equal(engine.broker.orders().length,0);assert.equal(engine.broker.account(trial.accountId).nativeBalanceRaw,null);
 const view=await fetch(url+'/api/strategies',{headers:{host:headers.host}}).then(r=>r.json()) as {diagnostics:unknown[]};assert.equal(view.diagnostics.length,9);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();}
});
test('Engine archives actual pair-ready preparations and replays the candidate decision after a new block',async()=>{const {store,gateway,engine}=fixture();try{
 // Let real snapshot processing cross a millisecond boundary; never rewrite the clock or quote timestamps.
 const snapshot=engine.snapshot.bind(engine);engine.snapshot=(...args:Parameters<Engine['snapshot']>)=>{const until=performance.now()+2;while(performance.now()<until){}return snapshot(...args);};
 const strategy=engine.broker.strategies().find(s=>s.id==='bsc-momentum-short')!;await engine.startTape(strategy,sourceTrade(gateway),'隔离量价信号');const sample=store.samples(strategy.id)[0] as ResearchSample;
 assert.equal(sample.entry.at,sample.capturedAt);assert.equal(sample.entry.quotes.length,0,'preparations must not be backdated into the signal snapshot');assert.equal(sample.entryPreparations!.length,ENTRY_BUDGETS_USD.length);assert.deepEqual(sample.entryPreparations!.map(p=>p.budgetUsd),[...ENTRY_BUDGETS_USD]);
 for(const p of sample.entryPreparations!){assert.equal(p.status,'ready');assert.equal(p.at,p.receivedAt);assert.ok(p.at>=sample.capturedAt);assert.equal(p.buy!.quote.side,'buy');assert.equal(p.reverse!.quote.side,'sell');assert.equal(p.buy!.quote.block,p.block);assert.equal(p.reverse!.quote.block,p.block);assert.equal(p.reverse!.quote.inputRaw,p.buy!.quote.outputRaw);assert.equal(p.reverse!.quote.spentInputRaw,p.buy!.quote.outputRaw);assert.ok(p.buy!.quote.at<=p.buy!.receivedAt&&p.buy!.receivedAt<=p.at);assert.ok(p.reverse!.quote.at<=p.reverse!.receivedAt&&p.reverse!.receivedAt<=p.at);}
 assert.equal(sample.entryPreparations!.at(-1)!.last,true);assert.equal(engine.broker.orders().length,0,'research-only preparation cannot open the live account');await new Promise(r=>setTimeout(r,520));gateway.head++;await engine.captureTapes();
 const updated=store.samples(strategy.id)[0] as ResearchSample,replay=replayPortfolio([updated],strategy.rules,{chain:'bsc',from:sample.signalAt-1000,to:Date.now()+1}),attempt=replay.attempts[0],selected=attempt.preparations!.find(p=>p.disposition==='selected')!;
 assert.ok(selected,'this candidate must select an affordable prepared pair');assert.equal(attempt.decisionAt,selected.receivedAt);assert.equal(selected.budgetUsd,2);assert.ok(attempt.openedAt!==null&&attempt.openedAt>=attempt.decisionAt+500,'actual selection, not original signal time, starts the delay');assert.ok(attempt.fills[0].block>sample.entryPreparations!.find(p=>p.budgetUsd===selected.budgetUsd)!.block);
 const archivedFill=updated.later.flatMap(p=>p.quotes).find(q=>q.quote.id===attempt.fills[0].quoteId)!;assert.equal(archivedFill.quote.inputRaw,sample.entryPreparations!.find(p=>p.budgetUsd===selected.budgetUsd)!.buy!.quote.inputRaw);assert.equal(attempt.originalRaw,archivedFill.quote.outputRaw);
}finally{store.close();}});
test('exact odd quantities include target residual and all legacy stages',()=>{const sizes=exactExitQuantities('1001');for(const raw of ['1001','500','501','700','301','600','401','250','151','150','1'])assert.ok(sizes.includes(raw),raw+' missing');assert.ok(!sizes.includes('0'));});
test('restoring old backup cannot erase failed experiments or consumed final windows',()=>{const {store}=fixture();try{const before=store.backup(),window={runId:'sealed-run',from:100,to:200,dataHash:'known-failed'};store.archiveEvidence('failed-run','training','bsc-wallet-short',{allAttempts:[{netUsd:-1}],reason:'failed'});store.sealWindow('bsc-wallet-short',window);store.restore(before);assert.equal(store.sealedWindows('bsc-wallet-short').length,1);assert.equal(store.evidence('training','bsc-wallet-short')[0].allAttempts[0].netUsd,-1);assert.throws(()=>store.archiveEvidence('failed-run','training','bsc-wallet-short',{allAttempts:[{netUsd:1}]}),/禁止覆盖/);}finally{store.close();}});
test('configuration changes invalidate the old forward run and preserve its test window',()=>{const {store,engine}=fixture();try{const strategy=engine.broker.strategies().find(s=>s.id==='bsc-wallet-short')!,at=Date.now();const run:ResearchRun={id:randomUUID(),strategyId:strategy.id,status:'forward',createdAt:at,trainStart:at-21*86400000,trainEnd:at-7*86400000,validationEnd:at,forwardStart:at,forwardEnd:at+7*86400000,seed:1,dataHash:'old',selectedRules:strategy.rules,candidates:[],training:null,validation:null,forward:null,reason:'forward',promotedAt:null};store.put('research_runs',run);const old=engine.context(strategy);engine.strategyChange(strategy.id,{wallets:[{name:'新观察名单',address:WALLET}]});assert.equal(store.get<ResearchRun>('research_runs',run.id)?.status,'failed');assert.notEqual(engine.context(store.get<Strategy>('strategies',strategy.id)!),old);assert.equal(store.sealedWindows(strategy.id).length,1);}finally{store.close();}});
test('24-hour acceptance cannot inherit elapsed wall time or samples from persisted state',()=>{const {store,engine}=fixture();try{engine.codeHash='test-code';store.setMeta('soak',{startedAt:Date.now()-86400001,codeHash:engine.codeHash,runtimeId:engine.runtimeId,targetMs:86400000,samples:1440,connectedSamples:{bsc:1440,robinhood:1440},ledgerFailures:0,gaps:0,status:'running',completedAt:null});engine.healthSample();assert.equal(store.meta<any>('soak').status,'running');assert.equal(store.meta<any>('soak').samples,1);assert.equal(store.meta<any>('soak').elapsedMs,0);assert.equal(store.evidence('soak')[0].samples,1440);}finally{store.close();}});
test('public ABI bigints persist without precision loss or crashing events',()=>{const {store}=fixture();try{const id=randomUUID(),raw=(1n<<180n)+7n;store.event({id,chain:'bsc',at:Date.now(),block:1,payload:{amount:raw}} as any);assert.equal(store.events(0)[0].payload.amount,raw.toString());}finally{store.close();}});

type Fixture=ReturnType<typeof fixture>;
function buyInput(){return {clientId:randomUUID(),accountId:'manual-bsc',token:TOKEN,side:'buy' as const,amountUsd:1,reason:'isolated restore/reorg integration regression'};}
async function afterDeadline(order:PaperOrder){await new Promise(r=>setTimeout(r,Math.max(0,order.dueAt-Date.now())+20));}
async function seedFilledBook(f:Fixture){const order=await f.engine.broker.submit(buyInput());await afterDeadline(order);f.gateway.head++;await f.engine.broker.execute(order);assert.equal(f.store.get<PaperOrder>('orders',order.id)?.status,'filled');assert.equal(f.engine.broker.checks().passed,true);return f.engine.broker.fills()[0];}
function bookSnapshot(store:Store){return {accounts:store.all('accounts'),positions:store.all('positions'),orders:store.all('orders'),fills:store.all('fills'),ledger:store.db.prepare('SELECT * FROM ledger ORDER BY id').all(),marker:store.meta('integration-live-marker')};}
function corruptedFillBackup(store:Store,id:string,change:(fill:Record<string,any>)=>void){
 const path=resolve(store.dataDir,'corrupt-fixture-'+randomUUID()+'.sqlite');writeFileSync(path,store.backup());const db=new DatabaseSync(path);
 try{db.exec('PRAGMA journal_mode=DELETE');const row=db.prepare('SELECT payload FROM fills WHERE id=?').get(id) as {payload:string};const fill=JSON.parse(row.payload);change(fill);db.prepare('UPDATE fills SET payload=? WHERE id=?').run(JSON.stringify(fill),id);assert.equal((db.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check,'ok');}finally{db.close();}
 return readFileSync(path);
}
async function assertRejectedBeforeOverwrite(f:Fixture,backup:Buffer,reason:RegExp){
 f.store.setMeta('integration-live-marker',randomUUID());const original=f.store.db,before=bookSnapshot(f.store);await assert.rejects(()=>f.engine.restore(backup),reason);
 assert.equal(f.store.db,original,'invalid backup must not replace the live database handle');assert.deepEqual(bookSnapshot(f.store),before,'cash, fills, positions and live marker must remain untouched');assert.equal(f.engine.broker.stopped,false);assert.equal(f.engine.broker.checks().passed,true);
}

test('Engine restore accepts a valid filled ledger and preserves its exact cash and position',async()=>{const f=fixture();try{await seedFilledBook(f);const backup=f.store.backup(),before=bookSnapshot(f.store);await f.engine.restore(backup);assert.deepEqual(bookSnapshot(f.store),before);assert.equal(f.engine.broker.checks().passed,true);}finally{f.store.close();}});

test('Engine restore rejects corrupt fill numbers and fees before replacing the live ledger',async t=>{const f=fixture();try{const fill=await seedFilledBook(f);const cases:{name:string;change:(row:Record<string,any>)=>void}[]=[
 {name:'NaN-producing USD string',change:row=>{row.usd='not-a-number';}},
 {name:'numeric string is not an authoritative amount',change:row=>{row.usd=String(row.usd);}},
 {name:'nonnumeric cost basis',change:row=>{row.costBasisUsd='not-a-number';}},
 {name:'negative gas fee',change:row=>{row.fees.gasUsd=-1;}}
 ];for(const c of cases)await t.test(c.name,async()=>{const backup=corruptedFillBackup(f.store,fill.id,c.change);await assertRejectedBeforeOverwrite(f,backup,/成交金额、成本或费用无效/);});}finally{f.store.close();}});

test('Engine restore rejects cross-account, token, chain and missing-order fill ownership',async t=>{const f=fixture();try{const fill=await seedFilledBook(f);const cases:{name:string;change:(row:Record<string,any>)=>void}[]=[
 {name:'another existing account',change:row=>{row.accountId='manual-robinhood';}},
 {name:'another token',change:row=>{row.token=WALLET;}},
 {name:'another chain',change:row=>{row.chain='robinhood';}},
 {name:'missing parent order',change:row=>{row.orderId=randomUUID();}}
 ];for(const c of cases)await t.test(c.name,async()=>{const backup=corruptedFillBackup(f.store,fill.id,c.change);await assertRejectedBeforeOverwrite(f,backup,/成交与订单、持仓归属不一致/);});}finally{f.store.close();}});

function holdNextQuote(gateway:TapeGateway,side:'buy'|'sell'){
 let release!:()=>void,arrived!:()=>void,held=false;const started=new Promise<void>(r=>arrived=r),waiting=new Promise<void>(r=>release=r);
 gateway.beforeQuote=async request=>{if(!held&&request.side===side){held=true;arrived();await waiting;}};return {started,release};
}
function sourceTrade(gateway:TapeGateway):MarketEvent {const at=Date.now();return {id:randomUUID(),chain:'bsc',kind:'trade',block:gateway.head,at,receivedAt:at,token:TOKEN,side:'buy',priceUsd:gateway.price,amountUsd:1,payload:{verified:true}};}
function removal(original:MarketEvent):MarketEvent {const at=Date.now();return {...original,id:original.id+':removed',kind:'removed',at,receivedAt:at,payload:{removedEventId:original.id}};}

// Isolated admission fixture: this is not evidence that a real strategy passed research.
function runningStrategy(f:Fixture,id='bsc-momentum-short'){
 const strategy=f.engine.broker.strategies().find(s=>s.id===id)!,at=Date.now(),day=86400000;
 const run:ResearchRun={id:randomUUID(),strategyId:id,status:'passed',createdAt:at-7*day,trainStart:at-28*day,trainEnd:at-14*day,validationEnd:at-7*day,forwardStart:at-7*day,forwardEnd:at,seed:1,dataHash:'isolated-admission-only',selectedRules:structuredClone(strategy.rules),candidates:[],training:null,validation:null,forward:null,reason:'test-only passed record',promotedAt:at};
 strategy.state='running';strategy.version=randomUUID();strategy.researchRunId=run.id;if(strategy.family==='wallet')strategy.wallets=[{address:WALLET,name:'isolated source'}];f.store.put('research_runs',run);f.store.put('strategies',strategy);f.engine.broker.pauseAccount(strategy.accountId,false);return strategy;
}
function assertNoEntryCashflow(f:Fixture,accountId:string){
 const a=f.engine.broker.account(accountId);assert.equal(a.nativeBalanceRaw,null);assert.equal(a.reservedNativeRaw,'0');assert.equal(a.feesUsd,0);assert.equal(a.dayEntries,0);assert.equal(f.engine.broker.orders().length,0);assert.equal(f.engine.broker.fills().length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM ledger').get()!.n,0);assert.equal(f.engine.broker.checks().passed,true);
}

test('collector persists an eligible prepared pair and queues immediately despite later size failures',async()=>{
 const f=fixture();let release!:()=>void,arrived!:()=>void,held=false,pending:Promise<void>|undefined;const started=new Promise<void>(r=>arrived=r),waiting=new Promise<void>(r=>release=r);
 try{
  const strategy=runningStrategy(f);f.gateway.beforeQuote=async request=>{if(request.side==='buy'&&nativeUsd(request.nativeAmountRaw!,f.gateway.fx)<1.9){if(!held){held=true;arrived();await waiting;}throw Error('isolated later-size RPC failure');}};
  pending=f.engine.startTape(strategy,sourceTrade(f.gateway),'隔离准备流失败验证');await started;
  const prefix=f.store.samples(strategy.id)[0] as ResearchSample,order=f.engine.broker.orders()[0];assert.deepEqual(prefix.entryPreparations!.map(p=>p.budgetUsd),[5,3,2]);assert.ok(prefix.entryPreparations!.every(p=>p.status==='ready'));assert.equal(order.status,'queued');assert.equal(order.referenceQuote!.id,prefix.entryPreparations![2].buy!.quote.id);assert.equal(order.decisionAt>=prefix.entryPreparations![2].at,true);assert.equal(f.engine.broker.account(strategy.accountId).feesUsd,0,'preparing or rejecting later quotes cannot charge Gas');
  release();await pending;const completed=f.store.samples(strategy.id)[0] as ResearchSample;assert.deepEqual(completed.entryPreparations!.slice(0,3),prefix.entryPreparations);assert.equal(completed.source,'authoritative');assert.deepEqual(completed.entryPreparations!.slice(3).map(p=>p.status),['failed','failed','failed','failed']);assert.equal(completed.entryPreparations!.at(-1)!.last,true);assert.equal(f.engine.broker.orders().length,1);assert.equal(f.engine.broker.orders()[0].status,'queued');assert.equal(f.engine.broker.account(strategy.accountId).feesUsd,0);
  const replay=replayPortfolio([completed],strategy.rules,{chain:'bsc',from:completed.signalAt-1,to:Date.now()+1}),attempt=replay.attempts[0];assert.equal(attempt.decisionAt,prefix.entryPreparations![2].at);assert.equal(attempt.preparations!.find(p=>p.disposition==='selected')!.budgetUsd,2);assert.equal(attempt.preparations!.slice(3).every(p=>p.disposition==='unused'),true);assert.equal(attempt.failures.length,4);assert.equal(attempt.feesUsd,0);assert.equal(attempt.fills.length,0);assert.equal(replay.authoritative,false,'failed preparations remain missing-data evidence');assert.equal(f.engine.broker.checks().passed,true);
 }finally{release();if(pending)await pending.catch(()=>{});f.store.close();}
});

test('collector rejects an already expired wallet signal without quotes, deposit, reservation or Gas',async()=>{
 const f=fixture();try{
  const strategy=runningStrategy(f,'bsc-wallet-short'),event={...sourceTrade(f.gateway),kind:'wallet' as const,wallet:WALLET,firstBuy:true,at:Date.now()-6000};await f.engine.startTape(strategy,event,'隔离过期钱包信号');
  const sample=f.store.samples(strategy.id)[0] as ResearchSample;assert.equal(f.gateway.requests.length,0);assert.equal(sample.entryPreparations!.length,1);assert.equal(sample.entryPreparations![0].status,'expired');assert.equal(sample.entryPreparations![0].last,true);assertNoEntryCashflow(f,strategy.accountId);
  const replay=replayPortfolio([sample],strategy.rules,{chain:'bsc',from:event.at-1,to:Date.now()+1});assert.equal(replay.attempts[0].fills.length,0);assert.equal(replay.attempts[0].feesUsd,0);assert.equal(replay.attempts[0].outlayUsd,0);
 }finally{f.store.close();}
});

test('collector records preparation expiry after awaited quotes without entering or charging Gas',async()=>{
 const f=fixture();let gate:ReturnType<typeof holdNextQuote>|undefined,pending:Promise<void>|undefined;try{
  const strategy=runningStrategy(f,'bsc-wallet-short'),event={...sourceTrade(f.gateway),kind:'wallet' as const,wallet:WALLET,firstBuy:true,at:Date.now()-4600};gate=holdNextQuote(f.gateway,'sell');pending=f.engine.startTape(strategy,event,'隔离报价期间过期');await gate.started;await new Promise(r=>setTimeout(r,Math.max(0,event.at+5000-Date.now())+20));gate.release();await pending;
  const sample=f.store.samples(strategy.id)[0] as ResearchSample;assert.ok(f.gateway.requests.some(r=>r.side==='buy'));assert.ok(f.gateway.requests.some(r=>r.side==='sell'));assert.equal(sample.entryPreparations!.length,1);assert.equal(sample.entryPreparations![0].status,'expired');assert.ok(sample.entryPreparations![0].at>=event.at+5000);assert.equal(sample.entryPreparations![0].buy,undefined);assertNoEntryCashflow(f,strategy.accountId);
  const replay=replayPortfolio([sample],strategy.rules,{chain:'bsc',from:event.at-1,to:Date.now()+1});assert.equal(replay.attempts[0].fills.length,0);assert.equal(replay.attempts[0].feesUsd,0);assert.equal(replay.attempts[0].outlayUsd,0);
 }finally{gate?.release();if(pending)await pending.catch(()=>{});f.store.close();}
});

test('research tape capacity does not block a validated live paper entry or demote its quotes',async()=>{
 const f=fixture();try{
  const waiting=f.engine.broker.strategies().find(s=>s.id==='bsc-momentum-short')!;for(let i=0;i<4;i++)await f.engine.startTape(waiting,sourceTrade(f.gateway),'隔离研究容量');assert.equal(f.engine.state().health.activeResearchTapes,4);
  const strategy=runningStrategy(f),offset=f.gateway.requests.length;await f.engine.startTape(strategy,sourceTrade(f.gateway),'隔离容量满时实时模拟');const samples=f.store.samples(strategy.id) as ResearchSample[],sample=samples.at(-1)!;
  assert.equal(samples.length,5);assert.equal(sample.source,'estimated');assert.match(sample.reason,/容量已满/);assert.equal(sample.entryPreparations!.length,ENTRY_BUDGETS_USD.length);assert.ok(sample.entryPreparations!.every(p=>p.status==='ready'));assert.equal(f.engine.state().health.activeResearchTapes,4);assert.ok(f.gateway.requests.slice(offset).length>0);assert.ok(f.gateway.requests.slice(offset).every(r=>r.background===false),'live admission must retain foreground priority');
  const order=f.engine.broker.orders()[0];assert.equal(f.engine.broker.orders().length,1);assert.equal(order.accountId,strategy.accountId);assert.equal(order.status,'queued');assert.equal(order.referenceQuote!.id,sample.entryPreparations![2].buy!.quote.id);assert.equal(f.engine.broker.account(strategy.accountId).feesUsd,0);assert.equal(f.engine.broker.fills().length,0);await f.engine.broker.execute(order);assert.equal(f.engine.broker.orders()[0].status,'queued','preparation does not bypass the 500ms/new-block requirement');
  const replay=replayPortfolio([sample],strategy.rules,{chain:'bsc',from:sample.signalAt-1,to:Date.now()+1});assert.equal(replay.attempts[0].fills.length,0);assert.equal(replay.authoritative,false,'capacity gaps cannot become promotion evidence');assert.equal(f.engine.broker.checks().passed,true);
 }finally{f.store.close();}
});

test('Engine reorg invalidates an outstanding collector pair without late sample overwrite or live cashflow',async()=>{
 const f=fixture();let gate:ReturnType<typeof holdNextQuote>|undefined,pending:Promise<void>|undefined;try{
  const strategy=runningStrategy(f),event=sourceTrade(f.gateway);gate=holdNextQuote(f.gateway,'sell');pending=f.engine.startTape(strategy,event,'隔离准备期间重组');await gate.started;assert.equal((f.store.samples(strategy.id)[0] as ResearchSample).entryPreparations!.length,0);const quotes=f.store.db.prepare('SELECT COUNT(*) n FROM quotes').get()!.n;
  await f.engine.receive(removal(event));const afterRemoval=f.store.samples(strategy.id)[0] as ResearchSample;assert.equal(afterRemoval.later.at(-1)!.removed,true);gate.release();await pending;assert.deepEqual(f.store.samples(strategy.id)[0],afterRemoval,'a cancelled capture must not replace the recorded reorg');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM quotes').get()!.n,quotes);assertNoEntryCashflow(f,strategy.accountId);
 }finally{gate?.release();if(pending)await pending.catch(()=>{});f.store.close();}
});

test('collector rechecks current pause and configuration before using an awaited prepared pair',async t=>{
 const changes:{name:string;strategyId?:string;apply:(f:Fixture,s:Strategy)=>void}[]=[
  {name:'operator pause',apply:(f,s)=>{f.engine.strategyChange(s.id,{action:'pause'});}},
  {name:'new exit-rule revision',apply:(f,s)=>{f.engine.strategyChange(s.id,{rules:exitGrid(s.horizon).find(c=>JSON.stringify(c.rules)!==JSON.stringify(s.rules))!.rules});}},
  {name:'new wallet list',strategyId:'bsc-wallet-short',apply:(f,s)=>{f.engine.strategyChange(s.id,{wallets:[{name:'replacement source',address:TOKEN}]});}},
  {name:'risk revision',apply:f=>{f.engine.riskChange({...f.engine.broker.risk,riskPct:.4});}}
 ];for(const change of changes)await t.test(change.name,async()=>{
  const f=fixture();let gate:ReturnType<typeof holdNextQuote>|undefined,pending:Promise<void>|undefined;try{
   const strategy=runningStrategy(f,change.strategyId),event=sourceTrade(f.gateway);if(strategy.family==='wallet'){event.kind='wallet';event.wallet=WALLET;event.firstBuy=true;}gate=holdNextQuote(f.gateway,'sell');pending=f.engine.startTape(strategy,event,'隔离入场准备后配置重检');await gate.started;change.apply(f,strategy);const current=structuredClone(f.store.get<Strategy>('strategies',strategy.id)!);gate.release();await pending;
   assert.deepEqual(f.store.get<Strategy>('strategies',strategy.id),current,'capture failures must not resurrect the old running configuration');assert.equal(f.engine.broker.account(strategy.accountId).paused,true);assertNoEntryCashflow(f,strategy.accountId);assert.ok((f.store.samples(strategy.id)[0] as ResearchSample).entryPreparations!.some(p=>p.status==='ready'),'research quotes can still be recorded without reopening the live account');
  }finally{gate?.release();if(pending)await pending.catch(()=>{});f.store.close();}
 });
});

test('Engine reorg cancels queued orders and rejects an outstanding initial quote without new cashflow',async()=>{const f=fixture();let gate:ReturnType<typeof holdNextQuote>|undefined,pending:Promise<PaperOrder>|undefined;try{
 const original=sourceTrade(f.gateway);await f.engine.receive(original);const queued=await f.engine.broker.submit(buyInput()),balance=f.engine.broker.account('manual-bsc').nativeBalanceRaw,quotes=f.store.db.prepare('SELECT COUNT(*) n FROM quotes').get()!.n;
 gate=holdNextQuote(f.gateway,'buy');pending=f.engine.broker.submit(buyInput());void pending.catch(()=>{});await gate.started;assert.equal(f.engine.broker.activeSubmissions,1);
 await f.engine.receive(removal(original));assert.equal(f.store.get<PaperOrder>('orders',queued.id)?.status,'cancelled');assert.match(f.store.get<PaperOrder>('orders',queued.id)!.error,/重组/);assert.equal(f.engine.broker.account('manual-bsc').reservedNativeRaw,'0');
 gate.release();await assert.rejects(pending,/失效/);assert.equal(f.engine.broker.activeSubmissions,0);assert.equal(f.engine.broker.orders().length,1);assert.equal(f.engine.broker.fills().length,0);assert.equal(f.engine.broker.account('manual-bsc').nativeBalanceRaw,balance);assert.equal(f.engine.broker.account('manual-bsc').feesUsd,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM quotes').get()!.n,quotes);assert.equal(f.engine.broker.checks().passed,true);
 }finally{gate?.release();if(pending)await pending.catch(()=>{});f.store.close();}});

test('Engine reorg invalidates a fill already awaiting its reverse quote and releases funds without Gas',async()=>{const f=fixture();let gate:ReturnType<typeof holdNextQuote>|undefined,executing:Promise<void>|undefined;try{
 const original=sourceTrade(f.gateway);await f.engine.receive(original);const order=await f.engine.broker.submit(buyInput()),balance=f.engine.broker.account('manual-bsc').nativeBalanceRaw;await afterDeadline(order);f.gateway.head++;
 gate=holdNextQuote(f.gateway,'sell');executing=f.engine.broker.execute(order);void executing.catch(()=>{});await gate.started;assert.equal(f.store.get<PaperOrder>('orders',order.id)?.status,'quoting');assert.ok(f.engine.broker.inFlight.has(order.id));
 await f.engine.receive(removal(original));gate.release();await executing;assert.equal(f.store.get<PaperOrder>('orders',order.id)?.status,'failed');assert.match(f.store.get<PaperOrder>('orders',order.id)!.error,/失效/);assert.equal(f.engine.broker.inFlight.size,0);assert.equal(f.engine.broker.account('manual-bsc').reservedNativeRaw,'0');assert.equal(f.engine.broker.account('manual-bsc').nativeBalanceRaw,balance);assert.equal(f.engine.broker.account('manual-bsc').feesUsd,0);assert.equal(f.engine.broker.positions().length,0);assert.equal(f.engine.broker.fills().length,0);assert.equal(f.engine.broker.checks().passed,true);
 }finally{gate?.release();if(executing)await executing.catch(()=>{});f.store.close();}});

for(const horizon of ['short','swing'] as const)test('approved '+horizon+' rules create an archived waiting revision and retire the old forward run',()=>{
 const {store,engine}=fixture();try{
  const strategy=engine.broker.strategies().find(s=>s.id==='bsc-momentum-'+horizon)!,at=Date.now();
  const run:ResearchRun={id:randomUUID(),strategyId:strategy.id,status:'forward',createdAt:at,trainStart:at-21*86400000,trainEnd:at-7*86400000,validationEnd:at,forwardStart:at,forwardEnd:at+7*86400000,seed:1,dataHash:'previous-rule-evidence',selectedRules:structuredClone(strategy.rules),candidates:[],training:null,validation:null,forward:null,reason:'sealed forward fixture',promotedAt:null};
  strategy.researchRunId=run.id;store.put('strategies',strategy);store.put('research_runs',run);const previous=structuredClone(strategy),context=engine.context(strategy),candidate=exitGrid(horizon).find(c=>JSON.stringify(c.rules)!==JSON.stringify(strategy.rules))!;
  assert.ok(candidate);assert.throws(()=>engine.strategyChange(strategy.id,{rules:candidate.rules,action:'resume'}),/新实验版本需要先通过独立验证/);assert.deepEqual(store.get<Strategy>('strategies',strategy.id),previous);assert.equal(store.evidence('configuration',strategy.id).length,0);
  const changed=engine.strategyChange(strategy.id,{rules:candidate.rules});assert.notEqual(changed.version,previous.version);assert.deepEqual(changed.rules,candidate.rules);assert.equal(changed.state,'waiting');assert.equal(changed.researchRunId,null);assert.equal(store.meta('revision:'+strategy.id),changed.version);assert.notEqual(engine.context(changed),context);assert.equal(engine.broker.account(changed.accountId).paused,true);assert.ok((store.meta<number>('recordingSince:'+strategy.id)??0)>=at);
  const retired=store.get<ResearchRun>('research_runs',run.id)!;assert.equal(retired.status,'failed');assert.deepEqual(retired.selectedRules,run.selectedRules);assert.deepEqual(store.sealedWindows(strategy.id).map(w=>({runId:w.runId,from:w.from,to:w.to})),[{runId:run.id,from:run.forwardStart,to:run.forwardEnd}]);
  const archives=store.evidence('configuration',strategy.id);assert.equal(archives.length,1);assert.deepEqual(archives[0].previous,previous);assert.equal(archives[0].next.version,changed.version);assert.deepEqual(archives[0].next.rules,candidate.rules);
  assert.throws(()=>engine.strategyChange(strategy.id,{action:'resume'}),/需要先通过独立验证/);assert.throws(()=>engine.strategyChange(strategy.id,{rules:{...candidate.rules,stopPct:candidate.rules.stopPct+1}}),/32种研究候选参数/);assert.deepEqual(store.get<Strategy>('strategies',strategy.id),changed);assert.equal(store.evidence('configuration',strategy.id).length,1);assert.equal(engine.broker.checks().passed,true);
 }finally{store.close();}
});

test('stopRobots persists all eight paused groups across restart and rejects unvalidated resume',()=>{
 const {store,engine,gateway}=fixture();let reopened:Store|undefined,closed=false;try{
  const previous=engine.broker.strategies().map(s=>({id:s.id,version:s.version})),manualBefore=engine.broker.accounts().filter(a=>a.kind==='manual');assert.equal(previous.length,8);
  const stopped=engine.stopRobots();assert.equal(stopped.length,8);assert.deepEqual(stopped.map(s=>({id:s.id,version:s.version})),previous);assert.ok(stopped.every(s=>s.state==='paused'));for(const s of stopped){assert.equal(engine.broker.account(s.accountId).paused,true);assert.equal(store.meta('operatorPaused:'+s.id),true);assert.throws(()=>engine.strategyChange(s.id,{action:'resume'}),/需要先通过独立验证/);}
  assert.deepEqual(engine.broker.accounts().filter(a=>a.kind==='manual'),manualBefore);assert.ok(engine.stopRobots().every(s=>s.state==='paused'));assert.equal(engine.broker.checks().passed,true);
  store.close();closed=true;reopened=new Store(store.dataDir);const restarted=new Engine(reopened,gateway),persisted=restarted.broker.strategies();assert.equal(persisted.length,8);assert.ok(persisted.every(s=>s.state==='paused'));for(const s of persisted){assert.equal(reopened.meta('operatorPaused:'+s.id),true);assert.equal(restarted.broker.account(s.accountId).paused,true);assert.throws(()=>restarted.strategyChange(s.id,{action:'resume'}),/需要先通过独立验证/);assert.equal(reopened.get<Strategy>('strategies',s.id)?.state,'paused');assert.equal(reopened.meta('operatorPaused:'+s.id),true);}assert.equal(restarted.broker.checks().passed,true);
 }finally{if(reopened)reopened.close();else if(!closed)store.close();}
});

test('research history keeps archived final status visible after restoring an older active run',async t=>{
 const cases:[ResearchRun['status'],ResearchRun['status']][]=[['collecting','failed'],['training','passed'],['forward','error']];
 for(const [oldStatus,finalStatus] of cases)await t.test(oldStatus+' restored after '+finalStatus,async()=>{
  const f=fixture();try{
   const strategy=f.engine.broker.strategies().find(s=>s.id==='bsc-wallet-short')!,at=Date.now();
   const old:ResearchRun={id:randomUUID(),strategyId:strategy.id,status:oldStatus,createdAt:at,trainStart:at-21*86400000,trainEnd:at-7*86400000,validationEnd:at,forwardStart:at,forwardEnd:at+7*86400000,seed:1,dataHash:'isolated-history-input',selectedRules:strategy.rules,candidates:[],training:null,validation:null,forward:null,reason:'old in-progress snapshot',promotedAt:null};
   f.store.put('research_runs',old);const backup=f.store.backup();assert.equal(f.engine.researchRuns().find(r=>r.id===old.id)!.status,oldStatus,'prime the archive cache before new evidence');
   const final={...old,status:finalStatus,reason:'immutable final '+finalStatus};f.store.archiveEvidence('isolated-final:'+old.id,'training',strategy.id,{run:final});assert.equal(f.engine.researchRuns().find(r=>r.id===old.id)!.status,finalStatus,'new archive evidence must invalidate the cached summary');
   await f.engine.restore(backup);assert.equal(f.store.get<ResearchRun>('research_runs',old.id)!.status,oldStatus);const visible=f.engine.state().researchRuns.find(r=>r.id===old.id)!;assert.equal(visible.status,finalStatus);assert.equal(visible.reason,final.reason);assert.equal(f.store.evidence('training',strategy.id).find(e=>e.run?.id===old.id)!.run.status,finalStatus);
   f.store.put('research_runs',{...final,reason:'current final SQL status'});assert.equal(f.engine.researchRuns().find(r=>r.id===old.id)!.reason,'current final SQL status','a current final record still takes precedence');assert.equal(f.engine.broker.checks().passed,true);
  }finally{f.store.close();}
 });
});
