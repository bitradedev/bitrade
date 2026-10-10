import { PlatformRepository, digest, fail } from '../bi-trade/lib/database-core.mjs';

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
  constructor(storage) {
    super(sqlDatabase(storage.sql), (fn) => storage.transactionSync(fn));
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS rate_limits(id TEXT PRIMARY KEY,at INTEGER NOT NULL,n INTEGER NOT NULL);',
    );
  }
  rateLimit(req, kind, max, ms, scope = 'ip:' + req.socket.remoteAddress) {
    const now = Date.now(),
      id = digest(kind + ':' + scope);
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
    const now = Date.now();
    this.db.prepare('DELETE FROM rate_limits WHERE at<?').run(now - 3600000);
    this.db.prepare('DELETE FROM challenges WHERE expires<?').run(now - 86400000);
    this.db.prepare('DELETE FROM credentials WHERE expires<?').run(now);
  }
  close() {}
}
