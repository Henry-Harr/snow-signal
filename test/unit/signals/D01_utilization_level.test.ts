import { describe, expect, it } from 'vitest';

import {
  createD01Detector,
  D01_DEFAULT_THRESHOLDS,
  D01_ID,
} from '../../../src/signals/D01_utilization_level.js';
import { detectorContext, marketContext, marketSnapshot } from './helpers.js';

describe('D01 utilization level', () => {
  const detector = createD01Detector();

  it('emits no signal for a normal utilization reading', () => {
    const ctx = detectorContext({
      markets: [marketContext({ current: marketSnapshot({ utilization: 0.5 }) })],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits watch at exactly the borderline threshold', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({ current: marketSnapshot({ utilization: D01_DEFAULT_THRESHOLDS.watch }) }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({ detectorId: D01_ID, family: 'pool_flow', severity: 'watch' });
  });

  it('emits critical for an alarming utilization reading', () => {
    const ctx = detectorContext({
      markets: [marketContext({ marketId: 'm1', current: marketSnapshot({ utilization: 0.999 }) })],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({
      severity: 'critical',
      subject: { kind: 'market', id: 'm1' },
      value: 0.999,
    });
  });

  it('does not fire on a market intentionally run near its design ceiling, just below watch (false-positive guard)', () => {
    // A market at 94.9% utilization is high but below every threshold — this is the
    // known false-positive shape documented in the detector's header comment (a
    // tightly-capped isolated market running near its design ceiling, or — the real
    // case that raised these thresholds — a market whose normal operating range just
    // happens to sit close to the old default); D01 must not fire just because
    // utilization is "high" in an absolute sense.
    const ctx = detectorContext({
      markets: [marketContext({ current: marketSnapshot({ utilization: 0.949 }) })],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('evaluates every market independently', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          marketId: 'm1',
          current: marketSnapshot({ marketId: 'm1', utilization: 0.5 }),
        }),
        marketContext({
          marketId: 'm2',
          current: marketSnapshot({ marketId: 'm2', utilization: 0.98 }),
        }),
      ],
    });
    const signals = detector.evaluate(ctx);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.subject.id).toBe('m2');
    expect(signals[0]!.severity).toBe('danger');
  });
});
