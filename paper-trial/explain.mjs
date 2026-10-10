import {RISK,RULES,MAX_ORDER_USD,EXTERNAL_WINDOW_MS,EXTERNAL_SIGNAL_AGE_MS,INNER_SIGNAL_AGE_MS,eligibleMarket,budgets} from './policy.mjs';

const finite=v=>typeof v==='number'&&Number.isFinite(v),positive=v=>finite(v)&&v>0;
const check=(label,status,value,threshold)=>({label,status,value,threshold});
const quality=value=>value==='verified'?'参考数据曾核实':value==='estimated'?'估计数据':'尚未核实';
export const REASONS={
 'fresh verified market data required':'行情不新鲜或覆盖中断，等待连续观察',
 'token age must be less than ten minutes':'币龄已超过新盘组10分钟范围',
 'need complete preceding sixty-second trade coverage':'连续观察不足60秒',
 'both thirty-second windows need verified trades':'前后两个30秒窗口都需要已核实成交',
 'no breakout of preceding thirty-second high':'当前价格没有突破前30秒高点',
 'latest volume is below twice preceding volume':'最新30秒成交量没有达到此前两倍',
 'buy volume is below 1.5 times sell volume':'买入金额没有达到卖出金额1.5倍',
 'new-token breakout, volume expansion and buy imbalance':'新盘突破、放量和买量条件同时满足，准备报价',
 'not a watched wallet buy':'不是本链观察名单中的钱包买入',
 'only first receipt-verified buy; ignore sells, adds and replay':'需要经回执核实的首买，排除卖出、加仓和历史重放',
 'wallet signal expired or future timestamp':'钱包信号超过60秒或时间无效',
 'both executable and target fill prices are required':'缺少目标成交价或当前参考价',
 'executable price is more than ten percent above target entry':'当前参考价格比目标买价高超过10%',
 'fresh first verified wallet buy within price premium cap':'观察钱包首买和价格条件满足，准备报价',
};
export function signalSummary(reason){return REASONS[reason]??reason;}

