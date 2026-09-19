# 0014: Liquidation scanner — subgraph discovery, on-chain truth, detection only

## Context

Sentinel's mission (docs/SPEC.md) is protecting the user's own position, not earning
money for its own sake. Asked directly whether live execution would be "making
money," the honest answer worked out to: no — a well-tuned watchdog earns exactly
the underlying pool's yield in a normal week, the same as doing nothing; its real
value is avoiding a rare, large loss, not generating one. The user then asked how to
make something that *earns*. Discussed three directions (leverage/looping, active
trading, liquidation-bot/MEV searching) — leverage and active trading both take on
real principal-loss risk in exchange for return, a fundamentally different risk
posture than this project's "protect my deposit" design. Liquidation searching is
different: profit comes from *other* users' already-triggered liquidations, with no
principal risk to the scanner's own funds if it never executes — closer in spirit to
this project's existing detection-first, paper-before-live discipline. User chose
this direction, explicitly wants it in the same repo, and explicitly asked to start
with a detection-only scanner (find and log real theoretical opportunities) before
any execution logic — the same order this whole project has built every other
money-adjacent capability in (watch → paper → live, Phases 5/7/8).

The first real design problem: "find all liquidatable users" doesn't scale via raw
RPC event scanning. Reconstructing every Aave v3 Core USDC borrower's position from
`Supply`/`Borrow` events since the pool's deployment would need replaying its entire
history — impractical against a free-tier RPC's `eth_getLogs` range cap (9 blocks,
already documented elsewhere in this project). Real liquidation bots solve this with
an indexer. Aave publishes an official one: the `aave/protocol-subgraphs` repo,
hosted on The Graph. Verified (not guessed) against the real schema
(`schemas/v3.schema.graphql`, raw.githubusercontent.com, `main` branch, fetched
2026-09-19): the schema does **not** expose a computed health factor anywhere —
`User`/`UserReserve` only carry raw per-reserve balances
(`currentATokenBalance`/`currentVariableDebt`/etc.) and `User.borrowedReservesCount`.

## Decision

Two-tier design, matching this project's existing "never trust an indirect source
for a real number" discipline (the same reasoning behind `RpcPool.quorumRead`,
`decodeEventLog` over topic-hash guessing, etc.):

1. **Subgraph = discovery only.** Query `users(where: { borrowedReservesCount_gt: 0
   })`, paginated via an `id_gt` cursor (not `skip`, which The Graph degrades/caps at
   depth) — cheap, and gives a candidate list no RPC-only approach could produce
   affordably. Nothing from this step is ever trusted as a real number.
2. **On-chain = ground truth.** Every candidate's real health factor comes from
   `getUserAccountData()` (`src/watchers/large-holders.ts`'s already-existing
   `fetchAaveBorrowerHealth`, reused as-is), quorum-read across independent
   providers exactly like every other decision-relevant chain read in this project
   (safety rule 7's spirit, even though this module logs rather than decides).
   Per-reserve breakdown (which specific reserve to repay/seize —
   `getUserAccountData` only gives account-wide totals, the same limitation D15's
   own doc comment already documents) comes from `getUserReserveData`, added to
   `poolDataProviderAbi` this session and verified against the official
   `aave-dao/aave-v3-origin` repo, the same sourcing discipline every existing ABI
   entry in this project already follows.

Profit estimation (`src/liquidations/profit.ts`) reproduces Aave's real close-factor
rule (`CLOSE_FACTOR_HF_THRESHOLD = 0.95e18`, `MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD =
$2,000`, 50%/100% split) — verified against `LiquidationLogic.sol`, not
reimplemented from memory. It is explicitly labeled an *estimate*: gas and DEX
slippage converting seized collateral back to the debt asset are not modeled (no real
routing data exists yet to model them honestly), and the contract's
`MIN_LEFTOVER_BASE` edge case is simplified away. `grossProfitBase` is a theoretical
upper bound for evidence-gathering, not a number ready to act on — before any
execution is ever built on this module, its output should be cross-checked via real
fork simulation, this project's own established "simulate before trusting a number"
standard (safety rule 5).

Detection only, by design: `src/liquidations/` never imports a signer, never builds
a transaction, and the new `liquidation_opportunities` table is pure append-only
evidence, written by nothing that acts on it. `sentinel scan-liquidations` is a
one-shot CLI command (not wired into `sentinel watch`'s loop or the risk-decision
pipeline) — deliberately kept structurally separate from the existing watchdog so
this experimental, higher-risk-category module can't accidentally influence a real
withdrawal decision.

## Alternatives considered

- **Raw RPC event backfill for borrower discovery** — rejected: the free-tier
  `eth_getLogs` range cap makes a full historical backfill impractical, and even a
  paid tier would mean re-deriving what an indexer already solves well.
- **Trusting the subgraph's raw balances directly for the liquidation decision** —
  rejected: the subgraph can lag, and more fundamentally doesn't even expose a
  health factor, so there's no shortcut here even if it were trusted; the on-chain
  read is mandatory regardless, so it becomes the sole source of truth by
  necessity, not just caution.
- **Building this as a separate project/repo** — user explicitly chose the same repo.
  Kept structurally isolated (own directory, own storage table, own CLI command, no
  wiring into `runOnce`/the risk engine) so it doesn't inherit or dilute the core
  watchdog's safety posture, rather than trying to retrofit CLAUDE.md's
  "protect-my-own-deposit" safety rules onto a fundamentally different threat model
  ("compete for other users' liquidations").

## Consequences

- A new external dependency (The Graph's decentralized network) and a new secret
  (`GRAPH_API_KEY`) — free tier (100,000 queries/month) comfortably covers a
  periodic scan, verified via web research this session, not assumed.
- The exact subgraph deployment ID per chain (`AAVE_SUBGRAPH_ID_ETHEREUM` /
  `AAVE_SUBGRAPH_ID_BASE`) was found via the README/Explorer, not independently
  confirmed against a real live query this session (no API key was available to
  test with) — the very first thing to do once a real key exists is a live test
  query, before trusting any scan output.
- No real evidence yet on whether real, competitive-scale opportunities exist on
  the currently-scoped markets (Aave v3 Core, Ethereum + Base) — that's exactly
  what this detection-only phase exists to produce. Expect most scans to find
  nothing publishable as "a real business," per the realistic competitive framing
  given to the user before building this.
- Morpho Blue liquidations are out of scope here — different mechanics (per-market
  LTV, no single "healthFactor"), needs its own research before extending.
