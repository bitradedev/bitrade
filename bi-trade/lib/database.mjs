import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PlatformRepository } from './database-core.mjs';
export * from './database-core.mjs';
export class PlatformStore extends PlatformRepository {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, 'platform.sqlite'),
      db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
    super(db, (fn) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = fn();
        db.exec('COMMIT');
        return value;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    });
    this.path = path;
  }
  close() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}
