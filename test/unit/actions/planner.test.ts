import { describe, expect, it } from 'vitest';

import { nextPriorityFeeGwei, planWithdrawal, type PlanWithdrawalInput } from '../../../src/actions/planner.js';
import { newWithdrawalCampaign } from '../../../src/actions/types.js';
import type { TxRequest } from '../../../src/core/types.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function tx(amount: bigint): TxRequest {
  return { chainId: 1, to: '0xpool', data: '0xdata', description: `withdraw ${amount}` };
}

function baseInput(overrides: Partial<PlanWithdrawalInput> = {}): PlanWithdrawalInput {
  return {
    positionId: 'aave-v3:ethereum:core:USDC',
    action: { kind: 'full_exit' },
    positionBalance: 1_000_000n,
    withdrawEstimate: { positionId: 'aave-v3:ethereum:core:USDC', availableNow: 1_000_000n, totalPosition: 1_000_000n },
    existingCampaign: undefined,
    buildTx: (amount) => tx(amount),
    now: NOW,
    priorityFee: { capGwei: 40 },
    ...overrides,
  };
}

describe('nextPriorityFeeGwei', () => {
  it('ramps in 4 equal steps up to the cap', () => {
    const config = { capGwei: 40 };
    expect(nextPriorityFeeGwei(0, config)).toBe(10);
    expect(nextPriorityFeeGwei(1, config)).toBe(20);
    expect(nextPriorityFeeGwei(2, config)).toBe(30);
    expect(nextPriorityFeeGwei(3, config)).toBe(40);
  });

  it('never exceeds the cap for a large attempt count', () => {
    expect(nextPriorityFeeGwei(100, { capGwei: 40 })).toBe(40);
  });
});

