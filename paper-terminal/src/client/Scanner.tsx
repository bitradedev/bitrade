import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, Chain, Market } from '../shared/domain';
import { CHAIN_NAMES, money, price, shortAddress, timestampMs } from './lib';
import { Badge, Empty, Icon } from './ui';
import { retainBrowseOrder, reuseArray } from './state-cache';

type ScannerStage = 'new' | 'near' | 'graduated';
type ScannerSort = 'newest' | 'volume' | 'liquidity';
// The server merges stage observations; the legacy phase may lag a graduation event.
export function scannerStage(market: Market): ScannerStage | 'unknown' {
  const stage = market.scannerStage;
  if (stage !== undefined) return stage === 'new' || stage === 'near' || stage === 'graduated' ? stage : 'unknown';
  if (market.stage === 'dex') return 'graduated';
  if (market.stage === 'curve') return 'new';
  return 'unknown';
}
export function marketAgeMs(market: Market, now: number): number | null {
  if (!Number.isFinite(market.createdAt) || market.createdAt <= 0) return null;
  const age = now - timestampMs(market.createdAt);
  return age >= 0 ? age : null;
}
export function filterScannerMarkets(markets: Market[], chain: Chain, search: string, maxAgeMs: number, sort: ScannerSort, now: number, platform = ''): Market[] {
  const query = search.trim().toLowerCase();
  const rows = markets.filter(m => m.chain === chain && (!platform || m.platform === platform) && `${m.symbol} ${m.name} ${m.address} ${m.platform}`.toLowerCase().includes(query) && (!maxAgeMs || (marketAgeMs(m, now) !== null && marketAgeMs(m, now)! <= maxAgeMs)));
  const value = (m: Market) => sort === 'newest' ? marketAgeMs(m, now) === null ? -Infinity : timestampMs(m.createdAt) : sort === 'volume' ? m.volumeUsd ?? -Infinity : m.liquidityUsd ?? -Infinity;
  return rows.sort((a, b) => { const av = value(a), bv = value(b); return av === bv ? a.address.localeCompare(b.address) : av > bv ? -1 : 1; });
}
export function scannerAgeText(market: Market, now: number) {
  const age = marketAgeMs(market, now);
  if (age === null) return '创建时间未知';
  if (age < 60000) return `${Math.floor(age / 1000)} 秒前`;
  if (age < 3600000) return `${Math.floor(age / 60000)} 分钟前`;
  if (age < 86400000) return `${Math.floor(age / 3600000)} 小时前`;
  return `${Math.floor(age / 86400000)} 天前`;
}
export function resolveScannerMarket(markets: Market[], selected: Pick<Market, 'chain' | 'address'>): Market | null {
  return markets.find(m => m.chain === selected.chain && m.address.toLowerCase() === selected.address.toLowerCase()) ?? null;
}
type ScannerCardProps = { market: Market; ageLabel: string; onOpen: (market: Market) => void };
const cardProgress = (m: Market) => typeof m.progressPct === 'number' && Number.isFinite(m.progressPct) && m.progressPct >= 0 && m.progressPct <= 100 ? m.progressPct : null;
export function sameScannerCardProps(previous: ScannerCardProps, next: ScannerCardProps): boolean {
  if (previous.onOpen !== next.onOpen || previous.ageLabel !== next.ageLabel) return false;
  const a = previous.market, b = next.market;
  // Display-only boundary: the state cache retains every routing, fee and metadata change.
  return (['id', 'chain', 'address', 'symbol', 'name', 'platform', 'priceUsd', 'volumeUsd', 'liquidityUsd', 'quality'] as const).every(key => Object.is(a[key], b[key])) && scannerStage(a) === scannerStage(b) && cardProgress(a) === cardProgress(b);
}
const columns: { stage: ScannerStage; name: string; detail: string; icon: string }[] = [
  { stage: 'new', name: '新币', detail: '已识别的内盘代币', icon: 'plus' },
  { stage: 'near', name: '即将毕业', detail: '来源已标记临近毕业', icon: 'clock' },
  { stage: 'graduated', name: '已毕业', detail: '已识别的外盘市场', icon: 'trade' },
];
export const Scanner = memo(function Scanner({ state, chain, onOpen }: { state: AppState; chain: Chain; onOpen: (market: Market) => void }) {
  const [search, setSearch] = useState('');
  const [maxAgeMs, setMaxAgeMs] = useState(0);
  const [sort, setSort] = useState<ScannerSort>('newest');
  const [platform, setPlatform] = useState('');
  const currentMarkets = useRef(state.markets); currentMarkets.current = state.markets;
  const openCurrentMarket = useCallback((selected: Market) => {
    const current = resolveScannerMarket(currentMarkets.current, selected);
    if (current) onOpen(current);
  }, [onOpen]);
  useEffect(() => { setPlatform(''); }, [chain]);
  const platforms = useMemo(() => [...new Set(state.markets.filter(m => m.chain === chain).map(m => m.platform).filter(Boolean))].sort(), [state.markets, chain]);
  const now = timestampMs(state.at);
  const rowsRef = useRef<Market[]>([]);
  const rows = useMemo(() => rowsRef.current = reuseArray(rowsRef.current, filterScannerMarkets(state.markets, chain, search, maxAgeMs, sort, now, platform)), [state.markets, chain, search, maxAgeMs, sort, now, platform]);
  const groupsRef = useRef<Record<ScannerStage | 'unknown', Market[]>>({ new: [], near: [], graduated: [], unknown: [] });
  const groups = useMemo(() => {
    const next: Record<ScannerStage | 'unknown', Market[]> = { new: [], near: [], graduated: [], unknown: [] };
    for (const row of rows) next[scannerStage(row)].push(row);
    for (const stage of ['new', 'near', 'graduated', 'unknown'] as const) next[stage] = reuseArray(groupsRef.current[stage], next[stage]);
    groupsRef.current = next; return next;
  }, [rows]);
  const unknown = groups.unknown;
  const status = state.chains.find(c => c.chain === chain);
  const live = status?.connected && now - timestampMs(status.headAt) <= 15000;
  return <div className="scanner-page">
    <header className="scanner-heading"><div><div className="eyebrow">SCAN / {CHAIN_NAMES[chain]}</div><h1>扫链 <span>发现 → 看 K 线 → 模拟交易</span></h1><p>点击代币查看真实成交与报价。所有下单使用独立模拟账户。</p></div><div className="scanner-live"><span className={`status-dot ${live ? 'green' : 'amber'}`}/>{live ? '行情持续更新' : '等待网络行情'}<small>{status?.head ? `区块 #${status.head.toLocaleString('en-US')}` : '尚未收到区块'}</small></div></header>
    <div className="scanner-filters panel"><label className="scanner-search"><Icon name="search" size={16}/><input aria-label="搜索扫链代币" placeholder="搜索名称、合约或平台" value={search} onChange={e => setSearch(e.target.value)}/>{search && <button className="icon-button" aria-label="清除扫链搜索" onClick={() => setSearch('')}><Icon name="close" size={13}/></button>}</label><label>平台<select aria-label="扫链平台" value={platform} onChange={e => setPlatform(e.target.value)}><option value="">全部平台</option>{platforms.map(name => <option value={name} key={name}>{name}</option>)}</select></label><label>币龄<select aria-label="扫链币龄" value={maxAgeMs} onChange={e => setMaxAgeMs(Number(e.target.value))}><option value={0}>全部币龄</option><option value={600000}>10 分钟内</option><option value={3600000}>1 小时内</option><option value={86400000}>24 小时内</option></select></label><label>排序<select aria-label="扫链排序" value={sort} onChange={e => setSort(e.target.value as ScannerSort)}><option value="newest">最新创建</option><option value="volume">成交额优先</option><option value="liquidity">流动性优先</option></select></label><span className="scanner-matches">{rows.length} 个市场 · {unknown.length} 个阶段待核实</span></div>
    <div className="scanner-columns">{columns.map(column => <ScannerColumn key={column.stage} column={column} markets={groups[column.stage]} now={now} onOpen={openCurrentMarket} filtered={!!search || !!maxAgeMs || !!platform}/>)}</div>
    <details className="scanner-unknown panel"><summary><Icon name="info" size={15}/><strong>阶段待核实</strong><span className="count">{unknown.length}</span><span>来源尚未确认阶段，未归入上方三栏</span><Icon name="chevron" size={14}/></summary><div className="scanner-unknown-list">{unknown.map(m => <ScannerCard key={m.id} market={m} ageLabel={scannerAgeText(m, now)} onOpen={openCurrentMarket}/>)}{!unknown.length && <Empty icon="search" title="没有阶段未知的匹配市场"/>}</div></details>
    <p className="scanner-note"><Icon name="info" size={13}/>币龄仅使用来源提供的创建时间；成交额与流动性按原始行情展示。毕业进度未核实时不显示百分比。</p>
  </div>;
});
export const ScannerCard = memo(function ScannerCard({ market, ageLabel, onOpen }: ScannerCardProps) {
  const stage = scannerStage(market);
  const progress = cardProgress(market);
  return <button className="scanner-card" onClick={() => onOpen(market)} aria-label={`查看 ${market.symbol || market.name || shortAddress(market.address)} K线与模拟交易`}>
    <div className="scanner-card-heading"><span className={`token-avatar large ${market.platform.toLowerCase().includes('flap') ? 'mint' : ''}`}>{(market.symbol || '?').slice(0, 2)}</span><span className="scanner-card-name"><strong>{market.symbol || '未命名'}<small>{market.name && market.name !== market.symbol ? market.name : shortAddress(market.address)}</small></strong><span>{market.platform || '平台未知'} · {ageLabel}</span></span><span className="scanner-card-price">{price(market.priceUsd)}<small>{shortAddress(market.address)}</small></span></div>
    <div className="scanner-card-metrics"><span>成交额<b>{money(market.volumeUsd)}</b></span><span>流动性<b>{money(market.liquidityUsd)}</b></span><span>毕业进度<b className={progress === null ? 'scanner-unknown-value' : ''}>{progress !== null ? `${progress.toFixed(1)}%` : stage === 'graduated' ? '已毕业' : '未核实'}</b></span></div>
    {progress !== null && <div className="scanner-progress" role="progressbar" aria-label="来源提供的毕业进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }}/></div>}
    <div className="scanner-card-footer"><Badge tone={market.quality === 'verified' ? 'green' : market.quality === 'estimated' ? 'amber' : 'muted'}>{market.quality === 'verified' ? '行情已核实' : '下单前校验报价'}</Badge><span>看 K 线 · 模拟交易<Icon name="arrow" size={13}/></span></div>
  </button>;
}, sameScannerCardProps);
const ScannerColumn = memo(function ScannerColumn({ column, markets, now, onOpen, filtered }: { column: typeof columns[number]; markets: Market[]; now: number; onOpen: (market: Market) => void; filtered: boolean }) {
  const [frozenIds, setFrozenIds] = useState<string[] | null>(null);
  const pointer = useRef(false), focus = useRef(false);
  const pause = () => setFrozenIds(previous => previous ?? markets.map(m => m.id));
  const resume = () => { if (!pointer.current && !focus.current) setFrozenIds(null); };
  const ordered = useMemo(() => retainBrowseOrder(markets, frozenIds), [markets, frozenIds]);
  return <section className={`scanner-column panel ${column.stage}`} aria-label={column.name}><header><div><span className="scanner-column-icon"><Icon name={column.icon} size={17}/></span><h2>{column.name}</h2><span className="count">{markets.length}</span></div><p>{frozenIds ? '浏览中 · 排序暂停，行情仍更新' : column.detail}</p></header><div className="scanner-card-list" title="鼠标悬停或键盘浏览时固定排序；阶段变化与行情继续更新。" onPointerEnter={() => { pointer.current = true; pause(); }} onPointerLeave={() => { pointer.current = false; resume(); }} onFocusCapture={() => { focus.current = true; pause(); }} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { focus.current = false; resume(); } }}>{ordered.map(m => <ScannerCard key={m.id} market={m} ageLabel={scannerAgeText(m, now)} onOpen={onOpen}/>)}{!markets.length && <Empty icon="search" title={`暂无${column.name}市场`} detail={column.stage === 'near' ? '只有来源确认临近毕业的代币才会显示在这里，不推算毕业进度。' : filtered ? '当前条件没有匹配的真实市场。' : '等待该阶段的真实行情。'}/>}</div></section>;
});
