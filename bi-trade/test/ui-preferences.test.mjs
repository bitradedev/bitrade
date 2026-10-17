import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const web=resolve(dirname(fileURLToPath(import.meta.url)),'../web');
test('manual trading renders both languages, escapes token names and keeps missing values unknown without provider details',()=>{
 for(const language of ['en','zh']){
  const host={innerHTML:''},context={BiUI:{language,locale:language==='en'?'en-US':'zh-CN'},document:{activeElement:null,querySelector:s=>s==='#trade-main'?host:s==='#chart-region'?null:{addEventListener(){},scrollTop:0},addEventListener(){},getElementById(){return null}},setInterval(){}};
  vm.createContext(context);vm.runInContext(readFileSync(resolve(web,'trade.js'),'utf8').replace('void boot();',''),context);
  vm.runInContext(`chosen={token:'0x'+'11'.repeat(20),symbol:'<img src=x onerror=alert(1)>',priceUsd:null,at:null,stage:'curve',reserveUsd:null,buyTaxPct:null,sellTaxPct:null};markets=[chosen];book={account:{balanceUsd:1000,balanceWei:'500000000000000000',realizedUsd:0,feesUsd:0,pending:0},positions:[],orders:[],fills:[]};render();`,context);
  assert.match(host.innerHTML,/&lt;img/);assert.doesNotMatch(host.innerHTML,/<img src=x|OpenAI|Cloudflare|rpc\.mainnet|connecting|正在连接/i);
  assert.match(host.innerHTML,/30%/);assert.match(host.innerHTML,/—/);assert.doesNotMatch(host.innerHTML,/NaN|undefined|\bnull\b/);
  if(language==='en')assert.doesNotMatch(host.innerHTML,/[\u4e00-\u9fff]/);else assert.match(host.innerHTML,/手动模拟交易/);
 }
});
function preferences(values={}){
 const readKeys=[],root={dataset:{}},context={window:{},localStorage:{getItem:key=>{readKeys.push(key);return values[key]??null;}},document:{documentElement:root,readyState:'loading',addEventListener(){}}};vm.createContext(context);
 for(const file of ['ui-catalog.js','ui-preferences.js'])vm.runInContext(readFileSync(resolve(web,file),'utf8'),context);
 return {ui:context.window.BiUI,root,readKeys,catalog:context.window.BI_UI_EN,context};
}
test('appearance preferences default to the approved light palette and accept only supported values',()=>{
 const first=preferences();assert.equal(first.root.dataset.theme,'light');assert.equal(first.root.lang,'en');assert.equal(first.ui.locale,'en-US');assert.deepEqual(first.readKeys,['bi-ui-theme','bi-ui-language']);
 const chosen=preferences({'bi-ui-theme':'dark','bi-ui-language':'en'});assert.equal(chosen.root.dataset.theme,'dark');assert.equal(chosen.root.lang,'en');assert.equal(chosen.ui.locale,'en-US');
 const invalid=preferences({'bi-ui-theme':'injected-value','bi-ui-language':'<script>'});assert.equal(invalid.root.dataset.theme,'light');assert.equal(invalid.ui.language,'en');
 const chinese=preferences({'bi-ui-language':'zh'});assert.equal(chinese.root.lang,'zh-CN');assert.equal(chinese.ui.language,'zh');assert.equal(chinese.ui.locale,'zh-CN');
});
test('English UI translation preserves order actions, asset addresses, amounts, and HTML structure',()=>{
 const {ui}=preferences({'bi-ui-language':'en'}),address='0x1111111111111111111111111111111111111111';
 const html='<button data-action="demo-sell" data-id="agent-1" data-token="'+address+'" data-amount="123">模拟卖出</button>';
 assert.equal(ui.t(html),html.replace('模拟卖出','Paper sell'));
 assert.equal(ui.t('<select aria-label="交易类型"><option value="paper">模拟交易</option></select>'),'<select aria-label="Trade type"><option value="paper">Paper trading</option></select>');
 assert.equal(ui.t('钱包地址">⧉</button>'),' wallet address">⧉</button>');
 assert.equal(ui.t('已实现盈亏</span><b class="'),'Realized profit / loss</span><b class="');
});
test('user-authored names, strategies, and unrecognized decision summaries stay in their original language',()=>{
 const {ui}=preferences({'bi-ui-language':'en'}),user={source:'user',name:'BI 趋势猎手',strategy:{name:'趋势动量',description:'我的自定义策略，不要改写。'}};
 assert.equal(ui.agentName(user),user.name);assert.equal(ui.strategyName(user),user.strategy.name);assert.equal(ui.strategyDescription(user),user.strategy.description);
 const builtin={...user,source:'builtin'};assert.equal(ui.agentName(builtin),'BI Trend Hunter');assert.equal(ui.strategyName(builtin),'Trend momentum');
 assert.equal(ui.systemMessage('这是 Agent 原始决策：等待下一根 K 线。'),'这是 Agent 原始决策：等待下一根 K 线。');
 assert.equal(ui.systemMessage('等待站点管理员配置 OpenAI API 密钥；尚未启动 AI 决策。'),'This evaluation has not been updated yet.');
 assert.equal(ui.systemMessage('AI 评估期间账户或持仓已变化，旧提案已取消，等待重新评估。'),'The account or positions changed while AI was evaluating. The previous proposal was cancelled; awaiting reassessment.');
 assert.equal(ui.systemMessage('持仓在核价期间改变，稍后重新检查'),'Positions changed during quote verification. They will be checked again.');
 assert.equal(ui.systemMessage('持仓风险资料时间未核实，需要重新核查'),'The holder-risk timestamp was not verified. A fresh check is required');
});
test('Paper account UI offers browser sessions and hides wallet/live controls in both languages while retaining account actions',()=>{
 for(const language of ['zh','en']){
  const {ui,context}=preferences({'bi-ui-language':language}),app=readFileSync(resolve(web,'app.js'),'utf8');context.BiUI=ui;
  vm.runInContext(app.slice(0,app.indexOf('const docSections=')),context);
  context.avatarSrc=()=>'/agent-trend-v1.png';context.archivedAccounts=()=>'';context.legacyBscPanel=()=>'';context.activityTable=()=>'';
  const login=context.dashboard();assert.match(login,/data-action="guest"/);assert.doesNotMatch(login,/data-action="login"/);assert.ok(login.includes(language==='en'?'No wallet required':'无需连接钱包'));
  context.stateInput={owner:{id:'owner',kind:'demo',address:null},liveEnabled:false,agents:[],orders:[],activity:[]};vm.runInContext('S=stateInput',context);
  const emptyAccount=context.dashboard();assert.match(emptyAccount,/data-action="pair"/);assert.doesNotMatch(emptyAccount,/data-action="login"/);
  const a={id:'agent-1',name:'My Agent',mode:'paper',source:'user',connectionState:'awaiting-agent',paused:false,public:false,address:'0x'+'11'.repeat(20),policy:{mode:'balance'},paper:{balanceUsd:1000,realizedUsd:-2,realizedNativeRaw:'-1',positions:[{token:'0x'+'22'.repeat(20),symbol:'HELD',remainingRaw:'1000000000000000000',decimals:18,estimatedValueUsd:5}]}};
  const card=context.agentCard(a,0);assert.match(card,/\$1,000\.00/);assert.match(card,/-\$2\.00/);assert.match(card,/data-action="pause"/);assert.match(card,/data-action="reconnect"/);assert.match(card,/data-action="archive"/);assert.match(card,/data-action="strategy"/);assert.doesNotMatch(card,/data-action="(?:login|fund|withdraw|recover|mode|policy|copy-wallet|demo-trade|demo-sell)"/);
  context.stateInput.liveEnabled=true;vm.runInContext('S=stateInput',context);assert.match(context.agentCard(a,0),/data-action="fund"/);
 }
});

