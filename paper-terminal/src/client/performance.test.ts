import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RISK } from '../shared/domain';
import type { AppState, Market } from '../shared/domain';
import { applyStateChange, stateChange } from '../shared/state-stream';
import { createFrameCoalescer, reconcileState, retainBrowseOrder, reuseArray, shareValue } from './state-cache';
import { money, price, rawQuantity, timeText, timestampMs } from './lib';
import { resolveScannerMarket, sameScannerCardProps } from './Scanner';

const at = 1791280000000;
const market: Market = { id: 'market-0', address: '0x1111111111111111111111111111111111111111', chain: 'bsc', name: 'Test fixture', symbol: 'TEST', platform: 'flap', stage: 'curve', createdAt: at - 3600000, priceUsd: 1, nativeUsd: 600, quoteAddress: 'native', decimals: 18, liquidityUsd: 200, volumeUsd: 100, buyTaxPct: 1, sellTaxPct: 1, updatedAt: at, block: 100, quality: 'verified', reason: '', scannerStage: 'new', progressPct: 50, metadata: { fees: { checked: true }, optional: 'value' } };
const base: AppState = { mode: 'paper', at, csrf: 'test-generation', chains: [{ chain: 'bsc', connected: true, head: 100, headAt: at, chainTime: at, gaps: 0, reconnects: 0, lastError: '', source: 'test' }], markets: [market], accounts: [], positions: [], orders: [], fills: [], strategies: [], researchRuns: [], audit: [], risk: DEFAULT_RISK, health: { recordingSince: at, evidence: { verified: true, count: 3 } }, controlActivity: [] };

