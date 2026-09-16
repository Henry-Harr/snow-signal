/**
 * Morpho's virtual-shares offset (`SharesMathLib.sol`, verified 2026-09-16, see
 * docs/SOURCES.md) — added to both sides of every shares<->assets conversion to make
 * an empty market's first deposit share-inflation-attack-resistant.
 * `VIRTUAL_SHARES = 1e6`, `VIRTUAL_ASSETS = 1`. Shared between the Morpho Blue
 * adapter (position balances) and the Morpho vault adapter (a MetaMorpho vault's own
 * supply position in each underlying market, for look-through exposure).
 */
export const VIRTUAL_SHARES = 1_000_000n;
export const VIRTUAL_ASSETS = 1n;

/** `shares.mulDivDown(totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES)` —
 * BigInt division already floors for non-negative operands, matching `mulDivDown`. */
export function toAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
}

/** `assets.mulDivUp(totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS)` —
 * ceiling division via the standard `(a + b - 1) / b` BigInt trick. */
export function toSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  const numerator = assets * (totalShares + VIRTUAL_SHARES);
  const denominator = totalAssets + VIRTUAL_ASSETS;
  return (numerator + denominator - 1n) / denominator;
}
