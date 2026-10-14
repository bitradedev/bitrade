import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStorage } from '../sqlite-storage.mjs';
import { SelfHostedStore } from '../store.mjs';
import { localDurableContext } from '../context.mjs';
import { startShowcaseDecision } from '../../cloudflare/decision-round.mjs';

test('self-hosted context completes a background AI decision and clears its in-flight marker', async () => {
  const context = localDurableContext({});
  let armed = 0;
  const host = {
    ctx: context,
    io: { trackDecision: (task) => task },
    decisionTask: null,
    arm: async () => {
      armed++;
    },
  };
  const app = { showcase: { tick: () => Promise.resolve({ action: 'hold' }) } };
  assert.equal(startShowcaseDecision(host, app), true);
  assert.ok(host.decisionTask);
  await Promise.all([...context.pendingTasks]);
  assert.equal(host.decisionTask, null);
  assert.equal(context.pendingTasks.size, 0);
  assert.equal(armed, 1);
});

test('online SQLite backup includes committed paper records and passes integrity verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bitrade-vps-backup-'));
  let storage;
  let saved;
  try {
    const path = join(dir, 'ledger.sqlite');
    storage = new SqliteStorage(path);
    new SelfHostedStore(storage).put('paper-fills', { id: 'preserved-fill', netUsd: -2 });
    const result = spawnSync(process.execPath, [resolve('vps/backup.mjs')], {
      env: { ...process.env, BI_TRADE_DB_PATH: path },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const files = readdirSync(join(dir, 'backups')).filter((name) => name.endsWith('.sqlite'));
    assert.equal(files.length, 1);
    assert.equal(
      readdirSync(join(dir, 'backups')).filter((name) => name.includes('.pending')).length,
      0,
    );
    saved = new DatabaseSync(join(dir, 'backups', files[0]), { readOnly: true });
    assert.equal(saved.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(
      saved.prepare("SELECT count(*) AS n FROM entities WHERE kind='paper-fills'").get().n,
      1,
    );
  } finally {
    saved?.close();
    storage?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('self-hosted store persists a fresh paper ledger without Cloudflare quota protection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bitrade-vps-store-'));
  try {
    const path = join(dir, 'paper.sqlite');
    const first = new SqliteStorage(path);
    const store = new SelfHostedStore(first);
    assert.equal(store.all('agents').length, 0);
    store.transaction(() => store.put('paper-fills', { id: 'sample', netUsd: -2 }));
    store.budget.rows = 90000;
    store.prepareWriteBudget();
    assert.equal(store.readOnly, false);
    assert.equal(store.budget.limit, Number.MAX_SAFE_INTEGER);
    first.close();
    const second = new SqliteStorage(path);
    assert.deepEqual(new SelfHostedStore(second).get('paper-fills', 'sample'), {
      id: 'sample',
      netUsd: -2,
    });
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh self-hosted database creates every account and housekeeping table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bitrade-vps-schema-'));
  let storage;
  try {
    storage = new SqliteStorage(join(dir, 'paper.sqlite'));
    const store = new SelfHostedStore(storage);
    const tables = new Set(
      storage.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map(({ name }) => name),
    );
    for (const name of ['entities', 'credentials', 'challenges', 'intents', 'audit', 'rate_limits'])
      assert.ok(tables.has(name), `missing ${name}`);
    const indexes = new Set(
      storage.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all()
        .map(({ name }) => name),
    );
    assert.ok(indexes.has('entities_by_agent'));
    assert.ok(indexes.has('entities_by_owner'));
    assert.doesNotThrow(() => store.prune());
  } finally {
    storage?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incomplete self-hosted schema is repaired without changing existing paper records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bitrade-vps-schema-repair-'));
  let storage;
  try {
    storage = new SqliteStorage(join(dir, 'paper.sqlite'));
    storage.db.exec(
      'CREATE TABLE entities(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));' +
        'CREATE TABLE rate_limits(id TEXT PRIMARY KEY,at INTEGER NOT NULL,n INTEGER NOT NULL);',
    );
    storage.db
      .prepare('INSERT INTO entities VALUES(?,?,?)')
      .run('paper-fills', 'preserved', JSON.stringify({ id: 'preserved', netUsd: -2 }));
    const store = new SelfHostedStore(storage);
    assert.deepEqual(store.get('paper-fills', 'preserved'), { id: 'preserved', netUsd: -2 });
    assert.doesNotThrow(() => store.prune());
    assert.equal(
      storage.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='credentials'").get()
        .n,
      1,
    );
  } finally {
    storage?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopback server serves the site and keeps the new paper accounts across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bitrade-vps-http-'));
  const portPicker = createServer();
  portPicker.listen(0, '127.0.0.1');
  await once(portPicker, 'listening');
  const port = portPicker.address().port;
  await new Promise((done) => portPicker.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    SITE_ORIGIN: origin,
    BI_TRADE_PORT: String(port),
    BI_TRADE_LISTEN_HOST: '127.0.0.1',
    BI_TRADE_DB_PATH: join(dir, 'paper.sqlite'),
    BI_TRADE_ASSET_DIR: resolve('bi-trade/web'),
    BI_TRADE_VAULT_KEY: Buffer.alloc(32, 5).toString('base64'),
    BI_TRADE_SHOWCASE_PAUSED: 'true',
    BI_TRADE_RUN_SCHEDULER: 'false',
    BI_TRADE_MEME_ONLY: 'true',
    BI_TRADE_PUBLIC_MARKET: 'true',
    BSC_RPC_URL: 'https://rpc.example.invalid',
  };
  async function start(extraEnv = {}) {
    const child = spawn(process.execPath, ['vps/server.mjs'], {
      cwd: resolve('.'),
      env: { ...env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', (chunk) => (logs += chunk));
    child.stderr.on('data', (chunk) => (logs += chunk));
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw Error(`Server exited early: ${logs}`);
      try {
        const response = await fetch(origin + '/intro');
        if (response.status === 200) return child;
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    throw Error(`Server did not start: ${logs}`);
  }
  async function stop(child) {
    child.kill();
    const [code, signal] = await once(child, 'exit');
    // Windows terminates spawned processes directly; POSIX runs our SIGTERM handler.
    assert.ok(code === 0 || (process.platform === 'win32' && signal === 'SIGTERM'));
  }
  let child;
  try {
    child = await start();
    const intro = await fetch(origin + '/');
    assert.equal(intro.status, 200);
    assert.match(await intro.text(), /BI Trade/i);
    const runtime = await fetch(origin + '/api/runtime');
    assert.equal(runtime.status, 200);
    const status = await runtime.json();
    assert.equal(status.platform, 'self-hosted');
    assert.equal(status.liveEnabled, false);
    assert.equal(status.storageProtection.writeBudget, null);
    const publicResponse = await fetch(origin + '/api/public');
    assert.equal(publicResponse.status, 200);
    const publicData = await publicResponse.json();
    assert.equal(publicData.agents.length, 3);
    assert.equal(publicData.activity.length, 0);
    await stop(child);
    child = await start();
    const reopened = await (await fetch(origin + '/api/public')).json();
    assert.deepEqual(
      reopened.agents.map((agent) => agent.id),
      publicData.agents.map((agent) => agent.id),
    );
    const storage = new SqliteStorage(env.BI_TRADE_DB_PATH);
    const store = new SelfHostedStore(storage);
    assert.equal(store.all('paper-fills').length, 0);
    assert.equal(store.all('agents').length, 3);
    storage.close();
    await stop(child);
    child = await start({ BI_TRADE_RUN_SCHEDULER: 'true' });
    await stop(child);
    child = null;
  } finally {
    if (child && child.exitCode === null && !child.signalCode) await stop(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