test('unchanged full snapshots reuse every semantic container without mutating either input', () => {
  const next = structuredClone(base), original = structuredClone(next);
  assert.equal(reconcileState(base, next), base);
  assert.deepEqual(next, original);
  next.at += 2000; next.chains[0].head++; next.chains[0].headAt += 2000;
  const result = reconcileState(base, next);
  assert.notEqual(result, base); assert.notEqual(result.chains, base.chains);
  for (const key of ['markets', 'accounts', 'positions', 'orders', 'fills', 'strategies', 'researchRuns', 'audit', 'risk', 'health'] as const) assert.equal(result[key], base[key]);
  assert.deepEqual(result, next);
});
test('all market fields, nested metadata, unknown state fields and property removals remain authoritative', () => {
  for (const key of Object.keys(market) as (keyof Market)[]) {
    const next = structuredClone(base), old = next.markets[0][key];
    (next.markets[0] as unknown as Record<string, unknown>)[key] = typeof old === 'number' ? old + 1 : typeof old === 'string' ? old + '-changed' : old === null ? 0 : { changed: true };
    const result = reconcileState(base, next);
    assert.deepEqual(result, next, key); assert.notEqual(result.markets[0], market, key);
  }
  const previous = { ...base, futureField: { keep: 1, remove: 2 } };
  const next = structuredClone(previous);
  delete next.markets[0].progressPct; delete next.markets[0].metadata!.optional;
  delete (next.futureField as { remove?: number }).remove;
  delete (next as Partial<AppState>).controlActivity;
  const result = reconcileState(previous, next);
  assert.deepEqual(result, next); assert.equal(Object.hasOwn(result.markets[0], 'progressPct'), false);
  assert.equal(Object.hasOwn(result, 'controlActivity'), false);
  const prototypeKey = JSON.parse('{"__proto__":{"data":true},"value":1}');
  const shared = shareValue(prototypeKey, JSON.parse('{"__proto__":{"data":true},"value":2}'));
  assert.equal(Object.hasOwn(shared, '__proto__'), true); assert.equal(Object.getPrototypeOf(shared), Object.prototype);
});
test('keyed lists reuse moved records while keeping additions, removals and current ordering', () => {
  const second = { ...market, id: 'market-1', address: '0x2222222222222222222222222222222222222222' };
  const previous = { ...base, markets: [market, second] };
  const reordered = reconcileState(previous, structuredClone({ ...previous, markets: [second, market] }));
  assert.equal(reordered.markets[0], second); assert.equal(reordered.markets[1], market);
  const added = { ...market, id: 'market-2' };
  const changed = reconcileState(previous, structuredClone({ ...previous, markets: [second, added] }));
  assert.equal(changed.markets[0], second); assert.equal(changed.markets[1].id, 'market-2'); assert.equal(changed.markets.some(m => m.id === market.id), false);
});
test('generation changes, explicit restore reset, head rollback and stale connection invalidate correctly', () => {
  const next = structuredClone(base); next.csrf = 'new-generation';
  assert.equal(reconcileState(base, next), next);
  const rollback = structuredClone(base); rollback.chains[0].head--;
  assert.equal(reconcileState(base, rollback), rollback);
  assert.equal(reconcileState(null, structuredClone(base)) === base, false);
  const stale = structuredClone(base); stale.at += 40000; stale.chains[0].connected = false; stale.chains[0].lastError = 'disconnected';
  const result = reconcileState(base, stale);
  assert.deepEqual(result.chains, stale.chains); assert.notEqual(result.chains[0], base.chains[0]);
});
test('full-entity delta upserts and health deletions reconcile without losing fields or retaining deleted data', () => {
  const next = structuredClone(base); next.at += 2000; next.markets[0].scannerStage = 'graduated'; next.markets[0].progressPct = 100;
  delete next.markets[0].metadata; delete (next.health.evidence as Record<string, unknown>).count;
  next.health.newField = { complete: true };
  const patched = applyStateChange(base, stateChange(base, next));
  const result = reconcileState(base, patched);
  assert.deepEqual(result, next); assert.equal(result.risk, base.risk); assert.equal(result.accounts, base.accounts);
});
test('crosshair burst schedules one frame, delivers the last point and cancels unmounted work', () => {
  const frames = new Map<number, () => void>(), delivered: number[] = []; let nextId = 0, requests = 0;
  const coalescer = createFrameCoalescer<number>(value => delivered.push(value), cb => { requests++; frames.set(++nextId, cb); return nextId; }, id => frames.delete(id));
  for (let i = 0; i < 300; i++) coalescer.push(i);
  assert.equal(requests, 1); assert.equal(frames.size, 1);
  const flush = frames.get(nextId)!; frames.delete(nextId); flush();
  assert.deepEqual(delivered, [299]);
  coalescer.push(400); coalescer.cancel(); assert.equal(frames.size, 0); assert.deepEqual(delivered, [299]);
});
test('paused browsing retains order while updating records and removing tokens that leave a stage', () => {
  const old = [{ id: 'a', price: 1 }, { id: 'b', price: 2 }], changed = [{ id: 'b', price: 3 }, { id: 'a', price: 4 }, { id: 'c', price: 5 }];
  assert.deepEqual(retainBrowseOrder(changed, old.map(m => m.id)).map(m => [m.id, m.price]), [['a', 4], ['b', 3], ['c', 5]]);
  assert.deepEqual(retainBrowseOrder(changed.filter(m => m.id !== 'a'), ['a', 'b']).map(m => m.id), ['b', 'c']);
  assert.equal(retainBrowseOrder(changed, null), changed); assert.equal(reuseArray(old, [...old]), old);
});
test('150 markets across 200 head-only snapshots replace 30000 raw market references but zero reconciled references', () => {
  let previous = { ...base, markets: Array.from({ length: 150 }, (_, i) => ({ ...market, id: `market-${i}` })) };
  let rawReplaced = 0, reconciledReplaced = 0;
  for (let tick = 0; tick < 200; tick++) {
    const next = structuredClone(previous); next.at += 2000; next.chains[0].head++;
    rawReplaced += next.markets.filter((m, i) => m !== previous.markets[i]).length;
    const result = reconcileState(previous, next);
    reconciledReplaced += result.markets.filter((m, i) => m !== previous.markets[i]).length;
    previous = result;
  }
  assert.equal(rawReplaced, 30000); assert.equal(reconciledReplaced, 0);
});
test('cached locale formatters preserve exact amounts, prices, whole quantities and Beijing timestamps', () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity, -0, 0, -1234.999, 1234.999, 1e-18, 999999999999999]) {
    for (const signed of [true, false]) {
      const original = value == null || !Number.isFinite(value) ? '—' : `${signed && value > 0 ? '+' : value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      assert.equal(money(value, signed), original);
    }
    const original = value == null || !Number.isFinite(value) ? '—' : value === 0 ? '$0' : '$' + value.toLocaleString('en-US', { maximumSignificantDigits: 6 });
    assert.equal(price(value), original);
  }
  for (const value of [null, undefined, 0, 1791280000, 1791280000000, Date.parse('2026-10-06T20:15:00Z')]) for (const date of [true, false]) {
    const original = !value ? '—' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...(date ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(timestampMs(value));
    assert.equal(timeText(value, date), original);
  }
  assert.equal(rawQuantity('1234500000000000000000'), '1,234.5');
});
test('scanner display memo skips invisible changes while opening the latest routing and fees', () => {
  const onOpen = () => {};
  const latest = { ...market, nativeUsd: 700, scannerAt: at + 1000, updatedAt: at + 1000, block: 101, quoteAddress: 'changed quote', pool: 'new-pool', buyTaxPct: 12, metadata: { fees: { checked: false } } };
  assert.equal(sameScannerCardProps({ market, ageLabel: '1 小时前', onOpen }, { market: latest, ageLabel: '1 小时前', onOpen }), true);
  const result = reconcileState(base, { ...base, markets: [latest] });
  assert.deepEqual(result.markets[0], latest);
  assert.equal(resolveScannerMarket([latest], market), latest);
  assert.equal(resolveScannerMarket([], market), null);
  assert.equal(resolveScannerMarket([{ ...latest, chain: 'robinhood' }], market), null);
});
test('scanner display changes and callback/age updates always invalidate the memo boundary', () => {
  const onOpen = () => {}, previous = { market, ageLabel: '1 小时前', onOpen };
  for (const key of ['id', 'chain', 'address', 'symbol', 'name', 'platform', 'priceUsd', 'volumeUsd', 'liquidityUsd', 'quality', 'scannerStage', 'progressPct'] as const) {
    const old = market[key];
    const changed = { ...market, [key]: typeof old === 'number' ? old + 1 : `${old}-changed` } as Market;
    assert.equal(sameScannerCardProps(previous, { ...previous, market: changed }), false, key);
  }
  assert.equal(sameScannerCardProps(previous, { ...previous, ageLabel: '2 小时前' }), false);
  assert.equal(sameScannerCardProps(previous, { ...previous, onOpen: () => {} }), false);
  const legacy = { ...market, scannerStage: undefined };
  assert.equal(sameScannerCardProps({ ...previous, market: legacy }, { ...previous, market: { ...legacy, stage: 'dex' } }), false);
});
