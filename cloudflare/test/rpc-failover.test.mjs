import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudRpc } from '../rpc.mjs';
const HASH = '0x' + '11'.repeat(32),
  OTHER_HASH = '0x' + '22'.repeat(32);
const block = (hash = HASH) => ({ number: '0x64', timestamp: '0x3e8', hash, transactions: [] });
function repository() {
  const rows = new Map();
  return {
    get: (kind, id) => rows.get(kind + ':' + id),
    put: (kind, v) => {
      rows.set(kind + ':' + v.id, structuredClone(v));
      return v;
    },
  };
}
test('A primary 429 automatically uses the verified BSC price backup, respects its server cooldown and retains it across restart', async () => {
  const store = repository(),
    calls = [];
  let now = 1000000,
    limited = true;
  const opts = {
    store,
    now: () => now,
    receiptUrl: 'https://backup.example',
    backupUrl: 'https://backup.example',
    fetchImpl: async (url, options) => {
      const q = JSON.parse(options.body);
      calls.push([url, q.method]);
      if (url.includes('primary') && limited)
        return Response.json({}, { status: 429, headers: { 'Retry-After': '60' } });
      return Response.json({
        result:
          q.method === 'eth_chainId'
            ? '0x38'
            : q.method === 'eth_getBlockByNumber'
              ? block()
              : '0x1',
      });
    },
  };
  let rpc = new CloudRpc('https://primary.example', opts);
  assert.equal(rpc.backupRpc, rpc.receiptRpc);
  assert.equal((await rpc.block()).hash, HASH);
  assert.equal(rpc.status().activeSource, 'backup');
  assert.equal(rpc.status().limited, false);
  assert.equal(rpc.status().primary.limited, true);
  assert.equal(rpc.status().primary.retryAt, 1065000);
  await Promise.all([
    rpc.request('eth_gasPrice'),
    rpc.request('eth_call', [{ to: '0x' + '33'.repeat(20) }, '0x64']),
  ]);
  assert.equal(calls.filter((c) => c[0].includes('primary')).length, 1);
  rpc = new CloudRpc('https://primary.example', opts);
  await rpc.block();
  assert.equal(calls.filter((c) => c[0].includes('primary')).length, 1);
  assert.equal(rpc.statusFor('eth_getLogs').limited, true);
  now = 1065000;
  limited = false;
  await rpc.block();
  assert.equal(rpc.status().primary.limited, false);
  assert.equal(rpc.status().primary.lastFailure.status, 429);
  assert.equal(rpc.status().activeSource, 'primary');
});
test('Failover rejects a different chain or a different fixed quote block before making a contract call', async () => {
  for (const wrongChain of [true, false]) {
    let limited = false;
    const calls = [];
    const rpc = new CloudRpc('https://primary.example', {
      backupUrl: 'https://backup.example',
      fetchImpl: async (url, options) => {
        const q = JSON.parse(options.body);
        calls.push([url, q.method]);
        if (url.includes('primary') && limited) return Response.json({}, { status: 429 });
        return Response.json({
          result:
            q.method === 'eth_chainId'
              ? url.includes('backup') && wrongChain
                ? '0x1'
                : '0x38'
              : q.method === 'eth_getBlockByNumber'
                ? block(url.includes('backup') ? OTHER_HASH : HASH)
                : '0x1',
        });
      },
    });
    await rpc.block();
    limited = true;
    await assert.rejects(
      rpc.request('eth_call', [{ to: '0x' + '33'.repeat(20) }, '0x64']),
      wrongChain ? /BSC 主网/ : /区块不一致/,
    );
    assert.equal(calls.filter(([u, m]) => u.includes('backup') && m === 'eth_call').length, 0);
  }
});
test('Concurrent fixed-block reads coalesce backup block verification and keep both endpoint queues serial', async () => {
  let limited = false,
    active = 0,
    peak = 0,
    anchorReads = 0;
  const rpc = new CloudRpc('https://primary.example', {
    backupUrl: 'https://backup.example',
    fetchImpl: async (url, options) => {
      const q = JSON.parse(options.body);
      if (url.includes('primary') && limited) return Response.json({}, { status: 429 });
      if (url.includes('backup')) {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        if (q.method === 'eth_getBlockByNumber') anchorReads++;
      }
      return Response.json({
        result:
          q.method === 'eth_chainId'
            ? '0x38'
            : q.method === 'eth_getBlockByNumber'
              ? block()
              : '0x1',
      });
    },
  });
  await rpc.block();
  limited = true;
  await Promise.all(
    ['eth_call', 'eth_getCode', 'eth_call'].map((m, i) =>
      rpc.request(m, [{ to: '0x' + String(i + 1).padStart(40, '0') }, '0x64']),
    ),
  );
  assert.equal(peak, 1);
  assert.equal(anchorReads, 1);
});
test('An exhausted invocation, unsupported event query, or financial method cannot spend requests on a price backup', async () => {
  const calls = [];
  let local = true;
  const rpc = new CloudRpc('https://primary.example', {
    backupUrl: 'https://backup.example',
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (local) throw Object.assign(Error('subrequest limit'), { code: 'CF_SUBREQUEST_BUDGET' });
      return Response.json({}, { status: 429 });
    },
  });
  await assert.rejects(rpc.request('eth_gasPrice'), /单轮请求上限/);
  assert.equal(rpc.status().primary.limited, false);
  assert.equal(calls.length, 1);
  local = false;
  await assert.rejects(rpc.request('eth_getLogs', [{}]), /429/);
  assert.equal(calls.length, 2);
  await assert.rejects(rpc.request('eth_sendRawTransaction', ['signed bytes']), /read-only/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((u) => u.includes('primary')));
});
test('Both endpoint bans persist and report the first allowed recovery time without sending repeat requests', async () => {
  const store = repository();
  let calls = 0;
  const opts = {
    store,
    now: () => 1000000,
    backupUrl: 'https://backup.example',
    fetchImpl: async (url) => {
      calls++;
      return Response.json(
        {},
        { status: 429, headers: { 'Retry-After': url.includes('backup') ? '120' : '60' } },
      );
    },
  };
  let rpc = new CloudRpc('https://primary.example', opts);
  await assert.rejects(rpc.block(), /429/);
  assert.equal(calls, 2);
  assert.equal(rpc.status().limited, true);
  assert.equal(rpc.status().retryAt, 1065000);
  rpc = new CloudRpc('https://primary.example', opts);
  await assert.rejects(rpc.block(), /冷却/);
  assert.equal(calls, 2);
  assert.equal(rpc.status().backup.retryAt, 1125000);
});
