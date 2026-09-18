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
 * Default thresholds: watch ≥ 95%, danger ≥ 97%, critical ≥ 99%. Originally 90%/95%/
 * 99% through Phase 4 — this is exactly the false-positive source described below,
 * caught for real: the currently-watched Aave v3 Ethereum Core USDC reserve runs at
 * roughly 87–94% utilization as a matter of routine (120 days of real on-chain
 * history sampled every 2 days, 2026-09-18: min 86.70%, p10 89.15%, median 90.96%,
 * mean 90.77%, p90 92.61%, max 93.94% — see docs/TUNING_LOG.md's 2026-09-18 entry),
 * so the original 90% watch threshold sat right at this market's typical midpoint,
 * not a meaningful elevated-risk signal at all. Raised to sit clearly above the
 * observed 120-day range so it only fires on a genuine excursion beyond this
 * market's real normal operation; danger raised proportionally; critical left
 * unchanged (already comfortably above anything observed in that window, and a real
 * live reading above 99% did occur once separately — see the tuning log).
 *
 * Known false-positive sources: a market that runs near-100% utilization *by design*
 * (some isolated Morpho Blue markets are deliberately capped tight) would fire
 * constantly here with no real elevated risk — D03 (exit coverage, which weighs my
 * actual position against available liquidity) is the more decision-relevant signal
 * for that case; D01 alone should not drive an exit (see corroboration rule, spec
 * §8.1). The above is exactly this failure mode, just discovered for a specific
 * market via real production data rather than anticipated in the abstract.
 */
export const D01_ID = 'D01_utilization_level';

export const D01_DEFAULT_THRESHOLDS: AscendingThresholds = {
  watch: 0.95,
  danger: 0.97,
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
