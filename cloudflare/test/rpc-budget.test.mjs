import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudRpc } from '../rpc.mjs';
import { parseAbi, encodeFunctionResult } from 'viem';

test('Two self-hosted RPC requests may overlap, but an in-flight success cannot erase a concurrent 429 cooldown', async()=>{
  let releaseSuccess,begin,active=0,peak=0,calls=0;
  const ready=new Promise(r=>begin=r),success=new Promise(r=>releaseSuccess=r);
  const rpc=new CloudRpc('https://bounded.example',{concurrency:2,now:()=>1000000,fetchImpl:async()=>{
    const n=++calls;active++;peak=Math.max(peak,active);
    if(n===2){begin();await success;active--;return Response.json({result:'0x38'});}
    await ready;active--;return Response.json({}, {status:429,headers:{'Retry-After':'60'}});
  }});
  const pending=Promise.allSettled(Array.from({length:5},()=>rpc.request('eth_chainId')));
  await ready;while(!rpc.status().limited)await Promise.resolve();releaseSuccess();
  const result=await pending;assert.equal(peak,2);assert.equal(calls,2);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(rpc.status().limited,true);assert.equal(rpc.status().retryAt,1065000);
  await assert.rejects(rpc.request('eth_getLogs',[{}]),/冷却/);assert.equal(calls,2);
});

test('Exact-block contract cache shares immutable reads without crossing recipients, blocks, forks or latest calls', async () => {
  const abi = parseAbi(['function value() view returns (uint256)']),
    token = '0x' + '11'.repeat(20),
    a = '0x' + '22'.repeat(20),
    b = '0x' + '33'.repeat(20);
  let calls = 0;
  const rpc = new CloudRpc('https://rpc.example', {
    fetchImpl: async () => {
      calls++;
      return Response.json({
        result: encodeFunctionResult({ abi, functionName: 'value', result: BigInt(calls) }),
      });
    },
  });
  rpc.cache.set(100, { hash: 'canonical-a' });
  assert.equal(await rpc.read(token, abi, 'value', [], 100, a), 1n);
  assert.equal(await rpc.read(token, abi, 'value', [], 100, a), 1n);
  assert.equal(calls, 1);
  assert.equal(await rpc.read(token, abi, 'value', [], 100, b), 2n);
  rpc.cache.set(100, { hash: 'canonical-b' });
  assert.equal(await rpc.read(token, abi, 'value', [], 100, a), 3n);
  await rpc.read(token, abi, 'value', [], undefined, a);
  await rpc.read(token, abi, 'value', [], undefined, a);
  assert.equal(calls, 5);
  await rpc.read(token, abi, 'value', [], 101, a);
  await rpc.read(token, abi, 'value', [], 101, a);
  assert.equal(calls, 7);
});

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
