import { describe, expect, it } from 'vitest';

import {
  createD02Detector,
  D02_DEFAULT_WINDOW_SECONDS,
  D02_ID,
  findVelocityBaseline,
} from '../../../src/signals/D02_utilization_velocity.js';
import { block, detectorContext, marketContext, marketSnapshot } from './helpers.js';

const NOW = 1_700_010_000;
const HOUR = 3600;

describe('findVelocityBaseline', () => {
  it('picks the latest history entry still at or before the cutoff', () => {
    const history = [
      marketSnapshot({ block: block({ timestamp: NOW - 2 * HOUR }), utilization: 0.5 }),
      marketSnapshot({ block: block({ timestamp: NOW - HOUR - 10 }), utilization: 0.55 }),
      marketSnapshot({ block: block({ timestamp: NOW - HOUR + 60 }), utilization: 0.9 }), // inside window
    ];
    const baseline = findVelocityBaseline(history, NOW, HOUR);
    expect(baseline?.utilization).toBe(0.55);
  });

  it('returns undefined when no entry is old enough to anchor the window', () => {
    const history = [marketSnapshot({ block: block({ timestamp: NOW - 100 }) })];
    expect(findVelocityBaseline(history, NOW, HOUR)).toBeUndefined();
  });
});

describe('D02 utilization velocity', () => {
  const detector = createD02Detector();

  function ctxWithUtilizations(baselineUtilization: number, currentUtilization: number) {
    return detectorContext({
      at: block({ timestamp: NOW }),
      markets: [
        marketContext({
          current: marketSnapshot({
            block: block({ timestamp: NOW }),
            utilization: currentUtilization,
          }),
          history: [
            marketSnapshot({
              block: block({ timestamp: NOW - D02_DEFAULT_WINDOW_SECONDS }),
              utilization: baselineUtilization,
            }),
          ],
        }),
      ],
    });
  }

  it('emits no signal for a stable market (no velocity)', () => {
    expect(detector.evaluate(ctxWithUtilizations(0.7, 0.7))).toEqual([]);
  });

  it('emits danger comfortably past the spec-anchored 10-point-per-hour rise', () => {
    // 0.58 -> 0.70 is a clean 12-point rise; a literal 0.60/0.70 pair is avoided here
    // since 0.70 - 0.60 is not exactly 0.1 in IEEE-754 double arithmetic (it's
    // 0.09999999999999998), which would make an "exactly at 10" assertion flaky
    // rather than testing anything about the detector itself.
    const [signal] = detector.evaluate(ctxWithUtilizations(0.58, 0.7));
    expect(signal).toMatchObject({ detectorId: D02_ID, severity: 'danger' });
    expect(signal?.value).toBeCloseTo(12, 9);
  });

  it('emits critical for an alarming spike', () => {
    const [signal] = detector.evaluate(ctxWithUtilizations(0.45, 0.7));
    expect(signal?.severity).toBe('critical');
  });

  it('does not fire when history exists but none of it is old enough (false-positive guard: new/thin history)', () => {
    const ctx = detectorContext({
      at: block({ timestamp: NOW }),
      markets: [
        marketContext({
          current: marketSnapshot({ block: block({ timestamp: NOW }), utilization: 0.99 }),
          history: [marketSnapshot({ block: block({ timestamp: NOW - 60 }), utilization: 0.5 })],
        }),
      ],
    });
    // Utilization jumped a lot, but the only history point is 60s old, not ~1h old —
    // D02 must not compute a misleadingly-large "velocity" over a 60-second window.
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('does not fire on a falling utilization (only rises count)', () => {
    expect(detector.evaluate(ctxWithUtilizations(1.0, 0.7))).toEqual([]);
  });
});
