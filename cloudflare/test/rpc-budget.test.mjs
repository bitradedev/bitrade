import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudRpc } from '../rpc.mjs';

function store() {
  const rows = new Map();
  return {
    rows,
    get: (kind, id) => rows.get(kind + ':' + id),
    put: (kind, row) => (rows.set(kind + ':' + row.id, structuredClone(row)), row),
  };
}

test('RPC 429 stops already queued requests and persists the received Retry-After until recovery', async () => {
  const db = store();
  db.put('paper-ledger', { id: 'keep-loss', deltaRaw: '-42' });
  let now = 1000000,
    calls = 0,
    limited = true;
  const opts = {
    store: db,
    now: () => now,
    fetchImpl: async () => {
      calls++;
      if (limited) {
        now += 8000;
        return Response.json({}, { status: 429, headers: { 'Retry-After': '39' } });
      }
      return Response.json({ result: '0x38' });
    },
  };
  let rpc = new CloudRpc('https://rpc.example/?credential=hidden-example', opts);
  const results = await Promise.allSettled([
    rpc.request('eth_chainId'),
    rpc.request('eth_gasPrice'),
    rpc.request('eth_blockNumber'),
  ]);
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(calls, 1, 'A rate-limited response must stop the remaining network queue');
  assert.equal(rpc.status().retryAt, now + 44000);
  const failure = rpc.status().lastFailure;
  assert.deepEqual(failure, { at: now, status: 429, serverRetryAt: now + 39000 });
  assert.doesNotMatch(JSON.stringify([...db.rows]), /hidden-example|https:\/\//);
  rpc = new CloudRpc('https://rpc.example/?credential=hidden-example', opts);
  await assert.rejects(rpc.request('eth_chainId'), /冷却/);
  assert.equal(calls, 1);
  now = rpc.status().retryAt;
  limited = false;
  assert.equal(await rpc.request('eth_chainId'), '0x38');
  assert.equal(rpc.status().limited, false);
  assert.equal(rpc.status().retryAt, 0);
  assert.deepEqual(rpc.status().lastFailure, failure);
  assert.equal(rpc.status().lastSuccessAt, now);
  assert.deepEqual(db.get('paper-ledger', 'keep-loss'), { id: 'keep-loss', deltaRaw: '-42' });
});

test('RPC cooldown uses bounded fallback delays, honors long HTTP dates and does not classify local I/O exhaustion as a provider ban', async () => {
  for (const header of [null, 'invalid', '0']) {
    const now = 1000000,
      rpc = new CloudRpc('https://rpc.example', {
        now: () => now,
        fetchImpl: async () =>
          Response.json(
            {},
            { status: 429, headers: header === null ? {} : { 'Retry-After': header } },
          ),
      });
    await assert.rejects(rpc.request('eth_chainId'), /429/);
    assert.equal(rpc.status().retryAt, now + 15000);
  }
  const now = 1000000,
    deadline = Date.UTC(2039, 0, 1);
  const rpc = new CloudRpc('https://rpc.example', {
    now: () => now,
    fetchImpl: async () =>
      Response.json(
        {},
        { status: 429, headers: { 'Retry-After': new Date(deadline).toUTCString() } },
      ),
  });
  await assert.rejects(rpc.request('eth_chainId'), /429/);
  assert.equal(rpc.status().retryAt, deadline + 5000);
  const local = new CloudRpc('https://rpc.example', {
    fetchImpl: async () => {
      throw Object.assign(Error('subrequest limit'), { code: 'CF_SUBREQUEST_BUDGET' });
    },
  });
  await assert.rejects(local.request('eth_chainId'), /单轮请求上限/);
  assert.equal(local.status().limited, false);
  assert.equal(local.status().lastFailure, null);
  await assert.rejects(local.request('eth_sendRawTransaction'), /read-only/);
});

test('Receipt batches share the receipt endpoint cooldown and do not block the independent price endpoint', async () => {
  const db = store(),
    now = 1000000,
    hashes = ['0x' + '12'.repeat(32), '0x' + '34'.repeat(32)];
  let receiptCalls = 0,
    priceCalls = 0;
  const options = {
    store: db,
    now: () => now,
    receiptUrl: 'https://receipts.example',
    fetchImpl: async (url) => {
      if (url.includes('receipts')) {
        receiptCalls++;
        return Response.json({}, { status: 429, headers: { 'Retry-After': '600' } });
      }
      priceCalls++;
      return Response.json({ result: '0x38' });
    },
  };
  const rpc = new CloudRpc('https://price.example', options);
  const results = await Promise.allSettled([
    rpc.receipts(hashes),
    rpc.receipts(hashes),
    rpc.receiptRpc.request('eth_chainId'),
  ]);
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(receiptCalls, 1);
  assert.equal(rpc.receiptRpc.status().retryAt, now + 605000);
  assert.equal(await rpc.request('eth_chainId'), '0x38');
  assert.equal(priceCalls, 1);
  const restarted = new CloudRpc('https://price.example', options);
  await assert.rejects(restarted.receipts(hashes), /冷却/);
  assert.equal(receiptCalls, 1);
  assert.equal(restarted.status().limited, false);
});
