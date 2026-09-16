import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { DecisionRecordRepository } from '../../../src/storage/decision-record-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { Decision } from '../../../src/risk/types.js';
import type { Signal } from '../../../src/core/types.js';

function decision(overrides: Partial<Decision> = {}): Decision {
  const signals: Signal[] = [
    {
      detectorId: 'D01_utilization_level',
      family: 'pool_flow',
      subject: { kind: 'market', id: 'aave-v3:ethereum:core' },
      severity: 'danger',
      value: 0.96,
      threshold: 0.95,
      evidence: { rawBigint: 12345n, block: 100n },
    },
  ];
  return {
    positionId: 'aave-v3:ethereum:core:USDC',
    at: new Date('2026-01-01T00:00:00.000Z'),
    blockNumber: 1000n,
    previousLevel: 'NORMAL',
    level: 'WATCH',
    rawLevel: 'WATCH',
    signals,
    rule: 'single-family cap: pool_flow only, no corroboration',
    action: { kind: 'alert' },
    standingAlert: false,
    configHash: 'abc123',
    ...overrides,
  };
}

describe('DecisionRecordRepository', () => {
  let repo: DecisionRecordRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new DecisionRecordRepository(db);
  });

  it('assigns an id on insert and round-trips the decision exactly, including nested bigints', () => {
    const d = decision();
    const id = repo.record(d);
    expect(id).toBeGreaterThan(0);
    expect(repo.findById(id)).toEqual({ id, ...d });
  });

  it('round-trips a partial_withdraw action with its fraction', () => {
    const id = repo.record(decision({ action: { kind: 'partial_withdraw', fraction: 0.5 } }));
    expect(repo.findById(id)?.action).toEqual({ kind: 'partial_withdraw', fraction: 0.5 });
  });

  it('findById returns undefined for an unknown id', () => {
    expect(repo.findById(999)).toBeUndefined();
  });

  it('findRecentForPosition returns newest first, scoped to one position', () => {
    repo.record(decision({ positionId: 'p1', at: new Date('2026-01-01T00:00:00Z') }));
    repo.record(decision({ positionId: 'p2', at: new Date('2026-01-01T00:01:00Z') }));
    repo.record(decision({ positionId: 'p1', at: new Date('2026-01-01T00:02:00Z') }));

    const found = repo.findRecentForPosition('p1', 10);
    expect(found).toHaveLength(2);
    expect(found[0]?.at.toISOString()).toBe('2026-01-01T00:02:00.000Z');
  });

  it('findSince returns every decision at or after the given time, oldest first, across positions', () => {
    repo.record(decision({ positionId: 'p1', at: new Date('2026-01-01T00:00:00Z') }));
    repo.record(decision({ positionId: 'p2', at: new Date('2026-01-02T00:00:00Z') }));
    repo.record(decision({ positionId: 'p1', at: new Date('2026-01-03T00:00:00Z') }));

    const found = repo.findSince('2026-01-02T00:00:00.000Z');
    expect(found.map((d) => d.positionId)).toEqual(['p2', 'p1']);
  });
});
