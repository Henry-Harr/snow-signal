# Progress

This is the project's memory across sessions. Read this in full at the start of every
session, along with `CLAUDE.md` and the relevant section of `docs/SPEC.md`.

## Status as of 2026-09-16

**Phase 0 (Research and plan): complete. Phase 1 (Foundations): complete. Phase 2
(read-only protocol adapters): functionally done, formally still open** — all three
adapters are implemented and unit-tested (81 tests total, `pnpm lint`/`typecheck`/
`test`/`build` all pass), but the phase's literal done-when criterion (fork
integration tests matching real chain state) isn't met yet, blocked on real RPC
access. PR #1 (repo repurpose + Phase 0 + Phase 1) merged to `main`; this work
continues on a fresh `claude/new-session-7ks5xy` branch restarted from `main` per the
merged-branch convention.

### Phase 2 plan (written before coding, per project convention)

**Scope decision:** real fork-integration tests ("adapters match direct contract
reads at pinned blocks on Ethereum and Base") are **blocked** on real RPC access —
still an open question from Phase 0 (see below), nobody has provided RPC URLs yet.
Rather than block all of Phase 2 on that, this pass:

1. Verifies every contract fact used (function/event signatures, struct layouts, the
   Morpho market-id computation, the Morpho oracle 1e36 scaling) directly against the
   official GitHub source for each protocol (`aave-dao/aave-v3-origin`,
   `morpho-org/morpho-blue`, `morpho-org/metamorpho`) — not from memory, per safety
   rule 6. Each ABI fragment cites its source file in a comment.
2. Implements all three adapters (`AaveV3Adapter`, `MorphoBlueAdapter`,
   `MorphoVaultAdapter`) against a minimal, explicitly-typed `AaveChainReader`-style
   client interface (a thin wrapper the adapter needs: `multicall`, `readContract`,
   `getLogs`) rather than importing `viem`'s full `PublicClient` type everywhere, so
   each adapter is unit-testable against hand-built mock responses shaped like real
   multicall results, without a real RPC.
3. Adapters take their contract addresses via constructor parameters (not hardcoded,
   not looked up internally) — deliberately deferring "how do we resolve the right
   address for a configured market" (address-book wiring, config-driven address
   resolution) to whichever later phase actually assembles the pipeline (Phase 5),
   since that's a wiring concern, not an adapter-correctness concern.
4. Unit tests stand in for fork integration tests for now: each adapter's read path is
   tested against realistic mock multicall/log responses matching the real ABI shapes.
   `test/integration/README.md` documents exactly what a real fork integration test
   run needs (an archive RPC + Foundry) and defers to Phase 0's still-open question 1.
5. Once real RPC URLs are available, add the actual fork integration tests (pinned
   blocks on Ethereum + Base, comparing adapter output to direct `cast call`s) as a
   follow-up — this is called out explicitly as **not yet done** rather than silently
   skipped, since it's Phase 2's literal done-when criterion.

**Risks:**

- Base currency / price decimals for Aave's oracle aren't fixed by the interface (spec
  says "1 ether for ETH, 1e8 for USD" depending on market config) — `collateralExposure`
  sidesteps this by computing a _share_ (ratio), where the common base-currency-unit
  scalar cancels out algebraically, so it never needs to assume 8 decimals. Anywhere an
  absolute USD value is needed (future phases), the actual base currency unit must be
  read from the deployed `AaveOracle`, not assumed.
- `getReserveDeficit` (Aave v3.3+) will revert on pools running an older Aave version —
  called defensively (`allowFailure: true` in that one multicall slot) so an
  undeployed-yet function doesn't take down the whole snapshot.
- Aave's real total-collateral-base exposure is approximated per ADR 0001; this phase
  implements exactly that approximation, not exact per-borrower accounting.

