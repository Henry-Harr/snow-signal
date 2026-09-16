import { resolveAssetSymbol } from '../core/known-assets.js';
import type { CollateralExposure } from '../core/types.js';
import type { AssetExposureEntry } from '../signals/types.js';

/**
 * Context-assembly helpers (docs/ARCHITECTURE.md #5, ADR 0007). The bulk of
 * `DetectorContext` assembly is orchestration (fetch from chain/storage, in
 * `src/core/pipeline.ts`) rather than logic — this file holds the pieces that
 * *are* real logic, so they're testable without a chain client or database.
 */

/** Aave's `getAssetPrice` (`IPriceOracleGetter`) returns USD scaled by 1e8 for the
 * markets Sentinel watches — verified in `src/protocols/aave-v3/abi.ts`'s own doc
 * comment on `aaveOracleAbi` (Phase 2). Detectors want a plain decimal number
 * (`AssetContext.current.oraclePrice`), not a raw scaled bigint. */
export function normalizeAaveOraclePrice(raw: bigint): number {
  return Number(raw) / 1e8;
}

/**
 * Builds D14's `assetExposure` join table (`DetectorContext.assetExposure`) from a
 * set of markets' own `CollateralExposure` — resolving each entry's address to a
 * symbol via `src/core/known-assets.ts` and grouping by symbol. An entry whose asset
 * has no known symbol is skipped (not included under its raw address) — D14 keys
 * exclusively on the same symbol strings `Signal.subject.id` uses for asset-family
 * signals, so an unresolvable address could never match a real signal anyway.
 *
 * **Known limitation** (see ADR 0007's consequences section): this only covers
 * *direct* market exposure, not vault look-through (a vault's exposure through the
 * underlying markets it allocates into) — resolving that needs walking a
 * MetaMorpho vault's supply/withdraw queue to each underlying Morpho Blue market's
 * own collateral exposure, which isn't wired yet. A vault position's own market
 * *does* still get a direct entry here if the vault itself has real "collateral"
 * exposure data recorded (chain doesn't apply to Morpho vaults, so today this
 * limitation only matters once a vault position is actually configured with
 * meaningful underlying-market collateral — not blocking for the currently
 * configured Aave-only collateral base).
 */
export function buildAssetExposure(
  chain: string,
  exposures: { marketId: string; collateralExposure: CollateralExposure[] }[],
): Record<string, AssetExposureEntry[]> {
  const result: Record<string, AssetExposureEntry[]> = {};
  for (const { marketId, collateralExposure } of exposures) {
    for (const exposure of collateralExposure) {
      const symbol = resolveAssetSymbol(chain, exposure.asset);
      if (symbol === exposure.asset) continue; // unresolved — see doc comment above
      (result[symbol] ??= []).push({
        marketId,
        shareOfCollateralBase: exposure.shareOfCollateralBase,
      });
    }
  }
  return result;
}
