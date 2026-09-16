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
- Contract addresses: could not confirm from this session whether Morpho Blue is
  deployed to the same address on Ethereum and Base (CREATE2 determinism claimed by
  some third-party sources, not confirmed against morpho-org's own deployment repo,
  which 404'd for the specific path tried). **Open item for Phase 2**: pull addresses
  from Morpho's official TS SDK / deployments package rather than hardcoding, if one
  exists (`@morpho-org/blue-sdk` mentioned in search results — verify).

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

## Zodiac Roles Modifier (v2 contract)

- Docs: https://docs.roles.gnosisguild.org/
- Conditions reference: https://docs.roles.gnosisguild.org/general/conditions
- SDK: `zodiac-roles-sdk` on npm. Note the **contract** is "Roles Modifier v2" (the
  version named in spec §4/§8.4) while the **npm SDK package** has its own,
  much-higher version number (4.1.3 reported in a 2026-08-25 search result) — these are
  different version counters. Confirm the SDK version is compatible with the on-chain
  v2 Modifier (vs. a newer v3 modifier contract, if gnosisguild has shipped one) before
  pinning a version in Phase 8.
- Repo: https://github.com/gnosisguild/zodiac-modifier-roles (legacy v1:
  https://github.com/gnosisguild/zodiac-modifier-roles-v1 — do not use).

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

## Runtime / tooling versions

- Node.js: Active LTS is **Node 24** as of 2026-09-15 (Node 22 is in Maintenance LTS,
  Node 26 is Current and becomes LTS in October 2026). Source: search summary of
  https://endoflife.date/nodejs — pin CI and `engines` to Node 24.
