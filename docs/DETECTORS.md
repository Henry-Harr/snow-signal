# Detectors

Phase 4 (docs/SPEC.md §7, §13). Every detector lives in its own file under
`src/signals/`, is a pure function of a `DetectorContext` (`src/signals/types.ts`) —
no I/O, no imports from `chain/`, `storage/`, or `notify/` (CLAUDE.md) — and is wired
into the registry (`src/signals/registry.ts`, `defaultDetectors()`/`evaluateAll()`).
Each detector's own file header comment is the authoritative source for its exact
formula, default thresholds, and known false-positive sources; this file is a shorter
index plus anything not obvious from reading spec's own table.

**All thresholds below are placeholders**, per spec §7 — they live in config
(wiring that into `sentinel.yaml` is a Phase 5 concern) and are only ever retuned
through replay evidence (`docs/TUNING_LOG.md`), never edited on a hunch.

**`DetectorContext` is not yet wired to live storage.** Every detector here is tested
against synthetic contexts (`test/unit/signals/helpers.ts`), per spec §7's own
instruction ("unit tests on synthetic data"). Building the assembler that reads
`MarketSnapshot`/price-quote/event history from SQLite and produces a real
`DetectorContext` for a live block is Phase 5's job (the risk engine is the first
thing that actually needs to run detectors on a schedule) — see ADR 0007 for the
design reasoning and the specific gaps it flags (joining oracle prices to independent
quotes by asset symbol, building `DexDepthSnapshot`s from live Uniswap v3 reads,
resolving vault look-through into `assetExposure`).

| ID  | Detector                          | Family     | File                               |
| --- | --------------------------------- | ---------- | ---------------------------------- |
| D01 | Utilization level                 | pool_flow  | `D01_utilization_level.ts`         |
| D02 | Utilization velocity              | pool_flow  | `D02_utilization_velocity.ts`      |
| D03 | Exit coverage                     | pool_flow  | `D03_exit_coverage.ts`             |
| D04 | Abnormal net outflows             | pool_flow  | `D04_abnormal_outflows.ts`         |
| D05 | Large-holder exits                | pool_flow  | `D05_large_holder_exits.ts`        |
| D06 | Oracle vs. market price deviation | collateral | `D06_oracle_market_deviation.ts`   |
| D07 | Frozen oracle                     | collateral | `D07_frozen_oracle.ts`             |
| D08 | Collateral supply anomaly         | collateral | `D08_collateral_supply_anomaly.ts` |
| D09 | Collateral liquidation depth      | collateral | `D09_liquidation_depth.ts`         |
| D10 | Peg deviation                     | peg        | `D10_peg_deviation.ts`             |
| D11 | Bad debt / deficit                | collateral | `D11_bad_debt.ts`                  |
| D12 | Risky governance/config change    | governance | `D12_risky_governance_change.ts`   |
| D13 | Vault allocation drift            | governance | `D13_vault_allocation_drift.ts`    |
| D14 | Contagion                         | collateral | `D14_contagion.ts`                 |
| D15 | Share of debt near liquidation    | collateral | `D15_debt_near_liquidation.ts`     |
| D16 | Infra health                      | infra      | `D16_infra_health.ts`              |

## Shared building blocks (`src/signals/util.ts`)

- `severityAtLeast`/`severityAtMost` — the two threshold-comparison shapes almost
  every detector uses ("higher is worse" vs. "lower is worse").
- `findTimeBaseline` — "the latest history entry still at least N seconds old,"
  used by every detector that computes a rate of change over a fixed lookback window
  (D02, D08).
- `modifiedZScore` — the robust (median/MAD-based) z-score D04 uses, reusing
  `median`/`medianAbsoluteDeviation` from `src/prices/aggregate.ts`.

## Standalone-critical and alert-only detectors (spec §8.1)

- **D06** at `critical` severity, and **D11** (any severity — it only ever fires at
  `critical`) are the two detectors spec explicitly allows to trigger a full exit
  without corroboration from a second signal family.
- **D10** (peg deviation) is never `standaloneCritical`, and per ADR 0005 the risk
  engine (Phase 5) must additionally exclude it from the standard action policy
  regardless of severity — a depeg alert must never itself trigger an automatic exit.
- **D16** (infra health) never reaches `critical` at all and is never
  `standaloneCritical` — infra signals alone must never cause an exit (spec §8.1).

## D14's two-pass registry (ADR 0007)

D14 (contagion) needs every other detector's output as input — it isn't computable
from raw snapshots alone. `evaluateAll()` runs every detector except D14 first,
collects their signals into `DetectorContext.priorSignals`, then runs D14 once more
against that populated context. Every other detector's `evaluate` is still called
exactly once; the two-pass structure lives entirely in the registry, not in any
detector, so `Detector.evaluate(ctx): Signal[]` stays a uniform, pure interface
across all sixteen.

## Known cross-cutting limitations

A few detectors share the same underlying gap, worth reading once instead of
per-detector:

- **Address ↔ symbol joins are not a detector's job.** Protocol data (Aave reserves,
  `CollateralExposure`) is address-keyed; price quotes and asset-family signals are
  symbol-keyed. Every detector that needs both sides already-joined receives
  pre-joined data in its `DetectorContext` slice (`AssetContext.marketId`,
  `AssetExposureEntry`, `AssetContext.collateralAmount`) rather than performing the
  join itself — see `types.ts`'s header comment and ADR 0007.
- **Borrower health is Aave-only and account-wide, not per-reserve** (D15) — see that
  detector's own doc comment for exactly what "share of debt" means here instead.
- **"New market" detection has no cross-run state yet** (D13) — every allocation
  event fires `watch` unconditionally until Phase 5/6 can diff against a stored
  previous queue.
- **D09's DEX depth is a single-active-tick approximation**, not full concentrated-
  liquidity tick-walking — it systematically under-, not over-, estimates true depth,
  which is the safer direction for a risk detector to err in.
- **No detector reads `MarketSnapshot.flags.paused`** (found in the Phase 6 session,
  building a synthetic "paused withdrawals" fault-injection scenario —
  `src/replay/synthetic-scenario.ts`). A market flipping to paused produces zero
  signals today; a real detector for this (or extending an existing one) is open work,
  not yet built.
- **D03/D10's `kind:'position'` signal subject was fixed in the Phase 6 session**:
  both used to key off the protocol adapter's own `Position.id` (`marketId:owner`),
  which never matched `decide()`'s `positionId` input (the canonical
  `protocol:chain:market:asset` form, docs/adr/0002) — so both signals were silently
  unreachable by the risk engine in every real run. Now both key off `market.marketId`
  instead, which is provably the same string as the canonical position id whenever
  `MarketContext.position` is set (see the fix's own comment in
  `src/signals/D03_exit_coverage.ts`). Caught by a synthetic replay scenario, not by
  any of Phase 4/5's existing unit/property tests — see docs/PROGRESS.md's Phase 6
  session note for why those tests never exercised this path.

## Testing convention

Every detector's test file (`test/unit/signals/D*.test.ts`) covers, at minimum: a
normal/no-signal case, a borderline threshold case, an alarming case, and at least one
documented false-positive scenario from that detector's own doc comment — per spec
§7 and CLAUDE.md's Phase 4 checklist. Synthetic contexts are built with the shared
fixtures in `test/unit/signals/helpers.ts` rather than duplicated per test file.
