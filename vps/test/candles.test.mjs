import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAbi,
  encodeEventTopics,
  encodeAbiParameters,
  keccak256,
  encodeAbiParameters as encode,
} from 'viem';
import {
  CandleRepository,
  CandleService,
  decodeTrade,
  createCandleService,
} from '../dist/candles.mjs';

const TOKEN = '0x' + '11'.repeat(20),
  CURVE = '0x' + '22'.repeat(20),
  HOOK = '0x' + '33'.repeat(20),
  ZERO = '0x' + '00'.repeat(20);
const MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const abi = parseAbi([
  'event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)',
  'event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 tax)',
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
]);
const h = (n) => '0x' + n.toString(16).padStart(64, '0'),
  hex = (n) => '0x' + n.toString(16),
  BASE = 1770000000000;
const key = { currency0: ZERO, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK };
const pid = keccak256(
  encode(
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'uint24' },
      { type: 'int24' },
      { type: 'address' },
    ],
    [ZERO, TOKEN, 0, 200, HOOK],
  ),
);
const meta = { token: TOKEN, curve: CURVE, key, poolId: pid, decimals: 18 };
function log(block = 100, index = 0, buy = true) {
  return {
    address: CURVE,
    blockNumber: hex(block),
    blockHash: h(block),
    transactionHash: h(block + 1),
    logIndex: hex(index),
    topics: encodeEventTopics({
      abi: [abi[buy ? 0 : 1]],
      eventName: buy ? 'CurveBuy' : 'CurveSell',
      args: { buyer: TOKEN, recipient: TOKEN, seller: TOKEN },
    }),
    data: encodeAbiParameters(
      Array.from({ length: 4 }, () => ({ type: 'uint256' })),
      buy
        ? [100n * 10n ** 18n, 200n * 10n ** 18n, 2n * 10n ** 18n, 3n * 10n ** 18n]
        : [200n * 10n ** 18n, 90n * 10n ** 18n, 2n * 10n ** 18n, 3n * 10n ** 18n],
    ),
  };
}
function fixture(t, path = ':memory:') {
  let head = 100,
    time = BASE + 100000,
    fork = 0;
  const logs = [],
    calls = [];
  const block = async (n = head) => ({
    number: n,
    hash: h(n + fork),
    time: BASE + n * 1000,
    transactions: [],
  });
  const rpc = {
    cache: new Map(),
    status: () => ({ retryAt: 0 }),
    block,
    read: async (_a, _abi, name) =>
      name === 'getLaunchedToken'
        ? {
            exists: true,
            token: TOKEN,
            curve: CURVE,
            pairToken: ZERO,
            poolFee: 0,
            tickSpacing: 200,
            phase: 0,
          }
        : name === 'decimals'
          ? 18
          : name === 'memeHook'
            ? HOOK
            : name === 'poolManager'
              ? MANAGER
              : [true, false, TOKEN, ZERO],
    request: async (method, [filter]) => {
      calls.push({ method, filter });
      return logs.filter(
        (l) =>
          l.address === filter.address &&
          Number(BigInt(l.blockNumber)) >= Number(BigInt(filter.fromBlock)) &&
          Number(BigInt(l.blockNumber)) <= Number(BigInt(filter.toBlock)),
      );
    },
  };
  const service = new CandleService({ path, rpc, now: () => time, intervalMs: 10 });
  t.after(() => service.close());
  return {
    service,
    rpc,
    logs,
    calls,
    advance(n) {
      head = n;
      time = BASE + n * 1000;
    },
    reorg() {
      fork = 10000;
      for (const l of logs) l.blockHash = h(Number(BigInt(l.blockNumber)) + fork);
      time += 2000;
    },
  };
}
test('real curve execution OHLC excludes buy snipe/creator fees and counts gross quote volume once', () => {
  const headers = new Map([[100, { hash: h(100), time: BASE + 100000 }]]);
  const buy = decodeTrade(log(), meta, 90, 100, headers),
    sell = decodeTrade(log(100, 1, false), meta, 90, 100, headers);
  assert.equal(buy.price, 0.475);
  assert.equal(buy.volume, 100);
  assert.equal(sell.price, 0.475);
  assert.equal(sell.volume, 95);
  assert.equal(buy.buy, true);
  assert.equal(sell.buy, false);
});
test('graduated V4 delta signs, pool ID and token orientation are independently validated', () => {
  const l = {
    ...log(),
    address: MANAGER,
    topics: encodeEventTopics({
      abi: [abi[2]],
      eventName: 'Swap',
      args: { id: pid, sender: TOKEN },
    }),
    data: encodeAbiParameters(
      [
        { type: 'int128' },
        { type: 'int128' },
        { type: 'uint160' },
        { type: 'uint128' },
        { type: 'int24' },
        { type: 'uint24' },
      ],
      [-(10n ** 18n), 2n * 10n ** 18n, 1n, 1n, 0, 0],
    ),
  };
  const headers = new Map([[100, { hash: h(100), time: BASE + 100000 }]]),
    trade = decodeTrade(l, meta, 90, 100, headers);
  assert.equal(trade.buy, true);
  assert.equal(trade.price, 0.5);
  assert.equal(trade.volume, 1);
  assert.throws(() => decodeTrade(l, { ...meta, poolId: h(1) }, 90, 100, headers), /pool/);
});
test('noncanonical blocks, removed logs, arbitrary emitters, malformed identities and zero trades never become candles', () => {
  const headers = new Map([[100, { hash: h(100), time: BASE + 100000 }]]);
  for (const change of [
    { removed: true },
    { blockHash: h(1) },
    { transactionHash: '0x0' },
    { address: HOOK },
    { blockNumber: '0x999' },
    { logIndex: 'bad' },
  ])
    assert.throws(() => decodeTrade({ ...log(), ...change }, meta, 90, 100, headers));
});
test('repository orders same-second executions by block/log, aggregates genuine volume and leaves empty intervals absent', () => {
  const repo = new CandleRepository(':memory:');
  const rows = [
    {
      token: TOKEN,
      block: 3,
      index: 0,
      hash: h(3),
      tx: h(4),
      ts: 180,
      price: 5,
      volume: 3,
      buy: true,
      venue: 'curve',
    },
    {
      token: TOKEN,
      block: 1,
      index: 1,
      hash: h(1),
      tx: h(4),
      ts: 61,
      price: 3,
      volume: 2,
      buy: true,
      venue: 'curve',
    },
    {
      token: TOKEN,
      block: 1,
      index: 0,
      hash: h(1),
      tx: h(4),
      ts: 61,
      price: 2,
      volume: 1,
      buy: true,
      venue: 'curve',
    },
  ];
  repo.replace(TOKEN, 1, 3, rows, {});
  const bars = repo.bars(TOKEN, 60);
  assert.deepEqual(
    bars.map((c) => c.time),
    [60, 180],
  );
  assert.deepEqual(bars[0], { time: 60, open: 2, high: 3, low: 2, close: 3, volume: 3, trades: 2 });
  repo.replace(TOKEN, 1, 3, rows, {});
  assert.equal(repo.bars(TOKEN, 300)[0].volume, 6);
  repo.close();
});
test('cold history and concurrent visitors share one scan; subsequent reads retain volume without double counting', async (t) => {
  const f = fixture(t);
  f.logs.push(log());
  await Promise.all([f.service.sync(TOKEN), f.service.sync(TOKEN)]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.service.snapshot(TOKEN, 60).candles[0].volume, 100);
  f.advance(101);
  await f.service.sync(TOKEN);
  assert.equal(f.service.snapshot(TOKEN, 60).candles[0].volume, 100);
  assert.ok(f.service.snapshot(TOKEN, 60).throughAt > BASE + 100000);
});
test('curve and graduation pool are both indexed and retained in one contiguous candle history', async (t) => {
  const f = fixture(t);
  f.logs.push(log());
  const v4 = {
    ...log(99, 1),
    address: MANAGER,
    topics: encodeEventTopics({
      abi: [abi[2]],
      eventName: 'Swap',
      args: { id: pid, sender: TOKEN },
    }),
    data: encodeAbiParameters(
      [
        { type: 'int128' },
        { type: 'int128' },
        { type: 'uint160' },
        { type: 'uint128' },
        { type: 'int24' },
        { type: 'uint24' },
      ],
      [-(10n ** 18n), 2n * 10n ** 18n, 1n, 1n, 0, 0],
    ),
  };
  f.logs.push(v4);
  await f.service.sync(TOKEN);
  assert.deepEqual(
    new Set(f.service.snapshot(TOKEN, 60).trades.map((r) => r.venue)),
    new Set(['curve', 'v4']),
  );
});
test('reorg replaces orphaned chart executions without touching any financial database', async (t) => {
  const f = fixture(t);
  f.logs.push(log());
  await f.service.sync(TOKEN);
  f.reorg();
  f.logs.length = 0;
  await f.service.sync(TOKEN);
  assert.equal(f.service.snapshot(TOKEN, 60).candles.length, 0);
  assert.equal(f.service.repo.cursor(TOKEN).hash, h(10100));
});
test('failed or duplicate event scans do not advance coverage or erase last valid candle time', async (t) => {
  const f = fixture(t);
  f.logs.push(log());
  await f.service.sync(TOKEN);
  const first = f.service.snapshot(TOKEN, 60);
  f.advance(110);
  f.logs.push(log());
  await assert.rejects(f.service.sync(TOKEN), /Duplicate/);
  const after = f.service.snapshot(TOKEN, 60);
  assert.equal(after.throughAt, first.throughAt);
  assert.deepEqual(after.candles, first.candles);
});
test('history persists through service reconstruction and does not refill or create trading accounts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bi-chart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'charts.sqlite');
  const repo = new CandleRepository(path);
  repo.replace(
    TOKEN,
    1,
    100,
    [decodeTrade(log(), meta, 90, 100, new Map([[100, { hash: h(100), time: BASE + 100000 }]]))],
    { first: 1, last: 100, hash: h(100), revision: 1 },
  );
  repo.close();
  const reopened = new CandleRepository(path);
  assert.equal(reopened.bars(TOKEN, 60)[0].volume, 100);
  assert.deepEqual(
    reopened.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name),
    ['chart_cursor', 'chart_trades'],
  );
  reopened.close();
});
test('SSE produces bounded deltas, shares readers and releases timers on disconnect', async (t) => {
  const f = fixture(t);
  f.logs.push(log());
  await f.service.sync(TOKEN);
  const abort = new AbortController(),
    res = await f.service.handle(
      new Request(`https://site.test/api/chart/stream?token=${TOKEN}&interval=60`, {
        signal: abort.signal,
      }),
    );
  assert.equal(res.headers.get('X-Accel-Buffering'), 'no');
  const reader = res.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /retry/);
  const snapshot = new TextDecoder().decode((await reader.read()).value);
  assert.match(snapshot, /"reset":true/);
  const watchers = f.service.watches.get(TOKEN);
  assert.equal(watchers.size, 1);
  const next = f.service.snapshot(TOKEN, 60);
  next.candles = next.candles.map((c) => ({ ...c, close: c.close + 0.001, high: c.high + 0.001 }));
  next.revision++;
  [...watchers][0].send(next);
  const delta = JSON.parse(
    new TextDecoder().decode((await reader.read()).value).split('data: ')[1],
  );
  assert.equal(delta.reset, false);
  assert.equal(delta.candles.length, 1);
  assert.equal(delta.candles[0].close, next.candles[0].close);
  abort.abort();
  assert.equal(f.service.watches.size, 0);
  await reader.cancel();
});

