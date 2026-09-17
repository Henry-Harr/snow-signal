# Sources

This file records where every protocol fact, address, ABI, and package choice used by
Sentinel came from. Safety rule 6 (see `docs/SPEC.md` §2) forbids hardcoding contract
facts from memory — every fact below was pulled from an official source, and anything
consumed by code should ideally come from a maintained package/API rather than a
hardcoded literal, so it stays correct as protocols upgrade.

**Freshness warning:** most of the research below was gathered via live web search on
2026-09-15, after this assistant's January 2026 knowledge cutoff — treat any entry not
marked "re-verified directly" as claimed-by-search, not verified-by-me-directly, and
re-check it against the primary source link before it drives an implementation
decision. Entries marked "re-verified directly (2026-09-16)" were fetched live from the
primary source (official docs site or raw GitHub) in the Phase 2 session and can be
trusted as of that fetch, though addresses/ABIs should still be re-pulled from a
maintained package at actual implementation time rather than copied from here.

## Aave v3 / v4

- Docs: https://aave.com/docs/aave-v3/overview , https://aave.com/docs/aave-v3/smart-contracts
- Changelog: https://aave.com/docs/resources/changelog
- Address book (Solidity + TS), current package name **`@aave-dao/aave-address-book`**
  (the older `@bgd-labs/aave-address-book` name shows up in search results and older
  docs/READMEs — confirm which one resolves on npm before pinning a version in Phase 2).
  Repo: https://github.com/aave-dao/aave-address-book
  - Exports one module per market, e.g. `AaveV3Ethereum`, `AaveV3Base`, each with `POOL`,
    `POOL_ADDRESSES_PROVIDER`, `ORACLE`, `AAVE_PROTOCOL_DATA_PROVIDER`, etc.
  - Confirmed (via raw GitHub fetch of `src/AaveV3Base.sol` on `main`,
    2026-09-15) that an `AaveV3Base` module exists with a `POOL` address — i.e. Base is
    covered. Re-fetch at implementation time; do not copy the address into code from
    this doc.
- **Watched-market Pool addresses, verified directly (2026-09-16)** by fetching
  `raw.githubusercontent.com/aave-dao/aave-address-book/main/src/AaveV3{Ethereum,Base}.sol`:
  Ethereum Core `POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`,
  `AAVE_PROTOCOL_DATA_PROVIDER = 0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD`; Base
  `POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`,
  `AAVE_PROTOCOL_DATA_PROVIDER = 0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A`. Recorded
  here for traceability; adapter code should still resolve these from the
  `@aave-dao/aave-address-book` npm package at runtime rather than a hardcoded literal,
  per this file's own header rule.
- Bad debt / reserve deficit accounting: introduced in **Aave v3.3** (`eliminateDeficit()`,
  `getReserveDeficit()` on the data provider, permissioned `eliminateReserveDeficit()` on
  Pool). Source: https://github.com/aave-dao/aave-v3-origin/blob/main/docs/3.3/Aave-v3.3-features.md
  — relevant to D11 (bad debt detector) and to whether `MarketSnapshot.badDebt` can be
  populated for a given market/version.
  - Web search (2026-09-15) reported Aave v3.6 deployed to nine networks including
    Ethereum in Jan 2026, and v3.7 on Base. It also reported **Aave v4 launched on
    Ethereum mainnet on 2026-03-30** ("hub-and-spoke" architecture), per
    https://www.theblock.co/news/defi/2026-03-30-aave-v4-launches-ethereum-mainnet-395617 .
  - **Re-verified directly (2026-09-16, Phase 2 start)** against
    `https://aave.com/docs/resources/changelog` (fetched live, not from memory): **both**
    Aave v4 (hub-and-spoke, 3 hubs / 11 spokes) **and** Aave v3.7 Part 2 are live on
    **Ethereum mainnet** concurrently — v3.7 Part 2 covers the Ethereum Core and Lido
    markets specifically, deployed 2026-05-29. **Base** runs **v3.7 Part 2** (also part
    of the same 2026-05-29 multi-chain rollout, alongside Polygon, Avalanche, Arbitrum,
    BNB Chain, Linea, Plasma, Mantle). So on Ethereum there are at least two
    concurrently-live deployments (a v4 hub/spoke and v3.7 Core/Lido) — **which one a
    watched position is actually on is not yet knowable** until the user answers open
    question 5 (which markets to watch) and we cross-check the specific Pool address's
    version-reporting function on-chain. Do not assume "the Ethereum market" means one
    or the other. Base only needs the v3 adapter for now (no Base v4 deployment found).
    Spec §6.2 already requires a v4 adapter behind the same `ProtocolAdapter` interface
    if a watched position turns out to be on v4 — build the v3 adapter first (covers
    Base for sure, and the Ethereum Core/Lido markets), add v4 once a watched market
    needs it.

