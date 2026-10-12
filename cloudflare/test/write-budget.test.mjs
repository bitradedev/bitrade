import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageWriteBudget } from '../write-budget.mjs';

test('Write budget restores only the current UTC day and rolls over without changing a ledger', () => {
  let now = Date.parse('2026-10-12T23:59:00Z');
  const budget = new StorageWriteBudget({ day: '2026-10-12', rows: 79999 }, { now: () => now });
  budget.record(1);
  assert.equal(budget.snapshot().retryAt, Date.parse('2026-10-13T00:00:00Z'));
  now += 61000;
  assert.equal(budget.snapshot().rows, 0);
  assert.equal(budget.snapshot().retryAt, null);
  assert.equal(new StorageWriteBudget({ day: '2026-10-11', rows: 90000 }, { now: () => now }).rows, 0);
});

test('Write budget counts failed transaction attempts conservatively and ignores invalid counters', () => {
  const budget = new StorageWriteBudget();
  for (const n of [NaN, Infinity, -1, 0, undefined, 2.5]) budget.record(n);
  assert.equal(budget.rows, 0);
  budget.record(30);
  budget.record(3);
  assert.equal(budget.snapshot().rows, 33);
  assert.equal(budget.snapshot().scope, 'platform-object-estimate');
});
