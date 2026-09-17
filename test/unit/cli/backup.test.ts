import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runBackup } from '../../../src/cli/backup.js';
import { FixedClock } from '../../../src/core/clock.js';
import { StorageError } from '../../../src/core/errors.js';
import { openDatabase } from '../../../src/storage/db.js';
import { GlobalControlsRepository } from '../../../src/storage/global-controls-repository.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('runBackup', () => {
  it('refuses when the source database does not exist', async () => {
    const dir = tempDir('sentinel-backup-missing-');
    await expect(
      runBackup({ dbPath: join(dir, 'sentinel.sqlite'), outDir: join(dir, 'out'), retentionCount: 3 }),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('refuses a non-positive retentionCount', async () => {
    const dir = tempDir('sentinel-backup-bad-retain-');
    const dbPath = join(dir, 'sentinel.sqlite');
    openDatabase(dbPath).close();

    await expect(
      runBackup({ dbPath, outDir: join(dir, 'out'), retentionCount: 0 }),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('creates a real, independently-readable copy of the live database', async () => {
    const dir = tempDir('sentinel-backup-copy-');
    const dbPath = join(dir, 'sentinel.sqlite');
    const db = openDatabase(dbPath);
    new GlobalControlsRepository(db).activateKillSwitch(new Date('2026-01-01T00:00:00Z'));

    const outDir = join(dir, 'out');
    const result = await runBackup({
      dbPath,
      outDir,
      retentionCount: 5,
      clock: new FixedClock(new Date('2026-01-02T03:04:05.678Z')),
    });
    db.close();

    expect(existsSync(result.backupPath)).toBe(true);
    expect(result.deletedPaths).toEqual([]);

    const backupDb = new Database(result.backupPath, { readonly: true });
    expect(new GlobalControlsRepository(backupDb).isKillSwitchActive()).toBe(true);
    backupDb.close();
  });

  it('prunes older backups beyond retentionCount, keeping the most recent', async () => {
    const dir = tempDir('sentinel-backup-prune-');
    const dbPath = join(dir, 'sentinel.sqlite');
    openDatabase(dbPath).close();
    const outDir = join(dir, 'out');

    const timestamps = [
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
    ];
    let lastResult;
    for (const ts of timestamps) {
      lastResult = await runBackup({
        dbPath,
        outDir,
        retentionCount: 2,
        clock: new FixedClock(new Date(ts)),
      });
    }

    const remaining = readdirSync(outDir).sort();
    expect(remaining).toHaveLength(2);
    expect(remaining.some((f) => f.includes('2026-01-01'))).toBe(false);
    expect(remaining.some((f) => f.includes('2026-01-02'))).toBe(true);
    expect(remaining.some((f) => f.includes('2026-01-03'))).toBe(true);
    expect(lastResult?.deletedPaths).toHaveLength(1);
    expect(lastResult?.deletedPaths[0]).toContain('2026-01-01');
  });
});
