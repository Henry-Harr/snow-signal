import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { RiskStateRepository } from '../../../src/storage/risk-state-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import { initialPositionRiskState, type PositionRiskState } from '../../../src/risk/types.js';

const NOW = new Date('2026-01-01T00:00:00Z');

describe('RiskStateRepository', () => {
  let repo: RiskStateRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new RiskStateRepository(db);
  });

  it('returns undefined for an unknown position', () => {
    expect(repo.get('unknown')).toBeUndefined();
  });

  it('round-trips a fresh (all-defaults) state', () => {
    const state = initialPositionRiskState('p1', NOW);
    repo.save(state, NOW);
    expect(repo.get('p1')).toEqual(state);
  });

  it('round-trips a state with pendingDeescalation and every manual control set', () => {
    const state: PositionRiskState = {
      positionId: 'p1',
      level: 'CRITICAL',
      since: NOW,
      pendingDeescalation: { rawLevel: 'WATCH', since: new Date('2026-01-01T01:00:00Z') },
      manualControls: {
        ackedDecisionId: '42',
        mutedUntil: new Date('2026-01-02T00:00:00Z'),
        forcedLevel: 'DANGER',
      },
    };
    repo.save(state, NOW);
    expect(repo.get('p1')).toEqual(state);
  });

  it('save is an upsert: saving again for the same position replaces its state', () => {
    repo.save(initialPositionRiskState('p1', NOW), NOW);
    const updated: PositionRiskState = {
      positionId: 'p1',
      level: 'WATCH',
      since: NOW,
      manualControls: {},
    };
    repo.save(updated, NOW);
    expect(repo.get('p1')).toEqual(updated);
  });

  it('findAll returns every persisted position state', () => {
    repo.save(initialPositionRiskState('p1', NOW), NOW);
    repo.save(initialPositionRiskState('p2', NOW), NOW);
    expect(
      repo
        .findAll()
        .map((s) => s.positionId)
        .sort(),
    ).toEqual(['p1', 'p2']);
  });
});