describe('planWithdrawal', () => {
  it('returns none for action kind "none" with no existing campaign', () => {
    const outcome = planWithdrawal(baseInput({ action: { kind: 'none' } }));
    expect(outcome).toEqual({ kind: 'none' });
  });

  it('returns none for action kind "alert" with no existing campaign', () => {
    const outcome = planWithdrawal(baseInput({ action: { kind: 'alert' } }));
    expect(outcome).toEqual({ kind: 'none' });
  });

  it('cancels an in-progress campaign when the action de-escalates to none', () => {
    const existingCampaign = newWithdrawalCampaign('p', 1_000_000n, NOW);
    const outcome = planWithdrawal(
      baseInput({ action: { kind: 'none' }, existingCampaign }),
    );
    expect(outcome.kind).toBe('cancelled');
    if (outcome.kind === 'cancelled') expect(outcome.campaign.status).toBe('cancelled');
  });

  it('plans a full exit in one step when everything is available', () => {
    const outcome = planWithdrawal(baseInput());
    expect(outcome.kind).toBe('plan');
    if (outcome.kind !== 'plan') throw new Error('expected plan');
    expect(outcome.plan.stepAmount).toBe(1_000_000n);
    expect(outcome.plan.wouldComplete).toBe(true);
    expect(outcome.plan.tx).toBeDefined();
    expect(outcome.plan.priorityFeeGwei).toBe(10);
    expect(outcome.plan.campaign.attemptCount).toBe(1);
  });

  it('plans a partial step when the pool cannot pay the full target', () => {
    const outcome = planWithdrawal(
      baseInput({
        withdrawEstimate: { positionId: 'p', availableNow: 300_000n, totalPosition: 1_000_000n },
      }),
    );
    expect(outcome.kind).toBe('plan');
    if (outcome.kind !== 'plan') throw new Error('expected plan');
    expect(outcome.plan.stepAmount).toBe(300_000n);
    expect(outcome.plan.wouldComplete).toBe(false);
    expect(outcome.plan.campaign.status).toBe('in_progress');
  });

  it('computes a partial_withdraw target from the configured fraction', () => {
    const outcome = planWithdrawal(
      baseInput({ action: { kind: 'partial_withdraw', fraction: 0.5 } }),
    );
    expect(outcome.kind).toBe('plan');
    if (outcome.kind !== 'plan') throw new Error('expected plan');
    expect(outcome.plan.campaign.targetAmount).toBe(500_000n);
    expect(outcome.plan.stepAmount).toBe(500_000n);
    expect(outcome.plan.wouldComplete).toBe(true);
  });

  it('resumes an in-progress campaign, only asking for the remaining amount', () => {
    const existingCampaign = {
      ...newWithdrawalCampaign('p', 1_000_000n, NOW),
      withdrawnSoFar: 400_000n,
      attemptCount: 1,
    };
    const outcome = planWithdrawal(
      baseInput({
        existingCampaign,
        withdrawEstimate: { positionId: 'p', availableNow: 1_000_000n, totalPosition: 600_000n },
      }),
    );
    expect(outcome.kind).toBe('plan');
    if (outcome.kind !== 'plan') throw new Error('expected plan');
    expect(outcome.plan.stepAmount).toBe(600_000n); // remaining = 1,000,000 - 400,000
    expect(outcome.plan.campaign.attemptCount).toBe(2);
    expect(outcome.plan.priorityFeeGwei).toBe(20); // attemptCount was 1 at plan time
  });

  it('reports already-complete without re-planning when withdrawnSoFar already meets the target', () => {
    const existingCampaign = {
      ...newWithdrawalCampaign('p', 1_000_000n, NOW),
      withdrawnSoFar: 1_000_000n,
    };
    const outcome = planWithdrawal(baseInput({ existingCampaign }));
    expect(outcome.kind).toBe('already-complete');
  });

  it('bumps the campaign target up (never down) when the action escalates mid-campaign', () => {
    const existingCampaign = {
      ...newWithdrawalCampaign('p', 500_000n, NOW), // started as a partial_withdraw
      withdrawnSoFar: 200_000n,
    };
    const outcome = planWithdrawal(
      baseInput({ action: { kind: 'full_exit' }, existingCampaign, positionBalance: 1_000_000n }),
    );
    expect(outcome.kind).toBe('plan');
    if (outcome.kind !== 'plan') throw new Error('expected plan');
    expect(outcome.plan.campaign.targetAmount).toBe(1_000_000n);
    expect(outcome.plan.stepAmount).toBe(800_000n); // remaining = 1,000,000 - 200,000
  });

  it('does not build a transaction or advance attemptCount when nothing is currently withdrawable', () => {
    const outcome = planWithdrawal(
      baseInput({
        withdrawEstimate: { positionId: 'p', availableNow: 0n, totalPosition: 1_000_000n },
      }),
    );
    expect(outcome.kind).toBe('plan');
    if (outcome.kind !== 'plan') throw new Error('expected plan');
    expect(outcome.plan.stepAmount).toBe(0n);
    expect(outcome.plan.tx).toBeUndefined();
    expect(outcome.plan.priorityFeeGwei).toBeUndefined();
    expect(outcome.plan.campaign.attemptCount).toBe(0);
    expect(outcome.plan.campaign.status).toBe('in_progress');
  });

  it('starts a fresh campaign when the previous one already completed', () => {
    const existingCampaign = {
      ...newWithdrawalCampaign('p', 500_000n, NOW),
      withdrawnSoFar: 500_000n,
      status: 'complete' as const,
    };
    const outcome = planWithdrawal(
      baseInput({ action: { kind: 'full_exit' }, existingCampaign, positionBalance: 1_000_000n }),
    );
    expect(outcome.kind).toBe('plan');
    if (outcome.kind !== 'plan') throw new Error('expected plan');
    expect(outcome.plan.campaign.targetAmount).toBe(1_000_000n);
    expect(outcome.plan.campaign.withdrawnSoFar).toBe(0n); // fresh campaign, not resumed
  });
});
