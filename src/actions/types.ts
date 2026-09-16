import type { ActionKind } from '../risk/types.js';
import type { TxRequest } from '../core/types.js';

/**
 * Withdrawal planning types (docs/SPEC.md §8.3). A withdrawal is a **campaign**, not
 * a single call: a pool that can't pay the full target right now still gets whatever
 * is currently available, then the same position is replanned on the next pipeline
 * run (retrying "until the exit is complete, cancelled, or the state de-escalates" —
 * spec's own wording) rather than the planner blocking or looping internally.
 * Persisted campaign state (`WithdrawalAttemptRepository`) is what makes that
 * replanning pick up where the last run left off, including priority-fee stepping.
 */

export type WithdrawalCampaignStatus = 'in_progress' | 'complete' | 'cancelled';

export interface WithdrawalCampaign {
  positionId: string;
  startedAt: Date;
  updatedAt: Date;
  /** The full amount the policy wants withdrawn, decided once when the campaign
   * starts (spec §8.2: a configured fraction for `partial_withdraw`, the whole
   * position for `full_exit`) — not recomputed each run, so a campaign started as a
   * 50% partial withdrawal stays a 50% campaign even if the position's own balance
   * changes slightly from interest accrual while it's in progress. */
  targetAmount: bigint;
  /** Raw units actually withdrawn so far, summed across every step's simulated (or,
   * once Phase 8 exists, real) execution. */
  withdrawnSoFar: bigint;
  status: WithdrawalCampaignStatus;
  /** How many withdrawal attempts this campaign has made — the input to priority-fee
   * stepping (spec §8.3: "raise priority fees step by step, up to a configured
   * cap"). Incremented once per plan-and-simulate step, not per retry-on-failure. */
  attemptCount: number;
}

export function newWithdrawalCampaign(
  positionId: string,
  targetAmount: bigint,
  now: Date,
): WithdrawalCampaign {
  return {
    positionId,
    startedAt: now,
    updatedAt: now,
    targetAmount,
    withdrawnSoFar: 0n,
    status: 'in_progress',
    attemptCount: 0,
  };
}

/** One planned step of a campaign — `tx` is `undefined` when nothing is currently
 * withdrawable (the pool has zero available liquidity right now; the campaign stays
 * `in_progress` and simply tries again next run, per spec's retry wording). */
export interface WithdrawalPlan {
  positionId: string;
  campaign: WithdrawalCampaign;
  /** This step's withdrawal amount — `min(remaining target, availableNow)`. */
  stepAmount: bigint;
  tx: TxRequest | undefined;
  /** Priority fee (gwei) this step should use, per the campaign's attempt count and
   * the configured per-chain cap — `undefined` when there's no transaction to send. */
  priorityFeeGwei: number | undefined;
  /** True once this step's `stepAmount`, added to `withdrawnSoFar`, would meet or
   * exceed `targetAmount` — the planner's own call on whether the campaign completes
   * after this step, before any simulation has actually run. */
  wouldComplete: boolean;
}

/** The result of actually running a plan through the simulator (`src/actions/
 * simulator.ts`) — `undefined` fields mean the step never got that far (e.g. no `tx`
 * to simulate because nothing was withdrawable). */
export interface WithdrawalSimulationResult {
  plan: WithdrawalPlan;
  /** `true` only when the simulated transaction succeeded *and* the position went
   * down and the Safe went up by the expected amount (safety rule 5 — the sole
   * "pass" bar; a revert or any other result is `false`). */
  passed: boolean;
  gasUsed: bigint | undefined;
  /** Human-readable reason for a non-`passed` result (revert reason, or a mismatch
   * description) — always populated when `passed` is `false` and a simulation was
   * actually attempted. */
  failureReason: string | undefined;
}

/** Maps a risk-engine `ActionKind` to the target amount a withdrawal campaign should
 * aim for, given the position's full balance and the policy's configured
 * `partial_withdraw` fraction. Returns `undefined` for `'none'`/`'alert'` — those
 * never start a campaign at all. */
export function targetAmountFor(
  kind: ActionKind,
  fraction: number | undefined,
  positionBalance: bigint,
): bigint | undefined {
  if (kind === 'full_exit') return positionBalance;
  if (kind === 'partial_withdraw') {
    const f = fraction ?? 0;
    return (positionBalance * BigInt(Math.round(f * 10_000))) / 10_000n;
  }
  return undefined;
}