test('public strategy details render saved exit rules in both languages and keep unknown plans unknown',async()=>{
 for(const language of ['zh','en']){
  const {ui,context}=preferences({'bi-ui-language':language});let shown;
  context.BiUI=ui;context.matchMedia=()=>({matches:false,addEventListener(){}});context.window.addEventListener=()=>{};
  const app=readFileSync(resolve(web,'app.js'),'utf8').split('\n');
  vm.runInContext(app.slice(1,app.findIndex(line=>line.startsWith('const statusLabel='))).join('\n')+'\n'+app.find(line=>line.startsWith('const pill=')),context);
  vm.runInContext(readFileSync(resolve(web,'home.js'),'utf8'),context);
  const plan={token:'0x'+'11'.repeat(20),symbol:'<script>bad</script>',costUsd:150.01,state:'active',deadlineAt:Date.now()+3600000,rule:{takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60}};
  const agent={id:'showcase-trend',name:'BI 趋势猎手',source:'builtin',mode:'paper',avatar:'trend',address:plan.token,strategy:{name:'趋势动量',description:'策略描述'},realizedUsd:0,returnPct:0,positions:1,settledSales:0,exitPlans:[plan]};
  context.api=async()=>({agent,activity:[]});context.modal=(_title,html)=>{shown=html;};context.avatarSrc=()=>'/agent-trend-v1.png';context.avatarNames={trend:'Trend'};context.activityTable=()=>'';
  await context.publicProfile(agent.id);
  assert.match(shown,/exit-plans/);assert.match(shown,/\+10%/);assert.match(shown,/−5%/);assert.match(shown,/&lt;script&gt;bad&lt;\/script&gt;/);assert.doesNotMatch(shown,/<script>bad/);
  assert.ok(shown.includes(language==='en'?'Current exit plan':'当前退出计划'));
  assert.ok(shown.includes(language==='en'?'60 minutes':'60 分钟'));
  agent.exitPlans=[{...plan,state:'missing',rule:null,deadlineAt:null}];const missing=context.exitPlanPanel(agent);
  assert.doesNotMatch(missing,/\+10%|−5%/);assert.ok(missing.includes(language==='en'?'Automatic exit rules unavailable':'未取得自动退出规则'));
  agent.exitPlans=[{...plan,state:'ai-managed',rule:{takeProfitPct:null,stopLossPct:null,maxHoldMinutes:null},previousRule:plan.rule,deadlineAt:null}];const managed=context.exitPlanPanel(agent);
  assert.ok(managed.includes(language==='en'?'AI-managed exit':'AI 自主退出'));assert.doesNotMatch(managed,/\+10%|−5%|null|0 minutes/);
  assert.ok(managed.includes(language==='en'?'historical context':'历史参考'));
  agent.exitPlans=[{...plan,rule:{takeProfitPct:null,stopLossPct:5,maxHoldMinutes:null},deadlineAt:null}];const optional=context.exitPlanPanel(agent);
  assert.ok(optional.includes(language==='en'?'No fixed condition':'未设置固定条件'));assert.match(optional,/−5%/);assert.doesNotMatch(optional,/\+0%|null/);
  assert.equal(context.exitPlanPanel({...agent,source:'user'}),'');assert.equal(context.exitPlanPanel({...agent,exitPlans:[]}),'');
  agent.runtime={state:'observing',reason:'等待退出报价',exitFailures:[{token:plan.token,at:Date.now()}]};await context.publicProfile(agent.id);
  assert.match(shown,/exit-failures/);assert.ok(shown.includes(language==='en'?'Exit quote awaiting retry':'退出报价待重试'));
  agent.runtime.exitFailures=[];await context.publicProfile(agent.id);assert.doesNotMatch(shown,/exit-failures/);assert.equal(context.exitFailurePanel({...agent,source:'user',runtime:{exitFailures:[{token:plan.token,at:Date.now()}]}}),'');
  agent.runtime.lastExecution={status:'failed',at:Date.now(),reason:'本次未成交，等待后续评估。'};await context.publicProfile(agent.id);
  assert.ok(shown.includes(language==='en'?'Latest execution:':'最近下单结果：'));assert.ok(shown.includes(language==='en'?'No fill was created':'本次未成交'));assert.ok(shown.includes(language==='en'?'Order not submitted':'下单未完成'));
  agent.runtime.lastExecution={status:'pending',at:Date.now(),reason:'AI 已提出交易，正在核对当前行情与风险。'};assert.ok(context.executionNote(agent).includes(language==='en'?'Proposal awaiting execution':'提案待执行'));
  agent.riskReviews=[{token:plan.token,buyAllowed:true,policy:'robinhood-pons-v2-paper-v1',reasons:[],warnings:['Meme 模拟采用已观测风险筛查；完整捆绑、老鼠仓、同源资金和黑名单能力仍可能未知，不能视为安全保证。'],metrics:{bundlerObservedFloatShare:null,bundlerVolumeShare:null,transferSample:{available:true,fromBlock:100,toBlock:300,clusters:[]}}}];
  await context.publicProfile(agent.id);assert.ok(shown.includes(language==='en'?'Pons V2 paper trading · Limited checks':'Pons V2 模拟 · 有限检测'));assert.ok(shown.includes(language==='en'?'Unknown':'未知'));assert.match(shown,/100 – 300/);assert.doesNotMatch(context.riskReviewPanel(agent),/0\.00%/);assert.ok(shown.includes(language==='en'?'not a safety guarantee':'不能视为安全保证'));
  agent.runtime={state:'waiting-ai',model:'gpt-internal-model',reason:'OpenAI 请求超时或网络不可用',lastDecisionAt:Date.now()-120000,aiRetryAt:Date.now()+60000,decision:{action:'hold',reason:'上次真实评估结论'}};
  await context.publicProfile(agent.id);assert.match(shown,/上次真实评估结论/);assert.doesNotMatch(shown,/OpenAI|gpt-internal|连接|Waiting for the AI|等待 AI/);
 }
});