test('dense history narrows at the adjacent edge and older reads extend coverage without a fabricated gap', async (t) => {
  const f = fixture(t);
  for (let n = 1; n <= 100; n++) f.logs.push(log(n));
  await f.service.sync(TOKEN);
  const first = f.service.repo.cursor(TOKEN);
  assert.equal(first.first, 76);
  assert.equal(first.last, 100);
  await f.service.sync(TOKEN, true);
  const older = f.service.repo.cursor(TOKEN);
  assert.ok(older.first < first.first);
  assert.equal(older.last, 100);
  assert.equal(
    f.service.repo.db.prepare('SELECT COUNT(*) n FROM chart_trades').get().n,
    older.last - older.first + 1,
  );
});
test('a busy market catches up past the replay overlap instead of endlessly rescanning old blocks', async (t) => {
  const f = fixture(t);
  for (let n = 1; n <= 200; n++) f.logs.push(log(n));
  await f.service.sync(TOKEN);
  let last = f.service.repo.cursor(TOKEN).last;
  f.advance(200);
  for (let n = 0; n < 10 && last < 200; n++) {
    await f.service.sync(TOKEN);
    const next = f.service.repo.cursor(TOKEN).last;
    assert.ok(next > last);
    last = next;
  }
  assert.equal(last, 200);
});