## Morpho Blue

- Docs: https://docs.morpho.org/learn/concepts/oracle/ ,
  https://docs.morpho.org/developers/contracts/oracles/
  (`docs.morpho.org` was blocked by this session's egress proxy on 2026-09-15; **it is
  reachable as of 2026-09-16** — re-checked directly, see below.)
- `MarketParams` struct: `loanToken`, `collateralToken`, `oracle`, `irm`, `lltv`.
- **Oracle scaling, re-verified directly (2026-09-16)** by fetching
  `https://docs.morpho.org/developers/contracts/oracles` live: `IOracle.price()`
  returns "the price of 1 asset of collateral token quoted in 1 asset of loan token,
  scaled by 1e36," precisely: "the price of 10**(collateral token decimals) assets of
  collateral token quoted in 10**(loan token decimals) assets of loan token with
  `36 + loan token decimals - collateral token decimals` decimals of precision." This
  confirms the earlier search-derived paraphrase was correct — safe to use for D06/D07
  price-deviation math in Phase 2/4, cite this doc + fetch date in the code comment
  next to wherever the scaling constant is applied.
- **Contract address, confirmed directly (2026-09-16)**: queried
  `api.morpho.org/graphql` (a `markets` query, `morphoBlue.address` field) filtered to
  `chainId_in: [1]` and separately `[8453]` — both returned
  `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`. Morpho Blue **is** deployed to the same
  address on Ethereum and Base (CREATE2-deterministic, as earlier third-party sources
  claimed, now verified directly rather than trusted from search). Recorded in
  `src/protocols/morpho-blue/addresses.ts`.
- Full `IMorpho` interface (functions `market`, `idToMarketParams`, `position`,
  `withdraw`; `MarketParams`/`Market`/`Position` struct field orders; `type Id is
bytes32`), `EventsLib.sol`'s full event list (including `Liquidate`'s
  `badDebtAssets`/`badDebtShares` — the direct on-chain signal for D11), `IOracle
.price()`, and `IIrm.borrowRateView()` (borrow rate **per second, WAD-scaled**) all
  **re-verified directly (2026-09-16)** against `raw.githubusercontent.com/morpho-org/
morpho-blue/main/...` — recorded in `src/protocols/morpho-blue/abi.ts`.
- **Virtual-shares conversion** (`SharesMathLib.sol`, verified 2026-09-16):
  `VIRTUAL_SHARES = 1e6`, `VIRTUAL_ASSETS = 1`, added to both sides of every
  shares<->assets conversion. `toAssetsDown(shares) = shares * (totalAssets + 1) /
(totalShares + 1e6)`; `toSharesUp(assets) = ceil(assets * (totalShares + 1e6) /
(totalAssets + 1))`. Used for position-balance conversion and the `buildWithdraw`
  "max" estimate in `src/protocols/morpho-blue/adapter.ts`.

## Watched Morpho vault pick

- User asked the assistant to pick the watched vault(s) (2026-09-16). Queried
  `api.morpho.org/graphql` directly (`vaults` query, `chainId_in: [8453]`, ordered by
  `totalAssetsUsd` desc) and picked the largest by TVL at pick time: **Gauntlet USDC
  Prime** (`gtUSDCp`) on Base, `0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61`, ~$421.7M
  TVL. This is a default-by-liquidity choice, not a recommendation — revisit if the
  user names a specific vault they actually hold. Still need to confirm on-chain
  whether it's MetaMorpho v1.1 or Vault V2 shaped before Phase 2 vault-adapter code
  assumes a queue/role structure (see the Vault V2 caveat below).

## Morpho Vaults (MetaMorpho v1.1, Vault V2)

- MetaMorpho (v1.1) repo: https://github.com/morpho-org/metamorpho-v1.1
- Vault V2 repo: https://github.com/morpho-org/vault-v2
- Vault V2 announcement: https://morpho.org/blog/morpho-vaults-v2-a-new-standard-for-asset-curation/
- Per search results: Vault V2 shipped 2025-09-30, first live deployment (Keyrock USDC
  Vault) 2025-10-08, audited by Blackthorn. Key differences from v1.1 relevant to the
  vault adapter (spec §6.4): V2 can allocate across multiple Morpho versions, has
  first-class "gates" as external timelocked contracts, and separates idle liquidity
  more explicitly. **If any watched vault is a V2 vault**, its allocation/queue/role
  reads will differ structurally from v1.1's `supplyQueue`/`withdrawQueue`/curator
  model — confirm which standard a given watched vault uses on-chain (its bytecode /
  factory) before assuming v1.1 shape.
