import {
  PlatformRepository,
  digest,
  fail,
  canonicalJson,
  json,
} from '../bi-trade/lib/database-core.mjs';

// Consume every cursor synchronously. No cursor survives an event or await.
export function sqlDatabase(sql) {
  return {
    exec: (query) => sql.exec(query).toArray(),
    prepare(query) {
      return {
        get: (...args) => sql.exec(query, ...args).toArray()[0],
        all: (...args) => sql.exec(query, ...args).toArray(),
        run: (...args) => {
          const cursor = sql.exec(query, ...args);
          cursor.toArray();
          return { changes: cursor.rowsWritten };
        },
      };
    },
  };
}
export class CloudStore extends PlatformRepository {
  constructor(storage, { readOnlyUntil = 0 } = {}) {
    const db = sqlDatabase(storage.sql),
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
    this.memoryLimits = new Map();
    if (!complete)
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS rate_limits(id TEXT PRIMARY KEY,at INTEGER NOT NULL,n INTEGER NOT NULL);',
      );
  }
  get readOnly() {
    return Date.now() < this.readOnlyUntil;
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
