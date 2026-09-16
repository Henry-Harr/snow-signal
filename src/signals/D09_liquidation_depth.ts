import type { AscendingThresholds } from './util.js';
import type { Detector, DetectorContext, DexDepthSnapshot } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D09 — Collateral liquidation depth (docs/SPEC.md #7, collateral family).
 *
 * Purpose: even a fully-solvent-on-paper market can produce bad debt if its
 * collateral can't actually be sold for a fair price when liquidations need to
 * happen — a market backed by more collateral than any real DEX can absorb without
 * a large price hit is quietly under-collateralized in practice, however healthy the
 * numbers look.
 *
 * Inputs: `AssetContext.collateralAmount` (how much of this asset sits as collateral
 * in the market) and `AssetContext.dexDepth` (the Uniswap v3 pool state needed to
 * estimate swap depth).
 *
 * Formula (`estimateDexDepth`): a **single-active-tick approximation**, not exact
 * concentrated-liquidity tick-walking math (see ADR 0007's consequences section — a
 * 5% price move very plausibly crosses multiple real tick boundaries, each with its
 * own liquidity, which this formula doesn't account for). Within one tick's constant
 * virtual liquidity `L` and `sqrtPriceX96`-derived `sqrtP`, the raw amount of the
 * collateral token that can be sold before price moves by fraction `f` is:
 * - if the collateral is `token0`: `(L / sqrtP) * (1/sqrt(1-f) - 1)`
 * - if the collateral is `token1`: `L * sqrtP * (1/sqrt(1-f) - 1)`
 *
 * (derived from Uniswap v3's `x = L/sqrtP`, `y = L*sqrtP` within a tick — selling
 * token0 decreases `sqrtP`, selling token1 increases it), then divided by
 * `10^decimals` for the collateral side to get whole-token units. `ratio =
 * collateralAmount / depthEstimate` — the signal fires when the market holds more of
 * this collateral than the DEX could absorb at the configured slippage.
 *
 * Default thresholds (spec gives only "watch if collateral exceeds DEX depth at ≤5%
 * slippage" — danger/critical are extrapolated placeholders as multiples of that):
 * watch ≥ 1× (collateral exceeds the depth estimate at all), danger ≥ 2×, critical ≥
 * 5×. `slippageFraction` defaults to 0.05.
 *
 * Known false-positive sources: this detector only sees *one* venue's depth (whatever
 * pool `dexDepth` was read from) — real liquidations can route across multiple pools/
 * chains/CEXes, so a thin single pool doesn't necessarily mean a thin *market*. The
 * single-tick approximation described above also systematically *underestimates*
 * true depth whenever nearby ticks (outside the current one) hold meaningful
 * liquidity, since it ignores them entirely — so this detector is more likely to
 * over-warn than under-warn, which is the safer direction for a risk detector to err
 * in, but is worth knowing when reading an alert.
 */
export const D09_ID = 'D09_liquidation_depth';

export const D09_DEFAULT_THRESHOLDS: AscendingThresholds = { watch: 1, danger: 2, critical: 5 };
export const D09_DEFAULT_SLIPPAGE_FRACTION = 0.05;

/** Raw collateral-token amount absorbable before price moves by `slippageFraction`,
 * in whole-token units. Exported for direct unit testing of the AMM math separately
 * from the detector's threshold logic. */
export function estimateDexDepth(dex: DexDepthSnapshot, slippageFraction: number): number {
  const sqrtP = Number(dex.sqrtPriceX96) / 2 ** 96;
  const multiplier = 1 / Math.sqrt(1 - slippageFraction) - 1;
  const liquidity = Number(dex.liquidity);
  const rawDepth = dex.baseIsToken0
    ? (liquidity / sqrtP) * multiplier
    : liquidity * sqrtP * multiplier;
  const decimals = dex.baseIsToken0 ? dex.decimals0 : dex.decimals1;
  return rawDepth / 10 ** decimals;
}

export function createD09Detector(
  thresholds: AscendingThresholds = D09_DEFAULT_THRESHOLDS,
  slippageFraction: number = D09_DEFAULT_SLIPPAGE_FRACTION,
): Detector {
  return {
    id: D09_ID,
    family: 'collateral',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const asset of ctx.assets) {
        if (asset.collateralAmount === undefined || !asset.dexDepth) continue;
        if (asset.collateralAmount <= 0) continue;

        const depthEstimate = estimateDexDepth(asset.dexDepth, slippageFraction);
        if (depthEstimate <= 0) continue;

        const ratio = asset.collateralAmount / depthEstimate;
        const severity =
          ratio >= thresholds.critical
            ? 'critical'
            : ratio >= thresholds.danger
              ? 'danger'
              : ratio >= thresholds.watch
                ? 'watch'
                : undefined;
        if (!severity) continue;

        signals.push({
          detectorId: D09_ID,
          family: 'collateral',
          subject: { kind: 'asset', id: asset.symbol },
          severity,
          value: ratio,
          threshold: thresholds[severity],
          evidence: {
            collateralAmount: asset.collateralAmount,
            depthEstimate,
            slippageFraction,
            pool: asset.dexDepth.pool,
            marketId: asset.marketId,
          },
        });
      }
      return signals;
    },
  };
}
