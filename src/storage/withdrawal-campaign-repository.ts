import type { SentinelDatabase } from './db.js';
import type { WithdrawalCampaign, WithdrawalCampaignStatus } from '../actions/types.js';

interface WithdrawalCampaignRow {
  position_id: string;
  started_at: string;
  updated_at: string;
  target_amount: string;
  withdrawn_so_far: string;
  status: string;
  attempt_count: number;
}

function rowToCampaign(row: WithdrawalCampaignRow): WithdrawalCampaign {
  return {
    positionId: row.position_id,
    startedAt: new Date(row.started_at),
    updatedAt: new Date(row.updated_at),
    targetAmount: BigInt(row.target_amount),
    withdrawnSoFar: BigInt(row.withdrawn_so_far),
    status: row.status as WithdrawalCampaignStatus,
    attemptCount: row.attempt_count,
  };
}

/** Persists withdrawal campaign state (docs/SPEC.md §8.3, migration 10) — UPSERT,
 * one row per position, so a partial-then-retry campaign resumes across pipeline
 * runs exactly where it left off (including priority-fee stepping via
 * `attemptCount`). */
export class WithdrawalCampaignRepository {
  constructor(private readonly db: SentinelDatabase) {}

  get(positionId: string): WithdrawalCampaign | undefined {
    const row = this.db
      .prepare(`SELECT * FROM withdrawal_campaigns WHERE position_id = ?`)
      .get(positionId) as WithdrawalCampaignRow | undefined;
    return row ? rowToCampaign(row) : undefined;
  }

  save(campaign: WithdrawalCampaign): void {
    this.db
      .prepare(
        `INSERT INTO withdrawal_campaigns
           (position_id, started_at, updated_at, target_amount, withdrawn_so_far, status, attempt_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (position_id) DO UPDATE SET
           started_at = excluded.started_at,
           updated_at = excluded.updated_at,
           target_amount = excluded.target_amount,
           withdrawn_so_far = excluded.withdrawn_so_far,
           status = excluded.status,
           attempt_count = excluded.attempt_count`,
      )
      .run(
        campaign.positionId,
        campaign.startedAt.toISOString(),
        campaign.updatedAt.toISOString(),
        campaign.targetAmount.toString(),
        campaign.withdrawnSoFar.toString(),
        campaign.status,
        campaign.attemptCount,
      );
  }
}
