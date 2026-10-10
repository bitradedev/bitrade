import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, AppState, Chain, ExitRules, Market, Position, RiskConfig, Side } from '../shared/domain';
import { DEFAULT_RULES } from '../shared/domain';
import type { TerminalControls } from './useTerminal';
import { CandleChart } from './Chart';
import { Badge, Empty, Field, Icon, RulesEditor } from './ui';
import { CHAIN_NAMES, QUALITY_NAMES, money, originalSellQuantity, pct, price, rawQuantity, shortAddress, timeText, timestampMs, validAddress, validateRules } from './lib';
import { PositionsTable } from './tables';
import { request } from './api';
import { reuseArray } from './state-cache';

export interface MarketSelection { chain: Chain; token: string; market: Market | null; }
function readDraft(chain: Chain, field: 'market' | 'amount'): string | null {
  try { return typeof window === 'undefined' ? null : sessionStorage.getItem(`paper-terminal.draft.${chain}.${field}`); } catch { return null; }
}
function saveDraft(chain: Chain, field: 'market' | 'amount', value: string) {
  try { sessionStorage.setItem(`paper-terminal.draft.${chain}.${field}`, value); } catch { /* Draft storage is optional; live interaction remains available. */ }
}
export function rememberTradingMarket(market: Market) { if (validAddress(market.address)) saveDraft(market.chain, 'market', market.address.toLowerCase()); }
export function retainMarketSelection(previous: MarketSelection | null, chain: Chain, markets: Market[]): MarketSelection | null {
  if (previous?.chain === chain && previous.token) {
    const live = markets.find(m => m.chain === chain && m.address.toLowerCase() === previous.token.toLowerCase());
    return live && live !== previous.market ? { ...previous, market: live } : previous;
  }
  const onChain = markets.filter(m => m.chain === chain);
  const priced = (m: Market) => m.priceUsd !== null && Number.isFinite(m.priceUsd) && m.priceUsd > 0;
  const first = onChain.find(m => priced(m) && m.quality === 'verified') ?? onChain.find(priced) ?? onChain[0];
  return first ? { chain, token: first.address.toLowerCase(), market: first } : null;
}

