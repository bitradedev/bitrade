// Read-only local snapshot, replayed in memory. Never submits an order or writes a ledger.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import type { AppState } from '../shared/domain';
import { reconcileState } from './state-cache';
import { money, price, timeText, timestampMs } from './lib';

const response = await fetch('http://127.0.0.1:8790/api/state', { signal: AbortSignal.timeout(5000) });
if (!response.ok) throw Error(`Cannot read benchmark snapshot: ${response.status}`);
const raw = await response.text();
const initial = JSON.parse(raw) as AppState;
const iterations = 200;
const percentile = (values: number[], quantile: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * quantile)];
function replay(oneMarketChanges: boolean) {
  let previous = initial, rawMarketReferencesReplaced = 0, sharedMarketReferencesReplaced = 0;
  const parseMs: number[] = [], reconcileMs: number[] = [];
  for (let tick = 0; tick < iterations; tick++) {
    const text = JSON.stringify(previous);
    const parseStart = performance.now();
    const next = JSON.parse(text) as AppState;
    parseMs.push(performance.now() - parseStart);
    next.at += 2000;
    for (const chain of next.chains) { chain.head++; chain.headAt += 2000; }
    if (oneMarketChanges && next.markets.length) {
      const market = next.markets[tick % next.markets.length];
      market.volumeUsd = (market.volumeUsd ?? 0) + 1;
    }
    rawMarketReferencesReplaced += next.markets.filter((m, i) => m !== previous.markets[i]).length;
    const mergeStart = performance.now();
    const result = reconcileState(previous, next);
    reconcileMs.push(performance.now() - mergeStart);
    sharedMarketReferencesReplaced += result.markets.filter((m, i) => m !== previous.markets[i]).length;
    previous = result;
  }
  assert.equal(sharedMarketReferencesReplaced, oneMarketChanges && initial.markets.length ? iterations : 0);
  return { scenario: oneMarketChanges ? 'head plus one market update' : 'head updates only', iterations, rawMarketReferencesReplaced, sharedMarketReferencesReplaced, parseMedianMs: percentile(parseMs, .5), parseP95Ms: percentile(parseMs, .95), reconcileMedianMs: percentile(reconcileMs, .5), reconcileP95Ms: percentile(reconcileMs, .95) };
}
function formattingBench() {
  const cases = Array.from({ length: 1000 }, (_, i) => initial.markets[i % initial.markets.length] ?? { volumeUsd: null, priceUsd: null, updatedAt: initial.at });
  const legacyMoney = (value: number | null) => value == null || !Number.isFinite(value) ? '—' : `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const legacyPrice = (value: number | null) => value == null || !Number.isFinite(value) ? '—' : value === 0 ? '$0' : '$' + value.toLocaleString('en-US', { maximumSignificantDigits: 6 });
  const legacyTime = (value: number) => !value ? '—' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(timestampMs(value));
  const measure = (name: string, before: (row: typeof cases[number]) => string, after: (row: typeof cases[number]) => string) => {
    const start = performance.now(), original = cases.map(before), beforeMs = performance.now() - start;
    const cachedStart = performance.now(), cached = cases.map(after), afterMs = performance.now() - cachedStart;
    assert.deepEqual(cached, original);
    return { formatter: name, labels: cases.length, beforeMs, cachedMs: afterMs, exactOutputMatch: true };
  };
  return [measure('money', row => legacyMoney(row.volumeUsd), row => money(row.volumeUsd)), measure('price', row => legacyPrice(row.priceUsd), row => price(row.priceUsd)), measure('Beijing date/time', row => legacyTime(row.updatedAt), row => timeText(row.updatedAt, true))];
}
const report = { measuredAt: new Date().toISOString(), source: 'One read-only local API snapshot; local replay scenarios, not browser FPS or live render counts', snapshotBytes: Buffer.byteLength(raw), marketCount: initial.markets.length, results: [replay(false), replay(true)], formatting: formattingBench() };
await writeFile(new URL('./performance-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
