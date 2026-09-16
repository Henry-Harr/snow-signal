import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { applyHysteresis, computeRawLevel, decide } from '../../../src/risk/state-machine.js';
import { riskLevelRank, type RiskLevel } from '../../../src/risk/types.js';
import type { Signal, SignalFamily, SignalSeverity } from '../../../src/core/types.js';
import { freshState, MARKET_ID, policy, POSITION_ID } from '../../unit/risk/helpers.js';

/**
 * Property tests for the four invariants docs/SPEC.md #8.1 explicitly asks for
 * (see ADR 0008 for how each is actually implemented):
 *
 * 1. Signals from a single family (other than standalone-critical ones) can never
 *    cause an exit.
 * 2. Infra signals alone never cause an exit.
 * 3. De-escalation never skips its dwell time.
 * 4. The same inputs always produce the same decision.
 */

const FAMILIES: SignalFamily[] = ['pool_flow', 'collateral', 'peg', 'governance', 'infra'];
const SEVERITIES: SignalSeverity[] = ['info', 'watch', 'danger', 'critical'];
const RISK_LEVELS: RiskLevel[] = ['NORMAL', 'WATCH', 'DANGER', 'CRITICAL'];

const signalArb = (family: SignalFamily, standaloneCritical: boolean) =>
  fc.record({
    detectorId: fc.constant('D_test'),
    family: fc.constant(family),
    subject: fc.constant({ kind: 'market' as const, id: MARKET_ID }),
    severity: fc.constantFrom(...SEVERITIES),
    standaloneCritical: fc.constant(standaloneCritical),
    value: fc.double({ min: 0, max: 1, noNaN: true }),
    threshold: fc.double({ min: 0, max: 1, noNaN: true }),
    evidence: fc.constant({}),
  }) satisfies fc.Arbitrary<Signal>;

/** "Can never cause an exit" — the state machine's own reachable level from a
 * single family (or infra-only, or an all-non-standalone-critical set) never
 * reaches a level whose default action policy would withdraw (DANGER/CRITICAL). */
function neverReachesWithdrawLevel(signals: Signal[]) {
  const { level } = computeRawLevel(signals);
  expect(riskLevelRank(level)).toBeLessThanOrEqual(riskLevelRank('WATCH'));
}

describe('invariant: a single non-standalone-critical family never causes an exit', () => {
  it('holds for any severity mix within one family', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FAMILIES.filter((f) => f !== 'infra')),
        fc.array(fc.constantFrom(...SEVERITIES), { minLength: 1, maxLength: 10 }),
        (family, severities) => {
          const signals = severities.map((severity): Signal => ({
            detectorId: 'D_test',
            family,
            subject: { kind: 'market', id: MARKET_ID },
            severity,
            standaloneCritical: false,
            value: 0,
            threshold: 0,
            evidence: {},
          }));
          neverReachesWithdrawLevel(signals);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('invariant: infra signals alone never cause an exit', () => {
  it('holds for any severity mix of infra-only signals', () => {
    fc.assert(
      fc.property(
        fc.array(signalArb('infra', false), { minLength: 0, maxLength: 10 }),
        (signals) => {
          const { level } = computeRawLevel(signals);
          expect(level).toBe('NORMAL');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('holds even mixed with a standalone-critical *flag* on an infra signal (D16 never actually sets it, but the state machine should not trust family=infra either way)', () => {
    fc.assert(
      fc.property(fc.array(signalArb('infra', true), { minLength: 1, maxLength: 5 }), (signals) => {
        const { level } = computeRawLevel(signals);
        expect(level).toBe('NORMAL');
      }),
      { numRuns: 50 },
    );
  });
});

describe('invariant: de-escalation never skips its dwell time', () => {
  it('never lowers the stored level before dwellSeconds have elapsed at a stable target', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RISK_LEVELS),
        fc.constantFrom(...RISK_LEVELS),
        fc.integer({ min: 1, max: 86_400 }),
        fc.integer({ min: 0, max: 86_399 }), // strictly less than dwellSeconds below
        (storedLevel, rawLevel, dwellSeconds, elapsedBeforeDwell) => {
          fc.pre(riskLevelRank(rawLevel) < riskLevelRank(storedLevel));
          fc.pre(elapsedBeforeDwell < dwellSeconds);

          const t0 = new Date('2026-01-01T00:00:00Z');
          const state = freshState({ level: storedLevel, since: t0 });
          // First call starts the pending timer.
          const afterFirst = applyHysteresis(state, rawLevel, t0, dwellSeconds);
          // A second call, still within the dwell window, at the same target.
          const t1 = new Date(t0.getTime() + elapsedBeforeDwell * 1000);
          const afterSecond = applyHysteresis(afterFirst, rawLevel, t1, dwellSeconds);

          expect(afterSecond.level).toBe(storedLevel); // must not have moved yet
        },
      ),
      { numRuns: 300 },
    );
  });

  it('does de-escalate once the full dwell time has elapsed at a stable target', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RISK_LEVELS),
        fc.constantFrom(...RISK_LEVELS),
        fc.integer({ min: 1, max: 86_400 }),
        (storedLevel, rawLevel, dwellSeconds) => {
          fc.pre(riskLevelRank(rawLevel) < riskLevelRank(storedLevel));

          const t0 = new Date('2026-01-01T00:00:00Z');
          const state = freshState({ level: storedLevel, since: t0 });
          const afterFirst = applyHysteresis(state, rawLevel, t0, dwellSeconds);
          const tDwelled = new Date(t0.getTime() + dwellSeconds * 1000);
          const afterSecond = applyHysteresis(afterFirst, rawLevel, tDwelled, dwellSeconds);

          expect(afterSecond.level).toBe(rawLevel);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('invariant: the same inputs always produce the same decision', () => {
  it('holds for arbitrary signal sets and states', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(...FAMILIES.map((f) => signalArb(f, false))), {
          minLength: 0,
          maxLength: 8,
        }),
        fc.constantFrom(...RISK_LEVELS),
        fc.boolean(),
        (signals, storedLevel, killSwitchActive) => {
          const input = {
            positionId: POSITION_ID,
            marketOrVaultId: MARKET_ID,
            signals,
            state: freshState({ level: storedLevel }),
            now: new Date('2026-01-01T00:00:00Z'),
            blockNumber: 12345n,
            configHash: 'hash',
            policy: policy(),
            killSwitchActive,
            dwellSeconds: 3600,
          };
          expect(decide(input)).toEqual(decide(input));
        },
      ),
      { numRuns: 200 },
    );
  });
});
