import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { decodeEventLog, getEventSelector } from 'viem';
import { CloudRpc } from '../cloudflare/rpc.mjs';
import { PONS_EVENTS } from '../cloudflare/robinhood-data.mjs';
import { PONS_V2_ABI, ERC20 } from '../paper-terminal/src/server/adapters/abi.js';
import { PONS_V2, ZERO, CHAIN_CONFIG } from '../paper-terminal/src/server/adapters/types.js';
import { poolId } from '../paper-terminal/src/server/adapters/venues.js';

const cfg = CHAIN_CONFIG.robinhood;
const lower = (x) => String(x).toLowerCase();
const hex = (n) => '0x' + n.toString(16);
const hash = (v) => /^0x[0-9a-f]{64}$/i.test(v ?? '');
const number = (v) => {
  if (!/^0x[0-9a-f]+$/i.test(v ?? '')) throw Error('Invalid event index');
  const n = Number(BigInt(v));
  if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid event index');
  return n;
};
export const CHART_INTERVALS = [60, 300, 900, 3600];

// Exchange execution prices exclude the separately reported curve fees/taxes.
// Quote-side volume counts the real gross quote leg once. Never use sampled
// spot quotes or paper fills to manufacture a candle or its volume.
export function decodeTrade(log, meta, from, to, headers) {
  const block = number(log.blockNumber),
    index = number(log.logIndex);
  const header = headers.get(block);
  if (
    log.removed ||
    block < from ||
    block > to ||
    !hash(log.transactionHash) ||
    !hash(log.blockHash) ||
    !header ||
    lower(header.hash) !== lower(log.blockHash)
  )
    throw Error('Non-canonical trade');
  let tokenRaw, quoteRaw, grossRaw, buy, venue;
  if (lower(log.address) === meta.curve) {
    const e = decodeEventLog({
      abi: PONS_EVENTS.slice(1, 3),
      topics: log.topics,
      data: log.data,
      strict: true,
    });
    const a = e.args;
    buy = e.eventName === 'CurveBuy';
    tokenRaw = buy ? a.tokensOut : a.tokensIn;
    // CurveBuy.fee includes the snipe charge; tax is the creator tax.
    grossRaw = buy ? a.quoteIn : a.quoteOut + a.fee + a.tax;
    quoteRaw = buy ? a.quoteIn - a.fee - a.tax : grossRaw;
    venue = 'curve';
  } else {
    if (lower(log.address) !== cfg.v4Manager) throw Error('Unknown trade emitter');
    const { args: a } = decodeEventLog({
      abi: [PONS_EVENTS[3]],
      topics: log.topics,
      data: log.data,
      strict: true,
    });
    if (lower(a.id) !== meta.poolId) throw Error('Unrelated pool');
    const token0 = meta.key.currency0 === meta.token;
    const t = token0 ? a.amount0 : a.amount1,
      q = token0 ? a.amount1 : a.amount0;
    if (!t || !q || t > 0n === q > 0n) throw Error('Invalid swap amounts');
    buy = q < 0n;
    tokenRaw = t < 0n ? -t : t;
    quoteRaw = q < 0n ? -q : q;
    grossRaw = quoteRaw;
    venue = 'v4';
  }
  const tokens = Number(tokenRaw) / 10 ** meta.decimals;
  const price = Number(quoteRaw) / 1e18 / tokens,
    volume = Number(grossRaw) / 1e18;
  const ts = Math.floor(header.time / 1000);
  if (
    !(price > 0 && volume > 0) ||
    !Number.isFinite(price + volume) ||
    !Number.isSafeInteger(ts) ||
    ts < 1
  )
    throw Error('Invalid trade amounts/time');
  return {
    token: meta.token,
    block,
    index,
    hash: lower(log.blockHash),
    tx: lower(log.transactionHash),
    ts,
    price,
    volume,
    buy,
    venue,
  };
}

