# Architecture

See `docs/SPEC.md` for the full build spec this implements. This document describes
how the pieces fit together and why, at a level that should stay accurate across
phases (update it when a structural decision changes; don't let it drift).

## 1. Pipeline

```
new block on each chain (after N confirmations)
  │
  ▼
Collectors: protocol adapters, price sources, watchers   [src/protocols, src/prices, src/watchers]
  │   every read in a snapshot is pinned to one block number
  ▼
Snapshot store (SQLite)                                  [src/storage]
  │
  ▼
Signal detectors: pure functions over snapshots          [src/signals]
  │
  ▼
Risk engine: one state machine per position               [src/risk]
  │
  ▼
Action planner                                             [src/actions]
  ├──▶ Notifier (Telegram, Discord, console)               [src/notify]
  ├──▶ Paper executor (simulates on a fork, never signs)
  └──▶ Live executor (Phase 8, gated, Safe + Roles only)
  │
  ▼
Reports, metrics, decision log                              [src/reports, src/ops]
```

A single `runOnce(blockRef)` pipeline function drives every stage in order. It is
invoked by two different callers that never diverge in behavior:

- **Live**: `src/chain`'s block source calls it once per confirmed block, per chain.
- **Replay**: `src/replay`'s runner calls it once per historical block pulled from
  cache, feeding a `Clock` that reports the historical timestamp instead of wall time.

## 2. Design principles and how they're enforced in code

- **One code path for live and replay.** `Pipeline` (in `src/core/pipeline.ts`, added
  in Phase 5) takes an injected `BlockSource` and `Clock` interface. Nothing downstream
  of the pipeline entry point is allowed to call `Date.now()`, a chain RPC, or a
  wall-clock timer directly — those all go through the injected interfaces so replay is
  bit-for-bit the same code as production.
- **Pure detectors.** Every `Detector.evaluate()` is a synchronous, allocation-only
  function: `(ctx: DetectorContext) => Signal[]`, no `await`, no imports from
  `src/chain` or `src/storage`. This is enforced by convention plus an ESLint
  `no-restricted-imports` rule scoped to `src/signals/**` (added in Phase 1) that
  blocks importing anything from `chain/`, `storage/`, or `notify/`.
- **Explainable decisions.** Every state transition in `src/risk` writes a
  `DecisionRecord` row: the signals that fired, their evidence, the rule that matched,
  the block numbers involved, and a hash of the active config. `DecisionRecord`s are
  append-only.
- **Idempotent and restartable.** `src/storage` tracks `last_processed_block` per
  chain. On startup, the block source resumes from `last_processed_block + 1` and
  backfills sequentially; it never skips a block silently.

## 3. Data flow and block pinning

A `MarketSnapshot` (and every other collector output) is only ever read at one
specific `BlockRef`. Collectors use viem `multicall` against that block number so a
snapshot can't straddle two blocks. Two independent RPC providers are queried for every
decision-critical value (balances, liquidity, oracle prices, pause/freeze flags); a
mismatch at the same block number becomes an infra signal (D16) rather than silently
picking one provider's answer.

Reorgs are detected by comparing each new block's parent hash against the previously
stored block hash at that height, per chain. On mismatch, everything derived from the
orphaned block (snapshots, signals, decisions) is rolled back and reprocessed from the
new canonical chain, starting after the chain's configured confirmation depth.

## 4. Protocol adapters

All protocol-specific logic lives behind `ProtocolAdapter` (see `docs/SPEC.md` §5.3).
Aave v3, Morpho Blue, and Morpho vaults are the Phase 2 adapters; the interface is
deliberately protocol-agnostic (`discoverPositions`, `snapshotMarkets`,
`collateralExposure`, `withdrawable`, `buildWithdraw`, `decodeEvents`) so a later Aave
v4, Euler, Spark, or Fluid adapter is additive, not a rewrite. Chain support is
config-driven through viem chain definitions; adding an EVM chain viem supports means
adding config and (if the chain needs it) new verified addresses, not new adapter code.

## 5. Risk engine

One state machine instance per **position** (not per market — a user's exposure to one
market through both a direct Aave supply and a Morpho vault look-through are two
positions that can both reference the same underlying market/asset risk). States:
`NORMAL → WATCH → DANGER → CRITICAL`, with corroboration (≥2 signal families, except
standalone-critical detectors), rate-of-change-aware escalation, and hysteresis-gated
de-escalation. See `docs/SPEC.md` §8.1 for the exact rules — they are safety-relevant
and should not be re-derived from memory; re-read the spec section.

## 6. Actions

The action planner is one code path across all three execution modes (`off`, `paper`,
`live`); only the last stage (does it actually sign and send) differs. `off` logs the
plan. `paper` runs the exact same plan through an Anvil-fork simulation. `live` (gated
behind Phase 8 completion and the user's own per-chain config flag) additionally
requires the Safe + Zodiac Roles permission scoping described in spec §8.4, an
allowlist check in code (recipient must be the configured Safe), and a pre-send
simulation against the latest block that must show exactly "position down, Safe up by
the expected amount" or the send is aborted.

## 7. Storage

SQLite (via better-sqlite3, WAL mode) is the only datastore. Versioned, numbered
migrations live in `src/storage/migrations/`; the migration runner is idempotent and
records applied versions in a `schema_migrations` table. No ORM — hand-written
repositories per aggregate (snapshots, signals, decisions, alerts, labels) keep the
schema and the query patterns easy to audit, which matters for a system whose whole
value proposition is auditable decisions.

## 8. Observability

Structured JSON logs (pino) everywhere; a Prometheus `/metrics` endpoint and a health
endpoint (`src/ops`) expose block lag, detector timings, provider errors, and state
counts. The daily report (`src/reports`) is the primary human-facing artifact and is
generated from the same DecisionRecord/signal/snapshot tables the live system writes,
so "what the report says happened" and "what the system actually decided" can never
diverge by construction.

## 9. Repository layout

See `docs/SPEC.md` §5.2 for the target layout; it is followed as specified.