- **Watched vault's shape, confirmed on-chain (2026-09-16)**: the user's watched vault
  (Gauntlet USDC Prime, `0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61` on Base) was
  deployed by factory `0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101`. Called
  `isMetaMorpho(vault)` on that factory directly via `cast call` against the live Base
  RPC: returned `true`. Called `isVaultV2(vault)` on the same factory: reverted (that
  function doesn't exist on a v1.1 factory — confirmed via `IVaultV2Factory.sol`'s
  interface, which only a _different_ factory contract would implement). **This is a
  MetaMorpho v1.1 vault, not Vault V2** — `src/protocols/morpho-vault/adapter.ts`
  implements v1.1 only; it will misread a Vault V2 vault if one is ever added to
  watched positions (needs a separate adapter, per spec §6.4). The same factory
  address (`0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101`) also deployed at least one
  Ethereum vault (Steakhouse USDT, found via `api.morpho.org/graphql`), alongside an
  older, different factory address (`0x1897A8997241C1cD4bD0698647e4EB7213535c24`,
  likely a pre-v1.1 MetaMorpho factory) — so factory address alone doesn't prove v1.1;
  the `isMetaMorpho()`/`isVaultV2()` check against a vault's _actual_ deploying
  factory is what's authoritative, not "which factory address looks familiar."
- **Full `IMetaMorpho` read interface, re-verified directly (2026-09-16)** against
  `raw.githubusercontent.com/morpho-org/metamorpho/main/src/interfaces/IMetaMorpho.sol`
  and `.../src/libraries/PendingLib.sol`: `MORPHO()`, `owner()`, `curator()`,
  `guardian()`, `isAllocator(address)`, `fee()` (`uint96`), `feeRecipient()`,
  `timelock()`, `pendingTimelock()`/`pendingGuardian()`/`pendingCap(Id)` (each a
  `{value, validAt}` pending-change struct), `supplyQueueLength()`/`supplyQueue(uint256)`,
  `withdrawQueueLength()`/`withdrawQueue(uint256)`, `config(Id)` (returns
  `MarketConfig{cap: uint184, enabled: bool, removableAt: uint64}`),
  `lastTotalAssets()`. Standard ERC-4626 reads (`totalAssets`, `maxWithdraw`,
  `maxRedeem`, `convertToAssets`, `asset`) and `withdraw(assets, receiver, owner)` come
  from viem's own maintained `erc4626Abi`, cross-checked against MetaMorpho's own
  `withdraw` signature in the same interface file (identical). Recorded in
  `src/protocols/morpho-vault/abi.ts`.
- Supply queue / withdraw queue / timelock behavior (v1.1): supply queue empty ⇒
  deposits revert; Allocator can reorder supply queue without timelock; cap _increases_
  are timelocked (24h–2w per curator config), cap _decreases_ and queue removals (when
  the vault's supply in that market is already 0, or removal was previously submitted
  and timelock elapsed) are not. Source: search summary of
  https://docs.morpho.org/curate/concepts/security-considerations/ and
  https://github.com/morpho-org/metamorpho — still needs the direct doc re-fetch (the
  events below were pulled directly, but this specific queue/timelock behavior wasn't
  re-verified this session); low risk since it only gates detector logic, not adapter
  event decoding, but re-check before D-series code depends on it.
