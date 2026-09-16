# 0007: Detector context shape, and a two-pass registry for D14 (contagion)

## Context

Spec §5.3 sketches `Detector.evaluate(ctx: DetectorContext): Signal[]` but doesn't
define `DetectorContext` itself. Two design questions had to be settled before any
detector could be written: what data a detector receives, and how D14 ("an asset
flagged anywhere escalates every market exposed to it") gets access to signals other
detectors raised, given `evaluate` is supposed to be pure.

## Decision

- **`DetectorContext`** (`src/signals/types.ts`) bundles, for one evaluation block: a
  `MarketContext` per watched market/vault (current + historical `MarketSnapshot`s,
  collateral exposure, my position, the holder ledger, borrower health, recent
  governance events), an `AssetContext` per priced collateral asset (current +
  historical oracle price and independent market quotes, token-supply history, DEX
  depth), and an `InfraChainSnapshot` per chain. A detector receives the whole bundle
  and loops over whatever subset it cares about (e.g. D01 loops `ctx.markets`, D06
  loops `ctx.assets`), returning zero or more `Signal`s — matching `evaluate`'s
  plural return type and spec §5.1's "signal detectors: pure functions over snapshots
  \[plural\] → signals."
- **Building a real `DetectorContext` from live storage is out of scope for Phase 4.**
  Spec §7 itself says detectors get "unit tests on synthetic data" — Phase 4's job is
  the detectors and a registry, not the storage-to-context wiring. That wiring
  naturally belongs to Phase 5 (the risk engine), which is the first thing that needs
  a live context to actually run detectors against real snapshots on a schedule.
- **D14 (contagion) needs other detectors' output as input** — it isn't computable
  from raw snapshots alone. `DetectorContext` carries a `priorSignals: Signal[]` field,
  empty by default. The registry (`src/signals/registry.ts`) runs every detector
  except D14 first, collects their signals, then runs D14 a second time with
  `priorSignals` populated by that collected list. `evaluate` itself stays pure (same
  inputs → same outputs) — the two-pass structure lives in the registry, not in any
  detector.
- Structural types needed from `src/watchers/large-holders.ts` and
  `src/watchers/token-supply.ts` (holder balances, borrower health, supply snapshots)
  are redeclared locally in `src/signals/types.ts` rather than imported, because both
  watcher modules transitively import `src/chain/**`, and CLAUDE.md's purity rule for
  `src/signals/**` forbids importing from `chain/`/`storage/`/`notify/` — a type-only
  import would compile away, but keeping the boundary literal (no import path crosses
  it at all) is easier to audit than relying on every future edit staying type-only.
  `PriceQuote` from `src/prices/types.ts` is imported directly instead, since that file
  has no I/O of its own and isn't in the forbidden list.

## Alternatives considered

- **Pass `Signal[]` as a separate parameter to `evaluate` for every detector**:
  rejected — it would break the uniform `Detector` interface spec §5.3 sketches (every
  detector implementing the same `evaluate(ctx)` signature is what makes a simple
  registry loop possible), for a need only one detector (D14) has.
- **Give D14 direct read access to other detectors' evaluate functions and call them
  itself**: rejected — that makes D14 impure (it would perform detector orchestration,
  not just evaluate a snapshot) and couples it to the registry's detector list instead
  of the registry owning that list.
- **Build the live context assembler now, in Phase 4**: rejected as scope creep —
  nothing in Phase 4 needs a live context (detectors are tested on synthetic data by
  spec's own instruction), and building it before the risk engine exists to consume it
  risks guessing at a shape Phase 5 will just have to revise.

## Consequences

- Any future detector needing cross-detector input follows D14's pattern
  (`priorSignals`), not a bespoke parameter — the registry's two-pass structure
  already supports it.
- Phase 5 must design the actual assembler: reading `MarketSnapshot`/`CollateralExposure`
  history from storage, joining oracle prices with independent price-source quotes by
  asset symbol, and building `DexDepthSnapshot`s from live Uniswap v3 reads (`liquidity()`
  and `slot0()`, neither of which the Phase 3 `UniswapV3PriceSource` currently fetches
  — it only reads `observe()` for the TWAP). This ADR flags that gap explicitly so
  Phase 5 doesn't rediscover it.
