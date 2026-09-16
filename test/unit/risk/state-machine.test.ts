import { describe, expect, it } from 'vitest';

import { applyHysteresis, computeRawLevel, decide } from '../../../src/risk/state-machine.js';
import { freshState, MARKET_ID, policy, POSITION_ID, signal } from './helpers.js';

describe('computeRawLevel', () => {
  it('is NORMAL with no signals', () => {
    expect(computeRawLevel([])).toMatchObject({ level: 'NORMAL' });
  });

  it('is WATCH for a single watch-severity signal', () => {
    expect(computeRawLevel([signal({ severity: 'watch' })])).toMatchObject({ level: 'WATCH' });
  });

  it('caps a single-family danger signal at WATCH without corroboration', () => {
    const result = computeRawLevel([signal({ family: 'pool_flow', severity: 'danger' })]);
    expect(result.level).toBe('WATCH');
    expect(result.rule).toMatch(/single-family cap/);
  });

  it('caps a single-family critical signal at WATCH without corroboration', () => {
    const result = computeRawLevel([signal({ family: 'pool_flow', severity: 'critical' })]);
    expect(result.level).toBe('WATCH');
  });

  it('reaches DANGER when two distinct families corroborate', () => {
    const result = computeRawLevel([
      signal({ family: 'pool_flow', severity: 'danger' }),
      signal({
        family: 'collateral',
        severity: 'danger',
        detectorId: 'D06_oracle_market_deviation',
      }),
    ]);
    expect(result.level).toBe('DANGER');
    expect(result.rule).toMatch(/corroborated across 2 families/);
  });

  it('reaches CRITICAL immediately for a standalone-critical signal, no corroboration needed', () => {
    const result = computeRawLevel([
      signal({
        family: 'collateral',
        severity: 'critical',
        standaloneCritical: true,
        detectorId: 'D11_bad_debt',
      }),
    ]);
    expect(result.level).toBe('CRITICAL');
    expect(result.rule).toMatch(/standalone-critical: D11_bad_debt/);
  });

  it('does not let infra count toward corroboration (invariant: infra alone never causes an exit)', () => {
    const result = computeRawLevel([
      signal({ family: 'pool_flow', severity: 'danger' }),
      signal({ family: 'infra', severity: 'danger', detectorId: 'D16_infra_health' }),
    ]);
    expect(result.level).toBe('WATCH'); // still single real family (pool_flow) -> capped
  });

  it('is NORMAL when every signal is infra, however severe', () => {
    const result = computeRawLevel([
      signal({ family: 'infra', severity: 'danger', detectorId: 'D16_infra_health' }),
    ]);
    expect(result.level).toBe('NORMAL');
  });
});

describe('applyHysteresis', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');

  it('escalates immediately regardless of dwell time', () => {
    const state = freshState({ level: 'NORMAL', since: t0 });
    const next = applyHysteresis(state, 'CRITICAL', t0, 3600);
    expect(next.level).toBe('CRITICAL');
    expect(next.pendingDeescalation).toBeUndefined();
  });

  it('does not de-escalate before the dwell time has elapsed', () => {
    const state = freshState({ level: 'CRITICAL', since: t0 });
    const t1 = new Date(t0.getTime() + 1000);
    const next = applyHysteresis(state, 'WATCH', t1, 3600);
    expect(next.level).toBe('CRITICAL'); // unchanged
    expect(next.pendingDeescalation).toMatchObject({ rawLevel: 'WATCH', since: t1 });
  });

  it('de-escalates once the dwell time has elapsed at a stable target', () => {
    const state = freshState({
      level: 'CRITICAL',
      since: t0,
      pendingDeescalation: { rawLevel: 'WATCH', since: t0 },
    });
    const tAfterDwell = new Date(t0.getTime() + 3600 * 1000);
    const next = applyHysteresis(state, 'WATCH', tAfterDwell, 3600);
    expect(next.level).toBe('WATCH');
    expect(next.pendingDeescalation).toBeUndefined();
  });

  it('resets the dwell timer if the de-escalation target changes mid-wait', () => {
    const state = freshState({
      level: 'CRITICAL',
      since: t0,
      pendingDeescalation: { rawLevel: 'DANGER', since: t0 },
    });
    const t1 = new Date(t0.getTime() + 1800 * 1000); // halfway through a 3600s dwell
    const next = applyHysteresis(state, 'WATCH', t1, 3600); // target changed to WATCH
    expect(next.level).toBe('CRITICAL'); // still hasn't de-escalated
    expect(next.pendingDeescalation).toMatchObject({ rawLevel: 'WATCH', since: t1 }); // timer restarted
  });

  it('clears the pending de-escalation if the raw level recovers back up', () => {
    const state = freshState({
      level: 'CRITICAL',
      since: t0,
      pendingDeescalation: { rawLevel: 'WATCH', since: t0 },
    });
    const t1 = new Date(t0.getTime() + 100 * 1000);
    const next = applyHysteresis(state, 'CRITICAL', t1, 3600);
    expect(next.level).toBe('CRITICAL');
    expect(next.pendingDeescalation).toBeUndefined();
  });
});

