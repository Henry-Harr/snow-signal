# Progress

This is the project's memory across sessions. Read this in full at the start of every
session, along with `CLAUDE.md` and the relevant section of `docs/SPEC.md`.

## Status as of 2026-09-16

**Phase 0 (Research and plan): complete. Phase 1 (Foundations): complete. Phase 2
(read-only protocol adapters): complete. Phase 3 (prices and watchers): complete.**
Price collection (Chainlink + CEX + Uniswap v3 DEX, aggregation, storage), the
governance/config watcher, the token-supply watcher, and the large-holder watcher are
all done — Phase 4 (detectors) is next. Repo repurposed from an unrelated static
ski-resort site to Sentinel per the user's explicit instruction, then built out
through the full Phase 1 foundation in the same session. `pnpm lint`, `pnpm
typecheck`, `pnpm test` (174 tests, unit + property), `pnpm build`, and `pnpm
test:integration` (44 fork/live tests against real Ethereum + Base data and real
Coinbase/Kraken APIs) all pass.

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

- Aave `collateralExposure` is a coarse approximation, not exact accounting (ADR 0001).
  Revisit once Phase 2 can measure the divergence.
- Morpho protocol facts in `docs/SOURCES.md` are unverified against primary docs due to
  an egress block this session — treat as provisional.
- No code exists yet. Phase 1 starts now, in this same session, immediately after this
  file is written.

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

- [ ] D01–D16 (spec §7 table), each: own file, doc comment (purpose/inputs/formula/
      thresholds/false-positive sources), unit tests (normal/borderline/alarming +
      ≥1 known false-positive case), entry in `docs/DETECTORS.md`.
- [ ] Detector registry.

**Done when:** every detector has the three test cases plus a false-positive case.

### Phase 5 — Risk engine, alerts, daily report (watch-only MVP)

- [ ] State machine (NORMAL/WATCH/DANGER/CRITICAL), corroboration rule, rate-of-change
      awareness, hysteresis + cooldowns, manual controls (ack/mute/force/kill),
      `DecisionRecord` writes.
- [ ] Property-based tests for the §8.1 invariants (single-family non-standalone-
      critical signals never exit; infra-only never exits; de-escalation never skips
      dwell time; determinism).
- [ ] Notifier interface: Telegram (primary), Discord webhook, console; dedup/rate-
      limit; repeat-until-ack for critical; Telegram commands (`/status`, `/positions`,
      `/ack`, `/mute`, `/kill`) restricted to allowlisted chat IDs.
- [ ] Daily report generator (`reports/YYYY-MM-DD.{md,json}`) per spec §10.2 contents.
- [ ] Labeling CLI (`sentinel label`).

**Done when:** `sentinel watch` runs 24h against real chains without crashing,
delivers test alerts, writes a complete daily report. First version the user actually
runs.

### Phase 6 — Replay harness

- [ ] Deterministic replay engine (injected `BlockSource`/`Clock`), disk cache
      (content-addressed, git-ignored) for archive RPC fetches.
- [ ] Scenario format (YAML) + the scenarios in spec §9.2: USDC depeg (Mar 2023),
      Stream Finance xUSD collapse (research exact chains/markets — may need minimal
      read-only support or reconstruction, document the choice), KelpDAO rsETH bridge
      exploit (Apr 2026 — research exact block range from postmortems, don't guess),
      ≥30 quiet days per chain, synthetic stress-test fault injection.
- [ ] Scoring (lead time, recoverable share, false alarms/week, gas) into
      `docs/REPLAY_RESULTS.md`.

**Done when:** every scenario runs from cache, results documented including honest
misses.

### Phase 7 — Paper mode and exit drills

- [ ] Withdrawal planner (what's withdrawable now per protocol, partial-then-retry
      logic, priority-fee stepping, nonce/pending-tx tracking).
- [ ] Fork simulator + paper executor (plans + simulates, never signs).
- [ ] Daily exit drill (fork latest block, simulate full exit via real executor path,
      report pass/fail + gas + estimated blocks-to-exit).

**Done when:** replays show what paper mode would have done; drill runs and reports
correctly.

### Phase 8 — Guarded live execution (forks only)

- [ ] Live executor: allowlist check (recipient = Safe) in code, pre-send simulation
      requiring exactly "position down, Safe up by expected amount."
- [ ] Safe + Zodiac Roles v2 setup scripts, **local fork only** — scoped to specific
      pool/vault contracts, withdraw/redeem functions only, recipient/owner-is-Safe
      parameter conditions (verify exact condition operators against Roles v2 docs at
      implementation time, not from this file).
- [ ] Private transaction submission per ADR 0004 (Flashbots Protect on Ethereum;
      direct RPC on Base, revisit if that changes).
- [ ] Kill switch: config flag, CLI `sentinel kill`, Telegram `/kill`;
      `sentinel resume --confirm` CLI-only re-enable.
- [ ] End-to-end fork test: deploy Safe + Roles, deposit into Aave and a Morpho vault,
      trigger synthetic crisis, verify bot exits to Safe.
- [ ] Negative permission tests: bot key attempting `transfer`, `approve`, or
      withdrawal to any non-Safe address must revert.
- [ ] Step-by-step mainnet setup guide for the user (Safe + Roles), written but never
      executed against a real network by Sentinel itself.

**Done when:** all e2e and negative tests pass on forks. Live mode is never enabled on
a real network by Sentinel — only the user does that, after review.

### Phase 9 — Hardening

- [ ] Chaos tests: kill providers, inject stale data, force reorgs mid-run.
- [ ] Prometheus metrics + optional Grafana dashboard JSON; health endpoint.
- [ ] Docker + docker-compose + systemd unit alternative; graceful shutdown; SQLite
      backups; log rotation.
- [ ] `docs/RUNBOOK.md` (setup, config, daily ops, reading alerts, incident response,
      kill switch, revoking the bot's Safe role).
- [ ] Final `docs/THREAT_MODEL.md` review.
- [ ] Dependency audit.

**Done when:** chaos tests pass, runbook covers every alert type and the kill switch.

### Phase 10 — Risk-adjusted allocation (optional, last)

- [ ] Only start after the user confirms the watchdog has run reliably. Whitelisted
      markets, yield-after-gas ranking adjusted for Sentinel's own risk scores, moves
      gated on expected gain over a configured horizon clearly exceeding costs,
      compared against a benchmark in the daily report.

**Not started. Do not start without explicit user confirmation per spec §13.**
