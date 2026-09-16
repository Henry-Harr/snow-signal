import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { GlobalControlsRepository } from '../../../src/storage/global-controls-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';

const NOW = new Date('2026-01-01T00:00:00Z');

describe('GlobalControlsRepository', () => {
  let repo: GlobalControlsRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new GlobalControlsRepository(db);
  });

  it('defaults to inactive', () => {
    expect(repo.isKillSwitchActive()).toBe(false);
  });

  it('activateKillSwitch sets it active', () => {
    repo.activateKillSwitch(NOW);
    expect(repo.isKillSwitchActive()).toBe(true);
  });

  it('deactivateKillSwitch clears it', () => {
    repo.activateKillSwitch(NOW);
    repo.deactivateKillSwitch(NOW);
    expect(repo.isKillSwitchActive()).toBe(false);
  });

  it('activating twice is idempotent (upsert, not a duplicate row)', () => {
    repo.activateKillSwitch(NOW);
    repo.activateKillSwitch(new Date('2026-01-02T00:00:00Z'));
    expect(repo.isKillSwitchActive()).toBe(true);
  });
});