- **Event names, re-verified directly (2026-09-16)** by fetching
  `https://raw.githubusercontent.com/morpho-org/metamorpho/main/src/libraries/EventsLib.sol`
  (official repo, `main` branch — not a version-pinned tag, so re-check against
  whatever commit/tag is actually pinned as a dependency in Phase 2). Full list of
  custom events: `SubmitTimelock(uint256)`, `SetTimelock(address indexed, uint256)`,
  `SetSkimRecipient(address indexed)`, `SetFee(address indexed, uint256)`,
  `SetFeeRecipient(address indexed)`, `SubmitGuardian(address indexed)`,
  `SetGuardian(address indexed, address indexed)`,
  `SubmitCap(address indexed, Id indexed, uint256)`,
  `SetCap(address indexed, Id indexed, uint256)`,
  `UpdateLastTotalAssets(uint256)`,
  `SubmitMarketRemoval(address indexed, Id indexed)`, `SetCurator(address indexed)`,
  `SetIsAllocator(address indexed, bool)`, `RevokePendingTimelock(address indexed)`,
  `RevokePendingCap(address indexed, Id indexed)`,
  `RevokePendingGuardian(address indexed)`,
  `RevokePendingMarketRemoval(address indexed, Id indexed)`,
  `SetSupplyQueue(address indexed, Id[])`, `SetWithdrawQueue(address indexed, Id[])`,
  `ReallocateSupply(address indexed, Id indexed, uint256, uint256)`,
  `ReallocateWithdraw(address indexed, Id indexed, uint256, uint256)`,
  `AccrueInterest(uint256, uint256)`, `Skim(address indexed, address indexed, uint256)`,
  `CreateMetaMorpho(address indexed, address indexed, address, uint256, address indexed, string, string, bytes32)`.
  Deposit/withdraw/mint/redeem/transfer are the standard ERC-4626/ERC-20 events (not
  custom to MetaMorpho), no separate verification needed for their signatures.

## Safe

- `@safe-global/protocol-kit` on npm, latest seen 8.0.6 (2026-09-15 search). Docs
  linked from https://www.npmjs.com/package/@safe-global/protocol-kit .
- **Phase 8 session (2026-09-17), concrete deployment addresses** — fetched directly
  from `safe-global/safe-deployments`'s own published JSON (`raw.githubusercontent.com/
safe-global/safe-deployments/main/src/assets/v1.4.1/{safe_proxy_factory,safe_l2}.json`),
  not from memory. Both files list the exact same address for chain `1` (Ethereum) and
  chain `8453` (Base) under their `"canonical"` deployment:
  - `SafeProxyFactory` v1.4.1: `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`
  - `SafeL2` v1.4.1 singleton: `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` (the L2
    variant is used on both chains here — Base needs it, and using it on Ethereum too
    for Sentinel's own test/setup Safe is harmless: it only adds extra events, no
    behavior change relevant to Sentinel).
  - The same JSON files bundle the full ABI; the functions Phase 8 actually needs
    (`setup`, `enableModule`, `execTransaction`, `isModuleEnabled`, `getThreshold`,
    `getOwners`, `nonce`, `getTransactionHash`) were pulled verbatim from that `abi`
    field, not retyped from memory — see `src/actions/safe-roles/abi.ts`.

## Zodiac Roles Modifier (v2 contract)

- Docs: https://docs.roles.gnosisguild.org/
- Conditions reference: https://docs.roles.gnosisguild.org/general/conditions
- SDK: `zodiac-roles-sdk` on npm (4.1.3 as of a 2026-08-25 search). **Not used** — see
  the Phase 8 note below for why Sentinel hand-builds `ConditionFlat` trees instead.
- Repo: https://github.com/gnosisguild/zodiac-modifier-roles (legacy v1:
  https://github.com/gnosisguild/zodiac-modifier-roles-v1 — do not use).
- **Phase 8 session (2026-09-17), concrete deployment addresses and ABI** — fetched
  directly from the Roles repo's own build artifact,
  `raw.githubusercontent.com/gnosisguild/zodiac-modifier-roles/main/packages/evm/mastercopies.json`
  (the exact file the repo's own deploy tooling reads), and cross-checked on-chain.
  **First attempt was wrong, caught by a real fork test, corrected via a second,
  independent source**: the JSON entry's own `"factory"` field
  (`0xce0042b868300000d44a59004da54a005ffdcf9f`) turned out to be the ERC-2470
  *singleton* factory — used once by the Zodiac team to deploy the mastercopy itself
  deterministically, not the per-instance factory a caller uses to deploy their own
  module clone; a real `deployModule` call against it reverted immediately (`cast
  call --trace` showed the revert happening before even reaching `createProxy`'s
  logic — confirmed via `raw.githubusercontent.com/gnosisguild/zodiac-core/master/
