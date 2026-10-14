import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CloudStore } from '../store.mjs';
import { EntityReads } from '../entity-reads.mjs';
import { TokenRiskGuard } from '../../bi-trade/lib/token-risk-core.mjs';
import { OwnerAuth, COOKIE } from '../../bi-trade/lib/auth.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let clock = 1791856000000,
    reads = 0,
    rejectReads = false;
  const sql = {
    exec(query, ...args) {
      if (!args.length && query.split(';').filter((x) => x.trim()).length > 1) {
        db.exec(query);
        return { toArray: () => [], rowsWritten: 0 };
      }
      const s = db.prepare(query);
      if (/^(CREATE|DELETE|INSERT|UPDATE)/i.test(query.trim())) {
        const r = s.run(...args);
        return { toArray: () => [], rowsWritten: r.changes };
      }
      reads++;
      if (rejectReads) throw Error('storage unavailable');
      const rows = s.all(...args);
      return { toArray: () => rows, rowsWritten: 0 };
    },
  };
  const store = new CloudStore(
    {
      sql,
      transactionSync(fn) {
        db.exec('BEGIN');
        try {
          const result = fn();
          db.exec('COMMIT');
          return result;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    { now: () => clock },
  );
  return {
    store,
    now: () => clock,
    advance: (ms) => (clock += ms),
    reads: () => reads,
    fail: (value) => (rejectReads = value),
  };
}

test('Cached repository results are independent objects and scoped by kind, Agent and owner', (t) => {
  const f = fixture(t),
    s = f.store;
  s.put('agents', { id: 'one', agentId: 'one', ownerId: 'alice', public: true, details: { n: 1 } });
  s.put('agents', { id: 'two', agentId: 'two', ownerId: 'bob', public: false });
  s.put('other', { id: 'one', agentId: 'two', ownerId: 'bob', details: { n: 9 } });
  const original = s.get('agents', 'one'),
    all = s.all('agents'),
    owned = s.byOwner('agents', 'alice'),
    held = s.forAgent('agents', 'one');
  const reads = f.reads();
  original.details.n = 10;
  all.reverse();
  owned[0].ownerId = 'bob';
  held.pop();
  assert.equal(s.get('agents', 'one').details.n, 1);
  assert.equal(s.all('agents')[0].id, 'one');
  assert.equal(s.byOwner('agents', 'alice')[0].ownerId, 'alice');
  assert.equal(s.forAgent('agents', 'one').length, 1);
  assert.equal(f.reads(), reads);
  assert.equal(s.get('other', 'one').details.n, 9);
  assert.deepEqual(
    s.byOwner('agents', 'bob').map((a) => a.id),
    ['two'],
  );
  assert.deepEqual(
    s.forAgent('agents', 'two').map((a) => a.id),
    ['two'],
  );
});

test('Direct SQL writes and failed writes invalidate positive and negative entity reads immediately', (t) => {
  const f = fixture(t),
    s = f.store;
  assert.equal(s.get('agents', 'one'), null);
  assert.deepEqual(s.all('agents'), []);
  s.db
    .prepare('INSERT INTO entities VALUES(?,?,?)')
    .run('agents', 'one', JSON.stringify({ id: 'one', ownerId: 'alice', public: true }));
  assert.equal(s.get('agents', 'one').public, true);
  assert.equal(s.byOwner('agents', 'alice').length, 1);
  s.db
    .prepare('UPDATE entities SET payload=? WHERE kind=? AND id=?')
    .run(JSON.stringify({ id: 'one', ownerId: 'bob', public: false }), 'agents', 'one');
  assert.equal(s.get('agents', 'one').public, false);
  assert.deepEqual(s.byOwner('agents', 'alice'), []);
  assert.equal(s.byOwner('agents', 'bob').length, 1);
  const before = f.reads();
  assert.throws(() =>
    s.db.prepare('INSERT INTO entities VALUES(?,?,?)').run('agents', 'one', '{}'),
  );
  assert.equal(s.get('agents', 'one').ownerId, 'bob');
  assert.ok(f.reads() > before);
  s.db.exec("DELETE FROM entities WHERE kind='agents'");
  assert.equal(s.get('agents', 'one'), null);
  assert.deepEqual(s.all('agents'), []);
});

test('A rollback cannot leave cached uncommitted balances, ownership, lots or newly inserted records', (t) => {
  const { store: s } = fixture(t),
    old = { id: 'one', agentId: 'one', ownerId: 'alice', balance: '1000' };
  s.put('accounts', old);
  assert.throws(
    () =>
      s.transaction(() => {
        s.transaction(() => s.put('accounts', { ...old, ownerId: 'bob', balance: '0' }));
        s.put('accounts', { id: 'new', agentId: 'one', ownerId: 'bob' });
        assert.equal(s.get('accounts', 'one').balance, '0');
        assert.equal(s.byOwner('accounts', 'bob').length, 2);
        assert.equal(s.forAgent('accounts', 'one').length, 2);
        assert.equal(s.all('accounts').length, 2);
        throw Error('abort');
      }),
    /abort/,
  );
  assert.deepEqual(s.get('accounts', 'one'), old);
  assert.equal(s.get('accounts', 'new'), null);
  assert.deepEqual(s.byOwner('accounts', 'bob'), []);
  assert.deepEqual(s.forAgent('accounts', 'one'), [old]);
  assert.deepEqual(s.all('accounts'), [old]);
});

test('Entity reuse preserves evidence age, expires within one second and never falls back after a failed read', (t) => {
  const f = fixture(t),
    s = f.store,
    token = '0x' + '12'.repeat(20),
    at = f.now() - 119800;
  s.put('token-risk-reports', {
    id: token,
    token,
    fetchedAt: at,
    buyAllowed: true,
    state: 'screened-limited',
    reasons: [],
  });
  const guard = new TokenRiskGuard(s, { source: {}, now: f.now });
  assert.equal(guard.snapshot(token).buyAllowed, true);
  const reads = f.reads();
  f.advance(300);
  assert.equal(guard.snapshot(token).buyAllowed, false);
  assert.equal(guard.snapshot(token).fetchedAt, at);
  assert.equal(f.reads(), reads);
  f.advance(700);
  f.fail(true);
  assert.throws(() => s.get('token-risk-reports', token), /unavailable/);
  f.fail(false);
  assert.equal(s.get('token-risk-reports', token).fetchedAt, at);
  assert.ok(f.reads() >= reads + 2);
});

test('Session credentials are never memoized, including expiry and immediate revocation', (t) => {
  const { store: s } = fixture(t),
    auth = new OwnerAuth(s, 'https://bitrade.site'),
    issued = auth.guest(),
    req = { headers: { cookie: COOKIE + '=' + issued.token } };
  assert.ok(auth.session(req));
  s.all('owners');
  s.db.prepare("UPDATE credentials SET expires=? WHERE kind='owner'").run(Date.now() - 1);
  assert.equal(auth.session(req), null);
  const replacement = auth.guest(),
    next = { headers: { cookie: COOKIE + '=' + replacement.token } };
  assert.ok(auth.session(next));
  s.get('owners', replacement.owner.id);
  s.db.prepare("DELETE FROM credentials WHERE kind='owner'").run();
  assert.equal(auth.session(next), null);
});

test('Entity memoization is bounded, bypasses oversized results and rereads after backwards time', () => {
  let at = 1000,
    loads = 0;
  const memo = new EntityReads({ now: () => at, maxEntries: 2, maxCharacters: 100 });
  const read = (key) => memo.read(key, () => ({ value: ++loads }));
  assert.deepEqual(read('a'), read('a'));
  read('b');
  read('c');
  assert.equal(memo.entries.size, 2);
  assert.ok(memo.characters <= 100);
  read('a');
  assert.equal(loads, 4);
  at = 0;
  read('a');
  assert.equal(loads, 5);
  const large = () =>
    memo.read('large', () => {
      loads++;
      return 'x'.repeat(101);
    });
  large();
  large();
  assert.equal(loads, 7);
  assert.ok(!memo.entries.has('large'));
  assert.throws(
    () =>
      memo.read('failed', () => {
        throw Error('unavailable');
      }),
    /unavailable/,
  );
  assert.equal(memo.entries.has('failed'), false);
  memo.clear();
  assert.equal(memo.characters, 0);
  assert.equal(memo.entries.size, 0);
});

test('Ledger reuse survives time and unrelated market writes, but every ledger update is immediately visible', (t) => {
  const f = fixture(t), s = f.store;
  s.put('paper-fills', { id: 'fill', agentId: 'alice-agent', ownerId: 'alice', netUsd: -2 });
  assert.equal(s.forAgent('paper-fills', 'alice-agent')[0].netUsd, -2);
  const before = f.reads();
  for (let i = 0; i < 20; i++) {
    f.advance(10000);
    s.put('cloud-markets', { id: 'token', updatedAt: f.now(), priceUsd: i + 1 });
    const afterMarket = f.reads();
    assert.equal(s.forAgent('paper-fills', 'alice-agent')[0].netUsd, -2);
    assert.equal(f.reads(), afterMarket);
  }
  assert.ok(f.reads() > before);
  s.put('paper-fills', { id: 'fill', agentId: 'bob-agent', ownerId: 'bob', netUsd: -3 });
  assert.deepEqual(s.forAgent('paper-fills', 'alice-agent'), []);
  assert.equal(s.forAgent('paper-fills', 'bob-agent')[0].netUsd, -3);
  assert.equal(s.byOwner('paper-fills', 'bob')[0].netUsd, -3);
  s.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run('paper-fills', 'fill');
  assert.deepEqual(s.forAgent('paper-fills', 'bob-agent'), []);
});

test('Unrelated market writes cannot refresh expired risk evidence or suppress source failures', (t) => {
  const f = fixture(t), s = f.store;
  const token = '0x' + '45'.repeat(20);
  s.put('token-risk-reports', { id: token, token, fetchedAt: f.now(), buyAllowed: true });
  const initial = s.get('token-risk-reports', token);
  s.put('paper-accounts', { id: 'account', nativeRaw: '1000' });
  const before = f.reads();
  assert.deepEqual(s.get('token-risk-reports', token), initial);
  assert.equal(f.reads(), before);
  f.advance(1000);
  f.fail(true);
  assert.throws(() => s.get('token-risk-reports', token), /unavailable/);
  f.fail(false);
  assert.equal(s.get('token-risk-reports', token).fetchedAt, initial.fetchedAt);
});

test('Successful no-op pruning and committed unrelated transactions preserve ledger reuse', (t) => {
  const f = fixture(t), s = f.store;
  s.put('paper-accounts', { id: 'one', nativeRaw: '1000' });
  s.get('paper-accounts', 'one');
  f.advance(10000);
  s.db.prepare('DELETE FROM entities WHERE kind=?').run('missing-kind');
  let before = f.reads();
  assert.equal(s.get('paper-accounts', 'one').nativeRaw, '1000');
  assert.equal(f.reads(), before);
  s.transaction(() => s.put('cloud-markets', { id: 'token', priceUsd: 1 }));
  before = f.reads();
  assert.equal(s.get('paper-accounts', 'one').nativeRaw, '1000');
  assert.equal(f.reads(), before);
});
