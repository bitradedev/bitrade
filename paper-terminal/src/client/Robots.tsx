import { useState } from 'react';
import type { AppState, Chain, ExitRules, Strategy } from '../shared/domain';
import type { TerminalControls } from './useTerminal';
import { Badge, Empty, Icon, Modal, RulesEditor, Stat } from './ui';
import { CHAIN_NAMES, accountReturn, money, pct, timeText, timestampMs, validAddress, validateRules } from './lib';

export function Robots({ state, chain, actions }: { state: AppState; chain: Chain; actions: TerminalControls }) {
  const [allChains, setAllChains] = useState(true);
  const [editing, setEditing] = useState<Strategy | null>(null);
  const strategies = state.strategies.filter(s => allChains || s.chain === chain).sort((a,b) => Number(b.mode === 'experiment') - Number(a.mode === 'experiment'));
  const accountIds = new Set(strategies.map(s => s.accountId));
  const botAccounts = state.accounts.filter(a => accountIds.has(a.id));
  const totalCapital = botAccounts.reduce((n, a) => n + a.initialCapitalUsd, 0);
  const equity = botAccounts.reduce((n, a) => n + a.conservativeEquityUsd, 0);
  const collectionMetric = (name: string) => typeof state.health[name] === 'number' && Number.isFinite(state.health[name]) ? state.health[name] as number : null;
  const recordingSince = collectionMetric('recordingSince');
  const collectedDays = recordingSince ? Math.max(0, (timestampMs(state.at) - timestampMs(recordingSince)) / 86400000) : null;
  return <div className="page robots-page"><div className="page-intro"><div><div className="eyebrow">AUTOMATED PAPER TRADING</div><h1>量化机器人 <span>先试运行，再验证</span></h1><p>点击“启动独立试运行”即可用另一份 $100 虚拟资金观察规则的实际表现。原正式账户继续独立研究。</p></div><label className="checkbox chain-checkbox"><input type="checkbox" checked={allChains} onChange={e => setAllChains(e.target.checked)}/>显示两条链全部实验组</label></div>
    <div className="robot-emergency panel"><button className="button danger" disabled={actions.pending || !state.strategies.length} onClick={() => void actions.mutate('/api/strategies/stop', {}, '已停止全部正式组与试运行的新仓；已有持仓继续退出。恢复须逐组操作。')}><Icon name="pause" size={18}/>停止全部机器人</button><div><strong>停止两条链全部实验组的新仓，并阻止自动启用</strong><span>已有持仓继续执行退出规则；恢复须逐组操作，正式组仍须通过验证。</span></div></div>
    <section className="panel collection-panel"><header className="panel-heading"><h2>{state.strategies.some(s => s.state === 'running' && s.mode !== 'experiment') ? '行情采集中 / 已验证策略运行中' : state.strategies.some(s => s.state === 'running' && s.mode === 'experiment') ? '独立试运行 / 正式策略仍在验证' : '行情采集中 / 可启动独立试运行'}</h2><Badge tone="blue">全终端实际统计</Badge></header><div className="collection-metrics"><Stat label="采集记录总数" value={collectionMetric('sampleCount')?.toLocaleString('en-US') ?? '—'} sub="含未完成记录，不等于合格回合"/><Stat label="已保存报价" value={collectionMetric('quoteCount')?.toLocaleString('en-US') ?? '—'} sub="采集记录不代表策略已盈利"/><Stat label="进行中的采集任务" value={collectionMetric('activeResearchTapes')?.toLocaleString('en-US') ?? '—'} sub="后台持续观察实际行情"/><Stat label="终端采集开始" value={timeText(recordingSince, true)} sub={collectedDays == null ? '等待采集状态' : `开始至今 ${collectedDays.toFixed(2)} 天，包含缺口`}/></div><p className="panel-note">正式验证至少需要 21 天完整采集（14 天训练 + 7 天验证），封存参数后再检验 7 天。独立试运行现在就可启动，结果单独标记“未验证”，不能替代正式验证。</p></section>
    <div className="stats-row"><Stat label="独立实验组" value={strategies.length} sub="8 个正式组 · 试运行另设 $100"/><Stat label="保守净值" value={money(equity)} sub={`初始虚拟本金 ${money(totalCapital)}`}/><Stat label="净值变化" value={money(equity - totalCapital, true)} tone={equity >= totalCapital ? 'positive' : 'negative'} sub="无法变现的仓位按保守值计入"/><Stat label="自动运行 / 等待检验" value={<>{strategies.filter(s => s.state === 'running').length}<span className="stat-divider">/</span>{strategies.filter(s => s.state === 'waiting').length}</>} sub="运行数含未验证试运行；后台持续运行"/></div>
    <div className="notice-box research-notice"><Icon name="shield" size={18}/><div><strong>试运行与正式策略分别记账，全部使用虚拟资金。</strong><span>试运行会按实时信号尝试成交，仍检查费用、报价和风控；没有可成交机会时，下方显示阻碍。试运行盈利不等于验证通过。</span></div></div>
    {!strategies.length ? <div className="panel"><Empty icon="robot" title="等待实验组初始化" detail="本机服务建立账户后，会显示各组的真实资金、运行状态和等待原因。"/></div> : <div className="robot-grid">{strategies.map(s => {
      const account = state.accounts.find(a => a.id === s.accountId);
      const positions = state.positions.filter(p => p.accountId === s.accountId && !p.closedAt);
      const run = s.mode === 'experiment' ? undefined : state.researchRuns.find(r => r.id === s.researchRunId) ?? state.researchRuns.find(r => r.strategyId === s.id);
      const diagnostic = state.robotDiagnostics?.find(d => d.strategyId === s.id);
      const trialExists = state.strategies.some(t => t.id === 'paper-experiment-' + s.id);
      const paused = s.state === 'paused';
      return <section className="robot-card panel" key={s.id}><header><span className={`robot-icon ${s.family === 'wallet' ? 'violet' : 'cyan'}`}><Icon name={s.family === 'wallet' ? 'wallet' : 'trade'} size={22}/></span><div><h2>{s.name}</h2><small>{CHAIN_NAMES[s.chain]} · {s.family === 'wallet' ? '钱包信号' : '独立选币'} · {s.horizon === 'short' ? '新盘短线' : '波段'}</small></div><Badge tone={s.mode === 'experiment' ? 'amber' : s.state === 'running' ? 'green' : paused ? 'muted' : 'amber'}><span className={`status-dot ${s.state === 'running' ? 'green' : paused ? '' : 'amber'}`}/>{s.mode === 'experiment' ? paused ? '试运行已暂停' : '未验证试运行' : s.state === 'running' ? '模拟运行' : paused ? '已暂停' : '等待达标'}</Badge></header>
        <div className="robot-equity"><span>保守净值</span><strong>{money(account?.conservativeEquityUsd)}</strong><span className={account && accountReturn(account) >= 0 ? 'positive' : 'negative'}>{account ? pct(accountReturn(account), true) : '—'}</span></div>
        <div className="robot-metrics"><div><span>已实现净收益</span><b className={(account?.realizedUsd ?? 0) >= 0 ? 'positive' : 'negative'}>{money(account?.realizedUsd, true)}</b></div><div><span>累计费用</span><b>{money(account?.feesUsd)}</b></div><div><span>持仓 / 上限</span><b>{positions.length} / {state.risk.maxPositions}</b></div><div><span>今日新仓 / 上限</span><b>{account?.dayEntries ?? '—'} / {state.risk.dailyEntries}</b></div></div>
        <div className="robot-reason"><Icon name={s.state === 'running' ? 'play' : 'info'} size={15}/><span>{account?.haltReason || s.reason || (s.state === 'waiting' ? '尚未通过训练、验证和实时检验。' : paused ? '已暂停自动新仓。' : '后台正在检查真实信号。')}</span></div>
        <div className="robot-diagnostics"><div><span>本版本信号</span><b>{diagnostic?.signals ?? '—'}</b></div><div><span>买卖报价就绪的记录</span><b>{diagnostic?.readySamples ?? '—'}</b></div><div><span>报价失败 / 过期次数</span><b>{diagnostic ? `${diagnostic.failedPreparations} / ${diagnostic.expiredPreparations}` : '—'}</b></div><div><span>已成交订单</span><b>{diagnostic?.filledOrders ?? '—'}</b></div></div>
        {diagnostic && <p className="robot-blocker">{!diagnostic.dataFresh ? '该链新区块已过期，暂停新入场。' : diagnostic.latestPreparationReason ? `最近报价被拦：${diagnostic.latestPreparationReason}` : diagnostic.signals === 0 ? '尚未捕获符合本组条件的核实信号。' : '报价就绪记录不等于完整回合；成交按延迟后的新区块重新核实。'}</p>}
        <div className="robot-rule-summary"><span>止损 −{s.rules.stopPct}%</span><span>首卖 {s.rules.targets[0] ? `+${s.rules.targets[0].gainPct}% / 原仓 ${s.rules.targets[0].sellOriginalPct}%` : '未设置'}</span><span>最长 {s.rules.maxHoldMs / 60000} 分钟</span></div>
        <div className="robot-progress"><div><span>{s.mode === 'experiment' ? '独立试运行，未通过正式验证' : run ? run.status === 'collecting' ? '正在收集正式验证资料' : '关联研究 ' + run.id.slice(0, 8) : '尚无封存研究'}</span><small>版本 {s.version.slice(0,8)}</small></div>{s.mode !== 'experiment' && <div className="progress-track"><span style={{ width: run?.status === 'passed' ? '100%' : run?.status === 'forward' ? '66%' : run?.status === 'training' ? '33%' : '0%' }}/></div>}<small>最近信号 {timeText(diagnostic?.lastSignalAt ?? s.lastDecisionAt, true)}</small>{s.mode !== 'experiment' && diagnostic && <small>最早训练日期 {timeText(diagnostic.earliestTrainingAt, true)}，仍需完整数据与样本达标</small>}</div>
        <footer>{s.mode !== 'experiment' && <button className="button primary small" disabled={actions.pending || trialExists} onClick={() => void actions.mutate(`/api/strategies/${encodeURIComponent(s.id)}/experiment`, {}, '独立100美元虚拟试运行已启动；正式账户和验证进度保留。')}><Icon name="play" size={14}/>{trialExists ? '已有独立试运行' : '启动独立试运行'}</button>}<button className="button secondary small" disabled={actions.pending} onClick={() => void actions.mutate(`/api/strategies/${encodeURIComponent(s.id)}`, { action: paused ? 'resume' : 'pause' }, paused ? '已请求恢复；后台将重新检查账户与风控条件。' : '策略已暂停新仓，已有仓位继续按规则退出。')}><Icon name={paused ? 'play' : 'pause'} size={14}/>{paused ? s.mode === 'experiment' ? '恢复试运行' : '恢复策略' : '暂停新仓'}</button><button className="button ghost small" onClick={() => setEditing(s)}><Icon name="settings" size={14}/>参数与钱包</button></footer>
      </section>;
    })}</div>}
    <div className="panel bot-risk-strip"><Icon name="shield"/><div><strong>统一风控</strong><span>单笔计划损失 ≤ {state.risk.riskPct}% · 单次投入 ≤ {state.risk.maxPositionPct}% · 连亏 {state.risk.maxConsecutiveLosses} 次停止 · 日亏 {state.risk.dailyLossPct}% 停止</span></div><Badge tone="amber">跳空与卖出失败仍可能超出计划损失</Badge></div>
    {editing && <StrategyEditor strategy={editing} actions={actions} onClose={() => setEditing(null)}/>}
  </div>;
}
function StrategyEditor({ strategy, actions, onClose }: { strategy: Strategy; actions: TerminalControls; onClose: () => void }) {
  const [rules, setRules] = useState<ExitRules>(structuredClone(strategy.rules));
  const [walletText, setWalletText] = useState(strategy.wallets.map(w => `${w.name}, ${w.address}`).join('\n'));
  const [error, setError] = useState('');
  const grid = strategy.horizon === 'short' ? { stop: [10, 15], gain: [30, 60], sell: [50, 70], trail: [10, 20], minutes: [5, 10] } : { stop: [5, 10], gain: [10, 20], sell: [50, 70], trail: [5, 10], minutes: [30, 120] };
  const save = async () => {
    const ruleError = validateRules(rules); if (ruleError) { setError(ruleError); return; }
    const wallets: { name: string; address: string }[] = [];
    if (strategy.family === 'wallet') for (const line of walletText.split('\n').map(l => l.trim()).filter(Boolean)) {
      const parts = line.split(/[,，]/).map(v => v.trim()); const address = parts.at(-1) ?? ''; const name = parts.length > 1 ? parts.slice(0, -1).join(', ') : address.slice(0, 8);
      if (!validAddress(address)) { setError(`钱包地址不完整：${line}`); return; }
      if (!wallets.some(w => w.address.toLowerCase() === address.toLowerCase())) wallets.push({ name, address });
    }
    const nextRules = { ...rules, targets: [...rules.targets].sort((a, b) => a.gainPct - b.gainPct) };
    const rulesChanged = JSON.stringify(nextRules) !== JSON.stringify(strategy.rules);
    const canonicalWallets = (values: Strategy['wallets']) => values.map(w => ({ name: w.name.trim(), address: w.address.toLowerCase() }));
    const walletsChanged = strategy.family === 'wallet' && JSON.stringify(canonicalWallets(wallets)) !== JSON.stringify(canonicalWallets(strategy.wallets));
    if (walletsChanged && !wallets.length) { setError('钱包信号策略至少需要一个观察钱包。'); return; }
    if (rulesChanged && (!nextRules.protectBreakeven || nextRules.targets.length !== 1 || !grid.stop.includes(nextRules.stopPct) || !grid.gain.includes(nextRules.targets[0].gainPct) || !grid.sell.includes(nextRules.targets[0].sellOriginalPct) || !grid.trail.includes(nextRules.trailPct) || !grid.minutes.some(m => m * 60000 === nextRules.maxHoldMs))) { setError('参数须属于下方列出的 32 个已批准候选组合，仅允许一档止盈，且须开启含费用的剩余成本保护。'); return; }
    setError('');
    if (await actions.mutate(`/api/strategies/${encodeURIComponent(strategy.id)}`, { action: 'pause', ...(rulesChanged ? { rules: nextRules } : {}), ...(walletsChanged ? { wallets: canonicalWallets(wallets) } : {}) }, strategy.mode === 'experiment' ? '试运行设置已保存并暂停；可在卡片上恢复独立虚拟试运行。' : '设置已保存，策略暂停等待重新研究；验证通过前不会自动开仓。')) onClose();
  };
  return <Modal title={`${strategy.name} · 参数与观察钱包`} onClose={onClose}><div className="notice-box warning">{strategy.mode === 'experiment' ? '试运行使用计划中的32种候选参数。修改后创建新版本并暂停新仓，可从卡片手动恢复；已有仓位保留原绑定规则。试运行始终标记未验证。' : '仅允许当前周期的 32 个已批准候选组合。更改参数会暂停新仓、创建新版本并使旧研究失效；已有仓位继续使用绑定时的规则。新版本须重新通过验证与实时检验，不能直接启用。'}</div><p className="approved-grid-note">止损 {grid.stop.join(' / ')}% · 首档止盈 {grid.gain.join(' / ')}% · 卖出原仓 {grid.sell.join(' / ')}% · 回撤 {grid.trail.join(' / ')}% · 最长持有 {grid.minutes.join(' / ')} 分钟。仅一档止盈，须开启含费用的剩余成本保护。</p>{strategy.family === 'wallet' && <label className="field"><span>{CHAIN_NAMES[strategy.chain]} 观察钱包</span><textarea rows={6} value={walletText} onChange={e => setWalletText(e.target.value)} placeholder="每行一个：名称, 0x钱包地址"/><small>只采纳核实的首次买入；不跟卖、不跟后续加仓。</small></label>}<RulesEditor rules={rules} onChange={setRules}/>{(error || actions.error) && <p className="inline-error" role="alert">{error || actions.error}</p>}<button className="button primary full" disabled={actions.pending} onClick={() => void save()}>{strategy.mode === 'experiment' ? '保存试运行版本并暂停' : '保存新版本并暂停新仓'}</button></Modal>;
}