export class CandleRepository {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chart_trades(token TEXT, block INTEGER, idx INTEGER,
        hash TEXT, tx TEXT, ts INTEGER, price REAL, volume REAL, buy INTEGER, venue TEXT,
        PRIMARY KEY(token,block,idx));
      CREATE INDEX IF NOT EXISTS chart_time ON chart_trades(token,ts,block,idx);
      CREATE TABLE IF NOT EXISTS chart_cursor(token TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  cursor(token) {
    const row = this.db.prepare('SELECT value FROM chart_cursor WHERE token=?').get(token);
    return row ? JSON.parse(row.value) : null;
  }
  replace(token, from, to, trades, cursor) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('DELETE FROM chart_trades WHERE token=? AND block BETWEEN ? AND ?')
        .run(token, from, to);
      const insert = this.db.prepare('INSERT INTO chart_trades VALUES(?,?,?,?,?,?,?,?,?,?)');
      for (const r of trades)
        insert.run(token, r.block, r.index, r.hash, r.tx, r.ts, r.price, r.volume, +r.buy, r.venue);
      this.db
        .prepare(
          'INSERT INTO chart_cursor VALUES(?,?) ON CONFLICT(token) DO UPDATE SET value=excluded.value',
        )
        .run(token, JSON.stringify(cursor));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  reset(token) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM chart_trades WHERE token=?').run(token);
      this.db.prepare('DELETE FROM chart_cursor WHERE token=?').run(token);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  bars(token, interval) {
    return this.db
      .prepare(
        `SELECT time,
      MAX(CASE WHEN first=1 THEN price END) AS open, MAX(price) AS high, MIN(price) AS low,
      MAX(CASE WHEN last=1 THEN price END) AS close, SUM(volume) AS volume, COUNT(*) AS trades
      FROM (SELECT *, CAST(ts / ? AS INTEGER) * ? AS time,
        ROW_NUMBER() OVER(PARTITION BY CAST(ts / ? AS INTEGER) ORDER BY block,idx) AS first,
        ROW_NUMBER() OVER(PARTITION BY CAST(ts / ? AS INTEGER) ORDER BY block DESC,idx DESC) AS last
        FROM chart_trades WHERE token=?) GROUP BY time ORDER BY time DESC LIMIT 600`,
      )
      .all(interval, interval, interval, interval, token)
      .reverse()
      .map((r) => ({ ...r }));
  }
  recent(token) {
    return this.db
      .prepare(
        'SELECT tx,ts,price,volume,buy,venue FROM chart_trades WHERE token=? ORDER BY block DESC,idx DESC LIMIT 30',
      )
      .all(token)
      .map((r) => ({ ...r, buy: !!r.buy }));
  }
  close() {
    this.db.close();
  }
}

// One shared reader per process, not one RPC poll per visitor. Charts have their
// own database and read-only RPC queue; financial records and risk freshness are
// never changed by chart scans. Recent blocks are replayed to handle reorgs.
export class CandleService {
  constructor({ path, rpc, now = Date.now, intervalMs = 1200 }) {
    this.repo = new CandleRepository(path);
    Object.assign(this, { rpc, now, intervalMs });
    this.jobs = new Map();
    this.meta = new Map();
    this.watches = new Map();
    this.cache = new Map();
    this.limits = new Map();
    this.cooldowns = new Map();
    this.retryAt = 0;
    this.closed = false;
    this.timer = null;
    this.round = null;
    this.headTask = null;
  }
  async head() {
    if (this.latest && this.now() - this.headAt < 1000) return this.latest;
    if (!this.headTask)
      this.headTask = this.rpc
        .block()
        .then((b) => {
          this.latest = b;
          this.headAt = this.now();
          return b;
        })
        .finally(() => {
          this.headTask = null;
        });
    return this.headTask;
  }
  async metadata(token, head) {
    const old = this.meta.get(token);
    if (old && this.now() - old.at < 60000) return old;
    const state = await this.rpc.read(
      PONS_V2,
      PONS_V2_ABI,
      'getLaunchedToken',
      [token],
      head.number,
    );
    if (
      !state.exists ||
      lower(state.token) !== token ||
      ![0, 1, 2, 3].includes(Number(state.phase)) ||
      ![ZERO, cfg.wrapped].includes(lower(state.pairToken))
    )
      throw Error('Unsupported launch');
    const [decimals, hook, manager] = await Promise.all([
      this.rpc.read(token, ERC20, 'decimals', [], head.number),
      this.rpc.read(PONS_V2, PONS_V2_ABI, 'memeHook', [], head.number),
      this.rpc.read(PONS_V2, PONS_V2_ABI, 'poolManager', [], head.number),
    ]);
    if (
      lower(manager) !== cfg.v4Manager ||
      !/^0x[0-9a-f]{40}$/.test(lower(hook)) ||
      lower(hook) === ZERO ||
      !Number.isInteger(Number(decimals)) ||
      Number(decimals) > 36
    )
      throw Error('Unknown pool configuration');
    const quote = lower(state.pairToken),
      [currency0, currency1] = [token, quote].sort();
    const key = {
      currency0,
      currency1,
      fee: Number(state.poolFee),
      tickSpacing: Number(state.tickSpacing),
      hooks: lower(hook),
    };
    const value = {
      token,
      curve: lower(state.curve),
      decimals: Number(decimals),
      key,
      poolId: lower(poolId(key)),
      at: this.now(),
    };
    if (!/^0x[0-9a-f]{40}$/.test(value.curve) || value.curve === ZERO) throw Error('Unknown curve');
    if (Number(state.phase) === 2) {
      const info = await this.rpc.read(
        key.hooks,
        PONS_V2_ABI,
        'launches',
        [value.poolId],
        head.number,
      );
      if (!info[0] || lower(info[2]) !== token || lower(info[3]) !== quote)
        throw Error('Unknown graduated pool');
    }
    this.meta.set(token, value);
    while (this.meta.size > 96) this.meta.delete(this.meta.keys().next().value);
    return value;
  }
  filters(meta) {
    return [
      {
        address: meta.curve,
        topics: [[getEventSelector(PONS_EVENTS[1]), getEventSelector(PONS_EVENTS[2])]],
      },
      { address: cfg.v4Manager, topics: [getEventSelector(PONS_EVENTS[3]), meta.poolId] },
    ];
  }
  async scan(meta, from, to, newest) {
    let logs;
    for (;;) {
      logs = (
        await Promise.all(
          this.filters(meta).map((filter) =>
            this.rpc.request('eth_getLogs', [
              { ...filter, fromBlock: hex(from), toBlock: hex(to) },
            ]),
          ),
        )
      ).flat();
      if (logs.length <= 4000 && new Set(logs.map((l) => number(l.blockNumber))).size <= 32) break;
      if (from === to) throw Error('Trade batch exceeds processing capacity');
      // Keep the adjacent edge: latest first for initial/older scans, oldest
      // first for catch-up. No skipped middle range is marked as covered.
      if (newest) from = Math.floor((from + to) / 2) + 1;
      else to = Math.floor((from + to) / 2);
    }
    const blocks = [...new Set([from, to, ...logs.map((l) => number(l.blockNumber))])];
    const headers = new Map();
    await Promise.all(
      blocks.map(async (n) => {
        headers.set(n, await this.rpc.block(n));
      }),
    );
    const seen = new Set(),
      rows = logs.map((l) => {
        const r = decodeTrade(l, meta, from, to, headers),
          id = `${r.block}:${r.index}`;
        if (seen.has(id)) throw Error('Duplicate trade event');
        seen.add(id);
        return r;
      });
    const anchor = await this.rpc.block(to, true);
    if (lower(anchor.hash) !== lower(headers.get(to).hash)) throw Error('Scan crossed a reorg');
    return {
      rows,
      from,
      to,
      firstAt: headers.get(from).time,
      throughAt: anchor.time,
      hash: anchor.hash,
    };
  }
  async sync(token, older = false) {
    if (this.closed) throw Error('Chart reader closed');
    if (this.jobs.has(token)) return this.jobs.get(token);
    if (this.now() < this.retryAt) throw Error('Chart reader cooling down');
    if (this.now() < (this.cooldowns.get(token) ?? 0)) throw Error('Token history cooling down');
    if (this.jobs.size >= 2) throw Error('Chart reader busy');
    const task = this.update(token, older)
      .catch((e) => {
        this.cooldowns.set(token, this.now() + 15000);
        while (this.cooldowns.size > 96) this.cooldowns.delete(this.cooldowns.keys().next().value);
        this.retryAt = Math.max(this.retryAt, this.rpc.status?.().retryAt ?? 0);
        throw e;
      })
      .finally(() => this.jobs.delete(token));
    this.jobs.set(token, task);
    return task;
  }
  async update(token, older) {
    const head = await this.head(),
      meta = await this.metadata(token, head);
    let cursor = this.repo.cursor(token);
    if (
      cursor &&
      (head.number < cursor.last ||
        lower((await this.rpc.block(cursor.last, true)).hash) !== lower(cursor.hash))
    ) {
      this.repo.reset(token);
      this.rpc.cache?.clear();
      cursor = null;
      for (const key of this.cache.keys()) if (key.startsWith(token + ':')) this.cache.delete(key);
    }
    if (older && cursor && this.now() - (cursor.olderAt ?? 0) < 5000) return;
    const to = older && cursor ? cursor.first - 1 : head.number;
    if (to < 1) return;
    const from =
      older || !cursor ? Math.max(1, to - 19999) : Math.max(cursor.first, cursor.last - 8);
    const result = await this.scan(meta, from, Math.min(to, from + 19999), older || !cursor);
    const next = {
      first: Math.min(cursor?.first ?? result.from, result.from),
      firstAt: result.from < (cursor?.first ?? Infinity) ? result.firstAt : cursor.firstAt,
      last: Math.max(cursor?.last ?? result.to, result.to),
      hash: result.to >= (cursor?.last ?? 0) ? result.hash : cursor.hash,
      throughAt: result.to >= (cursor?.last ?? 0) ? result.throughAt : cursor.throughAt,
      revision: (cursor?.revision ?? 0) + 1,
      olderAt: older ? this.now() : (cursor?.olderAt ?? 0),
    };
    this.repo.replace(token, result.from, result.to, result.rows, next);
    for (const key of this.cache.keys()) if (key.startsWith(token + ':')) this.cache.delete(key);
  }
  snapshot(token, interval) {
    const cursor = this.repo.cursor(token),
      key = token + ':' + interval;
    let cached = this.cache.get(key);
    if (!cached || cached.revision !== cursor?.revision) {
      cached = {
        token,
        chainId: 4663,
        currency: 'ETH',
        interval,
        candles: this.repo.bars(token, interval),
        trades: this.repo.recent(token),
        revision: cursor?.revision ?? 0,
        firstAt: cursor?.firstAt ?? null,
        throughAt: cursor?.throughAt ?? null,
      };
      this.cache.set(key, cached);
      while (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value);
    }
    return { ...cached, delayed: this.now() - (cursor?.throughAt ?? 0) > 20000 };
  }
  schedule() {
    if (this.timer || this.closed || !this.watches.size) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.round = (async () => {
        // Serialize markets to avoid saturating the anonymous upstream. Every
        // watcher of a token shares this scan and its immutable snapshot.
        for (const [token, watchers] of this.watches) {
          if (this.closed) break;
          try {
            await this.sync(token);
          } catch {
            /* retained snapshot, original timestamps */
          }
          for (const w of watchers) w.send(this.snapshot(token, w.interval));
        }
      })().finally(() => {
        this.round = null;
        this.schedule();
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }
  allow(ip) {
    const now = this.now(),
      old = this.limits.get(ip);
    const row = old && now - old.at < 60000 ? old : { at: now, count: 0 };
    row.count++;
    this.limits.set(ip, row);
    while (this.limits.size > 1000) this.limits.delete(this.limits.keys().next().value);
    return row.count <= 30;
  }
  async handle(request) {
    const url = new URL(request.url);
    if (!['/api/chart/history', '/api/chart/stream'].includes(url.pathname)) return null;
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Retry-After': '15',
        },
      });
    if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
    const token = lower(url.searchParams.get('token')),
      interval = Number(url.searchParams.get('interval') ?? 60);
    if (
      !/^0x[0-9a-f]{40}$/.test(token) ||
      !CHART_INTERVALS.includes(interval) ||
      [...url.searchParams.keys()].some((k) => !['token', 'interval', 'older'].includes(k))
    )
      return reply({ error: 'Invalid chart selection' }, 400);
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
    if (!this.allow(ip)) return reply({ error: 'Please wait before requesting more history' }, 429);
    if (!this.watches.has(token) && this.watches.size >= 8)
      return reply({ error: 'Chart temporarily unavailable' }, 503);
    if (url.pathname.endsWith('/history')) {
      try {
        await this.sync(token, url.searchParams.get('older') === '1');
      } catch {
        return reply(
          { ...this.snapshot(token, interval), delayed: true },
          this.repo.cursor(token) ? 200 : 503,
        );
      }
      return reply(this.snapshot(token, interval));
    }
    if (
      [...this.watches.values()].flatMap((s) => [...s]).length >= 64 ||
      [...this.watches.values()].flatMap((s) => [...s]).filter((w) => w.ip === ip).length >= 4
    )
      return reply({ error: 'Chart temporarily unavailable' }, 429);
    let watcher, heartbeat, expiry;
    const encoder = new TextEncoder();
    const detach = () => {
      clearInterval(heartbeat);
      clearTimeout(expiry);
      const list = this.watches.get(token);
      list?.delete(watcher);
      if (!list?.size) this.watches.delete(token);
      request.signal.removeEventListener('abort', abort);
    };
    let end;
    const abort = () => {
      detach();
      try {
        end?.();
      } catch {}
    };
    const stream = new ReadableStream({
      start: (controller) => {
        let last = '',
          previous = null;
        const write = (s) => {
          if (controller.desiredSize < -4) {
            abort();
            return;
          }
          try {
            controller.enqueue(encoder.encode(s));
          } catch {
            detach();
          }
        };
        end = () => controller.close();
        watcher = {
          ip,
          interval,
          send: (snapshot) => {
            const text = JSON.stringify(snapshot);
            if (text !== last) {
              const old = new Map(
                (previous?.candles ?? []).map((c) => [c.time, JSON.stringify(c)]),
              );
              const times = new Set(snapshot.candles.map((c) => c.time));
              const reset =
                !previous ||
                previous.revision > snapshot.revision ||
                [...old.keys()].some((time) => !times.has(time));
              const candles = reset
                ? snapshot.candles
                : snapshot.candles.filter((c) => old.get(c.time) !== JSON.stringify(c));
              write(
                'event: candles\ndata: ' + JSON.stringify({ ...snapshot, candles, reset }) + '\n\n',
              );
              last = text;
              previous = snapshot;
            }
          },
          close: abort,
        };
        if (!this.watches.has(token)) this.watches.set(token, new Set());
        this.watches.get(token).add(watcher);
        write('retry: 5000\n\n');
        if (this.repo.cursor(token)) watcher.send(this.snapshot(token, interval));
        heartbeat = setInterval(() => write(': keepalive\n\n'), 15000);
        heartbeat.unref?.();
        expiry = setTimeout(abort, 240000);
        expiry.unref?.();
        request.signal.addEventListener('abort', abort, { once: true });
        this.schedule();
      },
      cancel: detach,
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const watchers of [...this.watches.values()]) for (const w of [...watchers]) w.close();
    await Promise.allSettled([this.round, ...this.jobs.values()]);
    this.repo.close();
  }
}

export function createCandleService(env) {
  if (env.BI_TRADE_CHAIN !== 'robinhood') return null;
  const stop = new AbortController();
  const service = new CandleService({
    path:
      env.BI_TRADE_CHART_DB_PATH ??
      (env.BI_TRADE_DB_PATH ?? './data/bitrade.sqlite') + '.charts.sqlite',
    rpc: new CloudRpc(env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com', {
      chain: 'robinhood',
      concurrency: 2,
      fetchImpl: (url, options) =>
        fetch(url, {
          ...options,
          signal: AbortSignal.any([options.signal, stop.signal]),
        }),
    }),
  });
  return {
    async handle(request) {
      const path = new URL(request.url).pathname;
      if (!path.startsWith('/api/chart/')) return null;
      const secret = env.BI_TRADE_ORIGIN_PROXY_TOKEN;
      const supplied = request.headers.get('X-BI-Proxy-Key') ?? '';
      if (
        new URL(request.url).origin !== new URL(env.SITE_ORIGIN).origin ||
        (secret &&
          (Buffer.byteLength(supplied) !== Buffer.byteLength(secret) ||
            !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))))
      )
        return new Response('Forbidden', { status: 403 });
      return (await service.handle(request)) ?? new Response('Not found', { status: 404 });
    },
    close: () => {
      stop.abort();
      return service.close();
    },
  };
}
