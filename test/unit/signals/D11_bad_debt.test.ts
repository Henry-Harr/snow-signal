import { describe, expect, it } from 'vitest';

import { createD11Detector, D11_DEFAULT_MIN_BAD_DEBT, D11_ID } from '../../../src/signals/D11_bad_debt.js';
import { detectorContext, marketContext, marketSnapshot } from './helpers.js';

describe('D11 bad debt', () => {
  const detector = createD11Detector();

  it('emits no signal when there is no bad debt', () => {
    const ctx = detectorContext({
      markets: [marketContext({ current: marketSnapshot({ badDebt: 0n }) })],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits critical at exactly the borderline minimum, for a given threshold', () => {
    const detectorWithLowFloor = createD11Detector(1n);
    const ctx = detectorContext({
      markets: [marketContext({ marketId: 'm1', current: marketSnapshot({ badDebt: 1n }) })],
    });
    const [signal] = detectorWithLowFloor.evaluate(ctx);
    expect(signal).toMatchObject({
      detectorId: D11_ID,
      family: 'collateral',
      subject: { kind: 'market', id: 'm1' },
      severity: 'critical',
      standaloneCritical: true,
    });
  });

  it('emits critical for a large realized bad debt', () => {
    const ctx = detectorContext({
      markets: [marketContext({ current: marketSnapshot({ badDebt: 1_000_000_000_000n }) })],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.evidence['badDebt']).toBe(1_000_000_000_000n);
  });

  // Pins the production default (docs/TUNING_LOG.md's 2026-09-16 entry, applied
  // 2026-09-17): must clear the real, observed protocol-dust bad debt on both
  // currently-watched Aave v3 Core USDC reserves, or a real false CRITICAL/full-exit
  // alert reaches production again exactly as it did before this default was raised.
  it("the production default doesn't fire on real observed Aave Core USDC reserve dust", () => {
    const dustValues = [1_604_836n, 30_875_030n]; // ~$1.60 Ethereum, ~$30.88 Base
    for (const badDebt of dustValues) {
      const ctx = detectorContext({ markets: [marketContext({ current: marketSnapshot({ badDebt }) })] });
      expect(detector.evaluate(ctx)).toEqual([]);
    }
    expect(D11_DEFAULT_MIN_BAD_DEBT).toBeGreaterThan(30_875_030n);
  });

  it('does not fire when the protocol has no concept of bad debt for this market (false-positive guard)', () => {
    // badDebt left unset (the adapter default) rather than 0 — must not be treated
    // as "zero bad debt confirmed," since it's really "unknown/not tracked."
    const ctx = detectorContext({
      markets: [marketContext({ current: marketSnapshot() })],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('respects a configured minimum above the default (dust filtering)', () => {
    const detectorWithFloor = createD11Detector(1000n);
    const ctx = detectorContext({
      markets: [marketContext({ current: marketSnapshot({ badDebt: 500n }) })],
    });
    expect(detectorWithFloor.evaluate(ctx)).toEqual([]);
  });
});
