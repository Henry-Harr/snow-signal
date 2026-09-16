import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { DecisionLabelRepository } from '../../../src/storage/decision-label-repository.js';
import { DecisionRecordRepository } from '../../../src/storage/decision-record-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { Decision } from '../../../src/risk/types.js';

const NOW = new Date('2026-01-01T00:00:00Z');

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    positionId: 'p1',
    at: NOW,
    blockNumber: 100n,
    previousLevel: 'NORMAL',
    level: 'WATCH',
    rawLevel: 'WATCH',
    signals: [],
    rule: 'test',
    action: { kind: 'alert' },
    standingAlert: false,
    configHash: 'hash',
    ...overrides,
  };
}

describe('DecisionLabelRepository', () => {
  let repo: DecisionLabelRepository;
  let decisionId: number;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new DecisionLabelRepository(db);
    decisionId = new DecisionRecordRepository(db).record(decision());
  });

  it('returns undefined for an unlabeled decision', () => {
    expect(repo.get(decisionId)).toBeUndefined();
  });

  it('round-trips a label with notes', () => {
    repo.set(decisionId, 'false_positive', 'thin liquidity, not a real risk', NOW);
    expect(repo.get(decisionId)).toEqual({
      decisionId,
      label: 'false_positive',
      notes: 'thin liquidity, not a real risk',
      labeledAt: NOW,
    });
  });

  it('round-trips a label without notes', () => {
    repo.set(decisionId, 'true_positive', undefined, NOW);
    const label = repo.get(decisionId);
    expect(label?.notes).toBeUndefined();
  });

  it('set is an upsert: labeling again replaces the previous label', () => {
    repo.set(decisionId, 'false_positive', undefined, NOW);
    repo.set(decisionId, 'true_positive', 'corrected', new Date('2026-01-02T00:00:00Z'));
    expect(repo.get(decisionId)?.label).toBe('true_positive');
  });

  it('findForDecisions returns a map for the requested ids, skipping unlabeled ones', () => {
    repo.set(decisionId, 'true_positive', undefined, NOW);
    const found = repo.findForDecisions([decisionId, 999]);
    expect(found.size).toBe(1);
    expect(found.get(decisionId)?.label).toBe('true_positive');
  });

  it('findForDecisions returns an empty map for an empty input', () => {
    expect(repo.findForDecisions([])).toEqual(new Map());
  });
});
