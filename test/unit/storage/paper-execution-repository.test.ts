import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PaperExecutionOutcome } from '../../../src/actions/paper-executor.js';
import { newWithdrawalCampaign } from '../../../src/actions/types.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import { PaperExecutionRepository } from '../../../src/storage/paper-execution-repository.js';

const NOW = new Date('2026-01-01T00:00:00Z');

describe('PaperExecutionRepository', () => {
  let repo: PaperExecutionRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new PaperExecutionRepository(db);
  });

  it('records and reads back a simulated outcome, most recent first', () => {
    const plan = {
      positionId: 'p1',
      campaign: newWithdrawalCampaign('p1', 1_000_000n, NOW),
      stepAmount: 500_000n,
      tx: undefined,
      priorityFeeGwei: undefined,
      wouldComplete: false,
    };
    const outcome: PaperExecutionOutcome = {
      kind: 'simulated',
      result: { plan, passed: true, gasUsed: 123_456n, failureReason: undefined },
    };

    const id = repo.record({ positionId: 'p1', at: NOW, blockNumber: 100n, outcome });
    expect(id).toBeGreaterThan(0);

    const [record] = repo.findByPosition('p1');
    expect(record).toMatchObject({
      positionId: 'p1',
      blockNumber: 100n,
      outcome: 'simulated',
      stepAmount: 500_000n,
      passed: true,
      gasUsed: 123_456n,
      failureReason: undefined,
    });
  });

  it('records a non-simulated outcome (e.g. already-complete) with null step/passed/gas fields', () => {
    const campaign = { ...newWithdrawalCampaign('p1', 1_000_000n, NOW), status: 'complete' as const };
    const outcome: PaperExecutionOutcome = { kind: 'already-complete', campaign };

    repo.record({ positionId: 'p1', at: NOW, blockNumber: 200n, outcome });

    const [record] = repo.findByPosition('p1');
    expect(record?.outcome).toBe('already-complete');
    expect(record?.stepAmount).toBeUndefined();
    expect(record?.passed).toBeUndefined();
    expect(record?.gasUsed).toBeUndefined();
  });

  it('findByPosition orders most-recent-first and only returns that position', () => {
    repo.record({
      positionId: 'p1',
      at: new Date('2026-01-01T00:00:00Z'),
      blockNumber: 1n,
      outcome: { kind: 'no-position' },
    });
    repo.record({
      positionId: 'p1',
      at: new Date('2026-01-02T00:00:00Z'),
      blockNumber: 2n,
      outcome: { kind: 'no-position' },
    });
    repo.record({
      positionId: 'p2',
      at: new Date('2026-01-03T00:00:00Z'),
      blockNumber: 3n,
      outcome: { kind: 'no-position' },
    });

    const records = repo.findByPosition('p1');
    expect(records).toHaveLength(2);
    expect(records[0]!.blockNumber).toBe(2n);
    expect(records[1]!.blockNumber).toBe(1n);
  });
});
