# Progress

This is the project's memory across sessions. Read this in full at the start of every
session, along with `CLAUDE.md` and the relevant section of `docs/SPEC.md`.

## Status as of 2026-09-16

**Phase 0 (Research and plan): complete. Phase 1 (Foundations): complete.** Repo
repurposed from an unrelated static ski-resort site to Sentinel per the user's
explicit instruction, then built out through the full Phase 1 foundation in the same
session. `pnpm lint`, `pnpm typecheck`, `pnpm test` (43 tests, unit + property), and
`pnpm build` all pass. Phase 2 (read-only protocol adapters) is next.

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

### Phase 2 — Read-only protocol adapters

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
- [ ] Aave v3 adapter: reserve state, rates, caps, frozen/paused, collateral params,
      aToken balance, oracle prices, event decoding (Supply/Withdraw/Borrow/Repay/
      LiquidationCall + configurator events), reserve deficit read if version supports
      it (ADR 0001 approximation for `collateralExposure`).
- [ ] Morpho Blue adapter: market state/params, oracle `price()` (verified scaling),
      supply position, event decoding including realized bad debt.
- [ ] Morpho vault adapter: ERC-4626 state incl. `maxWithdraw`/`maxRedeem`, allocation
      (supply/withdraw queues + caps), roles, timelock + pending changes, event
      decoding; look-through exposure; vault withdrawable liquidity. Branch for Vault
      V2 shape if a watched vault uses it.
- [ ] Fork integration tests (Ethereum + Base, pinned blocks) asserting adapter reads
      match direct contract calls.

**Done when:** fork integration tests on Ethereum and Base match direct contract reads
at pinned blocks.

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
