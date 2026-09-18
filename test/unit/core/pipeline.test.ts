import { describe, expect, it } from 'vitest';

import { computeDispatchDedup } from '../../../src/core/pipeline.js';
import type { Decision } from '../../../src/risk/types.js';
import { signal } from '../risk/helpers.js';

/**
 * `computeDispatchDedup` (found 2026-09-18, the user's first real production
 * deployment): the notifier was re-sending a near-identical alert on every single
 * poll while a position sat at a non-NORMAL level, even when nothing about the
 * decision had changed since the last one actually sent. These tests exercise the
 * dedup rule directly, independent of the rest of `runOnce`'s scaffolding.
 */
function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    positionId: 'aave-v3:ethereum:core:USDC',
    at: new Date('2026-01-01T00:00:00Z'),
    blockNumber: 1n,
    previousLevel: 'WATCH',
    level: 'WATCH',
    rawLevel: 'WATCH',
    signals: [signal({ detectorId: 'D01_utilization_level' })],
    rule: 'watch: no corroboration required',
    action: { kind: 'alert' },
    standingAlert: false,
    configHash: 'test-hash',
    ...overrides,
  };
}

describe('computeDispatchDedup', () => {
  it('notifies when the level changed, even with the exact same signal set as before', () => {
    const result = computeDispatchDedup(
      decision({ previousLevel: 'NORMAL', level: 'WATCH' }),
      'D01_utilization_level',
    );
    expect(result.worthNotifying).toBe(true);
    expect(result.signalKey).toBe('D01_utilization_level');
  });

  it('does not notify when the level is unchanged and the same detector(s) are still the only thing firing', () => {
    const result = computeDispatchDedup(
      decision({ previousLevel: 'WATCH', level: 'WATCH' }),
      'D01_utilization_level',
    );
    expect(result.worthNotifying).toBe(false);
  });

  it('does not notify when the level is unchanged and signals went quiet (dwell-pending de-escalation)', () => {
    // Exactly the case that motivated this: level stays WATCH (hysteresis dwell
    // hasn't cleared yet) but this poll's raw signals are empty.
    const result = computeDispatchDedup(
      decision({ previousLevel: 'WATCH', level: 'WATCH', signals: [], rule: 'no qualifying signals' }),
      'D01_utilization_level',
    );
    expect(result.worthNotifying).toBe(false);
    expect(result.signalKey).toBeUndefined();
  });

  it('notifies when a genuinely different detector joins the picture, even though the level did not move', () => {
    const result = computeDispatchDedup(
      decision({
        previousLevel: 'WATCH',
        level: 'WATCH',
        signals: [signal({ detectorId: 'D12_risky_governance_change', family: 'governance' })],
      }),
      'D01_utilization_level',
    );
    expect(result.worthNotifying).toBe(true);
    expect(result.signalKey).toBe('D12_risky_governance_change');
  });

  it('always notifies when standingAlert is set, regardless of level or signal-set changes', () => {
    const result = computeDispatchDedup(
      decision({ previousLevel: 'WATCH', level: 'WATCH', standingAlert: true }),
      'D01_utilization_level',
    );
    expect(result.worthNotifying).toBe(true);
  });

  it('notifies the first time (no prior signal key recorded yet)', () => {
    const result = computeDispatchDedup(
      decision({ previousLevel: 'NORMAL', level: 'WATCH' }),
      undefined,
    );
    expect(result.worthNotifying).toBe(true);
    expect(result.signalKey).toBe('D01_utilization_level');
  });

  it('collapses multiple signals from the same set of detectors into one stable key regardless of order', () => {
    const a = computeDispatchDedup(
      decision({
        signals: [
          signal({ detectorId: 'D04_abnormal_outflows', family: 'pool_flow' }),
          signal({ detectorId: 'D01_utilization_level' }),
        ],
      }),
      'D01_utilization_level,D04_abnormal_outflows',
    );
    expect(a.worthNotifying).toBe(false); // same set, just re-ordered — not new
    expect(a.signalKey).toBe('D01_utilization_level,D04_abnormal_outflows');
  });
});
