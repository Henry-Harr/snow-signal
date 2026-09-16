# Progress

This is the project's memory across sessions. Read this in full at the start of every
session, along with `CLAUDE.md` and the relevant section of `docs/SPEC.md`.

## Status as of 2026-09-16

**Phase 0 (Research and plan): complete.** Repo repurposed from an unrelated static
ski-resort site to Sentinel per the user's explicit instruction. Phase 1 (Foundations)
is next and this session is proceeding directly into it.

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

### Phase 1 — Foundations — **IN PROGRESS**

Tasks:
- [ ] Repo scaffold: `package.json` (pnpm, Node 24 `engines`), strict `tsconfig.json`,
      ESLint (+ the `signals/**` no-restricted-imports rule from `ARCHITECTURE.md` §2)
      and Prettier configs.
- [ ] GitHub Actions CI: lint + typecheck + unit tests on every push/PR. A separate job
      for fork/integration tests, gated on RPC secrets being present, that skips
      cleanly (not fails) when they're absent.
- [ ] Config schema (zod) with environment-variable substitution (`${VAR}` in YAML),
      matching the shape in spec §14; `config/sentinel.example.yaml`; `.env.example`
      with placeholders; `.gitignore` covering all `.env*` and keystore paths.
- [ ] Pre-commit secret scanner (gitleaks) wired in (husky or a simple git hook +
      documented `pnpm` script — decide based on what's idiomatic once package.json
      exists).
- [ ] Logger (pino), structured JSON, with secret redaction for anything matching
      `*_KEY`/`*_TOKEN`/`*_SECRET` at the serializer level (threat model §2).
- [ ] Core error types, id generation helpers (`src/core`).
- [ ] SQLite storage (better-sqlite3, WAL mode), versioned migration runner
      (`src/storage/migrations`), `schema_migrations` tracking table.
- [ ] RPC pool (`src/chain`): ≥2 providers per chain, health scoring, rate limiting,
      jittered-backoff retries, failover, quorum-read comparison for decision-critical
      values, head-lag monitoring.
- [ ] Block source with reorg handling: confirmation depth per chain (config-driven),
      parent-hash mismatch detection, rollback of derived data on reorg.
- [ ] `sentinel` CLI skeleton (commander) + `sentinel doctor` (checks config validity,
      RPC quorum reachability, DB open/migrated, notifier configured — degrades
      gracefully to "not configured" rather than crashing when secrets are absent).
- [ ] `PreToolUse` Claude Code hook (safety rule 3) blocking shell commands that would
      broadcast a transaction to any RPC other than localhost/127.0.0.1 (e.g. `cast
      send --rpc-url <non-local>`, `forge script --broadcast --rpc-url <non-local>`).
      Document exactly what was added, per the spec's explicit instruction to "tell me
      exactly what you added."
- [ ] Reorg-handling tests (unit + a scripted Anvil scenario if feasible without a real
      fork setup yet — full fork integration tests are Phase 2's job).
- [ ] Update this file with a "Completed" note once done-when criteria are met.

**Done when:** `sentinel doctor` passes against configured RPCs or clearly-labeled
mocks, reorg tests pass, CI is green.

### Phase 2 — Read-only protocol adapters

- [ ] Re-verify Morpho oracle scaling and MetaMorpho v1.1 event names directly against
      `docs.morpho.org` (blocked this session) before writing detector-facing math.
- [ ] Re-verify which Aave version(s) the actually-configured watched markets run
      (v3.x vs v4) before assuming the v3 adapter covers them.
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
- [ ] Kill switch: config flag, CLI `sentinel kill`, Telegram `/kill`; `sentinel resume
      --confirm` CLI-only re-enable.
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
