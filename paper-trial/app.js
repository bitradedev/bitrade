let snapshot=null,polling=false,selectedChain='bsc',pendingControl=false,selectedCandidate=null;
let selectedOrderFilter='filled',selectedOrderAccount='normal',orderPage=0,currentView='overview';
try{const saved=localStorage.getItem('bi-trade-view-chain');if(['bsc','robinhood'].includes(saved))selectedChain=saved;}catch{}
const chainName={bsc:'BSC',robinhood:'Robinhood'},pageSize=20;
const el=id=>document.getElementById(id),escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>Number.isFinite(v)?(v<0?'−$':'$')+Math.abs(v).toFixed(2):'未知';
const signed=v=>Number.isFinite(v)?(v>0?'+':'')+money(v):'未知';
const time=v=>v?new Date(v).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
const stamp=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
const address=v=>v?String(v).slice(0,8)+'…'+String(v).slice(-6):'—';
const status={waiting:'等待',queued:'等待新区块',quoting:'报价中',filled:'虚拟成交',partial:'部分成交',failed:'失败',cancelled:'取消'};
const icon=id=>'<svg class="icon" aria-hidden="true"><use href="#i-'+id+'"/></svg>';
const accountName=id=>snapshot?.accounts.find(a=>a.id===id)?.name??id??'—';
const tokenName=token=>snapshot?.positions.find(p=>p.token===token)?.symbol??snapshot?.decisionBoards?.[selectedChain]?.candidates.find(c=>c.token===token)?.symbol??address(token);
const tone=v=>Number.isFinite(v)?v>0?'positive':v<0?'negative':'':'';
const total=(rows,key)=>rows.reduce((n,r)=>n+(Number.isFinite(r[key])?r[key]:0),0);
function html(id,markup){
 const node=el(id);if(node.innerHTML===markup)return;
 const open=new Set([...node.querySelectorAll('details[data-persist][open]')].map(d=>d.dataset.persist));
 node.innerHTML=markup;for(const d of node.querySelectorAll('details[data-persist]'))d.open=open.has(d.dataset.persist);
}
function empty(message,detail='',mark='trade'){return '<div class="empty">'+icon(mark)+escape(message)+(detail?'<small>'+escape(detail)+'</small>':'')+'</div>';}
function table(headers,rows,message='暂无记录',detail='合格信号与新鲜报价同时满足后，才会生成虚拟成交。'){
 return rows.length?'<table><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table>':empty(message,detail);
}
function valueText(v){
 if(v===null||v===undefined)return '未知';
 if(typeof v==='number')return v>1e12?stamp(v):Number.isInteger(v)?String(v):v.toPrecision(5);
 if(typeof v==='object'){
  const labels={current:'当前参考价',previousHigh:'此前高点',previousUsd:'前30秒金额',latestUsd:'最新30秒金额',previousWindowUsd:'前窗口金额',latestWindowUsd:'最新窗口金额',buyUsd:'买入金额',sellUsd:'卖出金额',gasUsd:'Gas估计',approvalUsd:'授权费估计',protocolUsd:'协议费用',taxUsd:'税费',conversionUsd:'转换损耗',quality:'费用质量',includedInOutput:'已包含于报价'};
  return Object.entries(v).filter(([k])=>k!=='notes').map(([k,x])=>(labels[k]??k)+'：'+(k.endsWith('Usd')?money(x):typeof x==='object'?valueText(x):String(x??'未知'))).join(' · ');
 }return String(v);
}
function checksHtml(checks){const labels={pass:'通过',fail:'未通过',unknown:'未知'};return '<div class="candidate-checks">'+checks.map(c=>'<div class="candidate-check"><b>'+escape(c.label)+'</b><span class="check-'+escape(c.status)+'">'+escape(labels[c.status]??c.status)+'</span><div>'+escape(valueText(c.value))+'<small>要求：'+escape(c.threshold??'')+'</small></div></div>').join('')+'</div>';}
function avatar(wallet=false){return '<svg class="account-avatar" viewBox="0 0 64 66" aria-hidden="true"><ellipse cx="32" cy="60" rx="22" ry="3" fill="'+(wallet?'#ded5a6':'#c9d6e9')+'"/><path d="M13 45C2 25 16 9 31 8s31 15 21 36c-6 14-30 15-39 1Z" fill="'+(wallet?'#eacf68':'#9bbbe5')+'" stroke="#465054" stroke-width="1.3"/><path d="m14 40-6 5m44-5 6 5" stroke="#465054" stroke-width="2" stroke-linecap="round"/><ellipse cx="24" cy="30" rx="2" ry="3.5" fill="#2e393f"/><ellipse cx="40" cy="30" rx="2" ry="3.5" fill="#2e393f"/><path d="M28 39q4 4 8 0" stroke="#2e393f" stroke-width="1.6" fill="none" stroke-linecap="round"/><ellipse cx="19" cy="37" rx="3" ry="1.5" fill="#fffefa" opacity=".6"/><ellipse cx="45" cy="37" rx="3" ry="1.5" fill="#fffefa" opacity=".6"/>'+(wallet?'<path d="m29 12 3-4 3 4-3 4Z" fill="#fff8cf"/>':'<path d="M17 18q13-9 27 0" stroke="#d7e6ff" fill="none" stroke-width="2"/>')+'</svg>';}
function accountState(a,fresh,closed){
 if(a.haltReason)return {label:'风控暂停',tone:'warn',reason:a.haltReason};
 if(a.paused)return {label:'已暂停',tone:'neutral',reason:'新仓已暂停，已有持仓继续按规则退出。'};
 if(closed)return {label:'窗口结束',tone:'neutral',reason:'本轮新仓窗口已结束，继续处理已有持仓。'};
 if(!fresh)return {label:'等待行情',tone:'warn',reason:'等待新鲜行情与可执行报价。'};
 return {label:'观察中',tone:'',reason:''};
}
function renderAccounts(s,accounts,fresh,trial){
 const b=s.decisionBoards?.[selectedChain];
 html('account-cards',accounts.map(a=>{
  const wallet=a.id.endsWith('-wallet'),pnl=a.equityUsd-a.initialCapitalUsd,st=accountState(a,fresh,trial?.entryWindowClosed);
  const last=b?.timeline.find(r=>r.accountId===a.id),unknown=s.positions.some(p=>p.accountId===a.id&&!p.closedAt&&(!p.valuationAt||Date.now()-p.valuationAt>5000));
  const reason=st.reason||last?.summary||(wallet?'等待观察钱包的首笔买入信号。':'观察突破、放量与净买入，满足条件后准备报价。');
  return '<article class="account'+(wallet?' wallet':'')+'"><div class="account-top">'+avatar(wallet)+'<div class="account-title"><h3>'+(wallet?'钱包首买':'自主选币')+'</h3><small>'+escape(chainName[a.chain])+' · 独立 '+a.initialCapitalUsd+'U 本金</small></div><span class="state-chip '+st.tone+'">'+st.label+'</span></div><div class="account-balance"><div class="equity">'+money(a.equityUsd)+'</div><div class="account-return '+tone(pnl)+'">'+signed(pnl)+'<small>相对本金'+(Number.isFinite(pnl)?' '+(pnl/a.initialCapitalUsd*100).toFixed(2)+'%':'')+'</small></div></div><div class="metrics"><span>现金<b>'+money(a.cashUsd)+'</b></span><span>已实现净盈亏<b class="'+tone(a.realizedUsd)+'">'+signed(a.realizedUsd)+'</b></span><span>估计费用<b>'+money(a.feesUsd)+'</b></span></div><p class="account-decision">'+icon(st.tone==='warn'?'shield':'agent')+'<span>'+escape(reason)+(unknown?' 持仓可卖估值尚未核实。':'')+'</span></p><div class="account-bottom"><span>今日开仓 '+a.dayEntries+' / '+s.risk.dailyEntries+'</span><a href="#trade-history" data-account-link="'+escape(a.id)+'">查看记录 '+icon('arrow')+'</a></div></article>';
 }).join('')||empty('先创建你的模拟账户','每个策略账户各有独立200U本金。','wallet'));
}
function renderOverview(s,accounts,trial){
 const normalFills=s.fills.filter(f=>f.chain===selectedChain&&!f.accountId.endsWith('-check')),positions=s.positions.filter(p=>p.chain===selectedChain&&!p.closedAt&&!p.accountId.endsWith('-check'));
 const equity=total(accounts,'equityUsd'),pnl=equity-total(accounts,'initialCapitalUsd');
 el('overview-account-count').textContent=accounts.length+' 个账户';el('overview-equity').textContent=accounts.length?money(equity):'—';
 el('overview-pnl').textContent=accounts.length?'相对初始本金 '+signed(pnl)+' · '+(pnl/total(accounts,'initialCapitalUsd')*100).toFixed(2)+'%':'创建后开始记录你的模拟结果';el('overview-pnl').className='hero-pnl '+tone(pnl);
 el('overview-realized').textContent=accounts.length?signed(total(accounts,'realizedUsd')):'—';el('overview-realized').className=tone(total(accounts,'realizedUsd'));
 el('overview-fees').textContent=accounts.length?money(total(accounts,'feesUsd')):'—';el('overview-open').textContent=String(positions.length);el('overview-fills').textContent=String(normalFills.length);
 el('overview-open-meta').textContent=positions.length?'按可卖报价管理退出':'目前没有未平仓批次';el('overview-fills-meta').textContent=normalFills.filter(f=>f.side==='buy').length+' 买入 · '+normalFills.filter(f=>f.side==='sell').length+' 卖出（已加载）';
 const halted=accounts.filter(a=>a.haltReason);el('account-alert').hidden=!halted.length;
 html('account-alert',halted.map(a=>escape(a.name)+'：'+escape(a.haltReason)).join(' · ')+'。<a href="#execution-check">查看运行与规则 →</a>');
 html('recent-fills',normalFills.slice(0,6).map(f=>'<div class="activity-row"><span class="direction-icon '+(f.side==='sell'?'sell':'')+'">'+(f.side==='buy'?'↙':'↗')+'</span><div><div class="activity-title">'+(f.side==='buy'?'买入 ':'卖出 ')+escape(tokenName(f.token))+'</div><small>'+time(f.at)+' · '+escape(accountName(f.accountId))+'</small></div><div class="activity-value">'+money(f.usd)+(f.side==='sell'?'<small class="'+tone(f.netUsd)+'">净盈亏 '+signed(f.netUsd)+'</small>':'<small>虚拟成交</small>')+'</div></div>').join('')||empty(!accounts.length?'先开始你的模拟':trial?.paused?'本链新仓已暂停':'还没有模拟成交',!accounts.length?'点击「开始模拟」，创建独立的策略账户。':trial?.paused?(s.capabilities?.sessions?'点击「恢复我的新仓」继续模拟。':'可在「运行」页面恢复该链模拟。'):'等待合格信号，实际成交后会显示在这里。'));
 const b=s.decisionBoards?.[selectedChain];el('overview-decision').textContent=b?.summary??'正在连接实际检查记录…';
 html('overview-thoughts',(b?.timeline??[]).slice(0,3).map(r=>'<div class="mini-event"><time>'+time(r.at).slice(0,5)+'</time><div><span class="mini-module">'+escape(r.module)+'</span>'+escape(r.summary)+'</div></div>').join('')||empty('等待第一轮检查记录','','agent'));
}
function renderDecisionBoard(s){
 const b=s.decisionBoards?.[selectedChain];
 if(!b){el('brain-summary').textContent='正在连接本链的实际判断依据…';for(const id of ['agents','candidates','thoughts'])html(id,empty('等待后台观察数据','','agent'));return;}
 el('brain-time').textContent='实际检查 '+time(b.at);el('brain-summary').textContent=b.summary;
 const marks={SCOUT:'search',PRICE:'pulse',SIZE:'wallet',RISK:'shield',EXEC:'trade',NEWS:'agent'};
 html('agents',b.modules.map(m=>'<article class="agent agent-'+escape(m.id.toLowerCase())+(m.status==='未接入'?' disabled':'')+'"><div class="agent-head"><span class="agent-icon">'+icon(marks[m.id]??'agent')+'</span><h3><small>'+escape(m.id)+'</small>'+escape(m.name)+'</h3><span class="agent-state">'+escape(m.status)+'</span></div><div class="agent-body"><p>'+escape(m.summary)+'</p><details data-persist="module-'+escape(m.id)+'"><summary>读取的数据与检查</summary><dl>'+m.facts.map(f=>'<div><dt>'+escape(f.label)+'</dt><dd>'+escape(valueText(f.value))+'</dd></div>').join('')+'</dl></details><p class="next">下一步：'+escape(m.next)+'</p></div></article>').join(''));
 el('candidate-meta').textContent=b.marketCount+' 个代币 · '+b.freshMarketCount+' 个新鲜已核实价格 · 最近 '+b.candidates.length+' 个候选';
 html('candidates',table(['代币 / 合约','平台','参考价','数据时间','当前判断','依据'],b.candidates.map(c=>[escape(c.symbol)+'<small class="mono">'+escape(address(c.token))+'</small>',escape(c.platform),typeof c.priceUsd==='number'?'$'+c.priceUsd.toPrecision(6):'未知',time(c.sourceAt),escape(c.summary),'<button class="candidate-select" data-token="'+escape(c.token)+'">查看依据</button>']),'本链还没有候选','SCOUT 会继续等待真实来源更新。'));
 const candidate=b.candidates.find(c=>c.token===selectedCandidate);el('candidate-detail').hidden=!candidate;
 if(candidate)html('candidate-detail','<div class="section-title"><h3>'+escape(candidate.symbol)+' · 检查依据</h3><button class="candidate-close" id="close-candidate" aria-label="关闭候选详情">'+icon('close')+'</button></div><p>'+escape(candidate.summary)+'</p><p class="muted">来源更新：'+stamp(candidate.sourceAt)+' · '+escape(candidate.sourceReason??'')+'</p>'+checksHtml(candidate.checks)+'<p class="fine-print">目录检查不代表成交信号；尚未执行的费用和入场检查显示为未知。</p>');
 html('thoughts',b.timeline.map(r=>'<article class="decision-row"><time>'+time(r.at)+'</time><span class="module">'+escape(r.module)+'</span><div><p>'+escape(r.summary)+'</p>'+(r.token?'<small>'+escape(r.symbol??address(r.token))+' · '+escape(accountName(r.accountId))+'</small>':'')+(r.checks?.length?'<details data-persist="thought-'+escape(r.id)+'"><summary>查看判断依据</summary>'+checksHtml(r.checks)+'</details>':'')+(r.next?'<small>下一步：'+escape(r.next)+'</small>':'')+'</div></article>').join('')||empty('正在记录第一轮实际检查','','agent'));
}
function renderOrders(s){
 const choices=s.accounts.filter(a=>a.chain===selectedChain);
 html('trade-account','<option value="normal">策略账户</option><option value="all">'+(s.capabilities?.executionCheck===false?'所有账户':'所有账户（含验证）')+'</option>'+choices.map(a=>'<option value="'+escape(a.id)+'">'+escape(a.name)+'</option>').join(''));
 if(!['normal','all',...choices.map(a=>a.id)].includes(selectedOrderAccount))selectedOrderAccount='normal';el('trade-account').value=selectedOrderAccount;
 const rows=s.orders.filter(o=>o.chain===selectedChain&&(selectedOrderAccount==='all'||selectedOrderAccount==='normal'&&!o.accountId.endsWith('-check')||o.accountId===selectedOrderAccount)).filter(o=>selectedOrderFilter==='all'||selectedOrderFilter==='filled'&&['filled','partial'].includes(o.status)||selectedOrderFilter==='pending'&&['queued','waiting','quoting'].includes(o.status)||selectedOrderFilter==='failed'&&['failed','cancelled'].includes(o.status)).sort((a,b)=>(b.filledAt||b.createdAt)-(a.filledAt||a.createdAt));
 const pages=Math.max(1,Math.ceil(rows.length/pageSize));orderPage=Math.min(orderPage,pages-1);
 html('orders',table(['时间','账户','方向','代币','状态','金额 / 净盈亏','依据'],rows.slice(orderPage*pageSize,(orderPage+1)*pageSize).map(o=>{const f=s.fills.find(f=>f.orderId===o.id);return [time(o.filledAt||o.createdAt),escape(accountName(o.accountId)),'<span class="side-tag '+o.side+'">'+(o.side==='buy'?'买入':'卖出')+'</span>',escape(tokenName(o.token))+'<small class="mono">'+escape(address(o.token))+'</small>','<span class="status '+escape(o.status)+'">'+escape(status[o.status]??o.status)+'</span>',f?money(f.usd)+(f.side==='sell'?'<small class="'+tone(f.netUsd)+'">净盈亏 '+signed(f.netUsd)+'</small>':''):money(o.amountUsd),escape(o.error||o.reason)];}),'当前筛选暂无订单','已成交、处理中及失败记录可以分别查看。'));
 el('order-count').textContent='已加载 '+rows.length+' 条筛选记录';el('order-page').textContent=(orderPage+1)+' / '+pages;el('orders-prev').disabled=orderPage===0;el('orders-next').disabled=orderPage>=pages-1;
 for(const b of document.querySelectorAll('[data-order-filter]'))b.setAttribute('aria-pressed',String(b.dataset.orderFilter===selectedOrderFilter));
 const positions=s.positions.filter(p=>p.chain===selectedChain&&(selectedOrderAccount==='all'||selectedOrderAccount==='normal'&&!p.accountId.endsWith('-check')||p.accountId===selectedOrderAccount));
 const active=positions.filter(p=>!p.closedAt);el('position-count').textContent=active.length+' 个未平仓批次';
 html('positions',table(['账户','代币','买入成本','可卖净值','当前规则'],active.map(p=>[escape(accountName(p.accountId)),escape(p.symbol)+'<small class="mono">'+escape(address(p.token))+'</small>',money(p.costUsd),p.valuationAt&&Date.now()-p.valuationAt<=5000?money(p.liquidationUsd):'未知<small>'+escape(p.valuationReason)+'</small>',escape(p.reason)]),'目前没有持仓','模拟买入后，将按止盈、止损和持有时间自动管理。'));
 html('position-history',table(['账户','代币','买入成本','卖出回收','已实现净盈亏','平仓时间'],positions.filter(p=>p.closedAt).slice().reverse().slice(0,30).map(p=>[escape(accountName(p.accountId)),escape(p.symbol),money(p.costUsd),money(p.cashBackUsd),'<span class="'+tone(p.netRealizedUsd)+'">'+signed(p.netRealizedUsd)+'</span>',time(p.closedAt)]),'还没有平仓记录',''));
}
function renderStudy(s){
 const study=s.exitStudies?.[selectedChain];el('study-conclusion').textContent=study?study.conclusion:'正在连接本链对照研究…';
 html('study-samples',(study?.pairedCount??0)+' <small>/ 20</small>');el('study-progress').style.width=Math.min(100,(study?.pairedCount??0)/20*100)+'%';
 const tokens=study?.rows?.[0]?.tokens??0;el('study-token-count').textContent='已配对 '+(study?.pairedCount??0)+' 组 · '+tokens+' 个不同代币；评估要求 20 组 / 5 个币';
 html('study-cards',(study?.rows??[]).map(r=>'<article class="study-card '+escape(r.id)+'"><div class="study-card-top"><b>'+escape(r.name)+'</b><span>'+r.count+' 组完整配对</span></div><small>扣费净收益</small><strong class="'+(r.count?tone(r.profitUsd):'')+'">'+(r.count?signed(r.profitUsd):'无样本')+'</strong><p class="study-rule">止损 '+r.stopPct+'% · 涨 '+r.targetPct+'% 卖原仓一半<br>回撤 '+r.trailPct+'% 退出 · 最长 '+r.maxHoldMs/60000+' 分钟</p><div class="study-card-stats"><span>胜率<b>'+(r.winRate===null?'—':r.winRate.toFixed(1)+'%')+'</b></span><span>已实现回撤<b>'+(r.realizedDrawdownPct===null?'—':r.realizedDrawdownPct.toFixed(1)+'%')+'</b></span><span>估计费用<b>'+(r.count?money(r.feesUsd):'—')+'</b></span></div></article>').join(''));
 html('study-table',study?table(['方案','止损 / 止盈','回撤 / 最长持有','完整配对','扣费净收益','胜率','盈利因子','已实现回撤','费用'],study.rows.map(r=>[escape(r.name),r.stopPct+'% / +'+r.targetPct+'%',r.trailPct+'% / '+r.maxHoldMs/60000+'分钟',r.count,r.count?'<span class="'+tone(r.profitUsd)+'">'+signed(r.profitUsd)+'</span>':'无样本',r.winRate===null?'—':r.winRate.toFixed(1)+'%',r.profitFactor===null?'—':r.profitFactor.toFixed(2),r.realizedDrawdownPct===null?'—':r.realizedDrawdownPct.toFixed(2)+'%',r.count?money(r.feesUsd):'—'])):empty('等待研究记录'));
 html('study-recent',study?.recent?.length?study.recent.map(g=>'<div class="log"><time>'+time(g.entryAt)+'</time><div>'+escape(tokenName(g.token))+' · 共同成本 '+money(g.costUsd)+g.cases.map(c=>'<small>'+escape(study.rows.find(r=>r.id===c.variantId)?.name)+'：'+escape(c.reason)+(c.profitUsd===null?'':' · '+signed(c.profitUsd))+'</small>').join('')+'</div></div>').join(''):empty('还没有可用于对照的入场','会根据实际策略成交建立配对样本。','study'));
}
function renderCheck(s){
 const check=s.executionCheck;el('execution-check').hidden=s.capabilities?.executionCheck===false;
 if(!check)return;
 el('check-summary').textContent=check.summary;
 const buy=total((check.fills??[]).filter(f=>f.side==='buy'),'usd'),sell=total((check.fills??[]).filter(f=>f.side==='sell'),'usd');
 const done=[check.orders?.length>0,buy>0,sell>0,check.status==='completed'&&s.ledger.passed];
 html('check-steps',['真实报价','模拟买入','自动退出','账本核对'].map((label,i)=>'<div class="check-step'+(done[i]?' done':'')+'"><i>'+(done[i]?'✓':i+1)+'</i>'+label+'</div>').join(''));
 el('check-result').hidden=check.status!=='completed';el('check-result').textContent='已完成：买入 '+money(buy)+' → 回收 '+money(sell)+' · 净盈亏 '+signed(sell-buy)+'（Robinhood 独立验证）';
 el('run-check').disabled=check.busy||['queued','holding'].includes(check.status)||s.chainTrials?.find(t=>t.chain==='robinhood')?.paused;
 html('run-check',(check.busy?'正在读取真实报价':check.status==='holding'?'等待自动退出':'验证模拟买卖')+icon('arrow'));
 html('check-fills',table(['时间 / 区块','方向','投入或回收','净盈亏','报价凭证'],(check.fills??[]).map(f=>[time(f.at)+'<small>'+f.block+'</small>',f.side==='buy'?'模拟买入':'模拟卖出',money(f.usd),f.side==='sell'?signed(f.netUsd):'待退出','<small class="mono">'+escape(check.orders.find(o=>o.id===f.orderId)?.fillQuote?.id??'')+'</small>']),'尚无验证成交','报价与模拟成交会分开显示。'));
 html('check-attempts',(check.attempts??[]).slice(-3).map(r=>'<div class="log"><time>'+time(r.at)+'</time><div>'+escape(r.symbol)+' · '+escape(r.reason)+'</div></div>').join(''));
 const a=s.accounts.find(a=>a.id.endsWith('-check'));html('check-account',a?'<p class="fine-print">验证账户净值 '+money(a.equityUsd)+' · 已实现净盈亏 '+signed(a.realizedUsd)+' · 估计费用 '+money(a.feesUsd)+'</p>':'');
}
function render(s){
 snapshot=s;if(!s.chains.some(c=>c.chain===selectedChain))selectedChain=s.chains[0]?.chain??'bsc';
 const chain=s.chains.find(c=>c.chain===selectedChain),trial=s.chainTrials?.find(c=>c.chain===selectedChain),name=chainName[selectedChain],accounts=s.accounts.filter(a=>a.chain===selectedChain&&!a.id.endsWith('-check'));
 const fresh=Boolean(s.sourceConnected&&Date.now()-s.sourceAt<5000&&chain?.connected&&Date.now()-chain.headAt<15000);
 const halted=accounts.filter(a=>a.haltReason).length;
 el('connection').className='notice'+(!fresh&&!trial?.paused?' bad':'');el('connection').textContent=!accounts.length?(fresh?name+' 行情在线 · 等待创建账户':name+' 等待新鲜行情'):trial?.paused?name+' 新仓已暂停 · 行情采集继续':!fresh?name+' 等待新鲜行情':halted?name+' 在线 · '+halted+' 个账户风控暂停':name+' 在线 · 区块 '+chain.head;
 renderAccounts(s,accounts,fresh,trial);renderOverview(s,accounts,trial);renderDecisionBoard(s);renderOrders(s);renderStudy(s);renderCheck(s);
 el('window').textContent=!accounts.length?'创建后开始24小时新仓观察窗口':trial?.entryWindowClosed?'本轮新仓窗口已结束，已有持仓继续管理':'新仓观察至 '+stamp(trial?.entryWindowUntil??s.entryWindowUntil);
 const labels={events:'观察事件',verifiedTrades:'已核实成交',liveTrades:'实时记录',replayedTrades:'历史回放',delayedTrades:'收到时已延迟',signals:'符合入场信号',submitted:'虚拟订单',rejected:'跳过信号'};
 html('counters',Object.entries(labels).map(([k,label])=>'<div><strong>'+((trial?.counters??s.counters)?.[k]??0).toLocaleString('zh-CN')+'</strong>'+label+'</div>').join(''));
 el('decision').textContent=s.lastError?'运行提示：'+s.lastError:trial?.latestDecision??'';el('last-update').textContent='北京时间 '+time(s.at);
 el('ledger').textContent=!accounts.length?'创建账户后对账':s.ledger.passed?'账本对账通过':'账本异常，新仓暂停';el('ledger').className='ledger-tag'+(s.ledger.passed?'':' bad');
 const fills=s.fills.filter(f=>f.chain===selectedChain&&!f.accountId.endsWith('-check')),lastSell=fills.find(f=>f.side==='sell'),lastBuy=fills.find(f=>f.side==='buy');
 el('trade-summary').textContent=lastSell?'最近策略卖出：成本 '+money(lastSell.costBasisUsd)+' → 回收 '+money(lastSell.usd)+' · 净盈亏 '+signed(lastSell.netUsd)+'。':lastBuy?'策略已模拟买入 '+money(lastBuy.usd)+'，正在管理退出。':'策略尚无模拟成交；满足信号与费用检查后才会下单。';
 html('audit',s.audit.filter(r=>{const d=r.details??{},c=d.chain??s.accounts.find(a=>a.id===d.account)?.chain;return (!c||c===selectedChain)&&(r.kind!=='decision'||r.at>=(s.configurationChangedAt??0));}).map(r=>{const d=r.details??{},detail=[d.account?accountName(d.account):'',d.module,d.token?address(d.token):'',d.budget?'预算 '+money(d.budget):'',d.error||d.reason||''].filter(Boolean).join(' · ');return '<div class="log"><time>'+time(r.at)+'</time><div>'+escape(r.message)+(detail?'<small>'+escape(detail)+'</small>':'')+'</div></div>';}).join('')||empty('暂无运行记录'));
 el('pause').disabled=pendingControl||!accounts.length;el('pause').textContent=s.accounts.length&&s.accounts.every(a=>a.paused)?'恢复全部新仓':'暂停全部新仓';
 for(const c of ['bsc','robinhood']){const t=s.chainTrials?.find(t=>t.chain===c);el('view-'+c).hidden=!s.chains.some(v=>v.chain===c);el('view-'+c).setAttribute('aria-pressed',String(c===selectedChain));el('pause-'+c).closest('.control-row').hidden=!t;el('pause-'+c).disabled=pendingControl||!t||!accounts.length;el('pause-'+c).textContent=(t?.paused?'启用 ':'暂停 ')+chainName[c];}
 el('chain-summary').textContent=(s.chainTrials??[]).map(t=>chainName[t.chain]+(t.paused?' 已暂停':' 已启用')).join(' · ');
 el('onboarding').hidden=!s.capabilities?.sessions||!!s.session;el('session-info').hidden=!s.session;
 el('research-link').hidden=!!s.capabilities?.sessions;
 if(s.capabilities?.sessions)el('pause').textContent=accounts.length&&accounts.every(a=>a.paused)?'恢复我的新仓':'暂停我的新仓';
 el('overview-note').textContent=s.capabilities?.executionCheck===false?'你的两个策略账户合计 · 各自独立200U':'当前链策略账户汇总 · 运行验证单独记账';
 el('rules-scope').textContent=(selectedChain==='bsc'?'BSC范围：已核实的内盘与外盘交易路线。':'Robinhood范围：Pons V2内盘＋已核实外盘。')+'40美元为含费用总投入上限，实际金额按费用核验；止损触发价不等于成交价。';
 if(s.session)html('session-info','<span>你的独立实验室 · '+escape(s.session.label)+'</span><small>本浏览器自动记住 · 仅你可控制</small>');
 route(false);
}
function route(scroll=true){
 const hash=location.hash.slice(1),map={'decision-board':'agents','decision-timeline':'agents','candidate-board':'agents','trade-history':'trades','open-positions':'trades','exit-study':'study','execution-check':'runtime','accounts':'overview','main':'overview','overview':'overview'};
 currentView=map[hash]??'overview';for(const p of document.querySelectorAll('[data-view]'))p.hidden=p.dataset.view!==currentView;
 for(const a of document.querySelectorAll('[data-page]')){if(a.dataset.page===currentView)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
 const headings={overview:['YOUR TRADING LAB','让交易，有迹可循。','每组独立 200U，每笔最多 40U。'],agents:['FOLLOW THE DECISION','看见每一次判断。','固定规则模块的实际检查、输入与下一步。'],trades:['EVERY TRADE, ON RECORD','你的交易记录。','持仓、成交、费用和失败记录都在这里。'],study:['TEST YOUR EXIT','找到更合适的退出。','同一入场，三套止盈止损，比较扣费后的结果。'],runtime:['KEEP YOUR LAB RUNNING','运行，一目了然。','管理暂停、查看规则，检查模拟是否正常。']};
 const h=headings[currentView];el('page-eyebrow').textContent=h[0];el('page-title').textContent=h[1];el('subtitle').textContent=chainName[selectedChain]+' · '+h[2];
 if(scroll){if(['decision-timeline','candidate-board','accounts','open-positions'].includes(hash))requestAnimationFrame(()=>el(hash)?.scrollIntoView({block:'start'}));else window.scrollTo({top:0,behavior:'instant'});}
}
async function refresh(){if(polling)return;polling=true;try{const r=await fetch('/api/state');if(!r.ok)throw Error('后台读取失败');render(await r.json());}catch(e){el('connection').className='notice bad';el('connection').textContent='服务连接中断：'+e.message;for(const id of ['pause','pause-bsc','pause-robinhood'])el(id).disabled=true;}finally{polling=false;}}
async function pause(paused,chain){if(!snapshot||pendingControl)return;pendingControl=true;el('control-feedback').hidden=true;render(snapshot);try{const r=await fetch('/api/pause',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':snapshot.csrf},body:JSON.stringify({paused,...(chain?{chain}:{})})});const v=await r.json();if(!r.ok)throw Error(v.error);await refresh();}catch(e){el('control-feedback').textContent=e.message;el('control-feedback').hidden=false;}finally{pendingControl=false;if(snapshot)render(snapshot);}}
el('pause').addEventListener('click',()=>void pause(!snapshot?.accounts.every(a=>a.paused)));
el('run-check').addEventListener('click',async()=>{if(!snapshot)return;el('run-check').disabled=true;try{const r=await fetch('/api/check',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':snapshot.csrf},body:JSON.stringify({check:true})});const v=await r.json();if(!r.ok)throw Error(v.error);await refresh();}catch(e){el('check-summary').textContent=e.message;}});
el('start-session').addEventListener('click',async()=>{el('start-session').disabled=true;try{const r=await fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({create:true})});const v=await r.json();if(!r.ok)throw Error(v.error);await refresh();}catch(e){el('connection').textContent=e.message;}finally{el('start-session').disabled=false;}});
for(const c of ['bsc','robinhood']){el('view-'+c).addEventListener('click',()=>{selectedChain=c;selectedCandidate=null;selectedOrderAccount='normal';orderPage=0;try{localStorage.setItem('bi-trade-view-chain',c);}catch{}if(snapshot)render(snapshot);});el('pause-'+c).addEventListener('click',()=>{const t=snapshot?.chainTrials?.find(t=>t.chain===c);if(t)void pause(!t.paused,c);});}
el('candidates').addEventListener('click',e=>{const b=e.target.closest('button[data-token]');if(!b)return;selectedCandidate=b.dataset.token;if(snapshot){renderDecisionBoard(snapshot);el('candidate-detail').scrollIntoView({behavior:'smooth',block:'center'});}});
el('candidate-detail').addEventListener('click',e=>{if(e.target.closest('#close-candidate')){selectedCandidate=null;el('candidate-detail').hidden=true;}});
for(const b of document.querySelectorAll('[data-order-filter]'))b.addEventListener('click',()=>{selectedOrderFilter=b.dataset.orderFilter;orderPage=0;if(snapshot)renderOrders(snapshot);});
el('trade-account').addEventListener('change',e=>{selectedOrderAccount=e.target.value;orderPage=0;if(snapshot)renderOrders(snapshot);});
el('orders-prev').addEventListener('click',()=>{orderPage=Math.max(0,orderPage-1);if(snapshot)renderOrders(snapshot);});el('orders-next').addEventListener('click',()=>{orderPage++;if(snapshot)renderOrders(snapshot);});
el('account-cards').addEventListener('click',e=>{const a=e.target.closest('[data-account-link]');if(!a)return;selectedOrderAccount=a.dataset.accountLink;selectedOrderFilter='filled';orderPage=0;if(snapshot)renderOrders(snapshot);});
window.addEventListener('hashchange',()=>route());route();void refresh();setInterval(()=>void refresh(),2000);
