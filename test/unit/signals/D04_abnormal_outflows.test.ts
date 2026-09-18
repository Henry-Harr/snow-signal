import { describe, expect, it } from 'vitest';

import {
  createD04Detector,
  D04_DEFAULT_THRESHOLDS,
  D04_DEFAULT_WINDOWS_SECONDS,
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
  // minMad: 0 — these tests exercise the generic z-score math with small, readable
  // synthetic magnitudes, so they opt out of the production minMad floor (which
  // would otherwise swamp a MAD of 10 entirely) rather than coupling to that
  // specific tuned constant. The floor itself is tested separately below.
  const detector = createD04Detector(D04_DEFAULT_THRESHOLDS, D04_DEFAULT_WINDOWS_SECONDS, 0);

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

  it("the production minMad floor stops a near-flat baseline from blowing ordinary noise into an absurd score (docs/TUNING_LOG.md 2026-09-18)", () => {
    // A near-flat baseline (MAD of just 1 raw unit — realistic for a large, quiet
    // stablecoin reserve sampled block-by-block) paired with a real-scale current
    // supply (hundreds of millions of raw units, i.e. real USDC magnitude) — without
    // the floor, even a tiny, immaterial swing here produces an enormous z-score.
    const flows = [-1, 1, -1, 1];
    let supplied = 500_000_000_000_000n; // ~$500M, realistic Aave Core USDC scale
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
    const last = points[points.length - 1]!;
    // A $500 outflow (immaterial at $500M scale) against a MAD of 1 raw unit would,
    // unfloored, produce a score in the hundreds of millions — with the default
    // (floored) detector it must stay well within a sane range instead.
    const ctx = detectorContext({
      at: block({ timestamp: NOW }),
      markets: [
        marketContext({
          current: marketSnapshot({ block: block({ timestamp: NOW }), totalSupplied: last.totalSupplied - 500_000_000n }),
          history: points,
        }),
      ],
    });
    const signals = detector.evaluate(ctx);
    // With minMad: 0 (this describe block's detector), the unfloored blow-up is
    // exactly what we're guarding against — assert it really would be absurd here,
    // then assert the production (floored) detector keeps it sane.
    expect(signals[0]?.value).toBeGreaterThan(1000);

    const flooredDetector = createD04Detector(); // real production default, incl. minMad
    const [flooredSignal] = flooredDetector.evaluate(ctx);
    expect(flooredSignal?.value ?? 0).toBeLessThan(1);
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
