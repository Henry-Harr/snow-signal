import { median } from '../prices/aggregate.js';
import { severityAtLeast, type AscendingThresholds } from './util.js';
import type { AssetContext, Detector, DetectorContext } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D06 — Oracle vs. market price deviation (docs/SPEC.md #7, collateral family).
 *
 * Purpose: the lending market's own oracle is what actually gates liquidations and
 * borrowing power — if it disagrees materially with where the asset is really
 * trading, the market is mispricing risk in a way that can eventually produce bad
 * debt (undercollateralized borrows the oracle didn't catch) or bad liquidations
 * (healthy positions liquidated on a wrong price).
 *
 * Inputs: `AssetContext.current.oraclePrice` (the market's own oracle reading) and
 * `.marketQuotes` (independent Chainlink/DEX/CEX quotes), plus `history` for the
 * "sustained for N blocks" requirement.
 *
 * Formula: `marketPrice = median(marketQuotes.map(q => q.price))`; `deviation =
 * |oraclePrice - marketPrice| / oraclePrice`. "Sustained for N blocks" means the
 * deviation at `current` *and* at each of the most recent `sustainBlocks - 1` history
 * points (newest-first) independently cross the same severity's threshold — a single
 * noisy reading, however large, does not fire this detector by itself.
 *
 * Default thresholds (spec placeholders): watch ≥ 2%, danger ≥ 5%, critical ≥ 10%.
 * `sustainBlocks` defaults to 3 (a placeholder — not specified by spec, tunable in
 * config). Critical is **standalone-critical** (spec §8.1): sustained ≥10% deviation
 * is allowed to trigger a full exit without corroboration from another detector
 * family, since a mispriced oracle is itself the risk, not a symptom of one.
 *
 * Known false-positive sources: an asset with genuinely thin independent-quote
 * coverage (e.g. only one DEX source, momentarily illiquid) can show a large but
 * meaningless "market price" swing that isn't really where the asset trades — the
 * `sustainBlocks` requirement exists specifically to filter out that kind of
 * single-block noise. A newly-listed collateral asset with no history yet can't
 * satisfy "sustained" at all and stays silent until enough history accumulates.
 */
export const D06_ID = 'D06_oracle_market_deviation';

export const D06_DEFAULT_THRESHOLDS: AscendingThresholds = {
  watch: 0.02,
  danger: 0.05,
  critical: 0.1,
};

export const D06_DEFAULT_SUSTAIN_BLOCKS = 3;

/** `undefined` if there are no independent quotes to compare against. Exported for
 * direct unit testing. */
export function deviationAt(point: AssetContext['current']): number | undefined {
  if (point.marketQuotes.length === 0 || point.oraclePrice === 0) return undefined;
  const marketPrice = median(point.marketQuotes.map((q) => q.price));
  return Math.abs(point.oraclePrice - marketPrice) / point.oraclePrice;
}

export function createD06Detector(
  thresholds: AscendingThresholds = D06_DEFAULT_THRESHOLDS,
  sustainBlocks: number = D06_DEFAULT_SUSTAIN_BLOCKS,
): Detector {
  return {
    id: D06_ID,
    family: 'collateral',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const asset of ctx.assets) {
        const currentDeviation = deviationAt(asset.current);
        if (currentDeviation === undefined) continue;
        const severity = severityAtLeast(currentDeviation, thresholds);
        if (!severity) continue;

        const recentPoints = [
          asset.current,
          ...[...asset.history].reverse().slice(0, sustainBlocks - 1),
        ];
        if (recentPoints.length < sustainBlocks) continue; // not enough history to judge "sustained"

        const sustained = recentPoints.every((point) => {
          const deviation = deviationAt(point);
          return deviation !== undefined && severityAtLeast(deviation, thresholds) !== undefined;
        });
        if (!sustained) continue;

        signals.push({
          detectorId: D06_ID,
          family: 'collateral',
          subject: { kind: 'asset', id: asset.symbol },
          severity,
          standaloneCritical: severity === 'critical',
          value: currentDeviation,
          threshold: thresholds[severity],
          evidence: {
            oraclePrice: asset.current.oraclePrice,
            marketQuotes: asset.current.marketQuotes,
            sustainBlocks,
            marketId: asset.marketId,
            block: asset.current.block,
          },
        });
      }
      return signals;
    },
  };
}