function baseInput(overrides: Partial<Parameters<typeof decide>[0]> = {}) {
  return {
    positionId: POSITION_ID,
    marketOrVaultId: MARKET_ID,
    signals: [],
    state: freshState(),
    now: new Date('2026-01-01T00:00:00Z'),
    blockNumber: 1000n,
    configHash: 'abc123',
    policy: policy(),
    killSwitchActive: false,
    dwellSeconds: 3600,
    ...overrides,
  };
}

describe('decide', () => {
  it('recommends no action at NORMAL', () => {
    const { decision } = decide(baseInput());
    expect(decision.level).toBe('NORMAL');
    expect(decision.action).toEqual({ kind: 'none' });
  });

  it('recommends the configured partial_withdraw action at DANGER', () => {
    const input = baseInput({
      signals: [
        signal({ family: 'pool_flow', severity: 'danger' }),
        signal({
          family: 'collateral',
          severity: 'danger',
          detectorId: 'D06_oracle_market_deviation',
        }),
      ],
    });
    const { decision } = decide(input);
    expect(decision.level).toBe('DANGER');
    expect(decision.action).toEqual({ kind: 'partial_withdraw', fraction: 0.5 });
  });

  it('suppresses a withdrawal action to alert when the kill switch is active', () => {
    const input = baseInput({
      signals: [
        signal({ family: 'pool_flow', severity: 'critical' }),
        signal({
          family: 'collateral',
          severity: 'critical',
          standaloneCritical: true,
          detectorId: 'D11_bad_debt',
        }),
      ],
      killSwitchActive: true,
    });
    const { decision } = decide(input);
    expect(decision.level).toBe('CRITICAL');
    expect(decision.action).toEqual({ kind: 'alert', suppressedByKillSwitch: true });
  });

  it('a manually forced level overrides the computed level entirely', () => {
    const input = baseInput({
      signals: [], // would otherwise compute NORMAL
      state: freshState({ manualControls: { forcedLevel: 'DANGER' } }),
    });
    const { state, decision } = decide(input);
    expect(state.level).toBe('DANGER');
    expect(decision.level).toBe('DANGER');
    expect(decision.rawLevel).toBe('NORMAL'); // what it would have been without the override
    expect(decision.rule).toMatch(/manually forced to DANGER/);
  });

  it('sets standingAlert when D03 fires, independent of the computed level', () => {
    const input = baseInput({
      signals: [
        signal({ detectorId: 'D03_exit_coverage', family: 'pool_flow', severity: 'watch' }),
      ],
    });
    const { decision } = decide(input);
    expect(decision.level).toBe('WATCH'); // single family, capped anyway
    expect(decision.standingAlert).toBe(true);
  });

  it('does not set standingAlert without a D03 signal', () => {
    const input = baseInput({ signals: [signal({ detectorId: 'D01_utilization_level' })] });
    expect(decide(input).decision.standingAlert).toBe(false);
  });

  it('ignores signals not scoped to this position or its market', () => {
    const input = baseInput({
      signals: [
        signal({
          family: 'pool_flow',
          severity: 'critical',
          subject: { kind: 'market', id: 'some-other-market' },
        }),
      ],
    });
    const { decision } = decide(input);
    expect(decision.level).toBe('NORMAL');
    expect(decision.signals).toEqual([]);
  });

  it('is deterministic: identical inputs produce an identical decision', () => {
    const input = baseInput({
      signals: [
        signal({ family: 'pool_flow', severity: 'danger' }),
        signal({
          family: 'collateral',
          severity: 'danger',
          detectorId: 'D06_oracle_market_deviation',
        }),
      ],
    });
    expect(decide(input)).toEqual(decide(input));
  });
});
