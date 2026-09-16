import { describe, expect, it } from 'vitest';

import {
  createD04Detector,
  D04_ID,
  windowedFlows,
} from '../../../src/signals/D04_abnormal_outflows.js';
import { block, detectorContext, marketContext, marketSnapshot } from './helpers.js';

const NOW = 1_700_010_000;
const FIVE_MIN = 300;

describe('windowedFlows', () => {
  it('pairs each point with the latest earlier point at least windowSeconds before it', () => {
    const points = [
      { block: { timestamp: 0 }, totalSupplied: 100n },
      { block: { timestamp: 300 }, totalSupplied: 110n },
      { block: { timestamp: 600 }, totalSupplied: 90n },
    ];
    expect(windowedFlows(points, 300)).toEqual([10, -20]); // 110-100, 90-110
  });

  it('returns an empty array when no pair spans the window', () => {
    const points = [
      { block: { timestamp: 0 }, totalSupplied: 100n },
      { block: { timestamp: 100 }, totalSupplied: 110n },
    ];
    expect(windowedFlows(points, 300)).toEqual([]);
  });
});

describe('D04 abnormal net outflows', () => {
  const detector = createD04Detector();

  /** 5 points spaced exactly 5 minutes apart, ending 5 minutes before `current` — a
   * baseline history with wiggle of ±10 around zero net flow (median 0, MAD 10 for
   * the 5-minute window). Total history span (20 minutes) is intentionally too short
   * to produce any baseline observation for the 1h/6h windows. */
  function baselineHistory() {
    const flows = [-10, 10, -10, 10];
    let supplied = 1_000_000n;
    const points = [
      marketSnapshot({ block: block({ timestamp: NOW - 5 * FIVE_MIN }), totalSupplied: supplied }),
    ];
    for (const f of flows) {
      supplied += BigInt(f);
      points.push(
        marketSnapshot({
          block: block({ timestamp: points[points.length - 1]!.block.timestamp + FIVE_MIN }),
          totalSupplied: supplied,
        }),
      );
    }
    return points;
  }

  function ctxWithCurrentSupply(currentSupplied: bigint) {
    const history = baselineHistory();
    return detectorContext({
      at: block({ timestamp: NOW }),
      markets: [
        marketContext({
          current: marketSnapshot({
            block: block({ timestamp: NOW }),
            totalSupplied: currentSupplied,
          }),
          history,
        }),
      ],
    });
  }

  it('emits no signal when the current flow matches the baseline wiggle', () => {
    const history = baselineHistory();
    const last = history[history.length - 1]!;
    expect(detector.evaluate(ctxWithCurrentSupply(last.totalSupplied + 10n))).toEqual([]);
  });

  it('emits watch for a moderate outflow relative to the baseline MAD', () => {
    const history = baselineHistory();
    const last = history[history.length - 1]!;
    // baseline median=0, MAD=10 -> score = 0.6745 * outflow / 10; outflow=70 -> ~4.7.
    const [signal] = detector.evaluate(ctxWithCurrentSupply(last.totalSupplied - 70n));
    expect(signal).toMatchObject({ detectorId: D04_ID, family: 'pool_flow', severity: 'watch' });
    expect(signal?.value).toBeGreaterThanOrEqual(4);
    expect(signal?.value).toBeLessThan(8);
  });

  it('emits critical for a sharp, large outflow', () => {
    const history = baselineHistory();
    const last = history[history.length - 1]!;
    const [signal] = detector.evaluate(ctxWithCurrentSupply(last.totalSupplied - 2000n));
    expect(signal?.severity).toBe('critical');
    const evidence = signal?.evidence as { windows: unknown[] };
    expect(evidence.windows).toHaveLength(1); // only the 5-minute window had enough baseline data
  });

  it('never fires on an inflow, however large (only outflows count)', () => {
    const history = baselineHistory();
    const last = history[history.length - 1]!;
    expect(detector.evaluate(ctxWithCurrentSupply(last.totalSupplied + 1_000_000n))).toEqual([]);
  });

  it('does not fire when there is too little history to build a baseline (false-positive guard)', () => {
    const ctx = detectorContext({
      at: block({ timestamp: NOW }),
      markets: [
        marketContext({
          current: marketSnapshot({ block: block({ timestamp: NOW }), totalSupplied: 1n }),
          history: [
            marketSnapshot({
              block: block({ timestamp: NOW - FIVE_MIN }),
              totalSupplied: 1_000_000n,
            }),
          ],
        }),
      ],
    });
    // A single history point can't build a ≥3-observation baseline for any window —
    // even though this "looks like" a massive outflow, D04 must stay silent rather
    // than compute a MAD from too little data.
    expect(detector.evaluate(ctx)).toEqual([]);
  });
});
