import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runKill, runResume } from '../../../src/cli/kill.js';
import { FixedClock } from '../../../src/core/clock.js';
import { openDatabase } from '../../../src/storage/db.js';
import { GlobalControlsRepository } from '../../../src/storage/global-controls-repository.js';

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-kill-test-'));
  return join(dir, 'sentinel.sqlite');
}

const NOW = new FixedClock(new Date('2026-01-01T00:00:00Z'));

describe('runKill', () => {
  it('activates the kill switch', () => {
    const dbPath = tempDbPath();
    runKill({ dbPath, clock: NOW });

    const db = openDatabase(dbPath);
    expect(new GlobalControlsRepository(db).isKillSwitchActive()).toBe(true);
    db.close();
  });
});

describe('runResume', () => {
  it('refuses to clear the kill switch without --confirm', () => {
    const dbPath = tempDbPath();
    runKill({ dbPath, clock: NOW });

    const result = runResume({ dbPath, confirm: false, clock: NOW });
    expect(result.ok).toBe(false);

    const db = openDatabase(dbPath);
    expect(new GlobalControlsRepository(db).isKillSwitchActive()).toBe(true);
    db.close();
  });

  it('clears the kill switch when confirmed', () => {
    const dbPath = tempDbPath();
    runKill({ dbPath, clock: NOW });

    const result = runResume({ dbPath, confirm: true, clock: NOW });
    expect(result.ok).toBe(true);

    const db = openDatabase(dbPath);
    expect(new GlobalControlsRepository(db).isKillSwitchActive()).toBe(false);
    db.close();
  });
});
