import { newWithdrawalCampaign, targetAmountFor, type WithdrawalCampaign, type WithdrawalPlan } from './types.js';
import type { ActionRecommendation } from '../risk/types.js';
import type { TxRequest, WithdrawEstimate } from '../core/types.js';

/**
 * The withdrawal planner (docs/SPEC.md §8.3) — a pure function over the current
 * campaign state and on-chain liquidity, called once per pipeline run. It never
 * loops or blocks waiting for a multi-step exit to finish; the pipeline calling it
 * again on the next block is what "retry on every new block" (spec's own wording)
 * actually means here.
 */

export interface PriorityFeeConfig {
  capGwei: number;
}

/** Ramps in 4 equal steps up to the configured cap (spec: "raise priority fees step
 * by step, up to a configured cap") — `attemptCount` is the campaign's count of
 * prior steps, so the very first step (attemptCount 0) already bids a quarter of the
 * cap rather than starting at zero (a too-low first bid on a fast-moving exit wastes
 * the retry it takes to discover that). Monotonic and capped regardless of how many
 * attempts have happened. */
export function nextPriorityFeeGwei(attemptCount: number, config: PriorityFeeConfig): number {
  const step = config.capGwei / 4;
  return Math.min(step * (attemptCount + 1), config.capGwei);
}

export interface PlanWithdrawalInput {
  positionId: string;
  action: ActionRecommendation;
  positionBalance: bigint;
  withdrawEstimate: WithdrawEstimate;
  existingCampaign: WithdrawalCampaign | undefined;
  buildTx: (amount: bigint) => TxRequest;
  now: Date;
  priorityFee: PriorityFeeConfig;
}

export type PlanOutcome =
  | { kind: 'none' }
  | { kind: 'cancelled'; campaign: WithdrawalCampaign }
  | { kind: 'already-complete'; campaign: WithdrawalCampaign }
  | { kind: 'plan'; plan: WithdrawalPlan };

export function planWithdrawal(input: PlanWithdrawalInput): PlanOutcome {
  const target = targetAmountFor(input.action.kind, input.action.fraction, input.positionBalance);

  if (target === undefined) {
    // 'none' or 'alert' — de-escalated (or never escalated). Cancel any in-progress
    // campaign per spec's "until ... the state de-escalates."
    if (input.existingCampaign?.status === 'in_progress') {
      return {
        kind: 'cancelled',
        campaign: { ...input.existingCampaign, status: 'cancelled', updatedAt: input.now },
      };
    }
    return { kind: 'none' };
  }

  const base =
    input.existingCampaign?.status === 'in_progress' ? input.existingCampaign : undefined;
  const campaign: WithdrawalCampaign = base
    ? { ...base, targetAmount: target > base.targetAmount ? target : base.targetAmount }
    : newWithdrawalCampaign(input.positionId, target, input.now);

  const remaining = campaign.targetAmount - campaign.withdrawnSoFar;
  if (remaining <= 0n) {
    return {
      kind: 'already-complete',
      campaign: { ...campaign, status: 'complete', updatedAt: input.now },
    };
  }

  const stepAmount =
    remaining < input.withdrawEstimate.availableNow ? remaining : input.withdrawEstimate.availableNow;
  const wouldComplete = stepAmount >= remaining;
  const hasStep = stepAmount > 0n;

  const plan: WithdrawalPlan = {
    positionId: input.positionId,
    campaign: {
      ...campaign,
      attemptCount: campaign.attemptCount + (hasStep ? 1 : 0),
      updatedAt: input.now,
    },
    stepAmount,
    tx: hasStep ? input.buildTx(stepAmount) : undefined,
    priorityFeeGwei: hasStep ? nextPriorityFeeGwei(campaign.attemptCount, input.priorityFee) : undefined,
    wouldComplete,
  };
  return { kind: 'plan', plan };
}
