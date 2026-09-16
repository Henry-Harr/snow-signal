/**
 * Chainlink price feed (`AggregatorV3Interface`) addresses for assets Sentinel
 * currently prices. Safety rule 6 (docs/SPEC.md #2): every address below was
 * resolved and verified directly on-chain this session (2026-09-16), not from a
 * scraped list — see docs/SOURCES.md for exactly how.
 *
 * Each was found by reading the actual price source Aave's own oracle uses for that
 * asset (`AaveOracle.getSourceOfAsset`), then unwrapping Aave's "capped" adapter (a
 * `PriceCapAdapterStable`-style wrapper some stablecoin feeds go through) via its
 * `ASSET_TO_USD_AGGREGATOR()` to get the raw Chainlink feed underneath — then
 * confirmed each resulting address has live contract code and a `latestRoundData()`
 * that returns a recent, sane price via a direct `cast call` against the real RPC.
 * Keyed by the token's own symbol (e.g. `"WETH"`), not the feed's pair name — the
 * `WETH` feeds are Chainlink's `ETH / USD` feed, since WETH is 1:1-wrapped ETH and
 * Chainlink has no separate WETH feed.
 */
export interface ChainlinkFeed {
  address: `0x${string}`;
  /** Chainlink's own display name for the feed, for traceability against the source
   * verification above — not used in any comparison logic. */
  description: string;
}

export const CHAINLINK_FEEDS: Record<string, Record<string, ChainlinkFeed>> = {
  ethereum: {
    USDC: { address: '0xEa674bBC33AE708Bc9EB4ba348b04E4eB55b496b', description: 'USDC / USD' },
    WETH: { address: '0x5424384B256154046E9667dDFaaa5e550145215e', description: 'ETH / USD' },
  },
  base: {
    USDC: { address: '0x1550207eAeB590D1557a6E6C066D3d57B5A4Dc65', description: 'USDC / USD' },
    WETH: { address: '0x9dA00D23465282005DB222a441a663eE7B9dfCc8', description: 'ETH / USD' },
  },
};

export function resolveChainlinkFeed(chain: string, asset: string): ChainlinkFeed | undefined {
  return CHAINLINK_FEEDS[chain]?.[asset];
}
