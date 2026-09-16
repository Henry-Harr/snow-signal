import { median } from '../prices/aggregate.js';
import { severityAtLeast, type AscendingThresholds } from './util.js';
import type { AssetContext, Detector, DetectorContext } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D07 — Frozen oracle (docs/SPEC.md #7, collateral family; "the xUSD pattern").
 *
 * Purpose: a lending market's oracle that has simply stopped updating is more
 * dangerous than one reporting a wrong-but-live price — D06 catches a *live* oracle
 * that disagrees with the market, but a genuinely stuck feed can hold a stale "safe"
 * price indefinitely while the real market price collapses underneath it, so nothing
 * ever looks undercollateralized on-chain until it's far too late. This is exactly
 * the failure mode that hit xUSD.
 *
 * Inputs: `AssetContext.current.oraclePrice`/`.marketQuotes` and `.history` (oldest →
 * newest).
 *
 * Formula: walk `history` newest → oldest while `oraclePrice` stays *exactly* equal
 * to `current.oraclePrice` (an on-chain oracle that hasn't updated reports the exact
 * same raw value every read — no floating-point tolerance needed, since the
 * normalized price is a deterministic function of that raw value). If at least
 * `minFlatReadings` prior points match (a single coincidental match isn't proof of a
 * stuck feed), the oracle is considered frozen since the oldest matching point.
 * Compare `median(marketQuotes.price)` at that point against the current median — if
 * the market has moved by more than the threshold while the oracle sat still, fire.
 *
 * Default thresholds (spec gives danger ≥ 3%, critical ≥ 10%; watch is an
 * extrapolated placeholder around that): watch ≥ 1.5%, danger ≥ 3%, critical ≥ 10%.
 * `minFlatReadings` defaults to 2.
 *
 * Known false-positive sources: a genuinely stable, low-volatility asset (most
 * stablecoins, most of the time) can have an oracle that legitimately doesn't update
 * for a while simply because the price hasn't moved enough to cross the feed's own
 * deviation-triggered update threshold — that isn't "frozen," it's "correct and
 * quiet." This detector only fires when the *market* price has also moved
 * meaningfully during the flat period, which is exactly what distinguishes "quiet
 * because stable" from "stuck while the real price moves."
 */
export const D07_ID = 'D07_frozen_oracle';

export const D07_DEFAULT_THRESHOLDS: AscendingThresholds = {
  watch: 0.015,
  danger: 0.03,
  critical: 0.1,
};

export const D07_DEFAULT_MIN_FLAT_READINGS = 2;

function marketPriceOf(point: AssetContext['current']): number | undefined {
  if (point.marketQuotes.length === 0) return undefined;
  return median(point.marketQuotes.map((q) => q.price));
}

/** The oldest history point (walking newest → oldest) whose `oraclePrice` still
 * exactly equals `current.oraclePrice`, requiring at least `minFlatReadings` matching
 * points — `undefined` if the oracle isn't considered frozen. Exported for direct
 * unit testing. */
export function findFrozenSince(
  current: AssetContext['current'],
  history: AssetContext['history'],
  minFlatReadings: number,
): AssetContext['current'] | undefined {
  let frozenSince: AssetContext['current'] | undefined;
  let matches = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const point = history[i]!;
    if (point.oraclePrice !== current.oraclePrice) break;
    matches++;
    frozenSince = point;
  }
  return matches >= minFlatReadings ? frozenSince : undefined;
}

export function createD07Detector(
  thresholds: AscendingThresholds = D07_DEFAULT_THRESHOLDS,
  minFlatReadings: number = D07_DEFAULT_MIN_FLAT_READINGS,
): Detector {
  return {
    id: D07_ID,
    family: 'collateral',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const asset of ctx.assets) {
        const frozenSince = findFrozenSince(asset.current, asset.history, minFlatReadings);
        if (!frozenSince) continue;

        const currentMarketPrice = marketPriceOf(asset.current);
        const frozenMarketPrice = marketPriceOf(frozenSince);
        if (
          currentMarketPrice === undefined ||
          frozenMarketPrice === undefined ||
          frozenMarketPrice === 0
        ) {
          continue;
        }

        const marketMove = Math.abs(currentMarketPrice - frozenMarketPrice) / frozenMarketPrice;
        const severity = severityAtLeast(marketMove, thresholds);
        if (!severity) continue;

        signals.push({
          detectorId: D07_ID,
          family: 'collateral',
          subject: { kind: 'asset', id: asset.symbol },
          severity,
          value: marketMove,
          threshold: thresholds[severity],
          evidence: {
            oraclePrice: asset.current.oraclePrice,
            frozenSinceBlock: frozenSince.block,
            frozenMarketPrice,
            currentMarketPrice,
            marketId: asset.marketId,
            block: asset.current.block,
          },
        });
      }
      return signals;
    },
  };
}
