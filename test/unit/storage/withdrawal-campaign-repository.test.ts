import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/storage/migrations.js';
import { WithdrawalCampaignRepository } from '../../../src/storage/withdrawal-campaign-repository.js';
import { newWithdrawalCampaign } from '../../../src/actions/types.js';

const NOW = new Date('2026-01-01T00:00:00Z');

describe('WithdrawalCampaignRepository', () => {
  let repo: WithdrawalCampaignRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new WithdrawalCampaignRepository(db);
  });

  it('returns undefined for an unknown position', () => {
    expect(repo.get('unknown')).toBeUndefined();
  });

  it('round-trips a fresh campaign', () => {
    const campaign = newWithdrawalCampaign('p1', 1_000_000n, NOW);
    repo.save(campaign);
    expect(repo.get('p1')).toEqual(campaign);
  });

  it('round-trips a campaign with progress and a non-zero attemptCount', () => {
    const campaign = {
      ...newWithdrawalCampaign('p1', 1_000_000n, NOW),
      withdrawnSoFar: 400_000n,
      attemptCount: 3,
      status: 'in_progress' as const,
      updatedAt: new Date('2026-01-01T02:00:00Z'),
    };
    repo.save(campaign);
    expect(repo.get('p1')).toEqual(campaign);
  });

  it('save is an upsert: saving again for the same position replaces it', () => {
    repo.save(newWithdrawalCampaign('p1', 1_000_000n, NOW));
    const completed = {
      ...newWithdrawalCampaign('p1', 1_000_000n, NOW),
      withdrawnSoFar: 1_000_000n,
      status: 'complete' as const,
    };
    repo.save(completed);
    expect(repo.get('p1')).toEqual(completed);
  });
});