export const Trading = memo(function Trading({ state, chain, actions, initialMarket }: { state: AppState; chain: Chain; actions: TerminalControls; initialMarket?: Market | null }) {
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<MarketSelection | null>(() => initialMarket?.chain === chain ? { chain, token: initialMarket.address.toLowerCase(), market: initialMarket } : null);
  const [pinRevision, setPinRevision] = useState(0);
  const [contract, setContract] = useState('');
  const [formError, setFormError] = useState('');
  const markets = useMemo(() => state.markets.filter(m => m.chain === chain).sort((a, b) => (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0)), [state.markets, chain]);
  const visible = useMemo(() => markets.filter(m => `${m.symbol} ${m.name} ${m.address} ${m.platform}`.toLowerCase().includes(search.toLowerCase())), [markets, search]);
  const marketsRef = useRef(markets); marketsRef.current = markets;
  const draftToken = readDraft(chain, 'market');
  const storedSelection = draftToken && validAddress(draftToken) ? { chain, token: draftToken.toLowerCase(), market: markets.find(m => m.address.toLowerCase() === draftToken.toLowerCase()) ?? null } : null;
  const preferredSelection = selection?.chain === chain ? selection : storedSelection;
  const activeSelection = retainMarketSelection(preferredSelection, chain, markets);
  const market = activeSelection?.market ?? null;
  useEffect(() => { setSelection(previous => retainMarketSelection(previous?.chain === chain ? previous : storedSelection, chain, markets)); }, [chain, markets]);
  useEffect(() => { if (activeSelection?.token) saveDraft(chain, 'market', activeSelection.token); }, [chain, activeSelection?.token]);
  useEffect(() => { setSearch(''); setContract(''); setFormError(''); }, [chain]);
  const chooseToken = useCallback((token: string) => {
    const address = token.trim().toLowerCase();
    setSelection(previous => ({ chain, token: address, market: marketsRef.current.find(m => m.address.toLowerCase() === address) ?? (previous?.chain === chain && previous.token === address ? previous.market : null) }));
    setPinRevision(n => n + 1);
  }, [chain]);
  const chartMarket = useMemo(() => market ? { chain: market.chain, address: market.address, updatedAt: market.updatedAt, block: market.block } : null, [market?.chain, market?.address, market?.updatedAt, market?.block]);
  const fillsRef = useRef<typeof state.fills>([]);
  const selectedFills = useMemo(() => fillsRef.current = reuseArray(fillsRef.current, state.fills.filter(f => f.chain === chain && f.token.toLowerCase() === market?.address.toLowerCase())), [state.fills, chain, market?.address]);
  const openPositions = useMemo(() => state.positions.filter(p => p.chain === chain && !p.closedAt), [state.positions, chain]);
  useEffect(() => {
    if (!activeSelection?.token) return;
    let current = true;
    // Retention is a background request; it never holds up selecting or displaying this market.
    void request('/api/markets/select', state.csrf, { chain, token: activeSelection.token }).catch(e => { if (current) actions.setError(`保留当前市场失败：${e instanceof Error ? e.message : '请稍后重新选择。'}`); });
    return () => { current = false; };
  }, [chain, activeSelection?.token, state.csrf, pinRevision]);
  const addMarket = async () => {
    if (!validAddress(contract)) { setFormError('请输入完整的 0x 合约地址（40 位十六进制）。'); return; }
    setFormError('');
    const token = contract.trim(); chooseToken(token);
    if (await actions.mutate('/api/markets/add', { chain, token }, '合约已加入观察列表。')) setContract('');
  };
  const chainStatus = state.chains.find(c => c.chain === chain);
  const stale = !chainStatus?.connected || timestampMs(state.at) - timestampMs(chainStatus.headAt) > 15000;
  return <div className="trading-layout">
    <aside className="market-panel panel"><header className="panel-heading"><h2>市场观察</h2><span className="count">{markets.length}</span></header>
      <div className="market-search"><Icon name="search" size={16}/><input aria-label="搜索市场" placeholder="搜索名称、合约、平台" value={search} onChange={e => setSearch(e.target.value)}/>{search && <button className="icon-button" aria-label="清除搜索" onClick={() => setSearch('')}><Icon name="close" size={12}/></button>}</div>
      <form className="contract-add" onSubmit={e => { e.preventDefault(); void addMarket(); }}><input aria-label="粘贴代币合约地址" placeholder="粘贴代币合约 0x…" value={contract} onChange={e => setContract(e.target.value)}/><button className="icon-button" type="submit" disabled={actions.pending || !contract.trim()} aria-label="加入合约"><Icon name="plus" size={17}/></button></form>
      {formError && <p className="inline-error">{formError}</p>}
      <div className="market-column-heading"><span>代币 / 阶段</span><span>价格 / 成交额</span></div>
      <div className="market-list">{visible.map(m => <MarketRow key={m.id} market={m} selected={market?.id === m.id} onChoose={chooseToken}/>)}
        {!visible.length && <Empty icon="search" title={search ? '没有匹配的市场' : '等待真实市场数据'} detail={search ? '试试代币名称或完整合约。' : `正在观察 ${CHAIN_NAMES[chain]}。也可以粘贴合约地址。`}/>}</div>
      <footer className="market-footer"><span className={`status-dot ${stale ? 'amber' : 'green'}`}/>{stale ? '行情未就绪 · 暂停新仓' : '链上实时观察'}<span>{chainStatus?.head ? `#${chainStatus.head.toLocaleString('en-US')}` : '等待新区块'}</span></footer>
    </aside>
    <section className="market-workspace">
      <div className="chart-panel panel"><header className="token-heading"><div className="token-identity"><span className="token-avatar large">{(market?.symbol || '?').slice(0, 2)}</span><div><h2>{market?.symbol || '选择代币'}{market && <Badge tone={market.quality === 'verified' ? 'green' : market.quality === 'estimated' ? 'amber' : 'red'}>{QUALITY_NAMES[market.quality]}</Badge>}</h2><div className="token-meta">{market ? <><span>{market.name}</span><button className="address-button" onClick={() => { void navigator.clipboard.writeText(market.address).then(() => actions.setNotice('合约地址已复制。')).catch(() => actions.setError('无法复制，请手动选择合约地址。')); }} title={market.address}>{shortAddress(market.address)}<Icon name="copy" size={12}/></button><span>{market.platform} · {market.stage}</span></> : <span>支持内盘与毕业后的外盘</span>}</div></div></div><div className="token-price"><strong>{price(market?.priceUsd)}</strong><small>最新参考价 · 非成交报价</small></div></header>
        <div className="market-metrics"><span>流动性 <b>{money(market?.liquidityUsd)}</b></span><span>成交额 <b>{money(market?.volumeUsd)}</b></span><span>买 / 卖税 <b>{pct(market?.buyTaxPct)} / {pct(market?.sellTaxPct)}</b></span><span>更新 <b>{timeText(market?.updatedAt)}</b></span></div>
        {market?.reason && <div className={`market-warning ${market.quality === 'unavailable' ? 'danger' : ''}`}><Icon name="info" size={14}/>{market.reason}</div>}
        <CandleChart market={chartMarket} fills={selectedFills}/>
      </div>
      <div className="positions-panel panel"><header className="panel-heading"><h2>当前链持仓</h2><Badge>{openPositions.length} 个批次</Badge></header><PositionsTable positions={openPositions} accounts={state.accounts} onSelectToken={chooseToken}/></div>
    </section>
    <OrderTicket key={chain} accounts={state.accounts} allPositions={state.positions} risk={state.risk} chain={chain} market={market} stale={stale} actions={actions}/>
  </div>;
});

