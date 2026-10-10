import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { AreaSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, TickMarkType, createChart, createSeriesMarkers } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts';
import type { Candle, Fill, Market } from '../shared/domain';
import { readCandles } from './api';
import { normalizeCandles, object, price, timestampMs } from './lib';
import { Empty, Icon } from './ui';
import { createFrameCoalescer, reuseArray, shareValue } from './state-cache';

const beijingFormatter = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hourCycle: 'h23', ...options });
const chartTimeFormatters = {
  hover: beijingFormatter({ month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  [TickMarkType.Year]: beijingFormatter({ year: 'numeric' }),
  [TickMarkType.Month]: beijingFormatter({ month: 'short' }),
  [TickMarkType.DayOfMonth]: beijingFormatter({ month: '2-digit', day: '2-digit' }),
  [TickMarkType.Time]: beijingFormatter({ hour: '2-digit', minute: '2-digit' }),
  [TickMarkType.TimeWithSeconds]: beijingFormatter({ hour: '2-digit', minute: '2-digit', second: '2-digit' }),
};
export function formatChartTime(time: Time, tickMarkType?: TickMarkType): string {
  const millis = typeof time === 'number' ? time * 1000 : typeof time === 'string' ? Date.parse(`${time}T00:00:00Z`) : Date.UTC(time.year, time.month - 1, time.day);
  return Number.isFinite(millis) ? chartTimeFormatters[tickMarkType ?? 'hover'].format(millis) : '—';
}
const commonOptions = {
  layout: { background: { type: ColorType.Solid, color: '#10141b' }, textColor: '#7e8ba1', fontFamily: 'Inter, "Microsoft YaHei", sans-serif', fontSize: 11, attributionLogo: true },
  grid: { vertLines: { color: '#1a202b' }, horzLines: { color: '#1a202b' } },
  crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#5a6880', labelBackgroundColor: '#303b4e' }, horzLine: { color: '#5a6880', labelBackgroundColor: '#303b4e' } },
  rightPriceScale: { borderColor: '#242c39' },
  localization: { locale: 'zh-CN', timeFormatter: (time: Time) => formatChartTime(time) },
  timeScale: { borderColor: '#242c39', timeVisible: true, secondsVisible: true, rightOffset: 4, minBarSpacing: 2, tickMarkFormatter: (time: Time, type: TickMarkType) => formatChartTime(time, type) },
};
export interface CandleMetadata { source?: 'gmgn' | 'verified-local' | 'mixed' | 'none'; state?: 'ready' | 'loading' | 'empty' | 'error' | 'stopped'; pending?: boolean; reason?: string; }
export function readCandleMetadata(response: unknown): CandleMetadata | null {
  const root = object(response);
  // The response can supply source/pending/reason even when it has no state field.
  for (const value of [root, ...Object.values(root)]) {
    const row = object(value);
    const source = typeof row.source === 'string' && ['gmgn', 'verified-local', 'mixed', 'none'].includes(row.source) ? row.source as CandleMetadata['source'] : undefined;
    const state = typeof row.state === 'string' && ['ready', 'loading', 'empty', 'error', 'stopped'].includes(row.state) ? row.state as CandleMetadata['state'] : undefined;
    const pending = typeof row.pending === 'boolean' ? row.pending : undefined;
    const reason = typeof row.reason === 'string' ? row.reason : undefined;
    if (source !== undefined || pending !== undefined || reason !== undefined) return { source, state, pending, reason };
  }
  return null;
}
const sameCandle = (a: Candle, b: Candle) => a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;
export function candleUpdatePlan(previous: Candle[], next: Candle[]): { replace: boolean; updates: Candle[] } {
  if (!previous.length) return { replace: next.length > 0, updates: [] };
  if (next.length < previous.length) return { replace: true, updates: [] };
  for (let i = 0; i < previous.length - 1; i++) if (!next[i] || !sameCandle(previous[i], next[i])) return { replace: true, updates: [] };
  const tail = previous.length - 1;
  if (next[tail]?.time !== previous[tail].time) return { replace: true, updates: [] };
  return { replace: false, updates: [...(!sameCandle(previous[tail], next[tail]) ? [next[tail]] : []), ...next.slice(previous.length)] };
}
export function mergeCandleRows(previous: Candle[], incoming: Candle[], full: boolean): Candle[] {
  let next: Candle[];
  if (full) next = incoming;
  else { if (!incoming.length) return previous; const rows = new Map(previous.map(c => [c.time, c])); for (const c of incoming) rows.set(c.time, c); next = [...rows.values()].sort((a, b) => a.time - b.time); }
  return next.length === previous.length && next.every((c, i) => sameCandle(c, previous[i])) ? previous : next;
}
export const candlePeriods = [{ seconds: 30, label: '30s' }, { seconds: 60, label: '1m' }, { seconds: 300, label: '5m' }, { seconds: 900, label: '15m' }, { seconds: 3600, label: '1h' }] as const;
export function aggregateCandles(source: Candle[], seconds: number): Candle[] {
  if (!candlePeriods.some(p => p.seconds === seconds)) throw Error('不支持的 K 线周期。');
  const rows = normalizeCandles(source);
  if (seconds === 30) return rows;
  const buckets = new Map<number, Candle>();
  for (const row of rows) {
    const time = Math.floor(row.time / seconds) * seconds;
    const previous = buckets.get(time);
    if (previous) { previous.high = Math.max(previous.high, row.high); previous.low = Math.min(previous.low, row.low); previous.close = row.close; previous.volume += row.volume; }
    else buckets.set(time, { ...row, time });
  }
  // Missing windows remain absent. Only known 30-second OHLC and volume are combined.
  return [...buckets.values()];
}
export function candleTimeForFill(candles: Candle[], second: number, period: number): number | null {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time <= second) return second < candles[i].time + period ? candles[i].time : null;
  }
  return null;
}
const emptyCandles: Candle[] = [];
type ChartMarket = Pick<Market, 'chain' | 'address' | 'updatedAt' | 'block'>;
export const CandleChart = memo(function CandleChart({ market, fills }: { market: ChartMarket | null; fills: Fill[] }) {
  const container = useRef<HTMLDivElement>(null);
  const dataKey = market ? `${market.chain}:${market.address}` : '';
  const [candleData, setCandleData] = useState<{ key: string; rows: Candle[] }>({ key: '', rows: [] });
  const [period, setPeriod] = useState<number>(30);
  const rawCandles = candleData.key === dataKey ? candleData.rows : emptyCandles;
  const candles = useMemo(() => aggregateCandles(rawCandles, period), [rawCandles, period]);
  const renderKey = `${dataKey}:${period}`;
  const setCandles = (update: Candle[] | ((previous: Candle[]) => Candle[])) => setCandleData(previous => {
    const rows = previous.key === dataKey ? previous.rows : [];
    const next = typeof update === 'function' ? update(rows) : update;
    return previous.key === dataKey && next === previous.rows ? previous : { key: dataKey, rows: next };
  });
  const hoverListener = useRef<((time: number | null) => void) | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [metadata, setMetadata] = useState<CandleMetadata | null>(null);
  const loadFromTick = useRef<(() => Promise<void>) | null>(null);
  const lastLoadStarted = useRef(0);
  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markersRef = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null);
  const loadedKey = useRef('');
  const fittedKey = useRef('');
  const renderedKey = useRef('');
  const renderedMarketKey = useRef('');
  const renderedRows = useRef<Candle[]>([]);
  const streamConnected = useRef(false);
  const streamRevision = useRef(0);
  const markerTimesRef = useRef<number[]>([]);
  const markerTimes = useMemo(() => markerTimesRef.current = reuseArray(markerTimesRef.current, candles.map(c => c.time)), [candles]);
  const previousMarkers = useRef<SeriesMarker<Time>[]>([]);
  useEffect(() => {
    if (loadedKey.current !== dataKey) { loadedKey.current = dataKey; fittedKey.current = ''; setCandles([]); setMetadata(null); }
    setError('');
    if (!market) return;
    let alive = true; let inFlight = false;
    const abort = new AbortController();
    const load = async () => {
      if (inFlight || !alive) return; inFlight = true; lastLoadStarted.current = Date.now(); setLoading(true);
      const callAbort = new AbortController();
      const timeout = setTimeout(() => callAbort.abort(), 15000);
      const revision = streamRevision.current;
      try { const result = await readCandles(market.chain, market.address, AbortSignal.any([abort.signal, callAbort.signal])); if (alive && revision === streamRevision.current) { const rows = normalizeCandles(result.candles ?? []); setCandles(previous => mergeCandleRows(previous, rows, true)); setMetadata(readCandleMetadata(result)); setError(''); } }
      catch (e) { if (alive && !abort.signal.aborted) setError(callAbort.signal.aborted ? '历史补充尚未返回，正在重试；不生成示例 K 线。' : e instanceof Error ? e.message : 'K 线暂不可用。'); }
      finally { clearTimeout(timeout); inFlight = false; if (alive) setLoading(false); }
    };
    loadFromTick.current = load;
    void load(); const timer = setInterval(() => void load(), 12000);
    return () => { alive = false; abort.abort(); clearInterval(timer); loadFromTick.current = null; if (tickTimer.current) { clearTimeout(tickTimer.current); tickTimer.current = null; } };
  }, [dataKey, reload]);
  useEffect(() => {
    streamConnected.current = false;
    if (!market) return;
    let current = true;
    const events = new EventSource(`/api/candles/events?chain=${encodeURIComponent(market.chain)}&token=${encodeURIComponent(market.address)}`);
    events.onopen = () => { if (current) streamConnected.current = true; };
    events.onerror = () => { if (current) streamConnected.current = false; };
    events.onmessage = event => {
      if (!current) return;
      try {
        const value = object(JSON.parse(event.data));
        if (value.type !== 'candles' || value.chain !== market.chain || typeof value.token !== 'string' || value.token.toLowerCase() !== market.address.toLowerCase() || !Array.isArray(value.candles) || typeof value.full !== 'boolean') return;
        const rows = normalizeCandles(value.candles as Candle[]);
        streamRevision.current++;
        setCandles(previous => mergeCandleRows(previous, rows, value.full === true));
        const nextMetadata = readCandleMetadata(value);
        setMetadata(previous => previous?.source === nextMetadata?.source && previous?.state === nextMetadata?.state && previous?.pending === nextMetadata?.pending && previous?.reason === nextMetadata?.reason ? previous : nextMetadata);
        setError('');
      } catch { setError('K 线实时更新暂不可用，仍会自动读取真实历史数据。'); }
    };
    return () => { current = false; streamConnected.current = false; events.close(); };
  }, [dataKey]);
  const latestFillAt = fills.filter(f => f.chain === market?.chain && f.token.toLowerCase() === market?.address.toLowerCase()).reduce((last, f) => Math.max(last, f.at), 0);
  useEffect(() => {
    if (!market || !loadFromTick.current || streamConnected.current) return;
    // SSE updates request real candles again; never infer candle volume or OHLC from a reference quote.
    const delay = Math.max(0, 3000 - (Date.now() - lastLoadStarted.current));
    if (tickTimer.current) return;
    if (delay === 0) { void loadFromTick.current(); return; }
    tickTimer.current = setTimeout(() => { tickTimer.current = null; if (!streamConnected.current) void loadFromTick.current?.(); }, delay);
  }, [market?.updatedAt, market?.block, latestFillAt, dataKey]);
  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, { ...commonOptions, width: Math.max(1, container.current.clientWidth), height: container.current.clientHeight || 375 });
    const series = chart.addSeries(CandlestickSeries, { upColor: '#37cba0', downColor: '#f07181', borderUpColor: '#37cba0', borderDownColor: '#f07181', wickUpColor: '#37cba0', wickDownColor: '#f07181', priceFormat: { type: 'custom', formatter: (value: number) => price(value), minMove: 0.0000000001 }, priceScaleId: 'right' });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.25 } });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart; seriesRef.current = series; volumeRef.current = volume; markersRef.current = createSeriesMarkers(series, []);
    chart.subscribeCrosshairMove(event => {
      const time = event.time === undefined ? null : Number(event.time);
      hoverListener.current?.(time !== null && Number.isFinite(time) ? time : null);
    });
    const resize = new ResizeObserver(entries => { const rect = entries[0]?.contentRect; if (rect && rect.width > 0 && rect.height > 0) chart.applyOptions({ width: Math.floor(rect.width), height: Math.floor(rect.height) }); });
    resize.observe(container.current);
    return () => { resize.disconnect(); markersRef.current?.detach(); chart.remove(); chartRef.current = null; seriesRef.current = null; volumeRef.current = null; };
  }, []);
  useEffect(() => {
    const plan = candleUpdatePlan(renderedRows.current, candles);
    const changedKey = renderedKey.current !== renderKey;
    const changedMarket = renderedMarketKey.current !== dataKey;
    const toPrice = (c: Candle) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });
    const toVolume = (c: Candle) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? '#37cba037' : '#f0718137' });
    if (changedKey || plan.replace) {
      const viewport = !changedMarket && renderedRows.current.length ? chartRef.current?.timeScale().getVisibleRange() : null;
      seriesRef.current?.setData(candles.map(toPrice)); volumeRef.current?.setData(candles.map(toVolume));
      if (viewport && candles.length) chartRef.current?.timeScale().setVisibleRange(viewport);
    } else for (const c of plan.updates) { seriesRef.current?.update(toPrice(c)); volumeRef.current?.update(toVolume(c)); }
    renderedKey.current = renderKey; renderedMarketKey.current = dataKey; renderedRows.current = candles;
    if (candles.length && fittedKey.current !== dataKey) { chartRef.current?.timeScale().fitContent(); fittedKey.current = dataKey; }
  }, [candles, renderKey, dataKey]);
  useEffect(() => {
    const markers: SeriesMarker<Time>[] = [];
    if (market && candles.length) {
      for (const fill of fills.filter(f => f.chain === market.chain && f.token.toLowerCase() === market.address.toLowerCase()).sort((a, b) => a.at - b.at)) {
        const second = Math.floor(timestampMs(fill.at) / 1000);
        if (second < candles[0].time || second >= candles.at(-1)!.time + period) continue;
        const candleTime = candleTimeForFill(candles, second, period);
        if (candleTime !== null) markers.push({ time: candleTime as UTCTimestamp, position: fill.side === 'buy' ? 'belowBar' : 'aboveBar', color: fill.side === 'buy' ? '#69dda9' : '#f8ab67', shape: fill.side === 'buy' ? 'arrowUp' : 'arrowDown', text: fill.side === 'buy' ? '模拟买' : '模拟卖' });
      }
    }
    markers.sort((a, b) => Number(a.time) - Number(b.time));
    const shared = shareValue(previousMarkers.current, markers);
    if (shared !== previousMarkers.current) { previousMarkers.current = shared; markersRef.current?.setMarkers(shared); }
    // Placement uses candle times only; price/volume updates cannot move a fill marker.
  }, [markerTimes, fills, dataKey, period]);
  return <div className="chart-shell">
    <div className="chart-toolbar"><span className="chart-interval" title="实时接收已核实的 30 秒成交 K 线；较长周期按真实成交聚合，缺口不补造，不推算成交量。">真实 K 线</span><div className="chart-periods" role="group" aria-label="K线周期">{candlePeriods.map(p => <button key={p.seconds} className={period === p.seconds ? 'active' : ''} aria-pressed={period === p.seconds} title={p.seconds === 30 ? '原始 30 秒成交 K 线' : '按真实 30 秒 K 线聚合，缺失窗口不填充'} onClick={() => { setPeriod(p.seconds); }}>{p.label}</button>)}</div><CandleReadout candles={candles} resetKey={renderKey} listener={hoverListener}/><button className="icon-button" title="重新读取已有成交，并补充历史" aria-label="刷新 K 线" onClick={() => setReload(n => n + 1)} disabled={!market}><Icon name="refresh" size={14}/></button></div>
    <div className="candle-stage"><div className="candle-container" ref={container}/>
      {!candles.length && <div className="chart-empty"><Empty icon="trade" title={!market ? '选择一个市场，开始观察' : metadata?.pending || loading ? '正在补历史' : '尚无成交 K 线'} detail={error || metadata?.reason || (market ? '仅显示该合约的真实成交；已有参考价并不代表已有成交 K 线。' : '从左侧选择代币，或粘贴合约地址。')}/></div>}
      {(error || metadata?.state === 'error') && candles.length > 0 && <div className="chart-error" role="alert">{error || metadata?.reason} · 当前显示已取得的数据</div>}
    </div>
    {metadata?.reason && <div className={`chart-status-note ${metadata.pending ? 'pending' : ''}`} role="status"><Icon name={metadata.pending ? 'clock' : 'info'} size={12}/>{metadata.pending && <strong>正在补历史 · </strong>}{metadata.reason}</div>}
    <footer className="chart-footer"><span>成交量 · USD <span className="legend-dot green"/>模拟买入 <span className="legend-dot amber"/>模拟卖出{metadata && <span className="chart-source" title={metadata.reason}> · {metadata.source ? ({ gmgn: '历史成交', 'verified-local': '链上已核实成交', mixed: '历史与链上成交', none: '暂无成交数据' })[metadata.source] : '来源待核实'}{metadata.pending ? ' · 正在补历史' : metadata.state === 'stopped' ? ' · 已停止更新' : ''}</span>}</span><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">图表由 TradingView Lightweight Charts™ 提供</a></footer>
  </div>;
});
const CandleReadout = memo(function CandleReadout({ candles, resetKey, listener }: { candles: Candle[]; resetKey: string; listener: RefObject<((time: number | null) => void) | null> }) {
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const byTime = useMemo(() => new Map(candles.map(c => [c.time, c])), [candles]);
  useEffect(() => {
    setHoverTime(null);
    const frames = createFrameCoalescer<number | null>(setHoverTime, callback => requestAnimationFrame(callback), id => cancelAnimationFrame(id));
    listener.current = frames.push;
    return () => { frames.cancel(); if (listener.current === frames.push) listener.current = null; };
  }, [listener, resetKey]);
  const candle = hoverTime === null ? candles.at(-1) : byTime.get(hoverTime) ?? candles.at(-1);
  return candle ? <div className="ohlc"><span>开 <b>{price(candle.open)}</b></span><span>高 <b>{price(candle.high)}</b></span><span>低 <b>{price(candle.low)}</b></span><span>收 <b className={candle.close >= candle.open ? 'positive' : 'negative'}>{price(candle.close)}</b></span></div> : null;
});
export interface EquityPoint { time: number; value: number; }
export function EquityChart({ points }: { points: EquityPoint[] }) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const data = useMemo(() => [...new Map(points.filter(p => Number.isFinite(p.value)).map(p => [p.time, p])).values()].sort((a, b) => a.time - b.time), [points]);
  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, { ...commonOptions, width: container.current.clientWidth, height: 210 });
    const series = chart.addSeries(AreaSeries, { lineColor: '#91a0ff', topColor: '#91a0ff28', bottomColor: '#91a0ff00', lineWidth: 2, priceFormat: { type: 'custom', formatter: (value: number) => '$' + value.toFixed(2), minMove: 0.01 } });
    chartRef.current = chart; seriesRef.current = series;
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) chart.applyOptions({ width }); }); observer.observe(container.current);
    return () => { observer.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);
  useEffect(() => { seriesRef.current?.setData(data.map(p => ({ time: p.time as UTCTimestamp, value: p.value }))); chartRef.current?.timeScale().fitContent(); }, [data]);
  return <div className="equity-chart"><div ref={container}/>{data.length < 2 && <div className="equity-empty">等待第二个真实净值快照 · 不补画历史收益</div>}</div>;
}
