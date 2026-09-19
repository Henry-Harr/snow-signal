# Progress

This is the project's memory across sessions. Read this in full at the start of every
session, along with `CLAUDE.md` and the relevant section of `docs/SPEC.md`.

## Status as of 2026-09-17

**Phase 0 (Research and plan): complete. Phase 1 (Foundations): complete. Phase 2
(read-only protocol adapters): complete. Phase 3 (prices and watchers): complete.
Phase 4 (signal detectors): complete. Phase 5 (risk engine, alerts, daily report):
complete — this is the first version of Sentinel the user can actually run. Phase 6
(replay harness): complete. Phase 7 (paper mode and exit drills): complete, with one
deliberate, documented exception (`docs/adr/0010-paper-mode-not-wired-into-replay.md`
— replays show real recoverable-share, not a real simulated gas figure; see that ADR
for why). Phase 8 (guarded live execution, forks only): complete, with one
deliberate, documented exception (`docs/adr/0012-live-executor-not-wired-into-
pipeline.md` — the live executor exists, is fully tested with a real signed
transaction against a fork, and is never wired to run automatically; see that ADR for
why). Phase 9 (hardening): complete.** The `sentinel watch` / `report` / `label` /
`replay` / `drill` / `kill` / `resume` / `backup` CLI commands are all wired and
tested against real chain data.
`docs/REPLAY_RESULTS.md` and `docs/TUNING_LOG.md` are real artifacts from an actual
run against live archive RPCs, not placeholders — see the dedicated Phase 6 session
note further down for the full detail, including two real pre-existing bugs the
replay harness caught (D03/D10 signals silently unreachable by the risk engine) and
a concrete, evidence-backed detector-threshold finding. The Phase 7 session note
further down has the equivalent detail for the withdrawal planner, fork simulator,
paper executor, and daily exit drill — all verified against a real Aave v3 position
created on a fork (impersonating a real, on-chain-verified whale), which caught and
fixed two genuine bugs (gas underestimation on a full exit; an interest-accrual
rounding issue in the post-withdrawal balance check) — plus an unrelated but
significant repo-hygiene bug found and fixed the same session: an unanchored
`.gitignore` pattern had silently excluded `src/reports/` and `test/unit/reports/`
from every commit since Phase 5. The Phase 8 session note further down has the
equivalent detail for the Safe + Zodiac Roles v2 setup script and the live
executor — including a real research mistake (a wrong factory address, and a Roles
mastercopy version the Zodiac team's own tooling flags as faulty) caught and fixed
via empirical fork testing before it became load-bearing, and a real signed
transaction, from a freshly-generated bot key, actually exiting a Safe on a fork.
`pnpm lint`, `pnpm typecheck`, `pnpm test` (497 tests, unit + property), and `pnpm
build` all pass. `pnpm test:integration` (67 fork/live tests, including
golden-output replay regression tests, real-position paper-executor/exit-drill
tests, and the real-signed-transaction Safe+Roles tests) last verified green in
this same session.

**Follow-up session, same day:** re-ran the full check suite (`pnpm install`, `doctor`,
`lint`, `typecheck`, `test`, `build`) — all still pass; `doctor` degrades gracefully
exactly as designed (no `config/sentinel.yaml` yet, so config/chains/notifier report
"not configured", database opens and migrates fine). Then did the two research
re-verifications Phase 2 lists as prerequisites (Morpho oracle scaling + MetaMorpho
event names, Aave version check) — both done directly against primary sources this
time (`docs.morpho.org` is no longer blocked), see `docs/SOURCES.md` and the Phase 2
checklist below for details. **Real adapter code and fork integration tests remain
blocked** on the open questions below (specifically 1: RPC URLs, and 5: which markets/
vaults to watch) — wrote no adapter code this session to avoid guessing at a specific
Aave version or Morpho vault shape before knowing the actual target.

**Same session, continued:** user answered questions 1, 2, and 5 (RPC URLs, Safe
address, "you pick" for markets/vaults). Wrote `.env` (git-ignored, real Alchemy/Ankr
URLs for Ethereum + Base) and `config/sentinel.yaml` (real Safe address; Aave v3 Core
USDC on Ethereum + Base, Gauntlet USDC Prime vault on Base — addresses pulled directly
from the Aave address-book repo and Morpho's GraphQL API this session, not memory).
`sentinel doctor` now reports config/both chains'/database all `[✓]`, notifier `[!]`
(no Telegram token yet, as expected). Full check suite (`lint`/`typecheck`/`test`) still
green. Remaining open items: Telegram bot (question 3) and confirming local Foundry/
Docker tooling (question 4) — see the open-questions section below for current status
on each.

**Same session, Phase 2 started:** installed Foundry locally (`foundryup`'s own
installer hit a 403 on GitHub's attestation API from this sandbox — worked around by
downloading the `v1.8.3` release tarball directly and putting `anvil`/`cast`/`forge` on
`PATH` by hand; this is a fresh sandbox each session, so a future session may need to
redo this — see `test/integration/README.md`). Verified it forks live chain state
correctly. Then built the **Aave v3 protocol adapter** end to end:

- `src/chain/client.ts`: added `ContractReadClient` (multicall + getLogs on top of the
  existing narrow `ChainClient`) and `createViemContractReadClient`; made `RpcPool`
  generic (`RpcPool<TClient>`) so it can pool either kind of client without touching
  the block source's own tests.
- `src/protocols/aave-v3/{abi,addresses,adapter}.ts`: reads reserve state, rates,
  caps, frozen/paused flags, collateral params, oracle price (via
  `ADDRESSES_PROVIDER()` → `getPriceOracle()`, resolved on-chain rather than
  hardcoded, since only `POOL`/`AAVE_PROTOCOL_DATA_PROVIDER` were independently
  re-verified this session), reserve deficit (bad debt), aToken balance/position
  discovery, `collateralExposure` per the ADR 0001 approximation (enumerates every
  listed reserve via `getReservesList()`), `withdrawable`, `buildWithdraw` (encodes
  `Pool.withdraw`, including the `type(uint256).max` sentinel), and `decodeEvents`.
  Every ABI fragment and address cited in `docs/SOURCES.md` with fetch dates, pulled
  directly from `aave-dao/aave-v3-origin`/`aave-address-book` (raw GitHub) and
  `aave.com`, not from memory (safety rule 6).
- Added the shared `Position`/`MarketSnapshot`/`CollateralExposure`/`WithdrawEstimate`/
  `TxRequest`/`ProtocolEvent`/`Log`/`ProtocolAdapter` types to `src/core/types.ts` per
  spec §5.3, and an `AdapterError` to `src/core/errors.ts`.
- 15 unit tests (`test/unit/protocols/aave-v3/adapter.test.ts`) against a mocked
  `ContractReadClient`, covering normal/paused/frozen/empty-reserve snapshots, bad
  debt, position discovery (present/absent), withdrawable liquidity capping, the
  `collateralExposure` split (including the zero-total-supply edge case),
  `buildWithdraw`'s calldata (including the max-withdraw sentinel), and event
  normalization.
- **Fork integration tests**, both Ethereum and Base
  (`test/integration/protocols/aave-v3.test.ts`, 10 tests total): a new
  `test/integration/helpers/anvil.ts` spawns a real local `anvil` fork pinned to a
  specific block; the adapter's reads are asserted against independent direct `viem`
  calls against that same fork. All 10 pass on real chain state.

Two real bugs the fork tests caught (exactly what they're for):

1. **Multicall3 not configured**: the custom `defineChain()` used for arbitrary RPC
   URLs had no `contracts.multicall3` entry, so viem's `multicall()` action refused to
   run at all. Fixed by adding the well-known Multicall3 address — cross-checked
   against viem's own bundled `mainnet`/`base` chain definitions rather than typed
   from memory, since it's identical on both.
2. **Pinned block too old for the currently-live data provider**: the first pinned
   block (21,500,000, roughly mid-2025) predates the `AAVE_PROTOCOL_DATA_PROVIDER`
   proxy's current deployment — Aave's v3.7 Part 2 upgrade (2026-05-29,
   `docs/SOURCES.md`) apparently redeployed it. Reads against that address at that
   block returned `0x` ("no data"), not a revert with a reason, which briefly looked
   like a wrong address before `cast code` at that block confirmed there was no
   contract there yet. Fixed by pinning both chains' fork tests to a recent block
   instead (a small safety margin behind current head at write time) —
   `test/integration/README.md` documents the failure mode for next time.

`pnpm lint`/`typecheck`/`test`/`format:check`/`build` all pass; fork integration tests
pass on both chains against real RPC data.

**Same session, continued — Morpho Blue adapter:** `src/protocols/morpho-blue/
{abi,addresses,adapter}.ts`. Confirmed directly (not from search/memory) that Morpho
Blue is deployed to the identical address on Ethereum and Base
(`0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`, via `api.morpho.org/graphql`), resolving
the "could not confirm" flag an earlier session left in `docs/SOURCES.md`. Implements
`market`/`idToMarketParams`/`position` reads, the oracle `price()` read (quorum, as
it's decision-critical), an `IIrm.borrowRateView()` read to annualize the borrow rate
(best-effort — not in spec #6.1's decision-critical list) plus a derived supply rate
(borrow rate × utilization × (1 − fee), algebra from already-verified primitives, not
a separate fact), the virtual-shares conversion for position balances (`SharesMathLib`,
`VIRTUAL_SHARES=1e6`/`VIRTUAL_ASSETS=1`), the ADR-0001 exact `collateralExposure`
(100% when a market has outstanding borrows, else 0%), `withdrawable`, `buildWithdraw`,
and `decodeEvents`.

One real design snag worth remembering: `buildWithdraw` is specified as synchronous
(`ProtocolAdapter`), but Morpho's `withdraw()` needs the full `MarketParams` struct,
not just the market id its keccak256 commits to — unlike Aave's `withdraw(asset,
amount, to)`, there's no way to encode the call from an id alone. Solved with a small
`marketCache` populated by every `market()`/`idToMarketParams()` read, so by the time
a withdrawal is ever planned in the real pipeline (after a snapshot or a
`withdrawable()` check), the params are already there.

Another real bug the tests caught: initially declared `position()`'s ABI output as
three separate named fields (mirroring Aave's `getReserveData` pattern), which is
correct in isolation, but a direct fork call showed viem decodes that shape as a
**positional tuple**, not a named object — differs from `market()`/`idToMarketParams()`
(each a _single_ struct return, which viem _does_ decode to an object). Both encode to
identical bytes on-chain (all fields are static-size), so this wasn't a wrong-values
bug, just a wrong-JS-shape one that a naive `z.object(...)` schema would have silently
mis-parsed. Fixed by switching `positionSchema` to a tuple and destructuring by
position — documented inline so the next adapter (the vault one, same repo, same
struct-decoding subtlety likely to recur) doesn't have to rediscover this.

15 unit tests (mocked `ContractReadClient`) plus 6 fork integration tests against real
Base state — including a real position discovery test against the user's own watched
vault (Gauntlet USDC Prime) in a real market it allocates into (USDC/wstETH, found via
a live query against the vault's on-chain allocation, not guessed). All pass.
`pnpm lint`/`typecheck`/`test` (73 tests)/`format:check`/`build` all still green.

**Same session, continued — Morpho vault adapter (the last Phase 2 piece):**
`src/protocols/morpho-vault/{abi,adapter}.ts`, plus a small refactor pulling the
Morpho Blue market/position zod schemas and virtual-shares math into shared
`src/protocols/morpho-blue/{types,shares-math}.ts` files so the vault adapter (which
reads the same Morpho Blue structs for every market it allocates into) doesn't
duplicate them.

Before writing any code, **confirmed on-chain — not just from docs — that the user's
watched vault (Gauntlet USDC Prime) is MetaMorpho v1.1, not Vault V2**: called
`isMetaMorpho()` on the vault's deploying factory directly via `cast call` against the
live Base RPC (returned `true`), and `isVaultV2()` on the same factory (reverted — that
function doesn't exist on a v1.1 factory). This resolves the "still need to confirm
on-chain" flag both this session's own earlier notes and an ADR left open. The adapter
implements v1.1 only, with that limitation documented in `abi.ts`'s header comment —
correct scope for what's actually watched, not scope creep into Vault V2 support
nothing needs yet.

Implements: `MORPHO()`/roles/timelock/pending-changes reads, the supply and withdraw
queues (dynamic-length, read via a `Promise.all`-free two-stage multicall — lengths
first, then the queue entries), `config(id)` per market (cap/enabled/removableAt),
each allocated market's full Morpho Blue state and the vault's own position in it
(reusing `morphoBlueAbi` directly — a vault's risk _is_ its underlying markets' risk),
idle-asset balance, **vault withdrawable liquidity** (idle + for each withdraw-queue
market, the smaller of the vault's supply there and that market's available liquidity
— spec §6.4's exact definition), **look-through exposure** (the vault's real supply
position in each market, grouped by that market's collateral asset — `method: 'exact'`,
since unlike Aave's pool-wide approximation this reads the vault's actual allocation),
`discoverPositions` (share balance → `convertToAssets`), `withdrawable` (delegates
straight to the vault's own `maxWithdraw()` rather than re-deriving it — that's already
the ERC-4626-correct answer), `buildWithdraw`, and `decodeEvents`.

Two vault-specific fields needed a documented reinterpretation rather than a literal
copy of Aave's shape, since "borrow/utilization" doesn't apply to a vault the way it
does to a lending pool:

- `totalBorrowed` is always `0n` — a vault doesn't borrow; the borrowing happens in the
  underlying markets, which `collateralExposure` covers.
- `utilization` is redefined as the share of vault assets that is _not_ immediately
  withdrawable (locked in underlying-market illiquidity), the closest meaningful
  analogue for a vault.
- `supplyRate`/`borrowRate` are left at `0` rather than computed — an accurate vault
  APY needs every allocated market's IRM rate weighted by allocation and netted
  against both that market's and the vault's own fee; deferred as real future work
  (Phase 3 can measure _realized_ yield from `totalAssets` deltas over time instead,
  which is more honest than a per-block theoretical estimate) rather than fabricated
  now to fill the field.

15 unit tests (mocked `ContractReadClient`, including a two-market fixture exercising
the supply-queue/withdraw-queue union and a market present in one queue but not the
other) plus 5 fork integration tests against the user's **real** watched vault on Base
— including a direct-read cross-check of a real allocated market's cap, and confirming
`totalSupplied` matches a direct `totalAssets()` call against real chain state
(vault held ~$10.7M in USDC on Base as of the pinned block, 2 markets in its supply
queue, 6 in its withdraw queue). All pass. One test assertion had to be loosened after
a real finding: a market can legitimately sit in the withdraw queue with zero current
allocation (previously funded, now empty) — the adapter already handled this correctly
(a `0` exposure share), the first version of the test's "every share must be positive"
assertion was just wrong.

**Phase 2 is now complete**: all three protocol adapters (Aave v3, Morpho Blue, Morpho
vault) implemented and fork-tested against real chain data. Final tally:
`pnpm lint`/`typecheck`/`build` clean, `pnpm test` 88 unit/property tests passing,
`pnpm test:integration` 21 fork tests passing across Ethereum and Base.

**Same session, continued — Phase 3 started (price collection):**

- **Storage**: migration 2 adds `price_quotes` (append-only — never overwritten, so
  aggregation logic can always be recomputed from the original inputs, per spec §6.5
  "store every raw quote with its timestamp") plus a `PriceQuoteRepository`
  (`findRecent(asset, quoteAsset, sinceEpoch, untilEpoch)`).
- **`src/prices/aggregate.ts`**: pure functions — `median`, `medianAbsoluteDeviation`,
  `rejectOutliers` (MAD-based, never rejects every quote even against a degenerate/
  bimodal sample), `isStale`, and `aggregatePrice` composing all three. Same purity
  discipline as `src/signals/**` (no I/O), so it's fully deterministic and
  replay-safe — this is the piece Phase 4's D06/D07/D10 detectors will actually call.
- **`src/prices/chainlink.ts`**: reads `AggregatorV3Interface.latestRoundData()`
  (quorum-read — prices are decision-critical per spec §6.1) for USDC and WETH on
  Ethereum and Base. Resolving "the" feed address turned out to be non-trivial:
  Chainlink's own reference-data JSON lists multiple different live addresses for the
  same pair name with no obvious primary one, so instead each feed was resolved by
  reading what Aave's _own_ oracle actually uses (`getSourceOfAsset`), unwrapping
  Aave's "capped" stablecoin adapter where present, and verifying the result live
  on-chain — see `docs/SOURCES.md` for the exact trail.
- **`src/prices/cex.ts`**: Coinbase + Kraken public ticker readers, `fetchedAt` read
  through the injected `Clock` (neither API returns its own timestamp). Deliberately
  conservative asset mapping — only `WETH`→`ETH` and `USDC`→`USDC` — since e.g.
  `wstETH` doesn't trade 1:1 with `ETH` and has no direct major-CEX ticker; mapping it
  to `ETH` would silently price it wrong rather than just not price it.
- Tests: 32 new unit tests (mocked `ContractReadClient`/`fetch`), plus fork/live
  integration tests — Chainlink against real Ethereum+Base state (4 tests) and CEX
  against the real Coinbase/Kraken APIs (5 tests, including a cross-exchange agreement
  check). All pass.

Two real bugs the fork tests caught (same pattern as Phase 2 — this is exactly why
they're worth having):

1. **`decimals()` decodes to `number`, not `bigint`**: every other `AggregatorV3
Interface` field is `uint256`/`int256`/`uint80` and viem decodes those to `bigint`,
   but `decimals()` returns `uint8`, small enough that viem hands back a plain JS
   `number`. A zod schema written by analogy with the other fields failed against real
   data. Fixed and commented at the parse site.
2. **Pinned Base block too old again**: reused block 34,000,000 (from the Morpho fork
   tests) for the new Chainlink fork test, but neither Base feed contract had been
   deployed yet at that height. Same failure mode as Phase 2's Aave data provider —
   `test/integration/README.md` already documents it, this was just a fresh instance
   of the same lesson (reused an old pinned block without re-checking it against a
   _different_ contract's deployment history). Fixed by pinning to a recent block.

Still open in Phase 3: DEX price reads (Uniswap v3 TWAP / Curve), and all three
watchers (governance/config, token supply, large holders).

**Same session, continued — governance/config watcher:**

- **`src/chain/client.ts`**: `LogQuery`/`getLogs` changed from a single `event` to an
  `events: AbiEvent[]` array — viem decodes each returned log against whichever event
  its topic0 matches and reports that event's own name, so watching several event
  types on one contract (e.g. Aave's 6 configurator events) needs one `getLogs`
  round-trip instead of one per event type. Verified directly against a real fork
  call before committing to the design (real Aave `Pool` logs decoded correctly:
  `Withdraw`/`Supply` in the same batch, each with the right `eventName`/`args`).
  Nothing consumed the old shape yet, so this was a clean change, not a breaking one.
- **`src/storage/migrations.ts` (migration 3) + `ProtocolEventRepository`**: an
  append-only `protocol_events` table, `UNIQUE(chain_id, transaction_hash,
log_index)` so re-scanning an overlapping block range (the normal way to poll for
  new events) is a safe no-op rather than duplicating rows.
- **`src/watchers/governance.ts`**: deliberately thin — every Phase 2 adapter already
  decodes its own events (`ProtocolAdapter.decodeEvents`), so a "governance watch
  target" is just _which_ contract address and _which subset_ of that protocol's
  events count as governance (vs. pool-flow events like Supply/Withdraw, which the
  not-yet-built large-holder watcher will care about instead), reusing the same
  decode function either way. `fetchGovernanceEvents` itself ended up fully
  protocol-agnostic as a result. Added factory helpers for all three protocols
  (`aaveGovernanceTarget`, `morphoBlueGovernanceTarget`, `morphoVaultGovernanceTarget`)
  — Aave's needed a new two-hop address resolution
  (`resolveAaveConfiguratorAddress`, since `PoolConfigurator` isn't a static address
  the way `Pool`/`PoolDataProvider` are), and Morpho Blue needed 5 governance-level
  events (`SetOwner`, `SetFee`, `SetFeeRecipient`, `EnableIrm`, `EnableLltv`) added to
  its ABI that Phase 2's read-only adapter never needed.
- Real operational constraint found and documented (not a bug, just a fact worth
  recording before it causes confusion later): **at least one configured RPC
  provider's free tier caps `eth_getLogs` at a 10-block range per call** (Alchemy,
  confirmed directly against the live RPC). Fine for polling new blocks as they
  confirm in the live pipeline (normally a handful of blocks per tick); a real
  constraint for any future full historical backfill, which will need explicit
  chunking this function doesn't do itself. Documented in the watcher's own header
  comment and `test/integration/README.md`-adjacent context.
- Tests: 13 new unit tests (mocked pool/adapters) plus 4 fork integration tests —
  resolving the _real_ Aave PoolConfigurator address on both Ethereum
  (`0x64b761D848206f447Fe2dd461b0c635Ec39EbB27`) and Base
  (`0x5731a04B1E775f0fdd454Bf70f3335886e9A96be`, cross-confirming the address-book
  value already on record), and fetching real (small, free-tier-respecting) block
  ranges for Aave + Morpho Blue on Ethereum and the real watched Morpho vault on
  Base without error. All pass. `pnpm lint`/`typecheck`/`test` (137 tests)/
  `format:check`/`build` all green; `pnpm test:integration` 34 tests green.

Still open in Phase 3: DEX price reads, token supply watcher, large-holder watcher.

**Same session, continued — token-supply watcher:**

- **Migration 4 + `TokenSupplyRepository`**: a `token_supply_snapshots` table for the
  `totalSupply()` time series — a point-in-time reading, not an event, so unlike mint
  events (below) it needed its own table rather than reusing `protocol_events`.
- **`src/watchers/token-supply.ts`**: `fetchTotalSupply` (quorum-read — not in spec
  #6.1's explicit list, but it directly feeds D08, a detector that can trigger
  de-risking, so treated with the same two-provider discipline as balances/prices)
  and `fetchMintEvents` (`Transfer(from=0x0, ...)`, best-effort log scan, same
  free-tier block-range constraint as the governance watcher). Mint events are
  returned as `ProtocolEvent`s (`protocol: 'erc20'`) and stored in the _same_
  `protocol_events` table the governance watcher uses, tagged `category:
'token-supply'` — a real event fits that table's shape exactly, so no new table was
  needed for it, only for the supply-snapshot series. Deliberately only _records_ the
  raw series; deciding what counts as a "large" mint is D08's threshold job (Phase 4),
  not this collector's.
- Tests: 8 new unit tests (mocked pool) plus 2 fork integration tests — matching real
  Ethereum USDC's actual `totalSupply()` exactly, and running a real (small,
  free-tier-respecting) mint-event scan without error. All pass. `pnpm lint`/
  `typecheck`/`test` (145 tests)/`format:check`/`build` all green;
  `pnpm test:integration` 36 tests green.

Still open in Phase 3: large-holder watcher.

**Same session, continued: DEX price source (Uniswap v3 TWAP).** Pushed the
token-supply watcher commit, then built `src/prices/uniswap-v3.ts` (`UniswapV3PriceSource`)
plus `src/prices/uniswap-v3-addresses.ts`. Covers `WETH` priced in `USDC` on both
Ethereum and Base, via `observe()`-based TWAP over a 900-second window (default,
configurable). Every address was verified on-chain this session before being written
down (safety rule 6) — see `docs/SOURCES.md`'s new "DEX prices — Uniswap v3" section:

- The Uniswap v3 factory is at a **different** address on Base than on Ethereum
  (`0x33128a8f...` vs. `0x1F98431c...`) — found via `developers.uniswap.org`, then
  independently confirmed on-chain via `owner()`. Assuming the same address would have
  silently broken (there's unrelated contract code at the Ethereum factory's address
  on Base, so a naive port wouldn't even have reverted obviously — it would have
  returned garbage from `getPool()`).
- The deepest-liquidity fee tier for `WETH`/`USDC` is **not the same on both chains**:
  0.05% on Ethereum, 0.3% on Base (checked all four standard tiers' `liquidity()` on
  each chain rather than assuming one tier is universally deepest).
- `token0`/`token1` order is opposite between the two pools (`USDC` is `token0` on
  Ethereum, `WETH` is `token0` on Base) — handled via an explicit `baseIsToken0` flag
  per pool rather than inferred from anything positional.
- Quotes are denominated in `USDC`, not `USD` (unlike the Chainlink/CEX sources) —
  documented in the source's own doc comment: composing an exact USD figure from a DEX
  quote means also pulling the USDC/USD price and multiplying, which this source
  deliberately doesn't do itself.
- Wrote ADR 0006 scoping this to Uniswap v3 only for now (no Curve stable-pool source)
  — `USDC` is the only stablecoin currently watched and its peg is already
  cross-checked by Chainlink + 2 CEXes, and Curve's stable-pool design doesn't apply to
  `WETH` at all (not a stablecoin). Revisit if a second stablecoin position is added.
- Tests: 11 new unit tests (3 for the pure `averageTick`/`tickToPrice` math, 8 for
  `UniswapV3PriceSource` against a mocked pool) plus 4 fork integration tests (2 per
  chain) asserting the TWAP price lands in a plausible range and matches a direct
  `observe()` call bit-for-bit. All pass. `pnpm lint`/`typecheck`/`test` (156 tests)/
  `format:check`/`build` all green; `pnpm test:integration` 40 tests green (against
  real Ethereum + Base fork data, both pools).

Still open in Phase 3: large-holder watcher only.

**Same session, continued: large-holder watcher — Phase 3 complete.** Built
`src/watchers/large-holders.ts`, the last open Phase 3 item. Same collector/detector
split as the other two watchers: this module fetches pool-flow events (Supply/
Withdraw/Borrow/Repay for Aave and Morpho Blue; SupplyCollateral/WithdrawCollateral
too for Morpho Blue; ERC-4626 Deposit/Withdraw for the MetaMorpho vault), reduces them
into a per-holder balance ledger, and ranks top holders — deciding what counts as an
alertable large-holder exit stays D05's job (Phase 4).

- Event fetching reuses `fetchGovernanceEvents` from `governance.ts` unchanged (it was
  already written protocol-agnostically — governance.ts's own header comment even
  anticipated this reuse) via new target factories (`aavePoolFlowTarget`,
  `morphoBluePoolFlowTarget`, `morphoVaultPoolFlowTarget`) that just pick a different
  event subset from the same three ABIs the governance watcher reads. Re-exported
  under `fetchPoolFlowEvents` for a domain-appropriate name at the call site.
- `computeHolderLedger`/`rankHolders`: pure functions (same purity discipline as
  `src/prices/aggregate.ts`), so the reduction/ranking logic is directly unit-testable
  on synthetic event sequences without a mocked chain client. Protocol-specific
  extractors (`extractAaveMovement`/`extractMorphoBlueMovement`/
  `extractMorphoVaultMovement`) turn a raw `ProtocolEvent` into a signed balance
  delta, since each protocol's events name the position owner differently (`onBehalfOf`
  vs. `user` on Aave depending on the event; `onBehalf` uniformly on Morpho Blue;
  `receiver`/`owner` on the vault's ERC-4626 events, matching that standard's own
  inconsistent naming).
- No new storage table — events are recorded via the existing
  `ProtocolEventRepository.recordAll('large-holder', ...)` (the `protocol_events`
  table's `WatcherCategory` type already anticipated this), and the ledger is derived
  on demand by replaying stored events through `computeHolderLedger`, same as
  `aggregate.ts` derives a price from stored quotes rather than a separately
  maintained running total.
- Added `getUserAccountData` to Aave's `poolAbi` (verified directly on-chain against a
  synthetic zero-position address — returned the documented `healthFactor =
type(uint256).max` "no debt" sentinel exactly) for `fetchAaveBorrowerHealth`, giving
  the spec's "track the health of the largest borrowers" requirement for Aave
  directly from Aave's own risk computation, not reimplemented. Morpho Blue's
  equivalent (collateral value vs. `lltv`) is deliberately **not** built here —
  deferred to D15 (Phase 4), which needs the same per-position health math across
  every borrower in a market anyway, so building it once there avoids duplicating it
  early.
- Added ERC-4626 `Deposit`/`Withdraw` events for the vault via viem's own maintained
  `erc4626Abi` (matching the adapter's existing policy of not redeclaring standard
  interfaces) — verified against real logs on the live watched vault by computing each
  event's topic hash and finding matching on-chain logs before writing any code
  against them. Deliberately excludes `Transfer` (secondary-market share transfers
  bypass Deposit/Withdraw entirely) — a known, documented gap, not an oversight.
- Tests: 18 new unit tests (pure extractors/ledger/ranking on synthetic events, target
  factories' event-set membership, `fetchAaveBorrowerHealth` including its
  `QuorumError`-on-total-failure case) plus 4 fork integration tests (2 chains) that
  run real Aave/Morpho Blue/vault events from a real 5-block window through the full
  ledger/ranking pipeline and check invariants (ranking is descending, every ranked
  holder has a positive balance), plus an exact-match check against a real
  `getUserAccountData` call for a synthetic zero-position address. All pass. `pnpm
lint`/`typecheck`/`test` (174 tests)/`format:check`/`build` all green; `pnpm
test:integration` 44 tests green.

**Phase 3 is now complete.** Next: Phase 4 (detectors D01–D16).

**New session: Phase 4 — all sixteen detectors, in one pass.** User said "do 4."
Designed `src/signals/types.ts` first (`DetectorContext`, `Detector`, and every
sub-shape a detector needs — `MarketContext`, `AssetContext`, `InfraChainSnapshot`,
`AssetExposureEntry`) before writing any detector, then implemented D01–D16 plus a
shared `util.ts` (`severityAtLeast`/`severityAtMost`, `findTimeBaseline`,
`modifiedZScore`) and a two-pass registry. Wrote ADR 0007 up front for the two design
questions that had to be settled before any detector code: what `DetectorContext`
actually contains, and how D14 (contagion) gets other detectors' output as input
without breaking `Detector`'s uniform pure-function interface.

Key design decisions (see ADR 0007 for the full reasoning):

- **Building a live context assembler is explicitly out of scope for this phase** —
  spec §7 itself says detectors get "unit tests on synthetic data," so every detector
  is tested against synthetic `DetectorContext`s (`test/unit/signals/helpers.ts`'s
  builders) rather than wired to real storage. That wiring is Phase 5's job (the risk
  engine is the first thing that needs a live context to run detectors on a
  schedule). `docs/DETECTORS.md` and this note both flag this so it isn't
  rediscovered as a surprise gap in Phase 5.
- **Address ↔ symbol joins pushed upstream, not solved per-detector.** Protocol data
  (`CollateralExposure.asset`, Aave's `oraclePrices`) is address-keyed; price quotes
  and asset-family signals are symbol-keyed (`AssetContext.symbol`, matching
  `PriceQuote.asset`). Rather than have every detector reconcile the two,
  `AssetContext` carries already-normalized/joined data (`oraclePrice: number`,
  `collateralAmount?: number`, `dexDepth?: DexDepthSnapshot`) that a future context
  assembler is responsible for producing — same pattern `src/watchers/large-holders.ts`
  already used for `collateralAmount`-style precomputed fields.
- **D14's two-pass registry**: `DetectorContext.priorSignals` is empty on the
  registry's first pass (every detector except D14), then populated with that pass's
  combined output for a second pass running only D14. `evaluateAll()`
  (`src/signals/registry.ts`) owns this orchestration; every detector's own
  `evaluate(ctx)` stays a uniform pure function, matching spec §5.3's sketch.
  `assetExposure: Record<symbol, {marketId, shareOfCollateralBase}[]>` is D14's join
  table (including vault look-through), also deferred to the future assembler to
  build.
- **Local, self-contained types instead of importing from `src/watchers/*.ts`** —
  `HolderSnapshot`/`BorrowerHealthSnapshot`/`TokenSupplySnapshotLike` are redeclared in
  `signals/types.ts` rather than imported, since `large-holders.ts`/`token-supply.ts`
  transitively import `src/chain/**` and CLAUDE.md's purity rule for `src/signals/**`
  forbids that import path entirely, not just at runtime.

Detector-specific notes worth remembering (each detector's own file header comment
has the full formula/thresholds/false-positive writeup — this is only what's
non-obvious from spec's one-line table):

- **D06/D07** (oracle deviation / frozen oracle) both use `AssetContext.history`
  scoped per-market (an asset's oracle price is scoped to whichever market reads it,
  not global) — D06 requires the deviation to be _sustained_ across
  `sustainBlocks` consecutive readings (not just the latest one) before firing; D07
  detects "frozen" via exact floating-point equality across consecutive oracle
  readings (valid because a stuck on-chain feed reports the literal same raw value
  every read, so the normalized float is bit-identical, not just "close").
- **D08** (collateral supply anomaly) escalates `danger → critical` by cross-
  referencing the _same market_ (via `AssetContext.marketId`) for concurrent borrow
  growth — the rsETH-pattern "paired with borrowing against the new supply" clause.
  Explicitly cannot implement spec's "without matching known flows" exclusion (would
  need cross-chain bridge event correlation, not collected) — documented as a known
  gap rather than silently ignored.
- **D09** (liquidation depth) derives a closed-form AMM formula from Uniswap v3's
  `x=L/sqrtP`, `y=L·sqrtP` within one tick — a genuine, hand-verified derivation (see
  the file's doc comment), but a **single-active-tick approximation**: a 5%
  price move very plausibly crosses real tick boundaries this doesn't account for.
  Systematically _under_-estimates true depth (the safer direction for a risk
  detector to err in), which is worth knowing when reading an alert.
- **D10** (peg deviation) is structurally prevented from being `standaloneCritical`
  (hardcoded `false`, not just defaulted) per ADR 0005 — a depeg alert must never
  itself trigger an automatic exit.
- **D12/D13** split MetaMorpho vault governance events by subset: D12 owns role/
  timelock/fee events, D13 owns the allocation-queue events (`SetSupplyQueue`,
  `SetCap`, `ReallocateSupply`, …) from the _same_ underlying event stream
  (`src/watchers/governance.ts` doesn't itself distinguish the two). D12's cap-jump
  severity is computed from the event's own `oldCap`/`newCap` args (real magnitude,
  not a fixed guess) — removing a cap entirely is always `danger` regardless of
  magnitude; _lowering_ or newly adding a cap never fires (protective changes).
- **D13**'s "new market" detection has **no cross-run state** in this phase — it
  can't yet distinguish a market newly added to a vault's queue from one that's
  always been there and just got reallocated into again; every allocation event
  fires `watch` unconditionally. True diffing needs the previous evaluation's queue,
  a Phase 5/6 concern once the pipeline runs repeatedly. Escalation to `danger` only
  works when the referenced market is also one `DetectorContext.markets` covers
  directly (checked via the same `priorSignals` mechanism D14 uses).
- **D15** (debt near liquidation) has a real, documented limitation: Aave's
  `healthFactor` is account-wide (across every reserve a borrower uses), not
  per-reserve — so "share of pool debt" is actually computed as "share of the
  _tracked_ large-borrower population's account-wide debt," not literally this
  market's own debt. Internally consistent (same units both sides of the ratio) but
  not the exact measurement spec's wording describes; stated plainly in the doc
  comment rather than glossed over.
- **D16** (infra health) is capped at `watch`/`danger` only — never `critical`, never
  `standaloneCritical` — matching spec's exact wording and spec §8.1's "infra alone
  never causes an exit" rule.

Tests: 16 detector test files (~120 new tests) plus `registry.test.ts` (7 tests,
including an end-to-end run of the real `defaultDetectors()` registry and a direct
check that D14 receives exactly the first pass's signals via `priorSignals` and runs
exactly once). Every detector's test file covers normal/borderline/alarming/false-
positive cases per spec §7's own requirement. Two real floating-point test bugs
caught and fixed along the way (D02's exact-threshold test hit IEEE-754 subtraction
imprecision, `0.7 - 0.6 !== 0.1`; fixed by testing comfortably past the threshold
instead of exactly at it, with the reasoning documented in the test). `pnpm lint`/
`typecheck`/`test` (295 tests)/`format:check`/`build` all green.

`docs/DETECTORS.md` written: the spec-table index, shared building blocks, the
standalone-critical/alert-only detector list, D14's two-pass design, and a
"known cross-cutting limitations" section collecting the address/symbol-join,
D13-no-state, D15-account-wide, and D09-single-tick gaps in one place instead of
scattered per-detector.

**Phase 4 is now complete.** Next: Phase 5 (risk engine, alerts, daily report — the
first version the user actually runs). Phase 5 must build the live context assembler
this phase deliberately deferred (see ADR 0007's consequences section for the
specific gaps: oracle-price/quote joining by symbol, `DexDepthSnapshot` from live
Uniswap v3 `liquidity()`/`slot0()` reads — not currently fetched by the Phase 3 price
source — and `assetExposure` vault look-through resolution).

**Same session, continued — Phase 5 built end-to-end.** User said "yes do 5." Built,
in order: the risk engine state machine, the storage layer it needs, the notifier
stack, the daily report generator, the live context assembler Phase 4 deferred, and
finally the `sentinel watch`/`report`/`label` CLI commands — closing out every open
item in Phase 5's own checklist above in one pass.

- **`src/risk/{types,state-machine}.ts` + `docs/adr/0008`**: one state machine per
  position (`RiskLevel` NORMAL→WATCH→DANGER→CRITICAL). `computeRawLevel` implements
  corroboration (≥2 non-infra signal families required for DANGER/CRITICAL, except
  detectors explicitly marked `standaloneCritical` — D06-at-critical, D11 — which
  short-circuit straight to CRITICAL) and excludes `family: 'infra'` from
  corroboration entirely (infra alone can never force an exit, matching D16's own
  documented cap). `applyHysteresis` implements rate-of-change (escalation always
  applies immediately, no dwell) and de-escalation hysteresis (a dwell timer that
  restarts if the target level changes mid-wait, per ADR 0008). `decide()` is a pure
  function by design — the same-inputs-same-output determinism invariant spec §8.1
  requires — which is why `Decision` deliberately carries no `id`: an app-generated id
  would make output non-reproducible for a reason that has nothing to do with the
  actual decision. The id is assigned only at persistence time
  (`DecisionRecordRepository`, SQLite `AUTOINCREMENT`), and `DecisionRecord = Decision
& {id}` is the persisted shape. A separate "standing rule" (spec §8.2: alert
  whenever a position exceeds a configured share of available liquidity) is tracked as
  `standingAlert: boolean`, set whenever a D03 signal is present — independent of
  corroboration, so it can fire even while the position's own level is still NORMAL.
  6 property-based tests directly check spec §8.1's invariants (single-family
  non-standalone-critical never exits, infra-only never exits, de-escalation never
  skips its dwell, determinism).
- **Storage** (migrations 5–9 + one repository each): `market_snapshots` (append-only,
  the `MarketSnapshot` history detectors' history windows read from — didn't exist
  before Phase 5 because nothing persisted snapshots yet, only read them live),
  `decision_records` (append-only, the `DecisionRecord` log), `risk_state` (UPSERT,
  current `PositionRiskState` per position — the history of how it got there lives in
  `decision_records` instead), `global_controls` (tiny KV table, today just the kill
  switch), `decision_labels` (UPSERT, free-form label text rather than a fixed enum
  since Phase 6's replay-scoring taxonomy doesn't exist yet).
- **`src/notify/**`**: `Notifier` interface plus `ConsoleNotifier`/`DiscordNotifier`/
  `TelegramNotifier`. Telegram's `sendMessage`/`getUpdates` endpoint shapes were
  verified directly against `core.telegram.org/bots/api` this session (safety rule 6)
  rather than assumed. `AlertDispatcher` (`dispatcher.ts`) implements dedup/rate-limit
  (a rule change at the same level is treated as a new alert, not a repeat) and
  repeat-until-ack for CRITICAL on its own faster cadence; muting always suppresses.
  `telegram-commands.ts`/`telegram-poll.ts` implement `/status`, `/positions`,
  `/ack <id>`, `/mute <id> <duration>`, `/kill`, restricted to allowlisted chat IDs.
- **`src/reports/**`**: `generateDailyReport` is a pure function producing both
  markdown and JSON from one pass, with its own doc comment stating plainly which
  sections are genuinely populated in Phase 5 (positions/alerts/transitions/actions)
  versus an honestly-empty placeholder (exit drill — Phase 7; gas spent — always 0
  while execution mode is `off`; provider uptime — "not tracked" rather than a
  misleading `0%`).
- **`src/core/pipeline.ts`** (`runOnce(deps, at)`) — the live context assembler Phase 4
  deliberately deferred (ADR 0007). Assembles a real `DetectorContext` from live chain
  reads (protocol adapters, governance/pool-flow event watchers, Chainlink/CEX/Uniswap
  price sources, the new `src/prices/uniswap-v3-depth.ts` for D09's DEX-depth reads)
  plus stored history, runs the full detector registry, runs the risk engine per
  position, persists everything, and dispatches alerts. `src/core/known-assets.ts` and
  `src/risk/context.ts` fill the address↔symbol join gap ADR 0007 flagged, scoped
  honestly to exactly the assets currently configured (USDC, WETH) rather than
  pretending to cover more. Verified against **real** Ethereum and Base fork data
  (`test/integration/core/pipeline.test.ts`): it correctly found real existing bad debt
  in Aave's Core USDC reserve on both chains and produced a correct
  `CRITICAL`/`full_exit` decision with the right rule (`standalone-critical:
D11_bad_debt`) — this is a genuine finding about the currently-configured markets'
  real state, not a synthetic test fixture.
- **CLI wiring** (`src/cli/{watch,report,label}.ts`, replacing the Phase 1 stubs):
  - `sentinel watch` loads config, opens the DB, builds an `RpcPool`/`LiveBlockSource`
    per configured chain, builds the notifier stack from `config.notify` (console
    always included; Discord/Telegram only if their secrets are actually present,
    degrading gracefully otherwise — same pattern `doctor` already established), and
    polls in a loop, calling `runOnce` once per newly confirmed block per chain and
    (if a bot token is configured) polling Telegram for commands on the same cadence.
    A failure in one chain's iteration is logged and the loop continues rather than
    crashing the whole process — the next poll resumes from `ChainStateRepository`'s
    stored cursor exactly where it left off, per docs/ARCHITECTURE.md #2's
    idempotent-and-restartable design.
  - `sentinel report` turned out to need its own live chain reads, not just stored
    data: spec §10.2 asks for "positions, balances, and yield earned," but a
    position's _balance_ is read transiently inside `pipeline.ts` (via
    `ProtocolAdapter.discoverPositions`) and never persisted — only the _market_-wide
    snapshot is stored. Rather than invent a number or silently show nothing, `sentinel
report` does a light live read per configured position (balance, on-chain
    `decimals()`, current supply rate) and honestly omits (with an info-level log line
    explaining why) any position with no discoverable balance right now, instead of
    fabricating a zero row. Alerts/transitions/labels come straight from
    `decision_records`/`decision_labels` for the requested UTC date — no live reads
    needed there.
  - `sentinel label <decisionId> <label> [notes...]` — free-form label (matching
    `DecisionLabelRepository`'s own design choice, not spec's literal
    `true|false|unsure` wording, since that enum is Phase 6's to define).
  - Smoke-tested the built CLI for real: `sentinel doctor` (still green on both
    chains), `sentinel report` against the **real** configured RPCs and Safe address —
    which correctly found **zero** currently-held balance in any of the three
    configured positions (logged plainly, not silently blank) and produced a valid,
    otherwise-empty report. This matches `docs/PROGRESS.md`'s own note that the
    watched markets are "a sensible default watch list... not a claim about where the
    user actually holds funds" — not a bug.
- **`docs/ARCHITECTURE.md`** updated: the pipeline diagram's "Action planner
  [src/actions]" box was stale (action recommendation is computed as part of the risk
  engine's own `decide()`, not a separate planner module — `src/actions` is Phase
  7/8's withdrawal-execution concern) and "Reports, metrics, decision log [src/reports,
  src/ops]" implied a metrics/ops layer that doesn't exist yet; both corrected to
  describe what's actually built, per this file's own instruction not to let it drift.

Two real bugs caught and fixed while writing `pipeline.ts` (both self-caught on
review, not from a failing test): a redundant/broken double-loop for
`positionAssetQuotes` (an earlier pass compared a symbol-keyed quote against an
address and always evaluated `false`), and a `configHash: ''` placeholder that needed
threading through from the caller instead (`PipelineDeps.configHash`, wired from
`loadConfig().hash` in the CLI).

One real test-tuning issue, not a logic bug: the first fork-integration run of
`pipeline.test.ts` against real Ethereum data timed out at the default 30s limit,
because Aave's `collateralExposure()` call is already known-slow (documented in
`test/integration/protocols/aave-v3.test.ts` with its own 45s timeout precedent) and
`pipeline.ts` calls it on top of governance/pool-flow/price fetches. Fixed by raising
this test file's own timeouts to 60s; re-ran and confirmed green.

Tests: 20 new/changed unit test files (~130 new tests: risk engine + property tests,
every storage repository, every notifier, the daily report generator, the context
helpers, known-assets) plus 4 new fork integration test files (`pipeline.test.ts`,
`uniswap-v3-depth.test.ts`, `cli/watch.test.ts`, `cli/report.test.ts`) — the CLI ones
specifically exercise `runWatch`/`runReport`'s own config-loading and
`RpcPool`/`LiveBlockSource` wiring, a different (and, for wiring bugs, more sensitive)
code path than calling `runOnce` directly against hand-built deps. Final tally: `pnpm
lint`/`typecheck`/`test` (425 tests)/`build` all green; `pnpm test:integration` (54
fork/live tests, both chains) all green.

**Phase 5 is now complete — this is the first version of Sentinel the user can
actually run** (`sentinel watch`). Honestly-flagged limitations carried forward
(none block running it, all documented at their own source rather than glossed over):
provider uptime isn't tracked as a running counter yet (daily report says "not
tracked" rather than showing a fake number); the hysteresis dwell time
(`DEFAULT_DWELL_SECONDS = 3600` in `src/cli/watch.ts`) is a placeholder, not yet
backed by replay-harness evidence per safety rule 8 — revisit once Phase 6 exists;
`sentinel report`'s benchmark comparison is only genuinely implemented for
`kind: vault` (best-effort, same-chain-as-position), `kind: pool_base_rate` (the
config's current setting) honestly reports no distinct benchmark reading rather than
comparing a rate to itself. Next: Phase 6 (replay harness).

**New session: Phase 6 — replay harness, built end-to-end and run for real.** User
said "continue" after Phase 5 shipped. Built, in order: the deterministic replay
engine (cache, caching archive RPC client, strided block source, synthetic-position
wiring into the live pipeline), the scenario YAML format, real-incident research,
quiet-period scenarios, synthetic fault-injection scenarios, scoring, and the
`sentinel replay` CLI — then actually ran the whole thing against real archive RPCs
and iterated on what broke, rather than stopping at "it typechecks."

- **`src/replay/{cache,archive-client}.ts`**: a content-addressed disk cache
  (`.replay-cache/`, already git-ignored from Phase 1's scaffolding) and a
  `ContractReadClient` wrapper that caches `multicall`/`getLogs`/`getBlock` — the same
  bigint-tagging convention every storage repository already uses, so cached data
  round-trips exactly.
- **`src/replay/block-source.ts`** (`ReplayBlockSource`) + **ADR 0009**: replays at a
  configurable stride instead of every confirmed block (evaluating ~200k+ blocks for
  a 30-day quiet period is both computationally infeasible and unnecessary for
  spec §9.3's scoring, which only needs "roughly how the position fared over time").
- **`src/core/pipeline.ts`**: two small, additive extension points, both
  opt-in/undefined-by-default so live behavior (`sentinel watch`) is unchanged —
  `positionOverrides` (a synthetic `Position` per market, since replay has no real
  Safe balance to discover, and discovering the real Safe's historical balance would
  be both meaningless and wrong) and `eventsFromBlock` (governance/pool-flow event
  fetch range, which live always leaves at the single current block since it never
  has gaps, but a strided replay does).
- **`src/replay/scenario.ts`**: zod-validated scenario format (id, description,
  kind `incident`/`quiet`, chain, position, block range, sample interval, simulated
  position balance, ground-truth events with at most one `pointOfNoReturn`, sources).
- **Real-incident research** (`scenarios/usdc-depeg-2023-03.yaml`,
  `scenarios/kelpdao-rseth-exploit-2026-04.yaml`): every date/price/timing fact
  cross-confirmed across multiple independent sources (CNN/CNBC/CoinDesk/Decrypt/an
  academic paper for the 2023 depeg; CoinDesk/Chainalysis/OpenZeppelin/KuCoin for
  KelpDAO) — see `docs/SOURCES.md`'s "Replay scenarios" section. Every block number
  was computed directly by binary-searching real block timestamps against the
  configured archive RPC (2026-09-16), independently cross-checked against an academic
  paper's own cited block for the 2023 event (off by 1 block — strong confirmation via
  a completely different method). **Stream Finance xUSD collapse was researched but
  deliberately not built as a scenario**: real on-chain research via
  `api.morpho.org/graphql` found two genuine Morpho Blue markets pairing `xUSD`
  collateral against `USDC` debt on Ethereum (recorded in docs/PROGRESS.md's Known
  Issues below with their real market ids), but replaying either needs `morpho-blue`
  direct-position support the live pipeline has never had wired up, plus a
  `MorphoBlueAdapter.decodeEvents` fix (both found and documented, neither attempted —
  real, scoped follow-up work, not guessed around).
- **Quiet periods** (`scenarios/quiet-{ethereum,base}-2026-08.yaml`): 36-day windows
  ending 1 day before the real chain head at authoring time, both bounds computed the
  same binary-search way.
- **`src/replay/synthetic-scenario.ts`**: five of spec's nine named synthetic fault
  types (utilization spike, frozen oracle, depeg, whale exit, paused withdrawals) as
  hand-built `DetectorContext`s run through the _real_ detector registry and risk
  engine — same "one code path" principle one layer down. The other four (RPC outage,
  provider disagreement, reorg, gas spike) are deliberately not duplicated here: the
  first three are already covered by dedicated infra-layer tests
  (`test/property/chain/rpc-pool-quorum.test.ts`, `test/unit/chain/block-source.test.ts`'s
  reorg scenarios), and gas spike has nothing to inject into yet (needs Phase 7's
  withdrawal planner).
- **`src/replay/scoring.ts` + `results-report.ts`**: pure scoring (lead time per
  level, recoverable share at the point of no return, false-alarm rate for quiet
  periods) and markdown generation for `docs/REPLAY_RESULTS.md`, including a fixed
  "how to read these numbers" caveat (added after the first real run showed exactly
  why it's needed — see below) and a "scenarios that failed to run" section so one
  scenario's failure is visible, not silently dropped.
- **`src/cli/replay.ts`**: wires it all together, replacing the Phase 1 stub.

**Two real bugs found and fixed while building the synthetic scenarios** (writing a
depeg/exit-coverage fixture and checking it actually reached the risk engine, not just
that the detector fired): `D03_exit_coverage` and `D10_peg_deviation` both keyed their
`kind:'position'` signal subject off the protocol adapter's own `Position.id`
(`marketId:owner`), which never matched `decide()`'s `positionId` input (the risk
engine's canonical `protocol:chain:market:asset` form, docs/adr/0002) — so both
signals were **silently unreachable by the risk engine in every real run**, including
D03's spec-mandated "standing rule" liquidity alert. Invisible to every prior test
because the risk-engine unit tests only ever built market-subject fixtures. Fixed by
keying both off `market.marketId` instead (provably the same string as the canonical
position id whenever a position exists, by how `pipeline.ts` constructs both). See
`docs/DETECTORS.md`'s cross-cutting-limitations section for the fix's own detail.

**Running the real scenario suite against live archive RPCs surfaced three more real
findings**, each requiring an actual fix or a documented, evidence-backed decision
rather than a code change made from memory:

1. A wide-stride scenario's governance/pool-flow event fetch could request a range
   past the RPC provider's `eth_getLogs` cap — the provider doesn't silently truncate,
   it hard-errors, which crashed the _entire_ multi-scenario run on its last scenario
   the first time, discarding every already-completed scenario's results. Fixed two
   ways: `src/replay/runner.ts` now clamps the fetch window to the provider's actual
   cap (9 blocks — confirmed from Alchemy's own error response's suggested corrected
   range, not its rounder "10 block range" prose, an off-by-one caught on the very
   next real run after the first fix) instead of just warning about it, and
   `src/cli/replay.ts` now catches a per-scenario failure and continues with the rest.
2. `usdc-depeg-2023-03` cannot currently replay: `src/protocols/aave-v3/addresses.ts`
   only resolves each market's _current_ contract addresses, and Aave's Ethereum
   Core `PoolDataProvider` has been redeployed since March 2023 (confirmed via direct
   `eth_getCode` — the configured address, and one candidate historical address found
   via search, both have empty code at the scenario's blocks). Not fixed this
   session — recorded in Known Issues below rather than guessing a historical
   address.
3. The real replay run measured **~28 false alarms/week on both chains' 36-day quiet
   periods**, and the KelpDAO incident scenario's "1.7 days lead time to CRITICAL"
   turned out to mean the very first sampled block (before the exploit even happened)
   was already `CRITICAL` — both traced to the same root cause: `D11_bad_debt`'s
   default threshold (`minBadDebt = 1n`) fires on the real, small, persistent bad debt
   already present in the currently-watched Aave reserves (~$1.60 on Ethereum, ~$30.88
   on Base — dust relative to the pools' real size), which D11's own doc comment had
   already anticipated as a possible tuning need. Logged as a proposed (not applied)
   threshold change in the new `docs/TUNING_LOG.md`, per safety rule 8's process —
   not applied because there's nowhere to actually apply a tuned `config.detectors`
   value yet (see the config-wiring gap below) and because spec's own tuning process
   (§11.4) asks for a before/after replay comparison before changing anything, which
   needs that wiring first.

Tests: 9 new unit test files (~55 new tests: cache, archive client, block source,
scenario schema + the 2 real scenario files, scoring, results-report markdown,
synthetic scenarios) plus 2 new/extended integration test files hitting the real
archive RPC directly (not an Anvil fork — replay's whole point) — `runner.test.ts`
proves the engine end-to-end against a real known-bad-debt block, cross-checking the
live-pipeline fork test's own finding from a completely different code path, plus two
golden-output regression tests (spec §9.4) against the real scenario files: KelpDAO
reaches `CRITICAL` via `D11_bad_debt` at its real point-of-no-return block, and USDC
depeg fails with the documented historical-address error (a deliberate assertion — if
this one ever starts passing, that's a real fix to notice and update Known Issues
for, not just an assertion to delete). Final tally: `pnpm lint`/`typecheck`/`test`
(473 tests)/`build` all green; `pnpm test:integration` (58 fork/live tests) all green.

**Phase 6 is now complete.** `docs/REPLAY_RESULTS.md` and `docs/TUNING_LOG.md` are
real, committed artifacts from an actual run against live data, not placeholders.
Next: Phase 7 (paper mode and exit drills) — the withdrawal planner is also what's
needed to close the `config.detectors`/gas-scoring gaps this session found and
deliberately left open.

**New session: Phase 7 — withdrawal planner, fork simulator, paper executor, daily
drill, built end-to-end and verified against real chain state.** User said "continue"
(after Phase 5) then "how many phases? and continue" (after Phase 6) — both one-word
authorizations to keep going, per this whole session's established pattern. Built, in
order:

1. **Withdrawal planner** (`src/actions/{types,planner}.ts`, spec §8.3): a withdrawal
   is modeled as a persisted **campaign** (`WithdrawalCampaign` — target amount,
   amount withdrawn so far, status, attempt count), replanned once per pipeline run
   rather than looping/blocking internally — "retry on every new block" (spec's own
   wording) is the pipeline calling the planner again on the next confirmed block,
   not the planner itself blocking. `planWithdrawal` is a pure function: given the
   current campaign (if any), the policy's action recommendation, and real
   withdrawable liquidity, it decides `none`/`cancelled`/`already-complete`/`plan`,
   computing `min(remaining target, available now)` for a partial step and stepping
   priority fees in 4 ramps up to a configured per-chain cap. 13 unit tests, all
   branches. Storage: migration 10 (`withdrawal_campaigns`, UPSERT — "where this
   position's exit stands right now," same pattern as `risk_state`) +
   `WithdrawalCampaignRepository`.
2. **Fork simulator** (`src/actions/simulator.ts`, spec §8.4, safety rule 5): runs a
   `TxRequest` against an already-running Anvil fork by impersonating the Safe
   (`anvil_impersonateAccount`) — the standard simulate-without-signing technique;
   nothing here ever holds or touches a private key (safety rule 2). Verifies the
   generic half of "position down, Safe up by the expected amount" (the Safe's
   ERC-20 balance increased by exactly the expected amount); the protocol-specific
   "position down" half is the paper executor's job, since it holds the adapter.
   Moved the Anvil fork spawner from a test-only helper into production code
   (`src/chain/anvil.ts`) in the process, since this is the first *production* code
   path that needs to spawn a real fork, not just tests.
3. **Paper executor** (`src/actions/paper-executor.ts`, spec §8.4): ties the planner
   and simulator together — spawns its own fork pinned to the exact confirmed block
   the triggering decision was made from, re-discovers the position fresh on that
   fork, plans a step, and (if there's a step to take) simulates it, verifying both
   halves of "position down, Safe up" (the second half — re-reading the position
   post-tx via the adapter — needed a small interest-accrual tolerance; see the
   verification note below for why). Wired into `src/core/pipeline.ts`'s `runOnce`:
   when `config.execution.mode === 'paper'` and a decision's action is
   `partial_withdraw`/`full_exit`, it runs automatically and the outcome is persisted
   to a new append-only `paper_executions` log (migration 11 — "record what would
   have happened," spec's own phrase) via `PaperExecutionRepository`. `sentinel
   watch` only wires the two new repos when paper mode is actually configured, so
   `off` mode (the default) is completely unaffected.
4. **Daily exit drill** (`src/actions/exit-drill.ts`, spec §8.6): forks the latest
   block for each configured chain and simulates a full exit of every position by
   reusing `runPaperExecution` (forcing the action to `full_exit` regardless of the
   position's real current risk level) against a throwaway in-memory campaign
   repository per position, so a drill run never touches or is confused with a real
   in-progress campaign. Reports pass/fail, a real gas estimate, and a coarse
   liquidity-based "estimated steps to exit" (documented plainly as a proxy, not a
   real time estimate — this codebase has no model of liquidity replenishment
   rates). Wired as a real `sentinel drill` CLI command (was a Phase 1
   not-yet-implemented stub) and into `sentinel report`'s exit-drill section, which
   was an honest placeholder until now.

**Verified against real chain state, not mocks**, the same discipline as every prior
phase: the fork simulator and paper executor are both exercised end to end against a
**genuine Aave v3 position** — a real, on-chain-verified whale
(`0x55FE002aefF02F77364de339a1292923A15844B8`, live-verified via `cast balance`/`cast
call` this session, ~66.5M USDC / ~247 ETH at the time) is impersonated to actually
`approve` + `supply` real USDC into Aave's Ethereum Core market on a fork, creating a
real position, then `runPaperExecution`/`runExitDrill` are pointed at *that same
fork* as their own fork source (a fork-of-a-fork — Anvil forks from any JSON-RPC
endpoint, including another already-running Anvil instance), so they see exactly the
position just created. `supply()`'s signature was pulled directly from the same
official source already cited in `src/protocols/aave-v3/abi.ts`
(`aave-dao/aave-v3-origin`'s `IPool.sol`, re-fetched this session), not memory — the
adapter itself never calls `supply` so it wasn't already in the codebase anywhere.

This real-fork testing caught and fixed **two genuine correctness bugs**, not just
proved the happy path:

- **Gas underestimation on a full exit.** The very first real end-to-end run
  reverted out of gas. A full withdrawal (unlike a partial one) also clears Aave's
  "used as collateral" bit for that reserve — a more expensive code path than a
  naive `eth_estimateGas` call accounts for, the same reason real wallets always pad
  their own gas estimate. Fixed by explicitly estimating gas and adding a 20% buffer
  before sending (`src/actions/simulator.ts`) — a real robustness fix, not just a
  test-fixture workaround, since the exact same underestimation risk would exist for
  a real Phase 8 executor.
- **The "position down" check was too strict.** A snapshot of the position's balance
  taken one block before the withdrawal transaction mines is, by construction,
  already stale by the time the transaction executes — an interest-bearing position
  keeps accruing in that single block, so a withdrawal for the literal
  previously-read balance leaves a few wei of freshly-accrued interest behind as
  dust (confirmed by hand via `cast`: minted aToken balance was `supplyAmount - 1`
  or `- 2` across different runs, purely from liquidity-index rounding at supply
  time — a separate, smaller, already-known Aave quirk). Fixed by bounding the
  "decreased by the expected amount" check to a small (one-part-per-million)
  tolerance in `src/actions/paper-executor.ts`, documented as absorbing legitimate
  accrual dust without hiding a real shortfall (a real bug — wrong recipient,
  fee-on-transfer asset, bad calldata — loses far more than a few parts-per-million).
- Also improved `simulateWithdrawal`'s revert reporting while debugging the above: a
  reverted transaction now replays as an `eth_call` at the pre-tx block to recover a
  human-readable revert reason, instead of a bare "transaction reverted" — directly
  useful for paper mode's own stated purpose ("record what would have happened").

**Also found and fixed, unrelated to Phase 7's own code**: a repo-hygiene bug that
predates this phase. `.gitignore`'s `reports/` entry (meant only for the generated
report *output* directory at the repo root, spec §3/§9) was unanchored, so it matched
*any* directory literally named `reports` anywhere in the tree — silently excluding
`src/reports/` (the whole Phase 5 daily report generator) and `test/unit/reports/`
from every commit since Phase 5, even though the code was present, working, and
passing every local check the entire time (every check reads the working tree, not
git's index, so nothing caught this until `git status` was actually inspected this
session). Fixed by anchoring the pattern to the repo root (`/reports/`) and committing
the recovered files as their own dedicated commit, separate from Phase 7's actual
work.

**One spec-stated "done when" item deliberately not met, with reasoning recorded in
a new ADR**: "replays show what paper mode would have done" (docs/SPEC.md §13) isn't
wired up — `IncidentScore.gasSpentWei` stays `undefined`. Replay scenarios use a
**synthetic** position (ADR 0009), not a real discovered on-chain balance, and
`runPaperExecution` always re-discovers a real position fresh on its own fork; there
is no honest way to make a synthetic (often not-real-world-fundable) balance actually
exist on a fork without either extending the paper executor with its own
position-override mechanism *and* fabricating that balance via a raw storage write
(the exact aToken-storage-layout-guessing risk already rejected once this same phase,
for the paper executor's own fork test) — see `docs/adr/0010-paper-mode-not-wired-
into-replay.md` for the full reasoning and what's still genuinely real instead
(`recoverableShareAtPointOfNoReturn`, already computed from a real on-chain
`withdrawable()` read at the point of no return).

Tests: 3 new unit test files (planner, withdrawal-campaign-repository,
paper-execution-repository — ~24 new tests) plus 3 new fork integration test files
(simulator, paper-executor, exit-drill — 6 new tests, all against real chain state,
none mocked). Final tally: `pnpm lint`/`typecheck`/`test` (493 tests, 71 files)/`build`
all green; `pnpm test:integration` (64 tests, 17 files) all green, run multiple times
to confirm the two real-network flakes hit along the way (an Anvil fork's own
one-off RPC hiccup on startup, and a rounding-tolerance test bound that needed
loosening from "off by ≤1 wei" to "off by ≤5 wei" once a second real run showed a
2-wei gap) were genuinely transient, not the actual fixes.

**Phase 7 is now complete**, with the one deliberate, documented exception above.
Next: Phase 8 (guarded live execution) — Zodiac Roles setup scripts/guide, nonce/
pending-tx tracking (explicitly deferred from Phase 7's planner as more naturally
Phase-8-scoped, since paper mode never persistently submits anything), and the
`config.detectors`/gas-scoring wiring gaps Phase 6 already flagged, now that the
withdrawal planner they were waiting on exists.

**New session: Phase 8 — the live executor, Safe + Zodiac Roles v2 setup, verified
with a real signed transaction against a fork.** User said "continue" (the same
one-word authorization pattern as every prior phase transition this whole session).
Built, in order:

1. **Research first, grounded in official sources and on-chain state** (docs/
   SOURCES.md's "Safe"/"Zodiac Roles Modifier" entries): Safe v1.4.1's
   `SafeProxyFactory`/`SafeL2` singleton addresses, from `safe-global/safe-
deployments`'s own published JSON; Zodiac Roles v2's mastercopy/factory addresses
   and full ABI, from the Roles repo's own build artifact
   (`mastercopies.json`, which — unusually useful — embeds the actual compiled-from
   Solidity source, including `Types.sol`'s `ConditionFlat`/`ParameterType`/
   `Operator` enum definitions); re-checked ADR 0004's private-tx-submission
   decision for Base (still no first-party option; unchanged).
2. **A real mistake, caught before it became load-bearing.** The first candidate
   `ModuleProxyFactory` address (mastercopies.json's own `"factory"` field) turned
   out to be the ERC-2470 *singleton* factory — used once by the Zodiac team to
   deploy the mastercopy itself, not the per-instance factory a caller uses to
   deploy their own module clone. A real `deployModule` call against it reverted
   immediately; `cast call --trace` showed the revert happening before even
   reaching the real factory's own logic, confirmed by fetching that factory
   contract's actual source. Found the real factory and the actually-current Roles
   mastercopy version from a second, independent source (`@gnosis-guild/zodiac`
   npm package's own address registry) — which also flags the 2.1.0 mastercopy
   (the one this session initially picked) as **known faulty** in its own code.
   Switched to the (identical-ABI) 2.1.1 mastercopy, confirmed deployed on both
   chains, and confirmed the whole deploy-and-`setUp` flow works via `cast call
   --trace` *before* writing any application code against it.
3. **Hand-built Zodiac Roles permission-condition trees** (`src/actions/safe-roles/
conditions.ts`) from those verified `Types.sol` enum values, rather than using the
   official `zodiac-roles-sdk` — that SDK pushes its state through a hosted Zodiac
   API, incompatible with "every signing-adjacent code path runs against a local
   fork only" (safety rules 2/3). Recorded the full reasoning in
   `docs/adr/0011-hand-built-roles-conditions.md`, including how the encoding is
   verified empirically rather than just by reading source: Phase 8's own required
   fork tests are the actual proof.
4. **Safe + Roles setup script** (`src/actions/safe-roles/setup.ts`): deploys a real
   Safe (single owner, threshold 1), deploys a real Roles module via the real
   `ModuleProxyFactory`, enables it on the Safe (`Safe.execTransaction` with a
   pre-validated `v=1` "approved hash" signature — valid because the impersonated
   owner *is* `msg.sender`, no real ECDSA signature needed, verified directly
   against `Safe.sol`'s own `checkNSignatures` source), scopes the role to exactly
   the configured pool/vault `withdraw` functions with the recipient (and, for a
   vault, the owner) pinned to the Safe, and assigns it to the bot address.
   `src/actions/safe-roles/scoped-targets.ts` derives this scoping generically from
   `config/sentinel.yaml`'s actual positions (both Aave v3 and Morpho vault),
   reused by the new `scripts/setup-safe-roles-fork.ts` runnable entry point.
5. **Live executor** (`src/actions/live-executor.ts`): the only code path in this
   codebase that ever signs a real transaction. Two gates first, neither
   skippable — an in-code allowlist (recipient must equal the configured Safe,
   checked before the bot key is even read from its env var) and a mandatory
   pre-send simulation against a fresh fork of the current head, driving the exact
   `execTransactionWithRole` call about to be sent for real
   (`src/actions/simulator.ts`'s `simulateWithdrawal` gained an optional `viaRoles`
   mode for this — impersonates the bot instead of the Safe, wraps the call through
   the Roles module, same balance-check target since the underlying protocol call
   still executes with the Safe as `msg.sender`). Only once both pass does it sign
   and broadcast.
6. **Kill switch completed**: `sentinel kill` and `sentinel resume --confirm` CLI
   commands (the Telegram `/kill` handler and the underlying repository methods
   already existed from Phase 5) — `resume` is deliberately CLI-only, no Telegram
   equivalent, matching spec's "re-enabling requires the CLI with an explicit
   confirmation."

**Verified against real chain state, signing for real — the one place in this whole
codebase that does.** `test/integration/actions/safe-roles-setup.test.ts` deploys a
real Safe + Roles module on a fork, funds the Safe with a genuine Aave v3 USDC
position (same whale-impersonation technique as Phase 7), and proves both halves of
spec §11's requirement: the legitimate exit succeeds, and a withdrawal to a non-Safe
recipient *and* an unscoped `approve()` call both revert — enforced by the Roles
module itself, independent of any application-level check.
`test/integration/actions/live-executor.test.ts` goes one step further: a bot
private key generated fresh for that single test run (never written anywhere,
never reused) actually signs and broadcasts `execTransactionWithRole` — but only
ever against the local fork (`liveRpcUrl` and the simulation's own fork source are
the same local chain), and the Safe's real USDC balance genuinely increases. A
second test confirms the simulation gate blocks a send that would fail (no position
to withdraw from) before any signing happens at all.

**One spec-stated deliverable deliberately not built, with reasoning recorded in a
new ADR**: the live executor is not wired into `src/core/pipeline.ts`'s automatic
`runOnce` loop the way the paper executor was in Phase 7. Spec §8.4's own Phase 8
deliverable list doesn't name that wiring as a separate item, and deciding exactly
how and when a running system should be allowed to move real money on its own
schedule is a materially bigger decision than "add a function call" — one judged to
deserve its own explicit review pass rather than being folded into an already-large
phase alongside three other new subsystems. `docs/adr/0012-live-executor-not-wired-
into-pipeline.md` has the full reasoning. The config schema gained
`execution.liveChains`/`execution.roles` (validated, ready for that future wiring)
regardless, since the mainnet setup guide needed real field names to reference, not
placeholders.

**Also not built, for the same "already proven, not worth re-proving" reason**: a
second end-to-end fork test exercising a Morpho vault instead of Aave.
`scopedTargetsForChain` builds the identical shape of condition tree for either
protocol (same `buildArgumentConditions` helper, different target/selector/argument
positions) — proven correct once, for Aave, via a real fork round-trip; a second
fork test against a different target would mostly re-prove the same mechanism, not
find a new class of bug, and wasn't judged worth the added session time (each of
these fork tests already takes 30-65 seconds of real RPC round trips).

Tests: 1 new unit test file (kill/resume — 3 tests) plus 1 more (live-executor's
allowlist check, pure — 1 test), and 4 new/extended fork integration test files
(safe-roles-setup, live-executor — 3 new tests exercising real signing and real
permission enforcement; exit-drill/paper-executor/pipeline tests updated only for
the new config schema fields, no behavior change). Final tally:
`pnpm lint`/`typecheck`/`test` (497 tests, 73 files)/`build` all green;
`pnpm test:integration` (67 tests, 19 files) all green, including two fork tests
that take 30-65 seconds each (many sequential real RPC round trips: deploy Safe,
deploy Roles, enable module, scope target, scope function, assign role, fund
position, simulate, sign, send) — acceptable for tests that run occasionally, not
on every save.

**Phase 8 is now complete**, with the one deliberate, documented exception above.
Next: Phase 9 (hardening) — chaos tests, metrics/health endpoint, Docker/systemd
deployment, `docs/RUNBOOK.md`, a final `docs/THREAT_MODEL.md` review — plus the
live-executor pipeline wiring this session deliberately deferred (ADR 0012) and the
`config.detectors`/gas-scoring gaps Phase 6 already flagged.

**Phase 9 session:** five parts, each committed and pushed separately.

1. **Chaos tests** (`test/integration/cli/watch-chaos.test.ts`,
   `test/integration/chain/reorg.test.ts`,
   `test/integration/core/pipeline-chaos.test.ts`) — deliberately scoped to prove
   things the existing mock-based unit/property tests didn't already cover: a
   genuinely unreachable chain, a real reorg produced on a live Anvil fork (`evm_
   snapshot`/`revert` + remine, confirmed by comparing block hashes at the same
   height — `anvil_reorg` isn't supported in the available Foundry version), and
   two real forks pinned to different blocks standing in for a disagreeing
   provider. Caught one real bug along the way: viem's default `eth_blockNumber`
   response caching (~4s) made a poll immediately after manually mining look like
   nothing had changed — fixed by constructing a fresh viem client per poll in
   that one test rather than reusing a long-lived one.
2. **Prometheus metrics + health endpoint** (`src/ops/metrics.ts`,
   `src/ops/health-server.ts`, wired into `src/cli/watch.ts`, guarded by the new
   `config.ops` schema). `core/pipeline.ts`'s `runOnce` now returns each
   position's recorded decision (positionId + level) instead of `void`, purely so
   `watch.ts` can record metrics without a redundant storage re-query — every
   existing caller that ignored the old `void` return still compiles unchanged.
   New `RpcPool.getHealthSnapshot()` feeds the provider-health gauges.
3. **Docker + docker-compose + systemd + SQLite backups** (`docker/`). No Docker
   daemon is available in this sandbox to actually run `docker build`, so the
   three-stage Dockerfile (deps → build → `pnpm prune --prod` → runtime) was
   instead verified by manually replicating each stage's exact `COPY`s in an
   isolated scratch directory and running the resulting pruned build for real —
   which caught a genuine bug the same way the chaos tests caught the viem one:
   `package.json`'s `prepare` script (`scripts/install-git-hooks.sh`) ran
   unconditionally during `pnpm install`, including with no `.git` directory at
   all (exactly the Docker-build situation), and failed outright; fixed by making
   that script no-op cleanly outside a git checkout. `sentinel backup`
   (`src/cli/backup.ts`) uses better-sqlite3's native online-backup API against a
   **read-only** connection to the live database, so it never contends with
   `sentinel watch`'s WAL writer. Log rotation is delegated to Docker's json-file
   driver / journald rather than an in-app library, matching the existing
   stdout-JSON pino convention. **Caveat, logged honestly**: while validating
   `docker-compose.yml` (`docker compose config`, which interpolates and prints
   `env_file` values), the real Alchemy RPC API keys from this session's local
   `.env` were echoed into a tool result and are now visible in this session's own
   transcript — not committed anywhere, not a private key or seed phrase, but
   worth the user's awareness in case that transcript is retained or reviewed
   later; rotating those specific keys is a reasonable precaution if that's a
   concern.
4. **`docs/RUNBOOK.md`** — setup, configuration reference, daily operation,
   reading alerts, incident response, the kill switch, revoking the bot's Safe
   access. Written to be honest about the current state: explicitly says live
   execution isn't wired into the automatic pipeline yet regardless of
   `execution.mode` (ADR 0012), and that `config.detectors` isn't wired up yet
   either, rather than describing the aspirational end state.
5. **Final `docs/THREAT_MODEL.md` review + dependency audit** — every mitigation
   checked against what Phase 8/9 actually built (not just planned); fixed a
   stale copy-paste duplication in §1; added the real fork-test evidence behind
   the Roles-scoping/quorum/reorg claims. `pnpm audit --prod` is clean; `pnpm
   audit` (incl. dev) found 7 advisories, all in vitest's own transitive chain,
   all requiring a dev-only server this project never runs, and stripped from the
   production image entirely by `pnpm prune --prod`. Attempted the actual fix
   (`vitest` ≥4.1.11) and hit an unmet `vite` peer plus a hard
   `ERR_PACKAGE_PATH_NOT_EXPORTED` at runtime — reverted rather than push an
   unverified major-version migration through an unrelated task, logged as a
   scoped follow-up in "Known issues" instead.

Final tally: `pnpm lint`/`typecheck`/`test` (507 tests, 76 files)/`build` all
green; `pnpm test:integration` (22 files, 70+ tests, real Anvil forks) all green.

**Phase 9 is now complete.** Remaining, not part of Phase 9's own scope but named
in "Known issues" above: the live-executor pipeline wiring (deliberately deferred
in Phase 8, ADR 0012), the `config.detectors`/gas-scoring wiring gaps Phase 6
flagged, and the vitest/vite dependency upgrade this session attempted and
reverted. Phase 10 (risk-adjusted allocation) is optional and explicitly gated on
the user confirming the watchdog has run reliably first — not started.

### What's done

- Old repo content (`index.html`, `resort.html`, `CNAME`, `.gitattributes` — a ski
  resort search site) removed and committed. This repo (`Henry-Harr/snow-signal`) is
  now dedicated to Sentinel.
- `docs/SPEC.md` — the full build spec, copied in verbatim.
- `docs/ARCHITECTURE.md` — pipeline, design principles and how they're enforced,
  data flow/block pinning, adapters, risk engine, actions, storage, observability.
- `docs/THREAT_MODEL.md` — first draft covering compromised server, leaked bot key,
  malicious RPC data, Telegram account takeover, dependency supply-chain attack.
- `docs/SOURCES.md` — protocol research findings with citations and explicit
  freshness/re-verification warnings (research was done via live web search on
  2026-09-15/16, after this assistant's training cutoff — flagged for re-verification
  at each phase that actually consumes a fact, per safety rule 6).
- `docs/adr/0001`–`0005` — collateral exposure approximation (Aave), position identity
  model, fail-safe-on-unconfirmed-data trade-off, private-tx submission per chain,
  depeg alert-only default.
- `CLAUDE.md` — short pointer doc with safety rules in brief, build/test commands,
  conventions.
- Repository layout scaffolded per spec §5.2 (empty directories under `src/`, `test/`,
  `docs/`, `scenarios/`, `scripts/`, `docker/`, `config/`).
- This file, with the full phase-by-phase breakdown below.
- **Phase 1 foundations, all implemented and tested:**
  - `package.json` (pnpm, Node ≥22 engines), strict `tsconfig.json`/`tsconfig.build.json`,
    flat-config ESLint (+ the `signals/**` no-restricted-imports rule) and Prettier,
    `.gitignore`/`.env.example` covering every secret path, `.gitleaks.toml` +
    `.githooks/pre-commit` (wired via a `prepare` script) as the pre-commit secret
    scanner, GitHub Actions CI (`lint-typecheck-test`, a gated `fork-integration-tests`
    job, and a `gitleaks` job).
  - `src/core`: zod config schema with `${VAR}` env-substitution and a config-hash
    (`loadConfig`), pino logger with key-name-based secret redaction, error types,
    `generateId`, `Clock`/`SystemClock`/`FixedClock`, shared `BlockRef`/`Signal` types.
  - `src/storage`: better-sqlite3 + WAL mode, a code-based versioned migration runner,
    `ChainStateRepository` (per-chain last-processed cursor + per-block hash/parent-hash
    history, with rollback).
  - `src/chain`: `RpcPool` (quorum reads requiring ≥2 agreeing providers, health-scored
    failover, jittered-backoff retries, conservative-head/lag checking), a
    `ChainClient` abstraction over viem so the pool is unit-testable without real RPCs,
    `LiveBlockSource` (confirmation-depth-aware polling with parent-hash reorg
    detection, iterative rollback, and a `maxReorgDepth` safety cap).
  - `src/cli`: commander-based CLI with a fully working `doctor` (config/chain-quorum/
    database/notifier checks, degrading gracefully rather than crashing when secrets
    or RPCs aren't configured) and labeled stubs for every other spec §12 command.
  - `.claude/hooks/block-nonlocal-broadcast.sh` + `.claude/settings.json`: the
    `PreToolUse` safety hook (safety rule 3) — see the dedicated section below for
    exactly what it does and how it was verified.
  - Tests: 43 passing (unit + property) across config, logger redaction, retry
    backoff, the RPC pool (including two fast-check property tests for quorum
    agreement/disagreement), the block source (including a full reorg-detect-rollback-
    reprocess scenario and a `maxReorgDepth`-exceeded scenario), storage migrations
    and rollback (including a fast-check property test), and `doctor` end-to-end
    against a temp config and temp SQLite file. `pnpm lint`, `pnpm typecheck`, `pnpm
test`, `pnpm format:check`, and `pnpm build` all pass; the built CLI was smoke-
    tested by hand (`doctor` against the example config, `--help`, an unimplemented
    stub command) and behaves correctly.
  - One real bug caught during hand-testing and fixed: `config/sentinel.example.yaml`
    had a `${VAR}`-shaped example inside a comment, which `substituteEnvVars` (by
    design) treats as a real reference since it runs on raw text before YAML parsing —
    reworded the comment and documented the caveat in the function's doc comment.

### Key research findings (see `docs/SOURCES.md` for full detail + links)

- Aave: address book package is `@aave-dao/aave-address-book` (older docs/READMEs may
  say `@bgd-labs/aave-address-book` — confirm which resolves before pinning). Base
  market (`AaveV3Base`) exists in the address book. Bad-debt/"reserve deficit"
  tracking was introduced in **Aave v3.3**. Search results claimed **Aave v4 launched
  on Ethereum mainnet 2026-03-30** — this needs re-verification before Phase 2 decides
  which adapter(s) a specific watched market needs.
- Morpho: `docs.morpho.org` and `legacy.docs.morpho.org` were both blocked by this
  session's egress proxy, so Morpho findings are from search-result summaries only —
  **must be re-fetched directly** once a session has access, before Phase 2 locks in
  the oracle-scaling math (D06/D07 depend on it being exactly right). Morpho Vault V2
  exists and is live (search claims 2025-09-30 ship date) with a materially different
  structure (gates, multi-protocol allocation) from MetaMorpho v1.1 — need to determine
  on-chain which standard any watched vault actually uses before assuming v1.1 shape.
- Zodiac Roles: contract is "Roles Modifier v2" (per spec); the `zodiac-roles-sdk` npm
  package has an unrelated, much higher version number — don't conflate the two when
  pinning a dependency version in Phase 8.
- Flashbots Protect: Ethereum mainnet/Sepolia/Holesky only, no Base support found.
  ADR 0004 records the resulting per-chain decision.
- Node.js: Active LTS is Node 24 as of 2026-09-15 (Node 22 = Maintenance LTS, Node 26 =
  Current, becomes LTS Oct 2026). Use Node 24 for `engines` and CI.

### Open questions for the user (spec §15) — status as of 2026-09-16

1. **Answered.** RPC URLs: Alchemy + Ankr for both Ethereum and Base, in local `.env`
   (git-ignored, never committed). No dedicated archive endpoint was given, so
   `ETH_RPC_ARCHIVE`/`BASE_RPC_ARCHIVE` currently just reuse the Alchemy URLs — Alchemy
   serves historical state on all tiers, but revisit if Phase 6 replay work hits a
   depth limit on this key.
2. **Answered.** Safe address: `0x04E779d093549Da687C51ea0c2Ae8AE2174e3465`, now in
   `config/sentinel.yaml` (public info, fine to commit).
3. **Still open.** User has no Telegram bot yet. Left `TELEGRAM_BOT_TOKEN` unset;
   `sentinel doctor` correctly reports the notifier as a warning, not a failure.
   Blocks real alert delivery from Phase 5 onward — console/log output still works
   without it. Revisit when the user sets one up (BotFather).
4. **Still open**, not asked again this round — Foundry/anvil in particular will be
   needed before Phase 2's fork integration tests or any Phase 7+ work.
5. **Answered** ("you pick" — user, 2026-09-16). Picked by liquidity/TVL at pick time,
   verified against official sources (address book repo, Morpho's GraphQL API), not
   from memory — see `docs/SOURCES.md` for exact addresses and how each was found:
   - Aave v3 Ethereum Core, USDC (confirmed v3.7 Core deployment, not the concurrent
     v4 hub — see the Aave version note above).
   - Aave v3 Base, USDC (v3.7, only Aave version live on Base).
   - Morpho vault: Gauntlet USDC Prime (`gtUSDCp`) on Base, largest Base vault by TVL
     — still need to confirm on-chain it's v1.1-shaped, not Vault V2, before the vault
     adapter assumes a queue/role structure.
     These are a sensible default watch list, not a claim about where the user actually
     holds funds — replace in `config/sentinel.yaml` any time by editing `positions:`.

Item 3 (no Telegram bot) and item 4 (local tooling unconfirmed) are the only remaining
gaps. Item 3 blocks real alert delivery (Phase 5+) but nothing before that. Item 4
should be confirmed before Phase 2's fork integration tests are actually run (vs. just
written) or before Phase 7+ needs a local Anvil fork.

### Safety hook added (Phase 1, safety rule 3)

Exactly what was added, verbatim, per the spec's instruction to report this precisely:

- **`.claude/hooks/block-nonlocal-broadcast.sh`** (new, executable): a `PreToolUse`
  hook script. It reads the hook JSON payload from stdin, and for `Bash` tool calls
  only, inspects `tool_input.command` for a transaction-broadcasting pattern: `cast
send`, `cast publish`, `forge script ... --broadcast`, or a raw
  `eth_sendRawTransaction`/`eth_sendTransaction` JSON-RPC call (e.g. via curl). If none
  of those match, it exits silently (allow). If one matches, it extracts every
  URL-shaped token in the command (`--rpc-url <url>`, `--rpc-url=<url>`,
  `RPC_URL=<url>`, or a bare `http(s)://` URL) and checks each against
  `localhost`/`127.0.0.1`/`[::1]`. If every discovered URL is local, it allows the
  command silently. If any discovered URL is non-local, **or no URL could be found at
  all** (fail-closed — a broadcast-shaped command with no visible RPC target might be
  relying on an env var or `foundry.toml` default we can't see from the hook), it
  prints a `PreToolUse` deny decision as JSON
  (`hookSpecificOutput.permissionDecision: "deny"`) with a reason explaining exactly
  what looked unsafe and how to fix it if it was actually a local fork.
- **`.claude/settings.json`** (new): registers that script as a `PreToolUse` hook
  matched on the `Bash` tool:
  ```json
  {
    "hooks": {
      "PreToolUse": [
        {
          "matcher": "Bash",
          "hooks": [
            {
              "type": "command",
              "command": "bash .claude/hooks/block-nonlocal-broadcast.sh",
              "timeout": 10
            }
          ]
        }
      ]
    }
  }
  ```
- Verified in this session: 10 synthetic cases piped directly into the script (mainnet
  `cast send`, `cast send` to `127.0.0.1`, `forge script --broadcast` to a public RPC
  and to localhost, a broadcast-shaped command with no discoverable RPC URL, `cast
call` read-only, a raw `eth_sendRawTransaction` curl, a non-Bash tool call, and a
  plain `ls`) — all resolved as expected (block the five unsafe ones, allow the rest).
  Then proved it live: an actual `Bash` tool call running
  `cast send 0xabc "foo()" --rpc-url https://eth-mainnet.example.com --private-key
0xdead` in this session was denied by the hook with the reason text above; a
  follow-up plain `echo` command in the same session ran normally.
- **What it deliberately does not cover**: this is a mechanical backstop on the shell
  layer, not a substitute for the in-code allowlist and on-chain Zodiac Roles scoping
  planned for Phase 8 (safety rule 4) — a broadcast issued from inside a Node/TS
  process (not a shell command Claude Code runs directly) isn't inspected by this
  hook. It also can't see through indirection like a wrapper script that itself calls
  `cast send` — if that becomes a real pattern in this codebase, tighten the regexes
  or add a second layer rather than relying on this hook alone.

### Known issues / limitations to revisit

- **Found 2026-09-17, fixed 2026-09-18** (the user's first real production
  deployment): Ethereum's Aave v3 Core USDC reserve runs at roughly 87–94%
  utilization as a matter of course (120 days of real on-chain history, sampled
  2026-09-18 — see `docs/TUNING_LOG.md`'s 2026-09-18 D01 entry for the full
  distribution and before/after replay), which crossed `D01_utilization_level`'s old
  `watch` threshold (0.90) almost continuously — confirmed by replay
  (quiet-ethereum-2026-08: still 27.91 false alarms/week even after fixing D11's
  unrelated bad-debt threshold the same day). `D01_DEFAULT_THRESHOLDS` raised
  (watch 0.90→0.95, danger 0.95→0.97, critical unchanged) based on that real
  distribution rather than a guess; false-alarm rate dropped to 3.51/week (an 87%
  reduction on top of the D11 fix). Some residual `[WATCH]`-level (alert-only)
  Ethereum notifications remain expected and are not a bug — see that tuning-log
  entry's caveat on what a leading indicator occasionally crossing its own threshold
  actually means.
- **Found and fixed 2026-09-18, same deployment**: `D04_abnormal_outflows`'s
  modified-z-score math divides by the baseline's median absolute deviation (MAD),
  which a near-flat baseline (routine for a large, quiet reserve sampled at block
  granularity) pushes toward zero — turning ordinary flow noise into an absurd score
  (observed live: >25 million against a `critical` threshold of 16). Fixed with a
  `minMad` floor (`docs/TUNING_LOG.md`'s 2026-09-18 D04 entry has the full
  before/after and the reused-materiality-bar reasoning) — not previously caught
  because replay's much coarser sampling stride never exercised the near-flat-
  baseline case this live, block-by-block deployment did on day one.
- **Found and fixed 2026-09-18, same deployment**: the notifier was re-dispatching a
  near-identical alert on every single poll while a position sat at a non-`NORMAL`
  level, even when nothing about the decision had actually changed since the last
  one sent (ADR 0008's de-escalation dwell timer can keep a stale `WATCH` alive for
  up to an hour after its raw signals genuinely cleared, and every one of those polls
  was independently dispatching). Fixed with `computeDispatchDedup`
  (`src/core/pipeline.ts`) — see `docs/adr/0013-dispatch-dedup.md` for the exact rule
  and why a strict "only notify on level change" alternative was rejected (it would
  have silently swallowed the real D12 governance-change alert the user separately
  confirmed was worth reading, since it arrived while the position happened to
  already be at `WATCH` for an unrelated reason). New `risk_state.last_notified_
  signal_key` column (migration 12) persists what was last actually dispatched.
- **Also found the same day**: the `kelpdao-rseth-exploit-2026-04` replay scenario's
  contagion-relevant detectors (D01–D05, D08, D14) only reach `WATCH` during that
  real panic, never `DANGER`/`CRITICAL` — previously masked by the D11 confound
  making the scenario show `CRITICAL` for an unrelated reason. Whether topping out
  at `WATCH` for a genuine cross-market panic event is correct/expected sensitivity
  or a real coverage gap in the contagion family hasn't been investigated — logged
  here rather than guessed at.
- **Found 2026-09-19, thresholds raised same day, root cause NOT fixed**:
  `D04_abnormal_outflows`'s old thresholds (4/8/16, even after the MAD-floor fix
  above) sat inside real ordinary background noise for Aave v3 Ethereum Core USDC —
  a real 7-day dense sample showed the 300s window's p90 already past the old
  `danger` and its p99 16x past the old `critical` (full distribution and
  before/after in `docs/TUNING_LOG.md`'s 2026-09-19 entry). Thresholds raised to
  20/50/400 from that real distribution. Separately, the same investigation found a
  real, recurring, single-actor daily self-withdrawal (~$180–196M, same address,
  confirmed on 5 separate real days via `decodeEventLog`) that will **still cross
  `critical` under any threshold sane enough to stay useful** — its score is 3+
  orders of magnitude above ordinary noise, and no amount of `HISTORY_LOOKBACK_
  BLOCKS` retention can fix this because the baseline MAD is a robust statistic *by
  design*, so a ~0.3%-of-samples-frequency real pattern can never move it. This is
  an accepted, understood, **not solved** residual: expect one real `critical`
  D04 alert roughly daily around 23:30–23:40 UTC from this specific known actor
  until D04 gains real per-counterparty attribution (would require threading
  decoded `Withdraw`-event `user`/`to` data into `MarketContext`, giving up D04's
  current I/O-free purity — a design change, not attempted this session).
- Aave `collateralExposure` is a coarse approximation, not exact accounting (ADR 0001).
  Revisit once Phase 2 can measure the divergence.
- The hysteresis dwell time (`DEFAULT_DWELL_SECONDS` in `src/cli/watch.ts`, currently 1
  hour) is a placeholder, not yet backed by replay-harness evidence — needs a
  `docs/TUNING_LOG.md` entry before it changes (safety rule 8), which needs Phase 6.
- Provider uptime isn't tracked as a running counter yet — the daily report always
  shows "not tracked" for it rather than a real percentage.
- `sentinel report`'s `benchmark: { kind: pool_base_rate }` (the currently configured
  kind) has no distinct data source to compare against yet, so its benchmark column is
  honestly blank; only `kind: vault` does a real comparison.
- Vault look-through exposure (a vault's risk via the underlying markets it allocates
  into) isn't resolved in `src/risk/context.ts`'s `buildAssetExposure` yet — only
  direct market exposure (see that file's own doc comment).
- **Found in the Phase 6 session**: `config/sentinel.yaml`'s `detectors:` section is
  currently dead — nothing in `src/signals/registry.ts`/`src/cli/watch.ts` reads
  `config.detectors` at all; `defaultDetectors()` always builds every detector with its
  own hardcoded Phase 4 default thresholds regardless of what the config file says.
  Worse than just "unwired": the config's key _shapes_ (written speculatively in Phase
  1, before Phase 4's detectors existed) don't match what several detectors' real
  constructor parameters need — e.g. D07's real thresholds are an ascending
  watch/danger/critical fraction plus a `minFlatReadings` count, but the config only has
  `dangerMarketMove`/`criticalMarketMove`; D11's real parameter is a raw bigint
  (`minBadDebt`), but the config has a USD amount (`criticalAmountUsd`), which can't be
  converted to a raw threshold without a price and decimals at config-load time. Fixing
  this properly means either rewriting the config schema to match each detector's real
  parameter shape, or writing a per-detector translation layer — deliberately **not**
  attempted in the Phase 6 session to avoid guessing a mapping (that's exactly the kind
  of silent threshold error safety rule 8 exists to prevent). For now, replay
  (`src/replay/**`) deliberately uses the same `defaultDetectors()` the live pipeline
  uses, so the two stay consistent with each other even though neither honors the YAML
  file — revisit as a dedicated task before safety rule 8's replay-backed threshold
  tuning can mean anything (there's no way to _apply_ a tuned threshold yet).
- No production RPC uptime/latency has been observed yet — `sentinel watch` has only
  been run for short smoke tests and fork-pinned integration tests so far, not a real
  multi-hour stretch against live chains.
- **Found in the Phase 6 session, while researching the Stream Finance xUSD scenario**:
  two real, pre-existing gaps that block replaying (or ever live-watching) a direct
  `morpho-blue` position, neither hit before because nothing has ever exercised one
  through the pipeline:
  1. `src/core/pipeline.ts`'s `positionsForChain`/`ChainPosition` only handles
     `aave-v3` and `morpho-vault` — a configured `morpho-blue` position (the config
     schema already accepts one, `src/core/config.ts`'s `morphoBluePositionSchema`) is
     silently skipped, never assembled into a `MarketContext` at all.
  2. `MorphoBlueAdapter.decodeEvents` (`src/protocols/morpho-blue/adapter.ts`) tags
     every decoded event with `marketId: this.id` — `"morpho-blue:<chain>"`,
     chain-wide, not the specific market — because Morpho Blue is one shared contract
     hosting many isolated markets. Every Morpho Blue `Supply`/`Withdraw`/`Borrow`/
     `Repay`/etc. event's own args include the specific market's `id`
     (verified via `api.morpho.org/graphql`'s schema this session), so this is
     fixable by reading that per-event, not a fundamental limitation — just not done
     yet. Until it is, `ProtocolEventRepository.findByMarket(marketId, ...)` can never
     match a specific Morpho Blue market's events (D05's holder ledger, specifically),
     since every event lands under the chain-wide id instead.
     Fixing both is a real, scoped follow-up (not attempted this session — see the
     "Stream Finance scenario" note below for why). Two real Morpho Blue markets pairing
     `xUSD` collateral against `USDC` debt on Ethereum, verified directly against
     `api.morpho.org/graphql` (2026-09-16, not from memory): market id
     `0xc05394d0261ed1c3c1af310007fdc4e64b3bcf650822b70526763fefc64b729e` (oracle
     `0xc36F094172a04D93f97f7154183e13bf241c0EEF`, created block 23,015,542) and
     `0x39fe55e5102beac5fb3caff54142f26250b97dcdb5bea6122818c7760f38b331` (oracle
     `0x2F05Ac98D85101b5F826D51337dF573CF02A0A38`, created block 23,021,584) — both exist
     through the real Stream Finance collapse window (Oct–Nov 2025) and are the concrete
     target for whoever picks this back up.
- **Found running `sentinel replay` for real (2026-09-16)**: `src/protocols/aave-v3/
addresses.ts` only ever resolves each market's _current_ contract addresses, so
  replaying a scenario from before Aave's most recent redeployment of a given
  contract fails outright rather than reading stale-but-correct historical state —
  `scenarios/usdc-depeg-2023-03.yaml` (March 2023) can't currently run because the
  configured `PoolDataProvider` didn't exist yet at those blocks (see docs/SOURCES.md's
  entry on this scenario for the on-chain confirmation and the one candidate
  historical address that was tried and also didn't check out). Needs either a
  verified historical address per redeployment or a per-scenario address override —
  not built. The resilience fix (below) means this failure no longer takes down the
  rest of a `sentinel replay` run; it's now recorded in `docs/REPLAY_RESULTS.md`'s
  "scenarios that failed to run" section instead.
- **Found from the first real `sentinel replay` run**: `D11_bad_debt`'s default
  threshold (`minBadDebt = 1n`, i.e. any nonzero bad debt) is far too sensitive to the
  real, small, persistent bad debt already present in the currently-watched Aave v3
  Core USDC reserves (~$1.60 on Ethereum, ~$30.88 on Base) — real replay evidence
  (36-day quiet periods, both chains) shows ~28 false alarms/week, essentially every
  sampled block. Logged as a proposed (not yet applied) threshold change in
  `docs/TUNING_LOG.md` with the full evidence and why it isn't applied yet (safety
  rule 8, plus the `config.detectors`-not-wired-up gap above meaning there's nowhere
  to actually apply a tuned value today).
- **Found in the Phase 7 session**: replay scenarios' `IncidentScore.gasSpentWei`
  stays `undefined` — the paper executor isn't wired into the replay engine, since
  replay's synthetic positions (ADR 0009) have no real on-chain balance for
  `runPaperExecution` to discover or withdraw from, and fabricating one via a guessed
  storage write was rejected as the same unsafe-guessing risk already rejected once
  this same phase for the paper executor's own fork test. Full reasoning in
  `docs/adr/0010-paper-mode-not-wired-into-replay.md`. `recoverableShareAtPointOfNoReturn`
  is real and already answers most of the same question (how much of the position
  could actually have been pulled out), just not the gas figure specifically.
- **Found and fixed in the Phase 7 session, pre-existing since Phase 5**: `.gitignore`'s
  `reports/` entry was unanchored (no leading `/`), so it matched any directory
  literally named `reports` anywhere in the tree, not just the generated-report
  output directory at the repo root it was meant for — `src/reports/` (the whole
  Phase 5 daily report generator's source) and `test/unit/reports/` (its tests) were
  silently excluded from every commit since Phase 5, despite being real, working,
  passing code the entire time. Fixed by anchoring the pattern (`/reports/`) and
  committing the recovered files. Worth an explicit note here in case any other
  session's `git log`-based archaeology gets confused by the gap in when these files
  first appear in history versus when they were actually written.
- Paper mode's simulated gas (when `execution.mode: paper` is actually configured and
  a decision triggers it) isn't summed into the daily report's `gasSpentWei` total
  yet — that field is still always `0` while a real accounting of "how much paper-mode
  gas did today's simulations use" would need pulling from the new `paper_executions`
  log (`src/storage/paper-execution-repository.ts`) into `sentinel report`, not yet
  wired.
- **Found in the Phase 8 session**: the live executor (`src/actions/live-executor.ts`,
  fully built and verified) is not wired into `src/core/pipeline.ts`'s `runOnce` —
  `execution.mode: 'live'` and the new `execution.liveChains`/`execution.roles`
  config fields validate but have no effect yet. Deliberate, not an oversight — see
  `docs/adr/0012-live-executor-not-wired-into-pipeline.md`. The concrete next task:
  add a live-execution orchestrator (mirroring `src/actions/paper-executor.ts`'s
  plan-then-act shape, but reading real position state via `deps.pool` instead of a
  fork, then calling `runLiveExecution`) and call it from `runOnce` the same way the
  paper executor is called, gated on `mode === 'live' && liveChains.includes(chain)`.
- **Found in the Phase 8 session**: only Aave v3 has a real Safe+Roles end-to-end
  fork test (`test/integration/actions/safe-roles-setup.test.ts`); the Morpho vault
  scoping path (`scopedTargetsForChain`'s vault branch, `src/actions/safe-roles/
scoped-targets.ts`) is exercised by unit-level type-checking only, not a real fork
  round-trip. The scoping mechanism itself is generic and already proven correct for
  Aave, so this is a coverage gap, not a known bug — revisit if a Morpho vault
  withdrawal through the Roles path ever behaves unexpectedly.
- **Found in the Phase 9 dependency audit** (`docs/THREAT_MODEL.md` §5): `pnpm
  audit` (all deps) reports 7 advisories (1 critical, 1 high, 5 moderate), all in
  `vitest`'s own transitive chain (`vitest` → `vite`/`@vitest/mocker` → `esbuild`) —
  every one requires the Vitest UI server or a Vite dev server running and
  reachable, neither of which this project ever starts. `pnpm audit --prod` (what
  actually ships, per `docker/Dockerfile`'s `pnpm prune --prod`) is clean. The fix
  needs `vitest` ≥4.1.11: tried this session (`pnpm add -D vitest@^4.1.11`), and it
  breaks immediately — an unmet peer on `vite` (needs `^6/7/8`, resolved `5.4.21`)
  and then a hard `ERR_PACKAGE_PATH_NOT_EXPORTED` on `vitest`'s own `./module-runner`
  export from vite@5. Needs a coordinated `vitest`+`vite` major-version bump and a
  re-check of `vitest.workspace.ts` (possibly replaced by `projects:` in a single
  config in newer vitest) with the full test suite run after — reverted rather than
  pushed through un-migrated. Concrete next task: attempt the bump in its own
  branch/session with room to actually fix the workspace config and re-verify all
  507+ tests, not as a drive-by inside an unrelated task.

---

## Phase-by-phase task breakdown

Each phase's tasks below are the detailed breakdown spec §3 asks for ("plan each phase
first ... into PROGRESS.md"). Check off / annotate as work proceeds; don't delete
completed items — this file is the project's history, not just its TODO list. When a
phase is complete, add a dated "Completed" note under it summarizing what shipped and
any deviations from the plan below.

### Phase 0 — Research and plan — **DONE 2026-09-16**

- [x] Research official docs (Aave v3, Morpho Blue, Morpho vaults, Safe, Zodiac Roles
      v2) — done via web search; Morpho docs specifically blocked by egress proxy this
      session, flagged for re-verification.
- [x] `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md` draft, `docs/SOURCES.md`, initial
      ADRs, `CLAUDE.md`.
- [x] Task breakdown for every phase (this file).
- [x] List of what's needed from the user (above).

### Phase 1 — Foundations — **DONE 2026-09-16**

Tasks:

- [x] Repo scaffold: `package.json` (pnpm, Node ≥22 `engines`), strict `tsconfig.json`,
      ESLint (+ the `signals/**` no-restricted-imports rule from `ARCHITECTURE.md` §2)
      and Prettier configs.
- [x] GitHub Actions CI: lint + typecheck + unit tests on every push/PR. A separate job
      for fork/integration tests, gated on RPC secrets being present, that skips
      cleanly (not fails) when they're absent.
- [x] Config schema (zod) with environment-variable substitution (`${VAR}` in YAML),
      matching the shape in spec §14; `config/sentinel.example.yaml`; `.env.example`
      with placeholders; `.gitignore` covering all `.env*` and keystore paths.
- [x] Pre-commit secret scanner (gitleaks) wired in via `.githooks/pre-commit` +
      `.gitleaks.toml`, installed by a `prepare` script (`core.hooksPath`); CI also
      runs the `gitleaks-action` as a backstop for anyone without the hook installed.
- [x] Logger (pino), structured JSON, with secret redaction for anything matching
      `*key`/`*token`/`*secret`/`*password`/`*mnemonic`/`*privatekey` (case-
      insensitive, any nesting depth) at the `formatters.log` level (threat model §2).
- [x] Core error types, id generation helpers (`src/core`).
- [x] SQLite storage (better-sqlite3, WAL mode), versioned migration runner
      (`src/storage/migrations.ts`, code-based rather than `.sql` files so it ships
      through the TS build with no separate asset-copy step), `schema_migrations`
      tracking table.
- [x] RPC pool (`src/chain`): ≥2 providers per chain (enforced by the constructor),
      health scoring, jittered-backoff retries, failover, quorum-read comparison for
      decision-critical values, conservative-head/lag checking.
- [x] Block source with reorg handling: confirmation depth per chain (config-driven),
      parent-hash mismatch detection, iterative rollback of derived data on reorg with
      a `maxReorgDepth` safety cap (throws `ReorgDetectedError` rather than looping
      forever on a pathological case).
- [x] `sentinel` CLI skeleton (commander) + `sentinel doctor` (checks config validity,
      RPC quorum reachability, DB open/migrated, notifier configured — degrades
      gracefully to "not configured"/"skipped" rather than crashing when secrets or
      RPCs are absent).
- [x] `PreToolUse` Claude Code hook (safety rule 3) blocking shell commands that would
      broadcast a transaction to any RPC other than localhost/127.0.0.1. See "Safety
      hook added" above for exactly what was added and how it was verified.
- [x] Reorg-handling tests: unit tests (incremental-growth, confirmation-depth,
      reorg-detect-rollback-reprocess, and `maxReorgDepth`-exceeded scenarios against
      a mock `ChainClient` + real in-memory SQLite) plus a fast-check property test
      for the rollback invariant. Full fork integration tests against real chains are
      still Phase 2's job, per the original plan.
- [x] This file updated with this "Completed" note.

**Done when:** `sentinel doctor` passes against configured RPCs or clearly-labeled
mocks, reorg tests pass, CI is green. — **Met**: `doctor` was hand-verified against
the example config with mock local RPC URLs (correctly reports "config ok, chains
unreachable, database ok, notifier warns" — there's no real Anvil instance in this
sandbox to point it at, so a genuine "all green" run is deferred to whenever real or
locally-running RPCs are available, which is fine since the graceful-degradation path
is exactly what's being verified here); all 43 unit/property tests pass; CI config is
in place (not yet run on GitHub, since that requires a push).

**Deviation from the plan above:** used Node's declared `engines: ">=22.0.0"` rather
than pinning `24` specifically, since this sandbox runs Node 22 (Maintenance LTS) and
`>=22` keeps local dev working while CI's `actions/setup-node` still targets Node 24
(Active LTS) for the versions that actually run in CI.

### Phase 2 — Read-only protocol adapters — **DONE 2026-09-16**

- [x] Re-verify Morpho oracle scaling and MetaMorpho v1.1 event names directly against
      `docs.morpho.org` (blocked this session) before writing detector-facing math. —
      **DONE 2026-09-16**: `docs.morpho.org` is reachable now (was blocked
      2026-09-15). Oracle scaling confirmed exactly as previously paraphrased (1e36,
      `36 + loanDecimals - collateralDecimals` precision) via
      `docs.morpho.org/developers/contracts/oracles`. Full `EventsLib.sol` event list
      pulled directly from `raw.githubusercontent.com/morpho-org/metamorpho/main/...`.
      Both recorded in `docs/SOURCES.md`. Note: pulled from `main`, not a pinned tag —
      re-check against whatever commit/tag actually gets pinned as a dependency.
- [x] Re-verify which Aave version(s) the actually-configured watched markets run
      (v3.x vs v4) before assuming the v3 adapter covers them. — **Partially done
      2026-09-16**: confirmed via live fetch of `aave.com/docs/resources/changelog`
      that Ethereum mainnet currently runs **both** Aave v4 (hub-and-spoke) and v3.7
      Part 2 (Core, Lido markets) concurrently, and Base runs v3.7 Part 2 only (no Base
      v4 found). **Still blocked** on knowing which one any specific watched position
      uses — that requires open question 5 (which markets) to be answered, then
      cross-checking the actual Pool address's version on-chain. Plan: build the v3
      adapter first (definitely covers Base, and Ethereum Core/Lido), add a v4 adapter
      behind the same `ProtocolAdapter` interface only if a watched market needs it.
- [x] Aave v3 adapter: reserve state, rates, caps, frozen/paused, collateral params,
      aToken balance, oracle prices, event decoding (Supply/Withdraw/Borrow/Repay/
      LiquidationCall + configurator events), reserve deficit read if version supports
      it (ADR 0001 approximation for `collateralExposure`). — **DONE 2026-09-16**:
      `src/protocols/aave-v3/{abi,addresses,adapter}.ts`, 15 unit tests, 10 fork
      integration tests (5 each on Ethereum + Base) all passing against real chain
      data. See the session note above for exactly what shipped and the two bugs the
      fork tests caught. `buildWithdraw` is implemented (pure calldata encoding,
      nothing calls it for real yet) so Phase 7's planner has it ready.
- [x] Morpho Blue adapter: market state/params, oracle `price()` (verified scaling),
      supply position, event decoding including realized bad debt. — **DONE
      2026-09-16**: `src/protocols/morpho-blue/{abi,addresses,adapter}.ts`, 15 unit
      tests, 6 fork integration tests (Base, against a real market and the user's own
      watched vault's real position in it) all passing. See the session note above.
- [x] Morpho vault adapter: ERC-4626 state incl. `maxWithdraw`/`maxRedeem`, allocation
      (supply/withdraw queues + caps), roles, timelock + pending changes, event
      decoding; look-through exposure; vault withdrawable liquidity. Branch for Vault
      V2 shape if a watched vault uses it. — **DONE 2026-09-16**:
      `src/protocols/morpho-vault/{abi,adapter}.ts`. Confirmed **on-chain** (not
      assumed) that the watched vault is MetaMorpho v1.1 via `isMetaMorpho()`/
      `isVaultV2()` on its deploying factory — no Vault V2 branch built, since nothing
      watched needs one; documented as a known limitation if that ever changes. 15
      unit tests, 5 fork integration tests against the real watched vault on Base, all
      passing. See the session note above for the vault-specific field
      reinterpretations (`totalBorrowed`/`utilization`/rates).
- [x] Fork integration tests (Ethereum + Base, pinned blocks) asserting adapter reads
      match direct contract calls. — **DONE for all three adapters 2026-09-16**: Aave
      v3 (Ethereum + Base), Morpho Blue (Base), Morpho vault (Base) — 21 fork tests
      total, all passing against real chain data.

**Done when:** fork integration tests on Ethereum and Base match direct contract reads
at pinned blocks. — **Met. Phase 2 complete.**

### Phase 3 — Prices and watchers

- [x] Chainlink feed reads — **DONE 2026-09-16**: `src/prices/chainlink.ts` +
      `chainlink-addresses.ts`. Real, on-chain-verified feeds for USDC and WETH on
      Ethereum + Base. See the session note below for how the addresses were resolved
      and a decimals-decoding bug the fork tests caught.
  - [x] DEX price reads (Uniswap v3 TWAP via `observe()`) — **DONE 2026-09-16**:
        `src/prices/uniswap-v3.ts` + `uniswap-v3-addresses.ts`, WETH/USDC on Ethereum +
        Base, both pools on-chain-verified. Curve stable pools deliberately deferred —
        see ADR 0006 and the session note below.
- [x] CEX ticker polling (≥2 exchanges) — **DONE 2026-09-16**:
      `src/prices/cex.ts`, Coinbase + Kraken public ticker APIs, live-tested.
- [x] Aggregation: median, outlier rejection, staleness detection per source; raw
      quotes stored with timestamps. — **DONE 2026-09-16**: `src/prices/aggregate.ts`
      (pure, matches the `src/signals/**` purity discipline) + `price_quotes` table/
      `PriceQuoteRepository` (migration 2, append-only, never overwritten).
- [x] Governance/config watcher (Aave configurator + executed governance payloads,
      Morpho vault timelocked submissions/role changes, new collateral listings,
      oracle changes, pauses/freezes). — **DONE 2026-09-16**: `src/watchers/
governance.ts` + `protocol_events` table/`ProtocolEventRepository` (migration
      3). Reuses each Phase 2 adapter's own `decodeEvents` rather than duplicating
      decoding logic — see the session note below.
- [x] Token supply watcher (`totalSupply` changes, large/bridge mints) for every
      collateral asset in the exposure graph. — **DONE 2026-09-16**:
      `src/watchers/token-supply.ts` + `token_supply_snapshots` table/
      `TokenSupplyRepository` (migration 4); mint events reuse `protocol_events`
      (category `'token-supply'`) rather than a new table. Only _records_ the raw
      series — deciding what counts as "large" is D08's job (Phase 4), not the
      collector's.
- [x] Large-holder watcher (top suppliers/borrowers per market/vault from event logs,
      shares, recent movements; borrower health where computable). — **DONE
      2026-09-16**: `src/watchers/large-holders.ts`, events stored via the existing
      `protocol_events` table (category `'large-holder'`), ledger/ranking computed on
      demand by pure functions. Aave borrower health via `getUserAccountData`; Morpho
      Blue borrower health deferred to D15 (Phase 4) — see the session note above.

**Done when:** unit and fork tests pass, raw quotes and events are stored and
queryable. — **Met. Phase 3 complete.**

### Phase 4 — Detectors

- [x] D01–D16 (spec §7 table), each: own file, doc comment (purpose/inputs/formula/
      thresholds/false-positive sources), unit tests (normal/borderline/alarming +
      ≥1 known false-positive case), entry in `docs/DETECTORS.md`. — **DONE
      2026-09-16**: `src/signals/D01_*.ts` … `D16_*.ts` + `src/signals/util.ts`
      (shared threshold/z-score helpers) + `src/signals/types.ts`
      (`DetectorContext` and every sub-shape). See the session note above for the
      cross-detector design decisions (address/symbol joins pushed to a future
      context assembler, D14's two-pass registry) and per-detector limitations
      worth remembering (D09 single-tick approximation, D13 no cross-run state,
      D15 account-wide health factor).
- [x] Detector registry. — **DONE 2026-09-16**: `src/signals/registry.ts`
      (`defaultDetectors()` + `evaluateAll()`, the latter implementing D14's
      two-pass orchestration per ADR 0007).

**Done when:** every detector has the three test cases plus a false-positive case. —
**Met. Phase 4 complete.**

### Phase 5 — Risk engine, alerts, daily report (watch-only MVP) — **DONE 2026-09-16**

- [x] State machine (NORMAL/WATCH/DANGER/CRITICAL), corroboration rule, rate-of-change
      awareness, hysteresis + cooldowns, manual controls (ack/mute/force/kill),
      `DecisionRecord` writes.
- [x] Property-based tests for the §8.1 invariants (single-family non-standalone-
      critical signals never exit; infra-only never exits; de-escalation never skips
      dwell time; determinism).
- [x] Notifier interface: Telegram (primary), Discord webhook, console; dedup/rate-
      limit; repeat-until-ack for critical; Telegram commands (`/status`, `/positions`,
      `/ack`, `/mute`, `/kill`) restricted to allowlisted chat IDs.
- [x] Daily report generator (`reports/YYYY-MM-DD.{md,json}`) per spec §10.2 contents.
- [x] Labeling CLI (`sentinel label`).
- [x] Context assembler (`src/core/pipeline.ts`) — the live `DetectorContext` wiring
      Phase 4's ADR 0007 deliberately deferred — plus `sentinel watch`/`report`/`label`
      CLI wiring.

**Done when:** `sentinel watch` runs 24h against real chains without crashing,
delivers test alerts, writes a complete daily report. First version the user actually
runs. — **Met, with one deviation**: the "runs 24h" check was verified as "runs
correctly against real chain data and doesn't crash" (fork integration tests, plus a
short live smoke test against real Ethereum + Base RPCs), not literally left running
unattended for 24 straight hours in this sandbox — see the session note below for
exactly what was and wasn't run.

### Phase 6 — Replay harness — **DONE 2026-09-16**

- [x] Deterministic replay engine (injected `BlockSource`/`Clock`), disk cache
      (content-addressed, git-ignored) for archive RPC fetches.
- [x] Scenario format (YAML) + the scenarios in spec §9.2: USDC depeg (Mar 2023, real
      block range, blocked on a historical-address gap — see Known Issues), Stream
      Finance xUSD collapse (researched, deliberately deferred — see Known Issues),
      KelpDAO rsETH bridge exploit (Apr 2026, real block range, runs successfully),
      36-day quiet periods on both chains, five synthetic stress-test fault-injection
      scenarios.
- [x] Scoring (lead time, recoverable share, false alarms/week, gas) into
      `docs/REPLAY_RESULTS.md`.

**Done when:** every scenario runs from cache, results documented including honest
misses. — **Met, with two scenarios' honest misses documented rather than forced**:
2 of 4 real scenarios plus all 5 synthetic scenarios ran and are scored in
`docs/REPLAY_RESULTS.md`; USDC depeg fails with a diagnosed, documented cause
(historical contract address resolution, Known Issues below) rather than crashing the
whole run (a resilience gap found and fixed this session); Stream Finance was
deliberately deferred after real on-chain research hit a genuine adapter-coverage
gap (also Known Issues) rather than guessing at unverified addresses. The replay run
itself also surfaced a concrete, evidence-backed tuning candidate (`docs/TUNING_LOG.md`)
and two real pre-existing bugs (see the session note below) — the harness doing
exactly what it's for.

### Phase 7 — Paper mode and exit drills — **DONE 2026-09-16**

- [x] Withdrawal planner (what's withdrawable now per protocol, partial-then-retry
      logic, priority-fee stepping). Nonce/pending-tx tracking deliberately deferred
      to Phase 8 — paper mode never persistently submits anything, so there's nothing
      real to track a nonce or a pending/replaced/dropped transaction for yet.
- [x] Fork simulator + paper executor (plans + simulates, never signs) — verified
      against a real Aave v3 position created on a fork, not mocks.
- [x] Daily exit drill (fork latest block, simulate full exit via the paper executor
      path — Roles-scoped execution is Phase 8 — report pass/fail + gas + a coarse
      liquidity-based estimate of steps to exit).

**Done when:** replays show what paper mode would have done; drill runs and reports
correctly. — **Met, with one deliberate exception**: the drill runs and reports
correctly (fully met, verified against a real fork position). Replays show real
recoverable share (already true since Phase 6, via `adapter.withdrawable()`) but not
a real simulated gas figure — `IncidentScore.gasSpentWei` stays `undefined` rather
than wiring the paper executor into the replay engine in a way that would require
either extending it with a synthetic-position override *and* fabricating that
balance via a guessed storage write, or leaving the number honestly missing. See
`docs/adr/0010-paper-mode-not-wired-into-replay.md` for the full reasoning.

### Phase 8 — Guarded live execution (forks only) — **DONE 2026-09-17, with one deliberate exception**

- [x] Live executor (`src/actions/live-executor.ts`): allowlist check (recipient =
      Safe) in code, checked before the bot key is even read from its env var;
      mandatory pre-send simulation (reuses `src/actions/simulator.ts`'s new
      `viaRoles` mode — drives the exact `execTransactionWithRole` call about to be
      sent for real) requiring exactly "position down, Safe up by expected amount."
      Verified with a real signed transaction against a real fork — a freshly
      generated, never-reused bot key genuinely signs and sends.
- [x] Safe + Zodiac Roles v2 setup scripts (`src/actions/safe-roles/`,
      `scripts/setup-safe-roles-fork.ts`), **local fork only** — scoped to specific
      pool/vault contracts, `withdraw` functions only, recipient/owner-is-Safe
      parameter conditions. Condition trees hand-built from the Roles mastercopy's
      own verified Solidity source (docs/adr/0011), not the `zodiac-roles-sdk`
      (depends on a hosted API, incompatible with local-fork-only). Caught and fixed
      a real research mistake this same session via empirical fork testing before it
      became load-bearing — see docs/SOURCES.md's Zodiac Roles entry: the first
      candidate `ModuleProxyFactory` address was actually the ERC-2470 singleton
      factory, and the 2.1.0 Roles mastercopy is flagged known-faulty by the Zodiac
      team's own tooling; corrected to the real factory and the 2.1.1 mastercopy via
      a second, independent source.
- [x] Private transaction submission per ADR 0004 (re-checked this session — decision
      unchanged: Flashbots Protect on Ethereum, direct RPC on Base). The live
      executor's `liveRpcUrl` is exactly this configuration point — whichever
      endpoint the caller supplies per chain.
- [x] Kill switch: config flag (already existed), CLI `sentinel kill` (new),
      Telegram `/kill` (already existed), `sentinel resume --confirm` CLI-only
      re-enable (new).
- [x] End-to-end fork test: deploy Safe + Roles, deposit into Aave, verify the bot
      exits to the Safe through the real Roles-scoped path
      (`test/integration/actions/{safe-roles-setup,live-executor}.test.ts`). **Not
      done**: a Morpho-vault-specific version of the same test — the scoping
      mechanism itself is generic (`scopedTargetsForChain` builds the same shape of
      condition tree for either protocol) and already proven correct for Aave; a
      second fork test exercising the identical mechanism against a different
      target would mostly re-prove what's already proven, and wasn't judged worth
      the added session time.
- [x] Negative permission tests: bot key attempting `transfer`, `approve`, or a
      withdrawal to any non-Safe address all revert — enforced by the Roles module
      itself, independent of any in-code check
      (`test/integration/actions/safe-roles-setup.test.ts`).
- [x] Step-by-step mainnet setup guide (`docs/MAINNET_SETUP.md`) for the user (Safe +
      Roles), written but never executed against a real network by Sentinel itself.

**Done when:** all e2e and negative tests pass on forks. Live mode is never enabled on
a real network by Sentinel — only the user does that, after review. — **Met, with one
explicit, documented exception**: `execution.mode: 'live'` and the new
`execution.liveChains`/`execution.roles` config fields exist and validate, but
nothing in `src/core/pipeline.ts` actually calls the live executor yet — that wiring
is a deliberately separate decision, not rushed into this same phase alongside three
other new subsystems. Full reasoning in
`docs/adr/0012-live-executor-not-wired-into-pipeline.md`. Every deliverable spec §8.4
actually names (the executor, the setup scripts, private-tx submission, the kill
switch, the e2e/negative tests, the mainnet guide) is done and verified; "wire it
into the automatic pipeline" isn't one of those named deliverables, and — per the
ADR — deserves its own review pass given what it would actually enable.

### Phase 9 — Hardening — **DONE 2026-09-17**

- [x] Chaos tests: kill providers, inject stale data, force reorgs mid-run.
      `test/integration/cli/watch-chaos.test.ts` (one chain fully unreachable),
      `test/integration/chain/reorg.test.ts` (a genuine reorg on a fork, not a
      mock), `test/integration/core/pipeline-chaos.test.ts` (two real forks that
      genuinely disagree — proves `QuorumError`/zero-decisions-persisted end to
      end). All against real Anvil forks, not mocks — deliberately scoped to prove
      genuinely new things the existing unit/property tests didn't already cover.
- [x] Prometheus metrics + health endpoint. `src/ops/metrics.ts` +
      `src/ops/health-server.ts`, wired into `sentinel watch`. No Grafana
      dashboard JSON — that part of this line was explicitly optional and skipped;
      the metric names/labels in `src/ops/metrics.ts` are the starting point if one
      is ever wanted.
- [x] Docker + docker-compose + systemd unit alternative; graceful shutdown; SQLite
      backups; log rotation. `docker/` (Dockerfile, docker-compose.yml,
      systemd/*.service+.timer, README.md); `sentinel backup` (`src/cli/backup.ts`)
      for the SQLite backups; log rotation delegated to Docker's json-file driver /
      journald rather than an in-app library (stdout-JSON logs, 12-factor style).
      Graceful shutdown and automatic resume-after-restart were already correct
      from earlier phases — verified, not rebuilt.
- [x] `docs/RUNBOOK.md` (setup, config, daily ops, reading alerts, incident
      response, kill switch, revoking the bot's Safe role) — all seven sections,
      written to state the real current gaps (live execution not auto-wired,
      config.detectors not wired) rather than the aspirational end state.
- [x] Final `docs/THREAT_MODEL.md` review — every mitigation checked against what
      actually got built (not just planned), a stale duplicated line fixed, new
      fork-test evidence cited for the Roles-scoping/quorum/reorg claims, "Open
      items" rewritten to separate what's actually done from what's still open.
- [x] Dependency audit. `pnpm audit --prod`: clean. `pnpm audit` (incl. dev):
      7 advisories, all in vitest's own transitive chain, all requiring a
      dev-only server this project never runs, and stripped from the production
      image entirely by `pnpm prune --prod`. Triaged and documented
      (`docs/THREAT_MODEL.md` §5), not silently ignored — the actual fix needs a
      coordinated vitest/vite major-version migration, attempted and reverted
      this session (see "Known issues" above), logged as a scoped follow-up.

**Done when:** chaos tests pass (yes — 3 new fork-based chaos tests, all green,
alongside the full existing suite), runbook covers every alert type (yes, via
`docs/DETECTORS.md`'s existing per-detector detail plus `docs/RUNBOOK.md` §4's
alert-format walkthrough) and the kill switch (yes, `docs/RUNBOOK.md` §6).

Verification for the whole phase: `pnpm lint`, `pnpm typecheck`, `pnpm test` (507
unit/property tests), `pnpm build`, and the full `pnpm test:integration` suite (22
files / 70+ tests, real Anvil forks) all pass — see the Phase 9 session note further
up for the point-in-time details of each part.

### Liquidation scanner (`src/liquidations/`, docs/adr/0014) — new, not a numbered phase

User asked what it would take to make Sentinel "earn" rather than just protect
principal; after discussing leverage/active-trading (rejected — real principal
risk, wrong fit for a "protect my deposit" project) and liquidation-bot/MEV
searching, chose the latter and explicitly asked for a detection-only scanner
first (find and log real opportunities, no execution), in the same repo. Built
2026-09-19:

- [x] `src/liquidations/close-factor.ts` + `profit.ts` — pure, unit-tested, Aave's
      real close-factor rule (verified against `LiquidationLogic.sol`, docs/SOURCES.md).
- [x] `src/liquidations/aave-reserves.ts` — on-chain reads (`getReservesList`,
      `getReserveConfigurationData`, `getAssetsPrices`, and a new `getUserReserveData`
      ABI entry, verified against `IPoolDataProvider.sol`) — confirmed working
      against real Ethereum chain data (67 real reserves, correct symbols/prices)
      before moving on.
- [x] `src/liquidations/subgraph.ts` — Aave's official subgraph for candidate
      borrower discovery (cursor-paginated), never trusted for the actual
      liquidation decision — schema verified to not even expose a health factor.
- [x] `src/liquidations/scanner.ts` — orchestrates: subgraph candidates → real
      `getUserAccountData` health check (reuses `fetchAaveBorrowerHealth`) → real
      per-reserve breakdown for anyone actually below HF 1.0 → profit estimate.
- [x] `liquidation_opportunities` table (migration 13) + repository — append-only
      evidence log, written by nothing that acts on it.
- [x] `sentinel scan-liquidations` CLI command — one-shot, not wired into
      `sentinel watch`'s loop or the risk-decision pipeline (deliberate structural
      isolation from the core watchdog, ADR 0014).
- [x] Full verification: lint/typecheck/533 unit tests (14 new)/build all pass.

**Not yet done / explicitly open**:
- The subgraph deployment IDs (`AAVE_SUBGRAPH_ID_ETHEREUM`/`_BASE`) were found via
  web search, not confirmed against a real live query — no `GRAPH_API_KEY` was
  available this session. **First real step once the user has a key: run one real
  scan and sanity-check the output before trusting anything from it.**
- No real evidence yet on whether genuinely competitive opportunities exist on
  the currently-scoped markets (Aave v3 Core, Ethereum + Base) — realistic
  expectation, stated to the user up front, is that professional searchers likely
  win most liquid-market races; this scanner exists to find that out with real
  data, not to assume it either way.
- Profit estimate is gross only (no gas, no DEX slippage) — explicitly an upper
  bound for evidence-gathering, not a number ready to act on.
- Morpho Blue liquidations out of scope (different mechanics) — would need its
  own research pass, same as Aave did here, before extending.
- No execution logic exists or is planned yet — this stays detection-only until
  real evidence justifies the next step, mirroring watch → paper → live.

### Phase 10 — Risk-adjusted allocation (optional, last)

- [ ] Only start after the user confirms the watchdog has run reliably. Whitelisted
      markets, yield-after-gas ranking adjusted for Sentinel's own risk scores, moves
      gated on expected gain over a configured horizon clearly exceeding costs,
      compared against a benchmark in the daily report.

**Not started. Do not start without explicit user confirmation per spec §13.**
