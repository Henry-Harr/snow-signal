import { severityAtLeast, type AscendingThresholds } from './util.js';
import type { Detector, DetectorContext } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D01 — Utilization level (docs/SPEC.md #7, pool_flow family).
 *
 * Purpose: flag a market whose borrow utilization (`totalBorrowed /
 * (totalBorrowed + availableLiquidity)`, already computed by the adapter as
 * `MarketSnapshot.utilization`) is high enough that new withdrawals — including
 * mine — may not be immediately payable.
 *
 * Inputs: `MarketSnapshot.utilization` for each watched market, current block only
 * (no history needed).
 *
 * Formula: three-level threshold on the raw fraction (0–1). No smoothing — a single
 * high reading is real risk regardless of how it got there; D02 (velocity) is the
 * detector that cares about the rate of change.
 *
 * Default thresholds (spec placeholders, tunable in config): watch ≥ 90%, danger ≥
 * 95%, critical ≥ 99%.
 *
 * Known false-positive sources: a market that runs near-100% utilization *by design*
 * (some isolated Morpho Blue markets are deliberately capped tight) would fire
 * constantly here with no real elevated risk — D03 (exit coverage, which weighs my
 * actual position against available liquidity) is the more decision-relevant signal
 * for that case; D01 alone should not drive an exit (see corroboration rule, spec
 * §8.1).
 */
export const D01_ID = 'D01_utilization_level';

export const D01_DEFAULT_THRESHOLDS: AscendingThresholds = {
  watch: 0.9,
  danger: 0.95,
  critical: 0.99,
};

export function createD01Detector(
  thresholds: AscendingThresholds = D01_DEFAULT_THRESHOLDS,
): Detector {
  return {
    id: D01_ID,
    family: 'pool_flow',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const market of ctx.markets) {
        const utilization = market.current.utilization;
        const severity = severityAtLeast(utilization, thresholds);
        if (!severity) continue;
        signals.push({
          detectorId: D01_ID,
          family: 'pool_flow',
          subject: { kind: 'market', id: market.marketId },
          severity,
          value: utilization,
          threshold: thresholds[severity],
          evidence: {
            utilization,
            totalBorrowed: market.current.totalBorrowed,
            availableLiquidity: market.current.availableLiquidity,
            block: market.current.block,
          },
        });
      }
      return signals;
    },
  };
}