export function explainEvent({account,event,market,now,coverageStart,trades,wallets,result,blocked=null}){
 const age=finite(event.at)?Math.max(0,now-event.at):null,priceAge=finite(market?.updatedAt)?Math.max(0,now-market.updatedAt):null;
 const checks=[check('成交回执核实',event.payload?.verified===true?'pass':'fail',event.payload?.verified===true?'已核实':'未核实','必须有成功回执及协议净流'),
  check('历史重放',event.replayed?'fail':'pass',event.replayed?'历史回放':'实时收到','不使用回放信号开新仓'),
  check('参考行情',market?.quality==='verified'&&priceAge!==null&&priceAge<=5000?'pass':'fail',market?quality(market.quality)+(priceAge!==null?` · ${Math.round(priceAge/1000)}秒前`:''):'尚无行情','参考数据核实且更新时间≤5秒')];
 if(account.family==='wallet'){
  const watched=wallets.some(w=>w.toLowerCase()===event.wallet?.toLowerCase());
  const premium=positive(event.priceUsd)&&positive(market?.priceUsd)?(market.priceUsd/event.priceUsd-1)*100:null;
  checks.push(check('观察钱包',watched?'pass':'fail',event.wallet??'无钱包买入事件','属于本链观察名单'),
   check('首买',event.firstBuy===true?'pass':'fail',event.firstBuy===true?'当前观察周期的已核实首买':'不是已核实首买','忽略加仓、卖出及重复首买'),
   check('信号有效期',age!==null&&age<=60000?'pass':'fail',age===null?'未知':`${(age/1000).toFixed(1)}秒`,'≤60秒'),
   check('入场溢价',premium===null?'unknown':premium<=10?'pass':'fail',premium===null?'价格不足':`${premium.toFixed(2)}%`,'当前参考价较目标买价≤10%，成交时再核验'));
 }else{
  const rows=trades.filter(t=>t.verified&&!t.removed&&t.at<=now&&t.receivedAt<=now&&positive(t.priceUsd)&&positive(t.amountUsd));
  const external=market?.stage==='dex',windowMs=external?EXTERNAL_WINDOW_MS:30000;
  const prior=rows.filter(t=>t.at>now-windowMs*2&&t.at<=now-windowMs),latest=rows.filter(t=>t.at>now-windowMs&&t.at<=now);
  const high=prior.length?Math.max(...prior.map(t=>t.priceUsd)):null,pv=prior.reduce((n,t)=>n+t.amountUsd,0),lv=latest.reduce((n,t)=>n+t.amountUsd,0);
  const buy=latest.filter(t=>t.side==='buy').reduce((n,t)=>n+t.amountUsd,0),sell=latest.filter(t=>t.side==='sell').reduce((n,t)=>n+t.amountUsd,0),tokenAge=finite(market?.createdAt)?now-market.createdAt:null;
  checks.push(check('入场范围',external?'pass':tokenAge===null?'unknown':tokenAge>=0&&tokenAge<600000?'pass':'fail',external?'已核实外盘路线，无10分钟币龄上限':tokenAge===null?'未知':`${(tokenAge/60000).toFixed(1)}分钟`,external?'外盘按成交动量判断':'内盘新币上线不足10分钟'),
   check('连续观察',now-coverageStart>=windowMs*2?'pass':'fail',`${Math.max(0,Math.floor((now-coverageStart)/1000))}秒`,`本进程在最近缺口后连续观察≥${windowMs*2/1000}秒`),
   check('价格突破',high===null?'unknown':market?.priceUsd>high?'pass':'fail',high===null?'前窗口缺少真实成交':{current:market?.priceUsd??null,previousHigh:high},`当前参考价高于前${windowMs/1000}秒真实成交高点`),
   check('成交量放大',!prior.length||!latest.length?'unknown':lv>=pv*(external?1.5:2)?'pass':'fail',{previousWindowUsd:pv,latestWindowUsd:lv},external?'最新90秒金额≥此前90秒的1.5倍':'前后30秒窗口均有真实成交，最新金额≥此前2倍'),
   check('买卖金额',!latest.length?'unknown':external?buy>sell?'pass':'fail':buy>0&&buy>=sell*1.5?'pass':'fail',{buyUsd:buy,sellUsd:sell},external?'最新90秒买入金额大于卖出金额':'最新30秒买量≥卖量1.5倍'),
   check('信号有效期',age!==null&&age<=(external?EXTERNAL_SIGNAL_AGE_MS:INNER_SIGNAL_AGE_MS)?'pass':'fail',age===null?'未知':`${(age/1000).toFixed(1)}秒`,`观察成交到判断≤${external?60:30}秒；开仓报价≤5秒`));
 }
 return {chain:account.chain,accountId:account.id,token:event.token,symbol:market?.symbol??event.token?.slice(0,10),at:now,
  stage:'signal-check',module:account.family==='wallet'?'SCOUT · 钱包':market?.stage==='dex'?'PRICE · 外盘':'PRICE · 内盘',outcome:blocked?'blocked':result.eligible?'qualified':'skip',
  summary:blocked??signalSummary(result.reason),sourceAt:event.at,receivedAt:event.receivedAt,checks};
}