test('public chart endpoints reject invalid inputs and mutation; origin proxy secret cannot be bypassed', async (t) => {
  const f = fixture(t);
  for (const [query, status] of [
    ['token=bad', 400],
    [`token=${TOKEN}&interval=1`, 400],
    [`token=${TOKEN}&extra=1`, 400],
  ])
    assert.equal(
      (await f.service.handle(new Request('https://site.test/api/chart/history?' + query))).status,
      status,
    );
  assert.equal(
    (
      await f.service.handle(
        new Request(`https://site.test/api/chart/history?token=${TOKEN}`, { method: 'POST' }),
      )
    ).status,
    405,
  );
  const dir = mkdtempSync(join(tmpdir(), 'bi-chart-auth-'));
  const service = createCandleService({
    BI_TRADE_CHAIN: 'robinhood',
    SITE_ORIGIN: 'https://site.test',
    BI_TRADE_DB_PATH: join(dir, 'ledger'),
    BI_TRADE_ORIGIN_PROXY_TOKEN: 'private',
  });
  t.after(async () => {
    await service.close();
    assert.ok(dir.startsWith(join(tmpdir(), 'bi-chart-auth-')));
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(
    (await service.handle(new Request(`https://site.test/api/chart/history?token=${TOKEN}`)))
      .status,
    403,
  );
  assert.equal(
    (
      await service.handle(
        new Request(`https://wrong.test/api/chart/history?token=${TOKEN}`, {
          headers: { 'X-BI-Proxy-Key': 'private' },
        }),
      )
    ).status,
    403,
  );
});
