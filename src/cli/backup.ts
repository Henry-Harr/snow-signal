import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { SystemClock, type Clock } from '../core/clock.js';
import { StorageError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

/**
 * `sentinel backup` (docs/SPEC.md §9 Phase 9: "SQLite backups"). Uses better-sqlite3's
 * native online-backup API (`Database.backup`, a real SQLite backup-API binding, not a
 * file copy) so it's safe to run against the same database file `sentinel watch` is
 * concurrently reading and writing in WAL mode — this opens its own **read-only**
 * connection to the source, so it never contends for the single writer lock WAL mode
 * still requires, and never re-runs migrations (only the live process's read-write
 * connection should ever do that).
 *
 * Filenames are `sentinel-<ISO-timestamp-with-safe-chars>.sqlite`, sorted
 * lexicographically to double as chronological order; pruning keeps the
 * `retentionCount` most recent and deletes the rest, deliberately only ever touching
 * files matching that exact naming scheme so it can't delete something unrelated a
 * user happened to put in the same directory.
 */
const BACKUP_FILENAME_PATTERN = /^sentinel-.*\.sqlite$/;

export interface BackupOptions {
  dbPath: string;
  outDir: string;
  /** How many of the most recent backups to keep; older ones are deleted after a
   * successful new backup. Must be at least 1 (the backup just taken always survives
   * its own run). */
  retentionCount: number;
  clock?: Clock;
  logger?: Logger;
}

export interface BackupResult {
  backupPath: string;
  deletedPaths: string[];
}

export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  if (options.retentionCount < 1) {
    throw new StorageError('retentionCount must be at least 1');
  }
  if (!existsSync(options.dbPath)) {
    throw new StorageError(
      `No database found at ${options.dbPath} — nothing to back up (has 'sentinel watch' run yet?)`,
    );
  }
  mkdirSync(options.outDir, { recursive: true });

  const clock = options.clock ?? new SystemClock();
  const timestamp = clock.now().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(options.outDir, `sentinel-${timestamp}.sqlite`);

  const source = new Database(options.dbPath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(backupPath);
  } catch (cause) {
    throw new StorageError(`Backup of ${options.dbPath} to ${backupPath} failed`, { cause });
  } finally {
    source.close();
  }

  const existing = readdirSync(options.outDir)
    .filter((name) => BACKUP_FILENAME_PATTERN.test(name))
    .sort();
  const deletedPaths: string[] = [];
  while (existing.length > options.retentionCount) {
    const oldest = existing.shift()!;
    const oldestPath = join(options.outDir, oldest);
    unlinkSync(oldestPath);
    deletedPaths.push(oldestPath);
  }

  options.logger?.info(
    { backupPath, deletedCount: deletedPaths.length },
    'database backup complete',
  );
  return { backupPath, deletedPaths };
}
