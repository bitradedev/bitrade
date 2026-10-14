import { backup, DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

process.umask(0o077);
const sourcePath = process.env.BI_TRADE_DB_PATH;
if (!sourcePath) throw Error('BI_TRADE_DB_PATH is required');
const directory = process.env.BI_TRADE_BACKUP_DIR ?? join(dirname(sourcePath), 'backups');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const finished = join(directory, `bitrade-${stamp}.sqlite`);
const temporary = finished + '.pending';
const source = new DatabaseSync(sourcePath, { readOnly: true });
try {
  await backup(source, temporary);
  const snapshot = new DatabaseSync(temporary);
  try {
    snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
      throw Error('Backup integrity check failed');
  } finally {
    snapshot.close();
  }
  renameSync(temporary, finished);
  for (const suffix of ['-wal', '-shm']) rmSync(temporary + suffix, { force: true });
  console.log('SQLite backup verified.');
} catch (error) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(temporary + suffix, { force: true });
  throw error;
} finally {
  source.close();
}
