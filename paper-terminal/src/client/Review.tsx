import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppState, Chain } from '../shared/domain';
import type { TerminalControls } from './useTerminal';
import { EquityChart } from './Chart';
import type { EquityPoint } from './Chart';
import { exportCsv } from './api';
import { FillsTable, OrdersTable, PositionsTable } from './tables';
import { Badge, Empty, Icon, Stat } from './ui';
import { CHAIN_NAMES, ORDER_NAMES, money, object, pct, price, savedEquityPoints, shortAddress, timeText, timestampMs } from './lib';

const SNAPSHOT_KEY = 'paper-terminal.equity-observations.v1';
const EquityObservations = createContext<Record<string, EquityPoint[]>>({});
export function EquityObservationProvider({ state, children }: { state: AppState | null; children: ReactNode }) {
  const history = useEquityObservations(state);
  return <EquityObservations.Provider value={history}>{children}</EquityObservations.Provider>;
}
export function ObservedReview({ state, chain, actions }: { state: AppState; chain: Chain; actions: TerminalControls }) {
  const history = useContext(EquityObservations);
  return <Review state={state} chain={chain} actions={actions} history={history}/>;
}
export function useEquityObservations(state: AppState | null) {
  const [history, setHistory] = useState<Record<string, EquityPoint[]>>(() => { try { if (typeof window === 'undefined') return {}; const parsed = JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY) ?? '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } });
  useEffect(() => {
    if (!state) return;
    const time = Math.floor(timestampMs(state.at) / 1000);
    setHistory(previous => {
      const next = { ...previous }; let changed = false;
      for (const a of state.accounts) {
        const key = `${a.id}:${a.createdAt}`; const points = Array.isArray(next[key]) ? next[key] : [];
        if (points.length && time < points.at(-1)!.time + 5) continue;
        next[key] = [...points, { time, value: a.conservativeEquityUsd }].slice(-1500); changed = true;
      }
      if (changed) { try { sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(next)); } catch { /* Observations remain available in memory. */ } }
      return changed ? next : previous;
    });
  }, [state]);
  useEffect(() => { const clear = () => { sessionStorage.removeItem(SNAPSHOT_KEY); setHistory({}); }; window.addEventListener('paper-restored', clear); return () => window.removeEventListener('paper-restored', clear); }, []);
  return history;
}
export const Review = memo(function Review({ state, chain, actions, history }: { state: AppState; chain: Chain; actions: TerminalControls; history: Record<string, EquityPoint[]> }) {
  const [accountId, setAccountId] = useState('all');
  const [tab, setTab] = useState<'positions' | 'orders' | 'fills' | 'audit'>('positions');
  const [period, setPeriod] = useState('all');
  const [side, setSide] = useState('all');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const accounts = state.accounts.filter(a => a.chain === chain);
  const selectedAccount = accounts.find(a => a.id === accountId);
  const effectiveId = selectedAccount?.id ?? 'all';
  const visibleAccounts = effectiveId === 'all' ? accounts.filter(a => a.kind !== 'research') : accounts.filter(a => a.id === effectiveId);
  const accountIds = new Set(visibleAccounts.map(a => a.id));
  const cutoff = period === 'all' ? 0 : timestampMs(state.at) - (period === '24h' ? 86400000 : 7 * 86400000);
  const matches = (token: string, reason?: string) => `${token} ${reason ?? ''}`.toLowerCase().includes(search.toLowerCase());
  const positions = state.positions.filter(p => accountIds.has(p.accountId) && timestampMs(p.openedAt) >= cutoff && matches(p.token, p.symbol + ' ' + p.reason) && (!openOnly || !p.closedAt));
  const orders = state.orders.filter(o => accountIds.has(o.accountId) && timestampMs(o.createdAt) >= cutoff && matches(o.token, o.reason + ' ' + o.error) && (side === 'all' || o.side === side) && (status === 'all' || o.status === status));
  const fills = state.fills.filter(f => accountIds.has(f.accountId) && timestampMs(f.at) >= cutoff && matches(f.token, f.reason) && (side === 'all' || f.side === side));
  const equity = visibleAccounts.reduce((sum, a) => sum + a.conservativeEquityUsd, 0);
  const initial = visibleAccounts.reduce((sum, a) => sum + a.initialCapitalUsd, 0);
  const realized = visibleAccounts.reduce((sum, a) => sum + a.realizedUsd, 0);
  const fees = visibleAccounts.reduce((sum, a) => sum + a.feesUsd, 0);
  const chartAccount = selectedAccount ?? visibleAccounts.find(a => a.kind === 'manual') ?? visibleAccounts[0];
  const savedPoints = chartAccount ? savedEquityPoints(state.health, chartAccount.id) : [];
  const points = savedPoints.length ? savedPoints : chartAccount ? history[`${chartAccount.id}:${chartAccount.createdAt}`] ?? [] : [];
  const feeParts = useMemo(() => fills.reduce((sum, f) => ({ gas: sum.gas + f.fees.gasUsd, approval: sum.approval + f.fees.approvalUsd, protocol: sum.protocol + f.fees.protocolUsd, tax: sum.tax + f.fees.taxUsd, conversion: sum.conversion + f.fees.conversionUsd }), { gas: 0, approval: 0, protocol: 0, tax: 0, conversion: 0 }), [fills]);
  const exportKind = tab === 'audit' ? 'fills' : tab;
  const soak = object(state.health.soak);
  const soakStarted = typeof soak.startedAt === 'number' ? soak.startedAt : null;
  const soakDuration = typeof soak.targetMs === 'number' ? soak.targetMs : 86400000;
  const soakElapsed = soakStarted ? Math.max(0, timestampMs(state.at) - timestampMs(soakStarted)) : 0;
  const doExport = async () => { try { await exportCsv(exportKind); actions.setNotice('完整账本 CSV 已下载；页面筛选不影响导出范围。'); } catch (e) { actions.setError(e instanceof Error ? e.message : '导出失败。'); } };
  return <div className="page review-page"><div className="page-intro"><div><div className="eyebrow">EVERY DECISION, ACCOUNTED FOR</div><h1>交易复盘 <span>看清收益，也看清成本</span></h1><p>持仓、失败订单与无法卖出的仓位都保留。每次模拟成交可以追溯到当时的报价与理由。</p></div><button className="button secondary" onClick={() => void doExport()} disabled={tab === 'audit'}><Icon name="down" size={16}/>导出完整 {exportKind === 'fills' ? '成交' : exportKind === 'orders' ? '订单' : '持仓'} CSV</button></div>
    <div className="review-account-row"><label>账户<select aria-label="复盘账户" value={effectiveId} onChange={e => setAccountId(e.target.value)}><option value="all">{CHAIN_NAMES[chain]} · 人工与机器人全部账户</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.kind === 'research' ? '（研究账户）' : ''}</option>)}</select></label><span className="muted">以下净值为选中账户全期账本，不受记录时间筛选影响</span></div>
    <div className="stats-row"><Stat label="保守净值" value={money(equity)} sub={`初始虚拟本金 ${money(initial)}`}/><Stat label="净值收益率" value={initial ? pct((equity / initial - 1) * 100, true) : '—'} tone={equity >= initial ? 'positive' : 'negative'} sub={`变化 ${money(equity - initial, true)}`}/><Stat label="已实现净收益" value={money(realized, true)} tone={realized >= 0 ? 'positive' : 'negative'} sub="按后端账本统计"/><Stat label="累计交易费用" value={money(fees)} sub="含授权、Gas、协议费、税及兑换"/></div>
    <div className="review-charts"><section className="panel"><header className="panel-heading"><h2>保守净值曲线</h2><span className="muted">{chartAccount?.name ?? '无可用账户'} · {savedPoints.length ? '账本已保存快照' : '本次浏览观察'}</span></header><EquityChart points={points}/><p className="panel-note">优先显示后端保存的净值快照。缺少历史时，仅记录本次浏览收到的实际净值，不猜测历史持仓价值。</p></section><section className="panel cost-panel"><header className="panel-heading"><h2>成交费用拆分</h2><Badge>当前记录筛选</Badge></header>{[['Gas', feeParts.gas], ['模拟授权', feeParts.approval], ['协议费', feeParts.protocol], ['代币税', feeParts.tax], ['报价币兑换', feeParts.conversion]].map(([label, value]) => <div className="cost-row" key={String(label)}><span>{String(label)}</span><div className="cost-track"><span style={{ width: `${Math.max(0, Math.min(100, Object.values(feeParts).reduce((a, b) => a + b, 0) ? Number(value) / Object.values(feeParts).reduce((a, b) => a + b, 0) * 100 : 0))}%` }}/></div><b>{money(Number(value))}</b></div>)}<p className="panel-note">报价已扣的费用只展示一次；不再次从净收益扣除。部分费用可能为估计值。</p></section></div>
    <ControlWalletPanel state={state} chain={chain}/>
    <section className="panel review-ledger"><header className="ledger-tabs">{[['positions', '持仓批次', positions.length], ['orders', '全部订单', orders.length], ['fills', '成交明细', fills.length], ['audit', '运行记录', state.audit.length]].map(([id, label, count]) => <button className={tab === id ? 'active' : ''} key={String(id)} onClick={() => setTab(id as typeof tab)}>{label}<span>{count}</span></button>)}</header>
      {tab !== 'audit' && <div className="ledger-filters"><div className="filter-search"><Icon name="search" size={14}/><input aria-label="搜索复盘记录" placeholder="搜索合约、交易理由" value={search} onChange={e => setSearch(e.target.value)}/></div><select aria-label="记录时间范围" value={period} onChange={e => setPeriod(e.target.value)}><option value="all">全部时间</option><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option></select>{tab !== 'positions' && <select aria-label="交易方向" value={side} onChange={e => setSide(e.target.value)}><option value="all">买入与卖出</option><option value="buy">仅买入</option><option value="sell">仅卖出</option></select>}{tab === 'orders' && <select aria-label="订单状态" value={status} onChange={e => setStatus(e.target.value)}><option value="all">全部状态</option>{Object.entries(ORDER_NAMES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}{tab === 'positions' && <label className="checkbox"><input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)}/>只看未清仓</label>}</div>}
      {tab === 'positions' && <PositionsTable positions={positions} accounts={state.accounts}/>}{tab === 'orders' && <OrdersTable orders={orders} accounts={state.accounts} actions={actions}/>}{tab === 'fills' && <FillsTable fills={fills} accounts={state.accounts}/>}{tab === 'audit' && (state.audit.length ? <div className="audit-list">{[...state.audit].sort((a, b) => b.at - a.at).slice(0, 200).map(row => <div className="audit-row" key={row.id}><span>{timeText(row.at, true)}</span><Badge tone={/error|fail|gap/i.test(row.kind) ? 'amber' : 'muted'}>{row.kind}</Badge><p>{row.message}</p></div>)}</div> : <Empty title="暂无运行记录" detail="连接恢复、研究过程与订单处理事件会保留在这里。" icon="review"/>)}
    </section>
    <div className="chain-health-grid">{state.chains.map(c => <section className="panel chain-health" key={c.chain}><header><h3>{CHAIN_NAMES[c.chain]}</h3><Badge tone={c.connected ? 'green' : 'amber'}>{c.connected ? '已连接' : '等待重连'}</Badge></header><div><span>最新区块 <b>#{c.head.toLocaleString('en-US')}</b></span><span>数据缺口 <b>{c.gaps}</b></span><span>重连 <b>{c.reconnects}</b></span></div><small>{c.lastError || `最近区块 ${timeText(c.headAt)} · ${c.source}`}</small></section>)}</div>
    <section className="panel soak-panel"><header className="panel-heading"><h2>双链 24 小时运行验收</h2><Badge tone={soak.status === 'passed' ? 'green' : soak.status === 'failed' ? 'red' : 'amber'}>{soak.status === 'passed' ? '后台判定通过' : soak.status === 'failed' ? '发现运行问题' : soakStarted ? '持续采集检查' : '尚无验收记录'}</Badge></header><div className="soak-body"><div className="progress-track"><span style={{width:`${Math.min(100,soakElapsed / soakDuration * 100)}%`}}/></div><div><span>已运行 <b>{soakStarted ? `${(soakElapsed / 3600000).toFixed(1)} 小时` : '—'}</b></span><span>检查快照 <b>{typeof soak.samples === 'number' ? soak.samples : '—'}</b></span><span>账本检查异常 <b>{typeof soak.ledgerFailures === 'number' ? soak.ledgerFailures : '—'}</b></span><span>运行缺口 <b>{typeof soak.gaps === 'number' ? soak.gaps : '—'}</b></span></div><p>运行时长不能单独证明通过；必须同时满足双链连接覆盖率、无账本异常和无运行缺口。</p></div></section>
  </div>;
});
export function ControlWalletPanel({ state, chain }: { state: AppState; chain: Chain }) {
  const wallets = (state.controlWallets ?? []).filter(w => w.chain === chain);
  const addresses = new Set(wallets.map(w => w.address.toLowerCase()));
  const events = (state.controlActivity ?? []).filter(e => e.chain === chain && e.kind === 'wallet' && e.wallet && addresses.has(e.wallet.toLowerCase()) && (e.side === 'buy' || e.side === 'sell') && e.payload.verified === true && e.payload.removed !== true).sort((a, b) => timestampMs(b.at) - timestampMs(a.at)).slice(0, 40);
  return <section className="panel control-wallet-panel"><header className="panel-heading"><h2>你的钱包 · 只读对照</h2><Badge tone="blue">{CHAIN_NAMES[chain]} · 成交现金流</Badge></header>
    {wallets.map(w => <div className="control-wallet-address" key={`${w.chain}:${w.address}`}><span>{w.name || '你的钱包'}</span><span className="numeric">{w.address}</span><Badge>只读观察</Badge></div>)}
    <p className="panel-note">这里仅展示链上买卖金额，不计入虚拟资金。每笔完整成本尚未核实，不能仅按这些记录计算盈亏；美元价格和金额可能使用当前汇率换算。</p>
    {events.length ? <div className="table-wrap"><table><thead><tr><th>成交时间 / 区块</th><th>代币</th><th>方向</th><th>成交参考价 · USD</th><th>成交金额 · USD</th><th>核实状态</th></tr></thead><tbody>{events.map(e => {
      const market = state.markets.find(m => m.chain === chain && m.address.toLowerCase() === e.token?.toLowerCase());
      return <tr key={e.id}><td>{timeText(e.at, true)}<small>#{e.block.toLocaleString('en-US')}{e.replayed ? ' · 历史补录' : ''}</small></td><td title={e.token}>{market?.symbol || shortAddress(e.token ?? '未知代币')}<small title={e.wallet}>{wallets.find(w => w.address.toLowerCase() === e.wallet?.toLowerCase())?.name || '你的钱包'}</small></td><td><Badge tone={e.side === 'buy' ? 'green' : 'amber'}>{e.side === 'buy' ? '买入' : '卖出'}</Badge></td><td className="numeric">{price(e.priceUsd)}</td><td className="numeric">{money(e.amountUsd)}<small>{e.side === 'buy' ? '买入成交额' : '卖出成交额'} · 非盈亏</small></td><td><Badge tone="green">链上买卖已核实</Badge><small>收到 {timeText(e.receivedAt)}</small></td></tr>;
    })}</tbody></table></div> : <Empty icon="wallet" title={wallets.length ? '等待核实的买卖记录' : '尚未接入只读对照钱包'} detail={wallets.length ? '仅显示该链最近核实的买卖行为；没有记录时不推算收益。' : '后台接入后会显示你的钱包地址和实际买卖记录。'}/>}
    <p className="panel-note">最近记录来自后台最多 40 条已核实事件；此面板不提交跟单、签名或资金操作。</p>
  </section>;
}