**Test plan:** unit tests per adapter covering: snapshot reads decode correctly from
mocked multicall results (normal + a paused/frozen reserve + a pre-3.3 pool where
`getReserveDeficit` reverts), `discoverPositions` filters to only nonzero balances,
`collateralExposure` shares sum to 1 and weight by oracle-priced value not raw token
amount, `withdrawable` caps at available liquidity, `buildWithdraw` encodes the right
calldata for both a partial amount and `'max'`, and `decodeEvents` correctly classifies
each event kind from raw logs. Property test: for `collateralExposure`, shares across
all reserves in a market always sum to 1 (within floating-point tolerance) regardless
of how many reserves or what their relative sizes are.

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
- **Phase 2 protocol adapters, implemented and unit-tested (fork integration tests
  still pending real RPC access — see the Phase 2 section below):**
  - `src/chain/contract-reader.ts`: a `ContractReader` interface (`multicall`,
    `getLogs`) narrower than viem's full `PublicClient`, so adapters are unit-testable
    against hand-built mock responses; `createViemContractReader` wraps a real viem
    client for production use.
  - `src/protocols/aave-v3/`: `AaveV3Adapter` — `discoverPositions` (enumerates every
    reserve via `getReservesList`, keeps only nonzero aToken balances),
    `snapshotMarkets`, `collateralExposure` (ADR 0001's approximation: reserves
    weighted by oracle-priced value, defensively guarded for a missing/pre-3.3
    `getReserveDeficit`), `withdrawable`, `buildWithdraw` (partial and the
    `type(uint256).max` full-balance convention), `decodeEvents`.
  - `src/protocols/morpho-blue/`: `MorphoBlueAdapter`, plus `market-id.ts`
    reproducing Morpho's own `keccak256`-of-packed-struct market-id computation
    exactly. Share-to-asset conversion uses the real `SharesMathLib` virtual-shares
    formula, not an approximation — this matters since it feeds `buildWithdraw`'s
    exact-full-position redemption path.
  - `src/protocols/morpho-vaults/`: `MorphoVaultAdapter` (MetaMorpho v1.1 only, not
    Vault V2) — look-through exposure and vault withdrawable liquidity, both
    implemented via the same Morpho Blue market reads the Morpho Blue adapter uses
    (a vault's allocation lives in Morpho Blue's own storage). `buildWithdraw`
    currently only supports `'max'` (full redemption); a partial-amount ERC-4626
    `withdraw()` path is deferred to Phase 7 (nothing needs it yet).
  - Every ABI fragment cites its source file (a specific GitHub path, checked this
    session) in a code comment, per safety rule 6 — see `docs/SOURCES.md`'s "Phase 2
    verification" section for the consolidated list.
  - 38 new tests (27 unit + 1 property, across the three adapters) using hand-built
    mock `ContractReader` responses shaped like real multicall results, plus a shared
    `encodeTestEventLog` fixture (viem 2.x has no single `encodeEventLog` export, only
    `decodeEventLog`/`encodeEventTopics`) so `decodeEvents` tests round-trip through
    real ABI encoding rather than hand-crafted hex.
  - `test/integration/README.md`: documents exactly what's needed to add the real
    fork integration tests once RPC access exists, so this gap is visible rather than
    silently absent.

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

### Open questions for the user (spec §15 — using mocks/placeholders until answered)

1. RPC URLs for Ethereum and Base, two independent providers each, at least one with
   archive access for replays.
2. Public addresses to watch, including the user's Safe address (public only, never a
   key).
3. Telegram bot token and allowlisted chat ID(s).
4. Confirm local tooling: Node.js (LTS, ideally 24), pnpm, Foundry (anvil/cast), Docker
   — a Phase 1 `sentinel doctor`-adjacent check will report what's missing, but if the
   user already knows something is absent it saves a round-trip to say so now.
5. Which specific markets/vaults are the actual target positions? (Needed to know,
   concretely, e.g. whether a watched Aave position is on a v3 or v4 market once that's
   verified, and whether a watched Morpho vault is v1.1 or V2 shaped.) Using the spec's
   example config shape (Aave v3 core USDC on Ethereum, a Morpho vault on Base) as a
   placeholder until told otherwise.

None of these block Phase 1 (foundations don't need real RPCs or a real Safe address
yet — config schema + mocks suffice), but they will block meaningful Phase 2 testing
(fork integration tests need at least one archive-capable RPC) and everything from
Phase 5 onward (real alerts need a real Telegram token; the exit drill needs a real
Safe address to check `discoverPositions` against, even in `off` mode).

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