const OrderTicket = memo(function OrderTicket({ accounts, allPositions, risk, chain, market, stale, actions }: { accounts: Account[]; allPositions: Position[]; risk: RiskConfig; chain: Chain; market: Market | null; stale: boolean; actions: TerminalControls }) {
  const manualAccounts = useMemo(() => accounts.filter(a => a.chain === chain && a.kind === 'manual'), [accounts, chain]);
  const [accountId, setAccountId] = useState(manualAccounts[0]?.id ?? '');
  const account = manualAccounts.find(a => a.id === accountId) ?? manualAccounts[0];
  const [side, setSide] = useState<Side>('buy');
  const [kind, setKind] = useState<'market' | 'limit'>('market');
  const [amount, setAmount] = useState(() => { const draft = readDraft(chain, 'amount'); return draft !== null && draft.length <= 32 && (draft === '' || Number.isFinite(Number(draft))) ? draft : '2'; });
  useEffect(() => { saveDraft(chain, 'amount', amount); }, [chain, amount]);
  const [limit, setLimit] = useState('');
  const [slippage, setSlippage] = useState('3');
  const [reason, setReason] = useState('');
  const [sellPct, setSellPct] = useState(100);
  const [positionId, setPositionId] = useState('');
  const [rules, setRules] = useState<ExitRules>({ ...DEFAULT_RULES, targets: DEFAULT_RULES.targets.map(t => ({ ...t })) });
  const [showRules, setShowRules] = useState(true);
  const [error, setError] = useState('');
  const [orderPending, setOrderPending] = useState(false);
  const positions = useMemo(() => allPositions.filter(p => p.accountId === account?.id && p.token.toLowerCase() === market?.address.toLowerCase() && !p.closedAt && p.remainingRaw !== '0'), [allPositions, account?.id, market?.address]);
  const position = positions.find(p => p.id === positionId) ?? positions[0];
  const submitting = useRef(false);
  const reservedUsd = account?.nativeUsd ? Number(BigInt(account.reservedNativeRaw)) / 1e18 * account.nativeUsd : 0;
  const maxBudget = account ? Math.max(0, Math.min(account.cashUsd - reservedUsd, account.conservativeEquityUsd * risk.maxPositionPct / 100, rules.stopPct > 0 ? account.conservativeEquityUsd * risk.riskPct / rules.stopPct : 0)) : 0;
  const blockReasons: string[] = [];
  if (!account) blockReasons.push('当前网络没有可用的手动模拟账户。');
  if (!market) blockReasons.push('请先从左侧选择代币，或加入合约地址。');
  if (stale) blockReasons.push('网络未连接或区块更新已过期，暂时不能取得新区块报价。');
  if (side === 'buy' && account) {
    if (account.paused) blockReasons.push('该账户已暂停新仓，可用下方“恢复账户新仓”恢复。');
    if (account.dailyLatch || account.haltReason) blockReasons.push(account.dailyLatch || account.haltReason);
  }
  if (side === 'sell' && !position) blockReasons.push('当前所选代币没有可卖出的手动模拟批次。');
  if (orderPending) blockReasons.push('正在获取实际金额报价并校验本次订单，请等待结果。');
  const disabledReasons = [...new Set(blockReasons)];
  const blocked = disabledReasons.length > 0;
  const submit = async () => {
    if (submitting.current) return;
    if (!account || !market) { setError('请先选择可用的手动模拟账户和代币。'); return; }
    if (reason.trim().length < 2 || reason.trim().length > 500) { setError('交易理由须为 2–500 个字符，便于之后复盘。'); return; }
    const ruleError = side === 'buy' ? validateRules(rules) : null;
    if (ruleError) { setError(ruleError); return; }
    if (side === 'buy' && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) { setError('买入金额须大于 0。'); return; }
    if (side === 'buy' && Number(amount) > maxBudget + 1e-9) { const suggestion = Math.floor(Math.min(2, maxBudget) * 100) / 100; setError(`金额超过按价格止损估算的上限 ${money(maxBudget)}。${suggestion > 0 ? `可先试 ${money(suggestion)} 或更小金额，` : '当前风险预算不足，'}最终仍须按含费用报价校验。`); return; }
    if (!Number.isFinite(Number(slippage)) || Number(slippage) < 0 || Number(slippage) > 30) { setError('滑点容忍须在 0–30% 之间。'); return; }
    if (kind === 'limit' && (!Number.isFinite(Number(limit)) || Number(limit) <= 0)) { setError('请填写大于 0 的限价。'); return; }
    if (side === 'sell' && (!position || originalSellQuantity(position, sellPct) === '0')) { setError('该批次没有可卖出的数量。'); return; }
    setError('');
    const body = { clientId: crypto.randomUUID(), accountId: account.id, token: market.address, side, kind, amountUsd: side === 'buy' ? Number(amount) : undefined, ...(side === 'sell' && position ? { positionId: position.id, tokenAmountRaw: originalSellQuantity(position, sellPct) } : {}), ...(kind === 'limit' ? { limitPriceUsd: Number(limit) } : {}), slippagePct: Number(slippage), rules: side === 'sell' && position ? position.rules : { ...rules, targets: [...rules.targets].sort((a, b) => a.gainPct - b.gainPct) }, reason: reason.trim() };
    submitting.current = true;
    setOrderPending(true);
    try { if (await actions.mutate('/api/paper/orders', body, kind === 'limit' ? '虚拟限价单已提交，等待后台检查触发。' : '虚拟订单已提交，延迟后在新区块重新报价。')) setReason(''); }
    finally { submitting.current = false; setOrderPending(false); }
  };
  return <aside className="order-panel panel"><header className="panel-heading"><h2>模拟下单</h2><Badge tone="blue">虚拟资金</Badge></header>
    <div className="ticket-body"><Field label="手动模拟账户"><select value={account?.id ?? ''} onChange={e => { setAccountId(e.target.value); setPositionId(''); }} disabled={!manualAccounts.length}>{manualAccounts.length ? manualAccounts.map(a => <option value={a.id} key={a.id}>{a.name}</option>) : <option value="">暂无手动账户</option>}</select></Field>
      <div className="ticket-balance"><span>报价币现金（USD 折算）</span><strong>{money(account?.cashUsd)}</strong></div>
      <small className="budget-hint">{account?.nativeBalanceRaw == null ? '首次模拟下单后按当时汇率初始化报价币' : `报价币余额 ${rawQuantity(account.nativeBalanceRaw)} · 汇率 ${price(account.nativeUsd)}`}{reservedUsd > 0 && <><br/>订单已冻结 {money(reservedUsd)} · 不能重复用于新仓</>}</small>
      <div className="segmented side-switch"><button className={side === 'buy' ? 'active buy' : ''} onClick={() => { setSide('buy'); setError(''); }}>买入</button><button className={side === 'sell' ? 'active sell' : ''} onClick={() => { setSide('sell'); setError(''); }}>卖出</button></div>
      <div className="ticket-kind"><button className={kind === 'market' ? 'active' : ''} onClick={() => setKind('market')}>市价</button><button className={kind === 'limit' ? 'active' : ''} onClick={() => setKind('limit')}>限价触发</button><span>500 ms 延迟</span></div>
      {side === 'buy' ? <><Field label="买入金额 · USD"><div className="input-unit"><input aria-label="模拟买入金额" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}/><span>USD</span></div></Field><div className="amount-presets">{[1, 2, 5].map(n => <button key={n} onClick={() => setAmount(String(n))}>${n}</button>)}<button onClick={() => setAmount(String(Math.floor(maxBudget * 100) / 100))}>估算上限</button></div><small className="budget-hint">按止损估算上限 {money(maxBudget)}<br/>最终按含费用报价校验 · 单次投入限制 {risk.maxPositionPct}% 净值</small></> : <><Field label="卖出批次"><select value={position?.id ?? ''} onChange={e => setPositionId(e.target.value)} disabled={!positions.length}>{positions.length ? positions.map(p => <option value={p.id} key={p.id}>{timeText(p.openedAt)} · 余 {rawQuantity(p.remainingRaw, p.decimals)}</option>) : <option value="">没有可卖出的手动仓位</option>}</select></Field><Field label="卖出比例 · 原始总仓位 %"><input type="number" min="0.01" max="100" step="0.1" value={sellPct} onChange={e => setSellPct(Number(e.target.value))}/></Field><div className="amount-presets">{[25, 50, 75, 100].map(n => <button key={n} className={n === sellPct ? 'active' : ''} onClick={() => setSellPct(n)}>{n === 100 ? '全部余仓' : `${n}%`}</button>)}</div><small className="budget-hint">原仓 {position ? rawQuantity(position.originalRaw, position.decimals) : '—'} · 本次最多卖 {position ? rawQuantity(originalSellQuantity(position, sellPct), position.decimals) : '—'}<br/>按原仓计算，数量超过余仓时只卖余仓。</small></>}
      {kind === 'limit' && <Field label="触发价格 · USD" hint={side === 'buy' ? '买入：价格不高于此值时触发。' : '卖出：价格不低于此值时触发。'}><input type="number" min="0" step="any" value={limit} placeholder={market?.priceUsd ? String(market.priceUsd) : '输入触发价'} onChange={e => setLimit(e.target.value)}/></Field>}
      <Field label="滑点容忍 %"><input type="number" min="0" max="30" step="0.1" value={slippage} onChange={e => setSlippage(e.target.value)}/></Field>
      {side === 'buy' && <><button type="button" className="collapsible" onClick={() => setShowRules(!showRules)}><span>止盈 / 止损与退出</span><Icon name="chevron" size={14}/></button>{showRules && <RulesEditor compact rules={rules} onChange={setRules}/>}</>}
      <Field label="交易理由" hint="2–500 个字符，记录信号与失效条件，成交后保留到复盘。"><textarea aria-label="交易理由" rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="为什么买 / 卖？什么情况判断失效？" minLength={2} maxLength={500}/></Field>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {market?.quality === 'unavailable' && <div className="notice-box warning">参考行情未核实，可点击获取实际金额报价；只有报价、费用与风控通过才创建虚拟订单。</div>}
      {blocked && <div className="notice-box warning" id={`order-block-${chain}`} role="status"><strong>暂不能{side === 'buy' ? '模拟买入' : '模拟卖出'}</strong>{disabledReasons.map(message => <div key={message} style={{ marginTop: 5 }}>{message}</div>)}</div>}
      <button className={`button full ${side === 'buy' ? 'buy-button' : 'sell-button'}`} aria-describedby={blocked ? `order-block-${chain}` : undefined} title={disabledReasons.join('\n')} disabled={blocked} onClick={() => void submit()}>{orderPending ? '正在校验报价…' : `${side === 'buy' ? '模拟买入' : '模拟卖出'}${market?.symbol ? ' ' + market.symbol : ''}`}<Icon name="arrow" size={16}/></button>
      <p className="ticket-disclaimer"><Icon name="shield" size={14}/>真实行情 · 虚拟成交 · 无钱包签名<br/>报价包含冲击与费用。触发不保证成交；无法卖出的仓位会继续留在账本。</p>
      {account && <AccountPause account={account} actions={actions}/>}
    </div></aside>;
});
function AccountPause({ account, actions }: { account: Account; actions: TerminalControls }) { return <button className="text-button full" disabled={actions.pending} onClick={() => void actions.mutate(`/api/accounts/${encodeURIComponent(account.id)}/pause`, { paused: !account.paused }, account.paused ? '账户已恢复新仓。' : '账户已暂停新仓。')}><Icon name={account.paused ? 'play' : 'pause'} size={14}/>{account.paused ? '恢复账户新仓' : '暂停账户新仓'}</button>; }

const MarketRow = memo(function MarketRow({ market: m, selected, onChoose }: { market: Market; selected: boolean; onChoose: (token: string) => void }) {
  return <button className={`market-row ${selected ? 'selected' : ''}`} onClick={() => onChoose(m.address)}><span className={`token-avatar ${m.platform.toLowerCase().includes('flap') ? 'mint' : ''}`}>{(m.symbol || m.name || '?').slice(0, 2).toUpperCase()}</span><span className="market-name"><strong>{m.symbol || '未命名'}</strong><small>{m.platform} · {m.stage || '阶段未知'}</small></span><span className="market-values"><strong>{price(m.priceUsd)}</strong><small>{m.volumeUsd == null ? '成交额未知' : money(m.volumeUsd)}</small></span></button>;
}, (previous, next) => previous.selected === next.selected && previous.onChoose === next.onChoose && (['id', 'chain', 'address', 'symbol', 'name', 'platform', 'stage', 'priceUsd', 'volumeUsd'] as const).every(key => Object.is(previous.market[key], next.market[key])));