export function decisionBoard({chain,now,source,sourceAt,status,accounts,positions,orders,counters,coverageStart,lastReceivedAt,trialUntil,latest,checksPassed}){
 const rows=(source?.markets??[]).filter(m=>m.chain===chain&&eligibleMarket(m)),fresh=Boolean(status?.connected&&now-sourceAt<=5000&&now-status.headAt<=15000),paused=accounts.every(a=>a.paused);
 const wallets=[...new Map((source?.strategies??[]).filter(s=>s.chain===chain&&s.family==='wallet').flatMap(s=>s.wallets).map(w=>[w.address.toLowerCase(),w])).values()];
 const current=rows.filter(m=>m.quality==='verified'&&positive(m.priceUsd)&&finite(m.updatedAt)&&now-m.updatedAt<=5000);
 const ages=rows.map(m=>now-m.updatedAt).filter(v=>finite(v)&&v>=0),newestAge=ages.length?Math.min(...ages):null;
 const common=paused?'已暂停':!fresh?'等待行情':'观察中',active=positions.filter(p=>!p.closedAt),pending=orders.filter(o=>['waiting','queued','quoting'].includes(o.status));
 const gate=!checksPassed?'账本对账异常':paused?'用户暂停新仓':now>=trialUntil?'新仓观察窗口已结束':!fresh?'链头或共享行情已过期，不能准备新订单':!counters.verifiedTrades?'本轮尚无已核实成交信号':!current.length?'目录中没有5秒内更新的已核实参考价':latest?.summary??'等待满足全部入场条件的信号';
 const priceIssues=!fresh?'当前链头已过期，停止使用旧价格判断入场':!current.length?'没有5秒内更新的已核实参考价':'参考价可用；仍须通过实际金额的买卖报价';
 const modules=[
  {id:'SCOUT',name:'发现与钱包观察',status:common,summary:`正在检查${chain==='robinhood'?'Pons V2内盘与已核实外盘':'本链'}目录${rows.length}个代币、${wallets.length}个观察钱包。本轮已核实成交${counters.verifiedTrades}笔。`,facts:[{label:'观察范围',value:chain==='robinhood'?'Pons V2内盘 + 已核实外盘；排除Pons V1':'本链已接入协议'},{label:'内盘条目',value:rows.filter(m=>m.stage!=='dex').length},{label:'外盘条目',value:rows.filter(m=>m.stage==='dex').length},{label:'观察钱包',value:wallets.length},{label:'最新成交收到时间',value:lastReceivedAt||null}],next:'等待新收到的成交；目录条目不等于合格机会'},
  {id:'PRICE',name:'价格与成交量',status:!fresh||!current.length?'等待数据':common,summary:priceIssues,facts:[{label:'5秒内的已核实参考价',value:current.length},{label:'目录最近更新距今秒',value:newestAge===null?null:Math.round(newestAge/1000)},{label:'缺口后连续观察秒',value:Math.max(0,Math.floor((now-coverageStart)/1000))}],next:'内盘：新币突破+2倍量；外盘：连续观察3分钟，对比前后90秒的突破、1.5倍量和净买入；信号≤60秒，不限币龄；缺数据仍跳过'},
  {id:'SIZE',name:'仓位预算',status:paused?'已暂停':'待信号',summary:`每组独立${accounts[0]?.initialCapitalUsd??200}美元虚拟本金，自主开仓；单次含费用投入上限${MAX_ORDER_USD}美元。计划净损失预算放宽至${RISK.riskPct}%，实际金额按费用核验。`,facts:[{label:'单次绝对上限USD',value:MAX_ORDER_USD},...accounts.map(a=>({label:a.name+' · 当前风控预检预算USD',value:budgets(a.conservativeEquityUsd)[0]}))],next:`含费用投入≤${MAX_ORDER_USD}美元且≤净值${RISK.maxPositionPct}%；计划净损失≤${RISK.riskPct}%，最终按实际报价核验`},
  {id:'RISK',name:'风险与退出',status:checksPassed?'监控中':'已阻断',summary:checksPassed?`账本对账通过。当前${active.length}笔未平仓；每组最多${RISK.maxPositions}个币，每天${RISK.dailyEntries}次新仓。`:'账本对账失败，阻止新仓',facts:[{label:'未平仓批次',value:active.length},{label:'止损阈值%',value:RULES.stopPct},{label:'每日净亏停止阈值%',value:RISK.dailyLossPct}],next:`连续${RISK.maxConsecutiveLosses}次净亏停止新仓；数据中断不补造成交，无法卖出时保留余仓`},
  {id:'EXEC',name:'模拟执行',status:paused?'新仓暂停':!fresh?'等待行情':pending.length?'处理中':'待信号',summary:gate,facts:[{label:'待处理虚拟订单',value:pending.length},{label:'本轮提交',value:counters.submitted},{label:'本轮跳过信号',value:counters.rejected}],next:'通过信号及费用检查后，等待500毫秒和后续区块再报价撮合'},
  {id:'NEWS',name:'新闻与预测市场',status:'未接入',summary:'本轮没有接入新闻判断或预测市场策略；这里没有相关分析任务。',facts:[],next:'不参与这两组固定规则模拟'},
 ];
 const candidates=rows.slice().sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,18).map(m=>{
  const priceAge=finite(m.updatedAt)?Math.max(0,now-m.updatedAt):null,isFresh=m.quality==='verified'&&positive(m.priceUsd)&&priceAge!==null&&priceAge<=5000;
  const tokenAge=finite(m.createdAt)&&m.createdAt>0?now-m.createdAt:null;
  const checks=[check('链头连接',fresh?'pass':'fail',fresh?'在线':'过期或断开','需要新鲜链头'),
   check('参考价核实',m.quality==='verified'&&positive(m.priceUsd)?'pass':'unknown',m.priceUsd??'无价格','存在已核实参考价'),
   check('参考价新鲜度',priceAge===null?'unknown':priceAge<=5000?'pass':'fail',priceAge===null?'未知':`${Math.round(priceAge/1000)}秒前`,'更新时间≤5秒'),
   check('入场范围',m.stage==='dex'?'pass':tokenAge===null?'unknown':tokenAge>=0&&tokenAge<600000?'pass':'fail',m.stage==='dex'?'外盘，不设10分钟币龄上限':tokenAge===null?'未知':`${(tokenAge/60000).toFixed(1)}分钟`,'内盘新币不足10分钟；外盘按成交动量判断'),
   check('连续成交信号','unknown','尚未从该目录条目建立合格信号','需要本轮已核实成交，不以目录价格生成信号'),
   check('具体金额费用检查','unknown','尚未进入报价','通过实际买卖报价后才能确定费用和风险')];
  const reason=paused?'该链已暂停新仓':!fresh?'链头过期，等待恢复':!isFresh?(m.quality!=='verified'||!positive(m.priceUsd)?'路线或参考价尚未核实':'参考价已过期'):m.stage==='dex'?'外盘候选：等待真实突破、放量与净买入信号':tokenAge===null?'币龄未知':tokenAge>=600000?'超出内盘新币10分钟范围；钱包组仍需首买信号':'等待真实成交信号及全部条件';
  return {chain,token:m.address,symbol:m.symbol,name:m.name,platform:m.platform,priceUsd:m.priceUsd,sourceAt:m.updatedAt,at:now,
   stage:'catalog-check',module:'SCOUT / PRICE',outcome:paused?'paused':'waiting',summary:reason,sourceReason:m.reason,checks};
 });
 return {at:now,chain,kind:'fixed-rule-decision-summary',summary:gate,marketCount:rows.length,freshMarketCount:current.length,wallets,modules,candidates};
}

export class DecisionJournal {
 constructor(store,limit=120){this.store=store;this.limit=limit;this.rows=store.meta('decisionJournal')??[];this.memo=new Map();}
 record(row,minInterval=15000){
  const key=[row.chain,row.module,row.accountId??'',row.token??''].join(':'),prior=this.memo.get(key),fingerprint=JSON.stringify([row.summary,row.outcome]);
  if(prior&&row.at-prior.at<minInterval)return;
  if(prior&&prior.fingerprint===fingerprint&&row.at-prior.at<60000)return;
  this.memo.set(key,{at:row.at,fingerprint});if(this.memo.size>1000)this.memo.delete(this.memo.keys().next().value);
  const value={...row,id:row.chain+':'+row.at+':'+(this.rows.length+Math.random().toString(16).slice(2,8))};
  this.rows.push(value);this.rows=this.rows.slice(-this.limit);this.store.setMeta('decisionJournal',this.rows);
  this.store.audit('decision',row.summary,{chain:row.chain,module:row.module,token:row.token,account:row.accountId,stage:row.stage,outcome:row.outcome,checks:row.checks??[],facts:row.facts??[]});
 }
 recent(chain){return this.rows.filter(r=>r.chain===chain).slice(-45).reverse();}
}
