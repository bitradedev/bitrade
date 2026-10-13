import {
  PlatformRepository,
  digest,
  fail,
  canonicalJson,
  json,
} from '../bi-trade/lib/database-core.mjs';
import { StorageWriteBudget } from './write-budget.mjs';
import { EntityReads } from './entity-reads.mjs';

// Consume every cursor synchronously. No cursor survives an event or await.
export function sqlDatabase(sql, onWrite = () => {}, onMutation = () => {}) {
  const consume = (cursor) => {
    const result = cursor.toArray();
    if (cursor.rowsWritten > 0) onMutation();
    onWrite(cursor.rowsWritten);
    return result;
  };
  return {
    exec: (query) => {
      onMutation();
      return consume(sql.exec(query));
    },
    prepare(query) {
      return {
        get: (...args) => consume(sql.exec(query, ...args))[0],
        all: (...args) => consume(sql.exec(query, ...args)),
        run: (...args) => {
          onMutation();
          const cursor = sql.exec(query, ...args);
          consume(cursor);
          return { changes: cursor.rowsWritten };
        },
      };
    },
  };
}
export class CloudStore extends PlatformRepository {
  constructor(storage, { readOnlyUntil = 0, now = Date.now } = {}) {
    const meter = { current: null, reads: null },
      db = sqlDatabase(
        storage.sql,
        (rows) => meter.current?.record(rows),
        () => meter.reads?.clear(),
      ),
      tables = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name),
      );
    const complete = [
      'entities',
      'credentials',
      'challenges',
      'intents',
      'audit',
      'rate_limits',
    ].every((t) => tables.has(t));
    super(db, (fn) => storage.transactionSync(fn), { initializeSchema: !complete });
    this.readOnlyUntil = readOnlyUntil;
    this.now = now;
    this.quotaPauseUntil = 0;
    this.checkpointAt = 0;
    this.budget = new StorageWriteBudget(this.get('cloud-settings', 'storage-write-budget'), {
      now,
    });
    meter.current = this.budget;
    this.entityReads = new EntityReads({ now: () => this.now() });
    meter.reads = this.entityReads;
    this.memoryLimits = new Map();
    if (!complete)
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS rate_limits(id TEXT PRIMARY KEY,at INTEGER NOT NULL,n INTEGER NOT NULL);',
      );
  }
  get readOnly() {
    return this.now() < this.protectionUntil;
  }
  entityRead(method, args, load) {
    if (!this.entityReads || args.some((v) => typeof v !== 'string')) return load();
    return this.entityReads.read(JSON.stringify([method, ...args]), load);
  }
  get(kind, id) {
    return this.entityRead('get', [kind, id], () => super.get(kind, id));
  }
  all(kind) {
    return this.entityRead('all', [kind], () => super.all(kind));
  }
  forAgent(kind, id) {
    return this.entityRead('agent', [kind, id], () => super.forAgent(kind, id));
  }
  byOwner(kind, id) {
    return this.entityRead('owner', [kind, id], () => super.byOwner(kind, id));
  }
  transaction(fn) {
    try {
      return super.transaction(fn);
    } finally {
      // A rolled-back transaction may have populated reads of uncommitted data.
      this.entityReads?.clear();
    }
  }
  get protectionUntil() {
    return Math.max(this.readOnlyUntil, this.quotaPauseUntil);
  }
  prepareWriteBudget() {
    if (this.budget.roll()) this.quotaPauseUntil = 0;
    if (this.now() < this.readOnlyUntil || this.now() < this.quotaPauseUntil) return;
    const usage = this.budget.snapshot();
    if (usage.retryAt || this.now() - this.checkpointAt >= 60000) {
      // Reserve more than the checkpoint's table and index writes. On eviction,
      // the next instance starts from this conservative count, not from zero.
      const checkpoint = { ...usage, id: 'storage-write-budget', rows: usage.rows + 8 };
      this.budget.record(8);
      super.put('cloud-settings', checkpoint);
      this.checkpointAt = this.now();
    }
    this.quotaPauseUntil = this.budget.snapshot().retryAt ?? 0;
  }
  rateLimit(req, kind, max, ms, scope = 'ip:' + req.socket.remoteAddress) {
    const now = Date.now(),
      id = digest(kind + ':' + scope);
    if (this.readOnly || ['GET', 'HEAD'].includes(req.method)) {
      const old = this.memoryLimits.get(id),
        v = !old || now - old.at >= ms ? { at: now, n: 1 } : { at: old.at, n: old.n + 1 };
      this.memoryLimits.set(id, v);
      if (this.memoryLimits.size > 10000)
        this.memoryLimits.delete(this.memoryLimits.keys().next().value);
      if (v.n > max) throw fail('请求过于频繁，请稍后重试', 429);
      return;
    }
    const count = this.transaction(() => {
      const old = this.db.prepare('SELECT at,n FROM rate_limits WHERE id=?').get(id),
        value = !old || now - old.at >= ms ? { at: now, n: 1 } : { at: old.at, n: old.n + 1 };
      this.db
        .prepare(
          'INSERT INTO rate_limits VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,n=excluded.n',
        )
        .run(id, value.at, value.n);
      return value.n;
    });
    if (count > max) throw fail('请求过于频繁，请稍后重试', 429);
  }
  put(kind, value) {
    const identical = this.get(kind, value.id);
    if (identical && canonicalJson(identical) === canonicalJson(JSON.parse(json(value))))
      return identical;
    if (this.readOnly) throw fail('服务暂处于只读保护，写入额度恢复后自动继续', 503);
    if (kind === 'showcase-status') {
      const old = this.get(kind, value.id);
      if (
        old &&
        Date.now() - (old.checkedAt ?? 0) < 30000 &&
        JSON.stringify({ ...old, checkedAt: null }) ===
          JSON.stringify({ ...value, checkedAt: null })
      )
        return old;
    }
    return super.put(kind, value);
  }
  prune() {
    if (this.readOnly) return;
    const now = Date.now();
    this.db
      .prepare(
        "DELETE FROM entities WHERE kind IN ('cloud-gmgn-cache','cloud-public-cache') AND CAST(json_extract(payload,'$.at') AS INTEGER)<?",
      )
      .run(now - 300000);
    this.db
      .prepare(
        "DELETE FROM entities WHERE kind='cloud-meme-turnover' AND CAST(json_extract(payload,'$.at') AS INTEGER)<?",
      )
      .run(now - 2 * 86400000);
    this.db.prepare('DELETE FROM rate_limits WHERE at<?').run(now - 3600000);
    this.db.prepare('DELETE FROM challenges WHERE expires<?').run(now - 86400000);
    this.db.prepare('DELETE FROM credentials WHERE expires<?').run(now);
  }
  close() {}
}
