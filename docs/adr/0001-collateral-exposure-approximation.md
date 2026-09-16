# 0001: Collateral exposure approximation method

## Context

Spec §6.2: for a stablecoin supplier, the real risk is the pool's whole collateral
base — every asset borrowers can post against it — not just the stablecoin itself.
`ProtocolAdapter.collateralExposure(marketId, at)` needs to return, for a given market,
the exposure to each collateral asset borrowers are actually using.

The "correct" answer requires enumerating every borrower position in the market and
summing collateral by asset. For Aave v3 (a shared pool across all listed assets),
this means iterating all borrowers and their `getUserReserveData` / equivalent — an
unbounded, potentially very large read that isn't cheap to do every block, and gets
worse as a market grows. For Morpho Blue (isolated markets, single collateral asset
per market by construction), there's no approximation needed at all: a market's
collateral asset *is* its whole collateral exposure, 100% weighted, by protocol design.

## Decision

- **Morpho Blue**: exact by construction — `collateralExposure` returns the market's
  single collateral asset at 100% (or 0% if the market currently has zero collateral
  deposited, which is knowable from `totalBorrowAssets`/on-chain state directly).
- **Aave v3**: approximate using protocol-level aggregates rather than per-borrower
  enumeration:
  - Pull each listed reserve's aggregate borrow-side numbers (total variable/stable
    debt, if applicable) as a proxy for "how much borrowing is happening against this
    asset as debt," and each listed reserve's total supplied as the ceiling on how much
    of it *could* be posted as collateral.
  - For a first-cut weighting, treat every listed collateral-enabled reserve's *share
    of total supplied value across the pool* as its approximate share of the
    collateral base, rather than attempting to attribute specific borrow positions to
    specific collateral assets (which Aave's aggregate reserve data does not expose
    without per-user enumeration).
  - This is a **coarse upper-bound-style approximation**, not an exact accounting. It
    will over-count "safe" collateral (e.g. large stablecoin supply that mostly isn't
    used as collateral) and under-count concentration in a single risky asset if that
    asset's total supply is small relative to the pool but heavily borrowed against.
  - The large-holder watcher (spec §6.6) and D05/D15 detectors partially compensate:
    they track top suppliers/borrowers directly from event logs, which can refine the
    exposure picture over time without requiring full enumeration every block.
  - Revisit this approximation once Phase 2 is far enough along to measure how far it
    diverges from a periodic exact enumeration (e.g. run the exact computation
    on-demand, off the hot path, and compare) — if it diverges a lot in practice,
    consider a slower, cached "exact" pass (e.g. every N blocks) feeding into the
    per-block approximate one.

## Alternatives considered

- **Full per-borrower enumeration every block**: exact, but expensive (unbounded RPC
  calls scaling with borrower count) and works against the "keep call volume down"
  principle in spec §6.1. Rejected as the default; may become a periodic (not
  per-block) supplementary computation later.
- **Ignore collateral exposure for Aave entirely, only track the stablecoin reserve
  itself**: rejected outright — this is exactly the blind spot spec §6.2 calls out as
  the real risk for a stablecoin supplier (a pool's collateral base going bad is what
  produces bad debt that stablecoin suppliers eat).

## Consequences

- Aave `collateralExposure` values are approximate and should be presented/labeled as
  such (evidence should make clear this is an aggregate-based estimate, not a
  per-borrower sum) wherever they feed a detector or a report.
- D14 (contagion) and D08/D06/D07 (collateral-specific detectors) still work correctly
  off this approximation for *detecting that something is flagged*; the approximation
  mainly affects how much *weight* a flagged asset gets when escalating exposure
  through the pool, not whether it's detected at all (asset-level detectors read the
  asset's own price/supply behavior directly, not through this approximation).