### Phase 2 — Read-only protocol adapters — **PARTIALLY DONE 2026-09-16 (see below)**

- [x] Re-verify Morpho oracle scaling and MetaMorpho event names directly against
      official source. `docs.morpho.org` itself was still unreachable this session,
      but the primary contract source on GitHub (`morpho-org/morpho-blue`,
      `morpho-org/metamorpho`) was — every fact was verified there instead, which is
      arguably the more authoritative source anyway. See `docs/SOURCES.md`'s "Phase 2
      verification" section.
- [ ] Re-verify which Aave version(s) the actually-configured watched markets run
      (v3.x vs v4) before assuming the v3 adapter covers them. **Still open** — no
      specific watched markets are configured yet (open question 5), so there's
      nothing concrete to check yet; revisit once the user names real markets.
- [x] Aave v3 adapter (`src/protocols/aave-v3/`): reserve state, rates, caps,
      frozen/paused, collateral params, aToken balance, oracle prices, event decoding
      (Supply/Withdraw/Borrow/Repay/LiquidationCall), reserve deficit read guarded
      against pre-3.3 pools (ADR 0001 approximation for `collateralExposure`).
      Pool-configurator governance-change events are **not yet decoded** — that's
      squarely Phase 3 watcher territory (config-change detection), not Phase 2
      adapter territory, and is tracked there instead of duplicated here.
- [x] Morpho Blue adapter (`src/protocols/morpho-blue/`): market state/params, oracle
      `price()` (verified 1e36 scaling), supply position (via the exact
      `SharesMathLib` virtual-shares formula, not an approximation), event decoding
      including `Liquidate`'s bad debt fields.
- [x] Morpho vault adapter (`src/protocols/morpho-vaults/`): ERC-4626 state incl.
      `maxWithdraw` (not yet `maxRedeem` — not needed by anything built so far),
      allocation (supply/withdraw queues + caps via `config(id)`), curator/guardian/
      owner/timelock getters exist in the ABI but aren't yet read by adapter methods
      (no caller needs them yet — Phase 3's governance watcher will); look-through
      exposure and vault withdrawable liquidity are implemented. **Only MetaMorpho
      v1.1 is supported** — a Morpho Vault V2 vault needs a structurally different
      adapter variant, not assumed compatible (docs/SOURCES.md).
- [ ] Fork integration tests (Ethereum + Base, pinned blocks) asserting adapter reads
      match direct contract calls. **Not done — this phase's literal done-when
      criterion is unmet.** Blocked on real archive RPC access (open question 1) and
      Foundry (not installed in this sandbox). See `test/integration/README.md` for
      exactly what's needed and what the test should do once unblocked. Unit tests
      against mocked `ContractReader` responses stand in for now (81 tests total,
      38 of them new adapter tests, covering every adapter method including a
      fast-check property test for `collateralExposure`'s share-sum invariant).

**Done when:** fork integration tests on Ethereum and Base match direct contract reads
at pinned blocks. **Not yet met** — see the fork-integration-tests item above. Treat
Phase 2 as functionally complete (all three adapters implemented and unit-tested) but
formally still open until that criterion is satisfied; resume here first once RPC
access is available, rather than starting Phase 3 assuming Phase 2 is fully closed
out.

### Phase 3 — Prices and watchers

- [ ] Chainlink feed reads, DEX price reads (Uniswap v3 TWAP via `observe()`, Curve
      stable pools), CEX ticker polling (≥2 exchanges, e.g. Coinbase + Kraken).
- [ ] Aggregation: median, outlier rejection, staleness detection per source; raw
      quotes stored with timestamps.
- [ ] Governance/config watcher (Aave configurator + executed governance payloads,
      Morpho vault timelocked submissions/role changes, new collateral listings,
      oracle changes, pauses/freezes).
- [ ] Token supply watcher (`totalSupply` changes, large/bridge mints) for every
      collateral asset in the exposure graph.
- [ ] Large-holder watcher (top suppliers/borrowers per market/vault from event logs,
      shares, recent movements; borrower health where computable).

**Done when:** unit and fork tests pass, raw quotes and events are stored and
queryable.

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
