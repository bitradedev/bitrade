import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  createSeriesMarkers,
  CrosshairMode,
  TickMarkType,
} from 'lightweight-charts';

const en = BiUI.language === 'en',
  t = (zh, english) => (en ? english : zh);
const fmt = (v) =>
  Number.isFinite(v) ? Number(v).toLocaleString(BiUI.locale, { maximumSignificantDigits: 6 }) : '—';
const clock = (v) =>
  v
    ? new Date(v * 1000).toLocaleString(BiUI.locale, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';

// A persistent canvas and stream per selected market. Account renders never
// remount this component; market updates do not reset the user's viewport.
class TradeChart {
  constructor(host) {
    this.host = host;
    this.interval = 60;
    this.token = null;
    this.bars = new Map();
    this.fills = [];
    this.version = 0;
    this.abort = null;
    this.stream = null;
    this.loading = false;
    this.retryAt = 0;
    this.previousRange = null;
    this.needsFit = true;
    host.innerHTML = `<div class="candle-toolbar"><div class="candle-periods" role="group" aria-label="${t('K线周期', 'Candle interval')}">${[
      [60, '1m'],
      [300, '5m'],
      [900, '15m'],
      [3600, '1h'],
    ]
      .map(
        ([n, label]) => `<button data-period="${n}" aria-pressed="${n === 60}">${label}</button>`,
      )
      .join(
        '',
      )}</div><span class="candle-unit">ETH</span><button data-chart="older">${t('更早记录', 'Earlier')}</button><button data-chart="latest" title="${t('返回最新成交', 'Return to latest trades')}">↗ ${t('最新', 'Latest')}</button></div><div class="candle-legend" aria-live="off"></div><div class="candle-surface"><div class="candle-canvas" role="img" aria-label="${t('实际成交K线与成交量，支持缩放和拖动', 'Trade candlesticks and volume. Drag to pan; scroll to zoom.')}" tabindex="0"></div><div class="candle-empty"></div></div><div class="candle-footer"><span class="candle-asof"></span><span>${t('成交价 / 成交量 · ETH', 'Execution price / volume · ETH')}</span></div><div class="market-tape"><div class="market-tape-title">${t('市场成交', 'Market trades')}<span>${t('模拟订单不计入市场成交量', 'Paper orders do not add market volume')}</span></div><div class="market-tape-rows"></div></div>`;
    this.canvas = host.querySelector('.candle-canvas');
    this.chart = createChart(this.canvas, {
      autoSize: true,
      height: 370,
      layout: { fontFamily: 'Consolas, monospace', fontSize: 11 },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 9,
        minBarSpacing: 3,
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.26 } },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      localization: { locale: BiUI.locale, timeFormatter: clock },
    });
    this.price = this.chart.addSeries(CandlestickSeries, {
      upColor: '#13a37a',
      downColor: '#e05a72',
      wickUpColor: '#13a37a',
      wickDownColor: '#e05a72',
      borderVisible: false,
      priceFormat: { type: 'custom', formatter: fmt, minMove: 1e-18, base: 1e18 },
    });
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    this.volume
      .priceScale()
      .applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
    this.markers = createSeriesMarkers(this.price, [], { autoScale: false });
    this.chart.applyOptions({
      timeScale: {
        tickMarkFormatter: (time, type) => {
          const options =
            type === TickMarkType.Year
              ? { year: 'numeric' }
              : type === TickMarkType.Month
                ? { month: 'short' }
                : type === TickMarkType.DayOfMonth
                  ? { month: '2-digit', day: '2-digit' }
                  : { hour: '2-digit', minute: '2-digit', hour12: false };
          return new Date(time * 1000).toLocaleString(BiUI.locale, options);
        },
      },
    });
    const credit = document.createElement('a');
    credit.href = 'https://www.tradingview.com/';
    credit.textContent = 'TradingView';
    credit.className = 'chart-credit';
    credit.target = '_blank';
    credit.rel = 'noopener noreferrer';
    credit.title = 'TradingView Lightweight Charts™';
    this.host.querySelector('.candle-footer').append(credit);
    this.applyTheme();
    this.theme = new MutationObserver(() => this.applyTheme());
    this.theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    this.chart.subscribeCrosshairMove((p) => {
      const bar = p.seriesData.get(this.price);
      this.hover = !!bar;
      this.legend(
        bar ?? [...this.bars.values()].at(-1),
        bar ? p.seriesData.get(this.volume)?.value : undefined,
      );
    });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (
        range &&
        range.from < 4 &&
        Date.now() < (this.panUntil ?? 0) &&
        !this.needsFit &&
        this.bars.size &&
        this.bars.size < 600
      )
        void this.history(true);
    });
    for (const event of ['pointerdown', 'wheel', 'touchstart'])
      this.canvas.addEventListener(
        event,
        () => {
          this.panUntil = Date.now() + 3000;
        },
        { passive: true },
      );
    host.addEventListener('click', (e) => {
      const button = e.target.closest('button');
      if (!button) return;
      if (button.dataset.period) {
        const interval = Number(button.dataset.period);
        if (interval === this.interval) return;
        this.interval = interval;
        this.restart();
      }
      if (button.dataset.chart === 'older') void this.history(true);
      if (button.dataset.chart === 'latest') this.chart.timeScale().scrollToRealTime();
    });
    this.canvas.addEventListener('keydown', (e) => {
      const scale = this.chart.timeScale(),
        range = scale.getVisibleLogicalRange();
      if (!range) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const d = e.key === 'ArrowLeft' ? -10 : 10;
        scale.setVisibleLogicalRange({ from: range.from + d, to: range.to + d });
      }
      if (e.key === 'Home') {
        e.preventDefault();
        scale.scrollToRealTime();
      }
    });
    this.visibility = () => {
      if (document.hidden) {
        this.stream?.close();
        this.stream = null;
      } else if (this.token) {
        void this.history();
        this.connect();
      }
    };
    document.addEventListener('visibilitychange', this.visibility);
    this.notice(t('选择代币查看成交 K 线', 'Select a token to view trade candles'));
  }
  applyTheme() {
    const css = getComputedStyle(document.documentElement),
      color = (key) => css.getPropertyValue(key).trim();
    this.chart.applyOptions({
      layout: {
        background: { type: 'solid', color: color('--bi-panel') },
        textColor: color('--bi-muted'),
      },
      grid: {
        vertLines: { color: color('--bi-border'), visible: false },
        horzLines: { color: color('--bi-border') },
      },
      crosshair: {
        vertLine: { color: color('--bi-muted') },
        horzLine: { color: color('--bi-muted') },
      },
      timeScale: { borderColor: color('--bi-border') },
    });
  }
  notice(value) {
    const node = this.host.querySelector('.candle-empty');
    node.textContent = value;
    node.hidden = !value;
  }
  setToken(token) {
    if (this.token === token) return;
    this.token = token;
    this.restart();
  }
  restart() {
    this.version++;
    this.abort?.abort();
    this.stream?.close();
    this.stream = null;
    this.bars.clear();
    this.price.setData([]);
    this.volume.setData([]);
    this.markers.setMarkers([]);
    this.loading = false;
    this.retryAt = 0;
    this.olderAt = 0;
    this.revision = null;
    this.needsFit = true;
    this.markerKey = null;
    this.tapeKey = null;
    this.host
      .querySelectorAll('[data-period]')
      .forEach((b) =>
        b.setAttribute('aria-pressed', String(Number(b.dataset.period) === this.interval)),
      );
    this.host.querySelector('.market-tape-rows').replaceChildren();
    this.legend(null);
    this.host.querySelector('.candle-asof').textContent = '';
    this.notice(
      this.token
        ? t('成交记录以实际发生时间为准', 'Trade records use their actual execution time')
        : t('选择代币查看成交 K 线', 'Select a token to view trade candles'),
    );
    if (this.token) {
      void this.history();
      this.connect();
    }
  }
  async history(older = false) {
    if (
      !this.token ||
      this.loading ||
      Date.now() < this.retryAt ||
      (older && Date.now() < (this.olderAt ?? 0))
    )
      return;
    const version = this.version;
    if (older) this.olderAt = Date.now() + 8000;
    this.loading = true;
    this.abort = new AbortController();
    const controller = this.abort,
      timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(
        `/api/chart/history?token=${encodeURIComponent(this.token)}&interval=${this.interval}${older ? '&older=1' : ''}`,
        { signal: this.abort.signal },
      );
      if (version !== this.version) return;
      if (!response.ok) {
        this.retryAt =
          Date.now() + Math.max(15, Number(response.headers.get('Retry-After')) || 15) * 1000;
        throw Error('History unavailable');
      }
      const data = await response.json();
      if (version !== this.version) return;
      this.apply({ ...data, reset: true }, true);
    } catch (e) {
      if (version !== this.version) return;
      this.host.querySelector('.candle-asof').textContent = t(
        '成交记录暂未更新',
        'Trade records have not updated',
      );
      if (!this.bars.size)
        this.notice(
          t(
            '该代币的成交记录暂时不可用',
            'Trade history is temporarily unavailable for this token',
          ),
        );
    } finally {
      clearTimeout(timeout);
      if (version === this.version) this.loading = false;
    }
  }
  connect() {
    this.stream?.close();
    if (!this.token || document.hidden) return;
    const version = this.version;
    this.stream = new EventSource(
      `/api/chart/stream?token=${encodeURIComponent(this.token)}&interval=${this.interval}`,
    );
    this.stream.addEventListener('candles', (event) => {
      if (version !== this.version) return;
      try {
        this.apply(JSON.parse(event.data));
      } catch {
        /* retain last genuine candles */
      }
    });
    this.stream.onerror = () => {
      if (version !== this.version) return;
      this.host.querySelector('.candle-asof').textContent = this.throughAt
        ? t('成交记录截至 ', 'Records through ') + clock(this.throughAt / 1000)
        : t('成交记录暂未更新', 'Trade records have not updated');
    };
  }
  apply(data, history = false) {
    if (
      data.token !== this.token ||
      data.interval !== this.interval ||
      data.chainId !== 4663 ||
      data.currency !== 'ETH' ||
      (this.revision !== null && data.revision < this.revision && !data.reset)
    )
      return;
    // A late history response must never overwrite a newer stream revision.
    if (history && this.revision !== null && data.revision < this.revision) return;
    const candles = data.candles.filter(
      (c) =>
        Number.isInteger(c.time) &&
        c.time > 0 &&
        [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) &&
        c.low > 0 &&
        c.low <= Math.min(c.open, c.close) &&
        c.high >= Math.max(c.open, c.close) &&
        c.volume > 0,
    );
    if (candles.length !== data.candles.length) return;
    const old = this.bars,
      next = data.reset ? new Map() : new Map(old);
    for (const c of candles) next.set(c.time, c);
    this.bars = new Map([...next].sort((a, b) => a[0] - b[0]).slice(-600));
    const range = this.chart.timeScale().getVisibleRange(),
      last = [...old.keys()].at(-1);
    const rebuild = data.reset || candles.some((c) => c.time < (last ?? 0) && !old.has(c.time));
    if (rebuild) {
      this.price.setData([...this.bars.values()]);
      this.volume.setData([...this.bars.values()].map((c) => this.volumeBar(c)));
      if (range && !this.needsFit) {
        try {
          this.chart.timeScale().setVisibleRange(range);
        } catch {}
      }
    } else
      for (const c of candles) {
        this.price.update(c, c.time < (last ?? 0));
        this.volume.update(this.volumeBar(c), c.time < (last ?? 0));
      }
    this.revision = data.revision;
    this.throughAt = data.throughAt;
    if (this.needsFit && this.bars.size) {
      const count = this.bars.size;
      this.chart
        .timeScale()
        .setVisibleLogicalRange({ from: Math.max(-3, count - 65), to: count + 5 });
      this.needsFit = false;
    }
    this.notice(
      this.bars.size
        ? ''
        : t(
            '已核对的时间段内暂无成交，报价与模拟交易仍可单独使用。',
            'No trades in the checked period. Quotes and paper trading remain available separately.',
          ),
    );
    this.host.querySelector('.candle-asof').textContent =
      (data.delayed ? t('记录截至 ', 'Records through ') : t('已核对至 ', 'Checked through ')) +
      clock(data.throughAt / 1000);
    if (!this.hover) this.legend([...this.bars.values()].at(-1));
    this.updateMarkers();
    if (data.trades) this.tape(data.trades);
  }
  volumeBar(c) {
    return { time: c.time, value: c.volume, color: c.close >= c.open ? '#13a37a55' : '#e05a7255' };
  }
  legend(c, volume) {
    this.host.querySelector('.candle-legend').textContent = c
      ? `O ${fmt(c.open)}   H ${fmt(c.high)}   L ${fmt(c.low)}   C ${fmt(c.close)}   ${t('量', 'Vol')} ${fmt(volume ?? c.volume)} ETH`
      : 'O —   H —   L —   C —';
  }
  setFills(fills) {
    this.fills = fills;
    this.updateMarkers();
  }
  updateMarkers() {
    const markers = this.fills
      .filter((f) => f.token === this.token)
      .map((f) => ({
        time: Math.floor(f.at / 1000 / this.interval) * this.interval,
        position: f.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: f.side === 'buy' ? '#13a37a' : '#e05a72',
        shape: f.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: f.side === 'buy' ? t('模拟买', 'Paper B') : t('模拟卖', 'Paper S'),
      }))
      .filter((m) => this.bars.has(m.time))
      .sort((a, b) => a.time - b.time);
    const key = JSON.stringify(markers);
    if (key !== this.markerKey) {
      this.markers.setMarkers(markers);
      this.markerKey = key;
    }
  }
  tape(rows) {
    const list = this.host.querySelector('.market-tape-rows');
    const key = JSON.stringify(rows);
    if (key === this.tapeKey) return;
    this.tapeKey = key;
    list.replaceChildren(
      ...rows.slice(0, 12).map((r) => {
        const row = document.createElement('a');
        row.className = 'tape-row';
        row.href = `https://robinhoodchain.blockscout.com/tx/${/^0x[0-9a-f]{64}$/.test(r.tx) ? r.tx : ''}`;
        row.target = '_blank';
        row.rel = 'noopener noreferrer';
        for (const [i, value] of [
          clock(r.ts),
          r.buy ? t('买入', 'Buy') : t('卖出', 'Sell'),
          fmt(r.price),
          fmt(r.volume) + ' ETH',
          r.venue === 'v4' ? 'V4' : t('曲线', 'Curve'),
        ].entries()) {
          const span = document.createElement('span');
          span.textContent = value;
          if (i === 1) span.className = r.buy ? 'positive' : 'negative';
          row.append(span);
        }
        return row;
      }),
    );
  }
  close() {
    this.version++;
    this.abort?.abort();
    this.stream?.close();
    this.theme.disconnect();
    document.removeEventListener('visibilitychange', this.visibility);
    this.chart.remove();
  }
}
window.BiTradeChart = TradeChart;