test('A storage outage renders an explicit bilingual pause without invented balances and backs off refreshes',async()=>{
 for(const language of ['zh','en']){
  const {ui,context}=preferences({'bi-ui-language':language}),app=readFileSync(resolve(web,'app.js'),'utf8'),nodes=new Map();
  for(const id of ['content','public-wallets','ranking-board'])nodes.set('#'+id,{innerHTML:'',prepend(el){nodes.set('#'+el.id,el);}});
  context.document.querySelector=id=>nodes.get(id);context.document.createElement=()=>({remove(){nodes.delete('#'+this.id);}});
  context.location={pathname:'/home',origin:'https://bitrade.site'};context.BiUI=ui;
  vm.runInContext(app.slice(0,app.indexOf('const docSections=')),context);
  const retryAt=Date.now()+3600000;let calls=0;context.fetch=async()=>{calls++;return {ok:false,status:503,json:async()=>({error:'云端存储仍返回额度限制，暂时无法读取账户与成交。服务恢复后自动重试；不会重置资金或历史。',code:'STORAGE_DAILY_QUOTA',retryAt})};};
  let error;try{await context.api('/api/state');}catch(e){error=e;}
  assert.equal(error.code,'STORAGE_DAILY_QUOTA');context.serviceFailure(error);
  const html=nodes.get('#service-status').innerHTML;assert.ok(html.includes(language==='en'?'Service temporarily paused':'服务暂时暂停'));assert.ok(html.includes(language==='en'?'Expected recovery:':'预计恢复时间：'));
  for(const id of ['public-wallets','ranking-board']){assert.ok(nodes.get('#'+id).innerHTML.includes(language==='en'?'Data temporarily unavailable':'数据暂时不可用'));assert.doesNotMatch(nodes.get('#'+id).innerHTML,/1,000|0\.00%/);}
  vm.runInContext(app.split('\n').find(line=>line.startsWith('async function refresh()')),context);await context.refresh();assert.equal(calls,1);
  context.serviceFailure({...error,retryAt:null});assert.doesNotMatch(nodes.get('#service-status').innerHTML,/Expected recovery|预计恢复时间/);context.serviceFailure({message:'<script>unsafe</script>'});assert.doesNotMatch(nodes.get('#service-status').innerHTML,/<script>/);context.serviceRecovered();assert.equal(nodes.has('#service-status'),false);
 }
});

test('public pages use only Robinhood / Pons V2, with no former chain contract or links in either language',()=>{
 for(const language of ['en','zh']){const {ui,context}=preferences({'bi-ui-language':language});context.BiUI=ui;const app=readFileSync(resolve(web,'app.js'),'utf8');vm.runInContext(app.split('\n').find(line=>line.startsWith('function docs(){')),context);const text=context.docs();assert.match(text,/Pons V2/);assert.match(text,/ETH/);assert.match(text,/30%/);assert.doesNotMatch(text,/Pancake|Flap|Binance|OpenAI/);if(language==='en')assert.doesNotMatch(text,/[\u4e00-\u9fff]/);}
 for(const file of ['app.js','home.js','index.html','intro.html','ui-catalog.js','agents.md'])assert.doesNotMatch(readFileSync(resolve(web,file),'utf8'),/BSC|BNB|Binance|bscscan|Pancake|Flap|c534742e/i);
});
