import { describe, expect, it } from 'vitest';

import {
  runSyntheticScenario,
  SYNTHETIC_SCENARIOS,
} from '../../../src/replay/synthetic-scenario.js';

const POLICY = {
  watch: { action: 'alert' as const },
  danger: { action: 'partial_withdraw' as const, fraction: 0.5 },
  critical: { action: 'full_exit' as const },
  maxShareOfAvailableLiquidity: 0.05,
};

describe('synthetic fault-injection scenarios', () => {
  it('utilization-spike reaches WATCH via D01', () => {
    const scenario = SYNTHETIC_SCENARIOS.find((s) => s.id === 'utilization-spike')!;
    const result = runSyntheticScenario(scenario, POLICY);
    expect(result.decision.level).toBe('WATCH');
    expect(result.signals.some((s) => s.detectorId === 'D01_utilization_level')).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('frozen-oracle reaches WATCH via D07, capped by the single-family rule', () => {
    const scenario = SYNTHETIC_SCENARIOS.find((s) => s.id === 'frozen-oracle')!;
    const result = runSyntheticScenario(scenario, POLICY);
    expect(
      result.signals.some((s) => s.detectorId === 'D07_frozen_oracle' && s.severity === 'critical'),
    ).toBe(true);
    expect(result.decision.level).toBe('WATCH'); // capped despite the critical-severity signal (ADR 0008)
    expect(result.passed).toBe(true);
  });

  it('depeg reaches WATCH via D10 and never standaloneCritical (ADR 0005)', () => {
    const scenario = SYNTHETIC_SCENARIOS.find((s) => s.id === 'depeg')!;
    const result = runSyntheticScenario(scenario, POLICY);
    const d10 = result.signals.find((s) => s.detectorId === 'D10_peg_deviation');
    expect(d10?.severity).toBe('critical');
    expect(d10?.standaloneCritical).toBeFalsy();
    expect(result.decision.level).toBe('WATCH');
    expect(result.passed).toBe(true);
  });

  it('whale-exit reaches WATCH via D05', () => {
    const scenario = SYNTHETIC_SCENARIOS.find((s) => s.id === 'whale-exit')!;
    const result = runSyntheticScenario(scenario, POLICY);
    expect(result.signals.some((s) => s.detectorId === 'D05_large_holder_exits')).toBe(true);
    expect(result.decision.level).toBe('WATCH');
    expect(result.passed).toBe(true);
  });

  it('paused-withdrawals is a documented, honest miss — no detector fires', () => {
    const scenario = SYNTHETIC_SCENARIOS.find((s) => s.id === 'paused-withdrawals')!;
    const result = runSyntheticScenario(scenario, POLICY);
    expect(result.signals).toEqual([]);
    expect(result.decision.level).toBe('NORMAL');
    expect(result.passed).toBe(false); // expected — see the scenario's own description
  });

  it('every synthetic scenario runs without throwing', () => {
    for (const scenario of SYNTHETIC_SCENARIOS) {
      expect(() => runSyntheticScenario(scenario, POLICY)).not.toThrow();
    }
  });
});
