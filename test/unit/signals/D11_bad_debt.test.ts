import { describe, expect, it } from 'vitest';

import { createD11Detector, D11_ID } from '../../../src/signals/D11_bad_debt.js';
import { detectorContext, marketContext, marketSnapshot } from './helpers.js';

describe('D11 bad debt', () => {
  const detector = createD11Detector();

  it('emits no signal when there is no bad debt', () => {
    const ctx = detectorContext({
      markets: [marketContext({ current: marketSnapshot({ badDebt: 0n }) })],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits critical at exactly the borderline minimum', () => {
    const ctx = detectorContext({
      markets: [marketContext({ marketId: 'm1', current: marketSnapshot({ badDebt: 1n }) })],
    });
    const [signal] = detector.evaluate(ctx);
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
      markets: [marketContext({ current: marketSnapshot({ badDebt: 1_000_000n }) })],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.evidence['badDebt']).toBe(1_000_000n);
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
