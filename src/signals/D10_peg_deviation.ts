import { median } from '../prices/aggregate.js';
import { severityAtLeast, type AscendingThresholds } from './util.js';
import type { Detector, DetectorContext } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D10 — Peg deviation of the stablecoin I hold (docs/SPEC.md #7, peg family).
 *
 * Purpose: the most direct "is my money still worth a dollar" question — independent
 * of any lending market's own oracle (D06/D07 cover that), this compares the asset I
 * actually hold against a fixed $1.00 reference using only independent market quotes.
 *
 * Inputs: `MarketContext.position` (skipped if I don't hold anything there) and
 * `MarketContext.positionAssetQuotes` (independent Chainlink/DEX/CEX quotes for
 * `position.asset`, not the market's own oracle).
 *
 * Formula: `deviation = |median(quotes.price) - 1.0| / 1.0` — no "sustained" window
 * (unlike D06) since a peg check on the asset I directly hold should alert on the
 * first reading, not wait for confirmation across blocks; corroboration/hysteresis
 * before *acting* on it is the risk engine's job (spec §8.1), not this detector's.
 *
 * Default thresholds (spec placeholders): watch ≥ 0.5%, danger ≥ 2%, critical ≥ 5%.
 *
 * **This detector is alert-only by design and must never be standalone-critical** —
 * see ADR 0005: a depeg alert must not itself trigger an automatic exit (a forced
 * sale can lock in what turns out to be a temporary drop, as with USDC in March
 * 2023). `standaloneCritical` is always `false` here, and the risk engine (Phase 5)
 * must additionally exclude D10 from its standard action policy regardless of
 * severity, per ADR 0005 — this detector alone does not enforce that at the signal
 * level, since a signal's `standaloneCritical: false` only means "doesn't bypass
 * corroboration," not "never triggers the standard policy at all."
 *
 * Known false-positive sources: thin quote coverage during a low-liquidity period
 * (e.g. a single DEX source briefly illiquid) can show a large but meaningless
 * "price" swing — with only one or two independent sources, `median` offers no
 * outlier protection at all. This is a real limitation of relying on whatever
 * `positionAssetQuotes` the caller supplied; a future revision could reuse
 * `src/prices/aggregate.ts`'s `rejectOutliers` if quote coverage improves enough to
 * make that meaningful (fewer than 3 quotes, that function already keeps everything).
 */
export const D10_ID = 'D10_peg_deviation';

export const D10_DEFAULT_THRESHOLDS: AscendingThresholds = {
  watch: 0.005,
  danger: 0.02,
  critical: 0.05,
};

const PEG_PRICE = 1.0;

export function createD10Detector(
  thresholds: AscendingThresholds = D10_DEFAULT_THRESHOLDS,
): Detector {
  return {
    id: D10_ID,
    family: 'peg',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const market of ctx.markets) {
        const position = market.position;
        if (!position || market.positionAssetQuotes.length === 0) continue;

        const price = median(market.positionAssetQuotes.map((q) => q.price));
        const deviation = Math.abs(price - PEG_PRICE) / PEG_PRICE;
        const severity = severityAtLeast(deviation, thresholds);
        if (!severity) continue;

        signals.push({
          detectorId: D10_ID,
          family: 'peg',
          // `market.marketId`, not `position.id` — see the identical fix/comment on
          // D03 (`src/signals/D03_exit_coverage.ts`) for why.
          subject: { kind: 'position', id: market.marketId },
          severity,
          // Never standalone-critical — see this detector's doc comment and ADR 0005.
          standaloneCritical: false,
          value: deviation,
          threshold: thresholds[severity],
          evidence: {
            price,
            pegPrice: PEG_PRICE,
            quotes: market.positionAssetQuotes,
            block: market.current.block,
          },
        });
      }
      return signals;
    },
  };
}