contracts/factory/ModuleProxyFactory.sol`, the actual factory contract's source, that
  this address's tiny 308-byte bytecode couldn't be it). The real per-instance
  `ModuleProxyFactory` and the actually-correct Roles mastercopy version came from a
  second, independent source: the separate `@gnosis-guild/zodiac` npm package
  (v5.0.1)'s own `dist/esm/contracts.js` address registry — which also explicitly
  flags the **2.1.0** mastercopy as **known faulty**
  (`FAULTY[KnownContracts.ROLES]["2.1.0"]` in that same file, enforced by that
  package's own `sanityCheckZodiacModuleAddress` throwing on it). Corrected addresses,
  used throughout `src/actions/safe-roles/`, both confirmed deployed (`cast codesize`,
  real non-zero bytecode) on Ethereum mainnet and Base, and the deployment flow
  confirmed working end to end via `cast call --trace` (a real `setUp` call, complete
  with `OwnershipTransferred`/`RolesModSetup`/`Initialized`/`ModuleProxyCreation`
  events) before writing any application code against it:
  - Roles Modifier mastercopy, contract version **2.1.1**: `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5`.
  - `ModuleProxyFactory` v1.2.0: `0x000000000000aDdB49795b0f9bA5BC298cDda236`.
  - Full Roles ABI (73 entries, including `setUp`, `assignRoles`, `scopeTarget`,
    `scopeFunction`, `allowFunction`, `revokeTarget`, `revokeFunction`,
    `execTransactionWithRole`) came from the `mastercopies.json` entry's own `abi`
    field (2.1.0 and 2.1.1 have an identical ABI — diffed directly, only the
    generated export name differs — so the 2.1.0 entry's ABI is still valid for the
    2.1.1 mastercopy actually used). `ModuleProxyFactory`'s ABI
    (`deployModule(masterCopy, initializer, saltNonce)` / `ModuleProxyCreation`
    event) came from the same `@gnosis-guild/zodiac` package's bundled
    `dist/esm/abis/factory/1.2.0.js` (matching the "1.2.0" factory version actually
    deployed). Both copied verbatim into `src/actions/safe-roles/abi.ts`, not
    retyped from memory.
  - The `ConditionFlat`/`ParameterType`/`Operator`/`ExecutionOptions` enum and struct
    definitions Sentinel's setup script uses to hand-build permission-scoping
    condition trees (rather than depending on `zodiac-roles-sdk`, which pushes its
    state through a hosted Zodiac API — incompatible with "everything runs against a
    local fork only," safety rules 2/3) came from the actual Solidity source embedded
    in that same `mastercopies.json` entry's `compilerInput.sources["contracts/
Types.sol"]` — the real, compiled-from source, not a paraphrase. See
    `src/actions/safe-roles/conditions.ts` for the encoding built from these exact
    values, and `docs/adr/0011-hand-built-roles-conditions.md` for why the SDK wasn't
    used and how the encoding is verified empirically (a fork round-trip: the
    intended call succeeds, `transfer`/`approve`/a non-Safe recipient all revert).

## MEV protection / private transaction submission (§8.3)

- Flashbots Protect (Ethereum mainnet): https://docs.flashbots.net/flashbots-protect/overview
  — confirmed **Ethereum mainnet, Sepolia, Holesky only**; no Base support as of the
  2026-09-15 search.
- Base: no direct Flashbots-style private-mempool submission found. Base's own MEV
  mitigation is "Flashblocks" (200ms pre-confirmations, co-developed with Flashbots) at
  the sequencer level, not a private-tx RPC teams can submit through directly for
  front-running protection the way Flashbots Protect works on L1. **Decision recorded
  in `docs/adr/0004-private-tx-submission.md`**: since Sentinel only ever submits
  withdraw/redeem transactions (never anything with adversarial MEV value like a swap),
  the private-mempool requirement matters far less on Base; submit via the configured
  RPC directly on Base and revisit if a Base-native private relay becomes clearly
  established.

## Price sources (Phase 3, §6.5)

- **Chainlink feed addresses, verified directly on-chain (2026-09-16)** — not from
  Chainlink's own `reference-data-directory.vercel.app` JSON, which turned out to list
  **multiple different live addresses for the same pair name** (e.g. three distinct
  "USDC / USD" feeds on Ethereum mainnet, all live and agreeing in price) with no
  obvious way from the JSON alone to tell which one is "the" canonical feed. Instead,
  resolved each feed the way it actually matters for Sentinel: read the price source
  our own watched Aave markets' oracles use
  (`AaveOracle.getSourceOfAsset(asset)`), then unwrapped Aave's "capped" adapter
  wrapper some stablecoin sources go through (`description()` returns e.g. `"Capped
USDC / USD"`; its `ASSET_TO_USD_AGGREGATOR()` gives the raw underlying Chainlink
  feed) — confirmed each resulting address has live code and a sane recent
  `latestRoundData()` via `cast call` against the real RPC. Addresses recorded in
  `src/prices/chainlink-addresses.ts`:
  - Ethereum: USDC/USD `0xEa674bBC33AE708Bc9EB4ba348b04E4eB55b496b`, ETH/USD (used for
    `WETH`) `0x5424384B256154046E9667dDFaaa5e550145215e`.
  - Base: USDC/USD `0x1550207eAeB590D1557a6E6C066D3d57B5A4Dc65`, ETH/USD (used for
    `WETH`) `0x9dA00D23465282005DB222a441a663eE7B9dfCc8`.
  - `decimals()` on `AggregatorV3Interface` returns `uint8`, which viem decodes to a
    plain JS `number`, not `bigint` (unlike every other `latestRoundData()` field,
    which is `uint256`/`int256`/`uint80` and decodes to `bigint`) — found the hard way
    via a fork-test failure; noted in `src/prices/chainlink.ts`'s parse-site comment
    so it doesn't need rediscovering for the next feed-reading code written.
  - Base-specific pinned-block caveat: the two Base feed contracts above didn't exist
    yet at block 34,000,000 (reused from the Morpho fork tests) — same
    too-old-pinned-block failure mode as Phase 2's Aave data provider, see
    `test/integration/README.md`. Fork tests for these feeds are pinned to a much
    later Base block (51,370,000) instead.
- **Coinbase / Kraken public ticker APIs, verified live (2026-09-16, direct `curl`)**:
  `GET api.coinbase.com/v2/prices/{SYMBOL}-USD/spot` → `{data:{amount,base,currency}}`;
  `GET api.kraken.com/0/public/Ticker?pair={SYMBOL}USD` → `{error:[], result:{<internal
pair key>:{c:[lastPrice, lastVolume], ...}}}` — Kraken keys its response by its own
  internal pair name (e.g. `XETHZUSD` for an `ETHUSD` query), not the queried string,
  so the reader takes whatever single entry comes back rather than guessing the key.
  Both are unauthenticated and public; no API key needed. Recorded in
  `src/prices/cex.ts`.

## Governance watcher (Phase 3, §6.6)

- **Aave `PoolConfigurator` addresses, verified directly on-chain (2026-09-16)** via
  `cast call` (`PoolAddressesProvider.getPoolConfigurator()`): Ethereum
  `0x64b761D848206f447Fe2dd461b0c635Ec39EbB27`, Base
  `0x5731a04B1E775f0fdd454Bf70f3335886e9A96be` — the Base value cross-confirms the
  `POOL_CONFIGURATOR` constant already recorded from the address-book dump earlier
  this session. `PoolConfigurator` isn't included as a static export the adapter
  hardcodes (unlike `Pool`/`PoolDataProvider`); `src/watchers/governance.ts` resolves
  it on-chain at read time instead.
- **`eth_getLogs` range limit**: at least one configured RPC provider's free tier
  (Alchemy) rejects `eth_getLogs` calls spanning more than 10 blocks, returning a
  clear error naming the max allowed range. Confirmed directly by hitting it (a
  6-block-plus query against Aave's `PoolConfigurator` failed until narrowed). Not a
  Sentinel bug — a real operational constraint to design batch sizes around,
  documented in `src/watchers/governance.ts`'s header comment.
- Morpho Blue's remaining governance-level events (`SetOwner`, `SetFee`,
  `SetFeeRecipient`, `EnableIrm`, `EnableLltv`) were already fetched directly from
  `EventsLib.sol` earlier this session (see the Morpho Blue section above) — just not
  yet added to `src/protocols/morpho-blue/abi.ts` until the governance watcher needed
  them.

## DEX prices — Uniswap v3 (Phase 3, §6.5; see also ADR 0006)

- **`WETH` token address on Ethereum**, `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`:
  verified directly on-chain (2026-09-16) via `cast call ... "symbol()(string)"` and
  `"totalSupply()(uint256)"` — both returned sane, expected values.
- **`WETH` token address on Base**, `0x4200000000000000000000000000000000000006`:
  Base's canonical predeploy address for wrapped ETH; verified directly on-chain
  (2026-09-16) via `cast call ... "symbol()(string)"` (returned `"WETH"`) and
  `"decimals()(uint8)"` (returned `18`).
- **Uniswap v3 `Factory` address**, `0x1F98431c8aD98523631AE4a59f267346ea31F984` on
  Ethereum: verified directly on-chain (2026-09-16) via `cast call ... "owner()(address)"`
  (returned a real, non-zero address; a wrong address would revert or return garbage).
  On Base, the factory deploys to a **different** address,
  `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` — found via
  `developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments` (fetched
  2026-09-16) and then independently confirmed on-chain the same way (`owner()`
  returned a real address). Do not assume the Ethereum factory address carries over to
  every chain — it does not here, only the _bytecode_ is deterministic, not the
  deployment address, when a chain's deployer used a different nonce/salt.
- **`WETH`/`USDC` pool addresses and fee tiers**, both chains: resolved via
  `Factory.getPool(WETH, USDC, fee)` for all four standard fee tiers (0.01%/0.05%/0.3%/
  1%) on each chain, then picked the tier with the highest `liquidity()` reading (all
  verified directly via `cast call`, 2026-09-16):
  - Ethereum: `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` (0.05% tier, deepest at
    ~5.13e18 raw liquidity units, vs. ~4.61e17 at 0.01% and ~1.01e18 at 0.3%).
  - Base: `0x6c561B446416E1A00E8E93E221854d6eA4171372` (0.3% tier, deepest at
    ~3.15e19 raw liquidity units, vs. ~5.44e16 at 0.01%, ~1.51e18 at 0.05%, and
    ~6.39e16 at 1%) — notably a **different** fee tier is deepest than on Ethereum, so
    this was checked per chain rather than assumed to match.
  - `token0`/`token1` order (which one the pool's tick prices in terms of the other)
    also verified per pool via `cast call ... "token0()(address)"` — the two pools
    have opposite ordering (`USDC` is `token0` on Ethereum, `WETH` is `token0` on
    Base), recorded as `baseIsToken0` in `src/prices/uniswap-v3-addresses.ts` rather
    than assumed consistent.
  - `observe()` (the TWAP read) and sufficient observation cardinality for a 900-second
    window confirmed callable on both pools via a direct `cast call` before any code
    was written against it.

## Large-holder watcher (Phase 3, §6.6)

- **`IPool.getUserAccountData(address)`**: signature pulled from
  `raw.githubusercontent.com/aave-dao/aave-v3-origin/main/src/contracts/interfaces/IPool.sol`
  (fetched 2026-09-16), then verified directly on-chain via `cast call` against the
  real Ethereum Pool with a synthetic zero-position address (`0x00...01`) — returned
  all-zero collateral/debt and `healthFactor = type(uint256).max`, matching the
  interface doc's documented "no debt" sentinel exactly. Added to `poolAbi` in
  `src/protocols/aave-v3/abi.ts`.
- **ERC-4626 `Deposit`/`Withdraw` events** on the watched MetaMorpho vault: rather than
  redeclare the standard interface (this file already avoids that for ERC-4626 reads —
  see `morpho-vault/abi.ts`'s header comment), used viem's own maintained `erc4626Abi`
  export directly. Verified its `Deposit`/`Withdraw` event signatures match the real
  vault by computing each event's topic hash (`cast sig-event`) and finding real,
  successfully-decoding logs for both on the live Base vault
  (`0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61`) via `cast logs` over a real recent
  block range (2026-09-16) — `Withdraw`'s 3-indexed-topic shape and `Deposit`'s
  2-indexed-topic shape both matched what came back on-chain.
- Aave's `Supply`/`Withdraw`/`Borrow`/`Repay` events and Morpho Blue's
  `Supply`/`Withdraw`/`Borrow`/`Repay`/`SupplyCollateral`/`WithdrawCollateral` events
  were already in `poolAbi`/`morphoBlueAbi` from Phase 2 (needed for
  `decodeEvents`/position discovery) — no new verification needed, just a new
  consumer (`src/watchers/large-holders.ts`) picking a different event subset than the
  governance watcher does from the same ABIs.

## Replay scenarios (Phase 6, §9.2)

- **USDC depeg, March 2023** (`scenarios/usdc-depeg-2023-03.yaml`): event narrative
  cross-confirmed across multiple independent outlets (2026-09-16 web search) —
  Silicon Valley Bank was closed 2023-03-09; Circle disclosed ~$3.3B (≈8% of reserves)
  stuck at SVB the evening of 2023-03-10 ET; USDC traded down to a low of **$0.8774**
  on 2023-03-11 (CoinGecko ATL, corroborated by CNN/CNBC/CoinDesk/Decrypt reporting the
  same ~$0.87–0.88 range); Treasury/Fed/FDIC announced full depositor protection
  2023-03-12, and USDC recovered to ~$0.99+ within about 48 hours. An academic paper
  (`arxiv.org/html/2606.07442v1`, "Tracing Stablecoin Contagion during the USDC Depeg
  after the Silicon Valley Bank Collapse") independently defines the same "March 9–13,
  2023" event window and cites Ethereum block **16,801,144** as its own March 11 daily
  snapshot.
  - **Block numbers were not taken from any of the above sources** (none gives
    block-level precision) — computed directly by binary-searching real block
    timestamps against the actually-configured archive RPC (`ETH_RPC_PRIMARY`,
    2026-09-16): block **16,801,143** for 2023-03-11T00:00:00Z (1 block off the arxiv
    paper's independently-cited 16,801,144 for the same day — strong cross-confirmation
    via a completely different method), block **16,802,088** for
    2023-03-11T03:11:00Z (CoinDesk's cited time for Circle's confirmation tweet), and
    block **16,803,216** for 2023-03-11T06:59:59Z (≈2am ET, the time CNN's reporting
    associates with USDC's reported ~$0.87 trough — reporting doesn't specify an exact
    minute, so this is the best-supported hour-level anchor, not a claimed precise
    bottom tick).
  - Scenario's `blockRange` (16,786,948 to 16,822,491) covers 2023-03-09T00:00:00Z
    through 2023-03-14T00:00:00Z, computed the same way — comfortable margin either
    side of the confirmed event window.
  - `pointOfNoReturn` is set at block 16,803,216 (the ~2am ET trough anchor above).
  - **Found running this scenario for real (2026-09-16)**: it cannot currently replay
    — `getReserveData` against `0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD` (the
    currently-configured Ethereum Core `PoolDataProvider`, `src/protocols/aave-v3/
addresses.ts`) returns `0x` at these blocks. Confirmed via direct `eth_getCode`
    against `ETH_RPC_PRIMARY`: that address has no code at block 16,803,216 — it was
    deployed after this scenario's window (matching the already-known "Aave's v3.7
    Part 2 upgrade redeployed the data provider" finding from the Phase 2 session,
    docs/PROGRESS.md). Tried one candidate historical address surfaced by a web
    search (`0x497a1994c46d4f6C864904A9f1fac6328Cb7C8a6`, an Etherscan search result
    labeled "Protocol Data Provider V3") — also empty at that block, so not it either.
    Did not keep guessing further candidates (safety rule 6) — see docs/PROGRESS.md's
    Known Issues and the scenario file's own header comment.

- **KelpDAO rsETH bridge exploit, April 2026**
  (`scenarios/kelpdao-rseth-exploit-2026-04.yaml`): timeline sourced from CoinDesk's
  contemporaneous reporting (2026-09-16 web search,
  `coindesk.com/tech/2026/04/19/...`) — attacker compromised the RPC nodes KelpDAO's
  single LayerZero DVN relied on, causing it to attest a fabricated cross-chain
  message and mint 116,500 rsETH (~$292M) with no real backing; drain at **17:35 UTC**
  on 2026-04-18, two further failed drain attempts at 18:26/18:28 UTC, Kelp's
  emergency pause at **18:21 UTC** (46 minutes after the drain, per CoinDesk's own
  stated figure). 89,567 of the drained rsETH was deposited on Aave as collateral to
  borrow ~$190M in WETH — bad debt once the fraud was revealed. Cross-checked against
  Chainalysis (`chainalysis.com/blog/kelpdao-bridge-exploit-april-2026`, confirms
  Ethereum + L2s as the paused chains and the April 18 date, no more precise on time)
  and OpenZeppelin (`openzeppelin.com/news/lessons-from-kelpdao-hack`, attack
  mechanism detail; confirms WETH pools across Ethereum/Arbitrum/Base/Mantle/Linea hit
  100% utilization, corroborating the "billions left Aave within two days" framing
  spec's own scenario description uses).
  - **Block numbers, as with the USDC depeg scenario, were computed directly** against
    the real archive RPC (2026-09-16): block **24,908,282** for
    2026-04-18T17:35:00Z (the drain, this scenario's `pointOfNoReturn`), block
    **24,908,511** for 2026-04-18T18:21:00Z (the emergency pause), bracketed by
    **24,895,841** (2026-04-17T00:00:00Z) and **24,924,560** (2026-04-21T00:00:00Z)
    for the scenario's `blockRange`.
  - This scenario is watched through Aave v3 Ethereum Core USDC (Sentinel's actually
    configured position), not the WETH reserve the exploit's own collateral sat in —
    per spec's own instruction to test "how the watched stablecoin reserves behaved
    during the rush to withdraw," not to reconstruct the WETH-specific mechanics.

## Runtime / tooling versions

- Node.js: Active LTS is **Node 24** as of 2026-09-15 (Node 22 is in Maintenance LTS,
  Node 26 is Current and becomes LTS in October 2026). Source: search summary of
  https://endoflife.date/nodejs — pin CI and `engines` to Node 24.
