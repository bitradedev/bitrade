import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class SqliteStorage {
  constructor(path, onAlarmChanged = () => {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS __bitrade_local_meta(id TEXT PRIMARY KEY,value TEXT NOT NULL)',
    );
    this.onAlarmChanged = onAlarmChanged;
    this.sql = { exec: (query, ...bindings) => this.exec(query, bindings) };
  }

  exec(query, bindings) {
    // DatabaseSync.prepare accepts the first statement of a DDL script without
    // reporting the remaining statements. Schema setup uses such scripts, so
    // execute them as a whole before any account or housekeeping query runs.
    if (!bindings.length && /^\s*(?:CREATE|ALTER|DROP)\b/i.test(query)) {
      this.db.exec(query);
      return { toArray: () => [], rowsWritten: 0 };
    }
    let statement;
    try {
      statement = this.db.prepare(query);
    } catch (error) {
      if (bindings.length || !String(error.message).includes('more than one statement'))
        throw error;
      this.db.exec(query);
      return { toArray: () => [], rowsWritten: 0 };
    }
    const rows = statement.columns().length ? statement.all(...bindings) : null;
    const changes = rows ? 0 : Number(statement.run(...bindings).changes);
    return { toArray: () => rows ?? [], rowsWritten: changes };
  }

  transactionSync(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async getAlarm() {
    const row = this.db.prepare("SELECT value FROM __bitrade_local_meta WHERE id='alarm'").get();
    return row ? Number(row.value) : null;
  }

  async setAlarm(value) {
    this.db
      .prepare(
        "INSERT INTO __bitrade_local_meta VALUES('alarm',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(String(value));
    this.onAlarmChanged();
  }

  async deleteAlarm() {
    this.db.prepare("DELETE FROM __bitrade_local_meta WHERE id='alarm'").run();
    this.onAlarmChanged();
  }

  close() {
    this.db.close();
  }
}
