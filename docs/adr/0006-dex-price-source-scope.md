# 0006: DEX price source scoped to Uniswap v3 TWAP, no Curve pools yet

## Context

Spec §6.5 lists on-chain DEX prices as one of three price sources, giving "Uniswap v3
time-weighted averages via `observe()`, and Curve stable pools" as examples of what
that can mean. The two assets Sentinel currently prices are `USDC` (the asset in every
watched position) and `WETH` (the other asset with a Chainlink feed configured, used as
collateral risk cross-checking material for Phase 4's collateral detectors).

## Decision

- Implement the DEX price source as Uniswap v3 TWAP only (`src/prices/uniswap-v3.ts`),
  covering `WETH` priced in `USDC` on both Ethereum and Base — the deepest-liquidity
  pool per chain, verified on-chain this session (`docs/SOURCES.md`).
- Do not implement a Curve stable-pool price source in this phase. Rationale: Curve's
  stable pools would price one stablecoin against another (e.g. `USDC`/`USDT`/`DAI`).
  `USDC` is the only stablecoin Sentinel currently watches, and its peg is already
  independently cross-checked by Chainlink (`USDC/USD`) and two CEX tickers
  (`coinbase`, `kraken`) — a third, DEX-based `USDC` peg check is marginal value right
  now, not zero value forever. `WETH` isn't a stablecoin, so Curve's stable-pool design
  doesn't apply to it at all; Uniswap v3 is the correct venue for that price.
- If a future watched position adds a second stablecoin (e.g. a Morpho market
  collateralized by `USDT` or `DAI`), add a Curve stable-pool source at that point,
  verified the same way (on-chain, cited in `docs/SOURCES.md`) — this ADR does not
  block that, it just says it isn't needed for the two assets currently in scope.

## Alternatives considered

- **Build both DEX sources now, speculatively**: rejected — CLAUDE.md's conventions
  explicitly discourage building for hypothetical future requirements; a second price
  source for an asset class Sentinel doesn't watch yet is exactly that.
- **Skip DEX pricing entirely until more assets are configured**: rejected — `WETH` is
  already priced via Chainlink and used in collateral-risk reasoning (Phase 4), and
  spec §6.5 explicitly wants an _independent_ on-chain price alongside the oracle feed,
  not just a second oracle read. Uniswap v3 TWAP is cheap to get right for the one
  asset that needs it now.

## Consequences

- `docs/DETECTORS.md`'s future D06/D07 (oracle vs. market price deviation, frozen
  oracle) will have `WETH` covered by three independent sources (Chainlink, Uniswap v3,
  CEX) and `USDC` covered by two (Chainlink, CEX) — enough for the two-independent-
  provider confirmation pattern used elsewhere (safety rule 7), with Uniswap v3 as the
  odd one out on `USDC` rather than a gap.
- Adding a new priced asset later means checking whether it needs a Curve pool (is it a
  stablecoin traded against other stablecoins) or a Uniswap v3 pool (is it traded
  against a volatile pair) — this isn't automatic and needs the same on-chain
  verification step `uniswap-v3-addresses.ts`'s header comment describes.
