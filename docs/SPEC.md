# Sentinel: Build Spec for a DeFi Stablecoin Position Watchdog

> **For Claude Code:** This is a large, multi-session project. Read this entire file before doing anything, then start at Phase 0 (Section 13). Work through the phases in order, and keep `docs/PROGRESS.md` up to date so any future session can pick up exactly where the last one stopped. Section 2 contains safety rules that override everything else.

---

## 1. Mission

Build **Sentinel**, a long-running service that protects my stablecoin deposits in DeFi lending protocols. On every block, it watches my positions and the markets behind them, detects the warning signs that came before past DeFi blowups, and alerts me. Only in a later, explicitly gated phase does it also withdraw my funds back to my own Safe before most people react.

Priorities, in order:

1. **Sentinel itself must never lose or misdirect funds.**
2. **Detect real danger early**, with evidence I can verify.
3. **Keep false alarms rare** enough that I don't learn to ignore alerts.
4. **Be observable, testable, and easy to improve** from daily reports.

Yield optimization is explicitly *not* a priority. It comes last (Phase 10), if at all.

### 1.1 In scope

- **Protocols:** Aave v3, Morpho Blue (isolated markets), and Morpho vaults (MetaMorpho, plus Morpho Vault V2 if any watched vault uses it). Design the adapter interface so other protocols (Aave v4, Euler, Spark, Fluid, and so on) can be added later.
- **Chains:** Ethereum mainnet and Base. Chain support must be config-driven, so any EVM chain that viem supports (for example Arbitrum) can be added for monitoring or replay without code changes beyond verified addresses.
- **Assets I hold:** USDC and USDT to start, and any ERC-20 stablecoin via config.

### 1.2 Out of scope (do not build)

- Trading, leverage, borrowing, or looping of any kind
- Watching the public mempool to front-run other users
- Automatic swaps out of a stablecoin (depeg handling is alert-only by default; see §8.5)
- Anything that requires a seed phrase

---

## 2. Non-negotiable safety rules

These override everything else in this document. If a task seems to require breaking one, stop and ask me.

1. **Secrets.** Never ask for, print, log, store, or commit a seed phrase or private key. Runtime secrets (RPC keys, the bot key, the Telegram token) come only from environment variables or an encrypted keystore stored outside the repo. Commit a `.env.example` with placeholders, git-ignore every other `.env*` file and all keystores, and add a pre-commit secret scanner (for example gitleaks).
2. **No real transactions during development.** Every code path that signs or sends a transaction is exercised only against a local Anvil fork. Execution mode defaults to `off`. Never run a command that broadcasts to a public network (for example `cast send` or `forge script --broadcast` pointed at a non-local RPC).
3. **Enforce rule 2 mechanically.** In Phase 1, add a Claude Code `PreToolUse` hook to this project's settings that blocks shell commands which would broadcast transactions to any RPC other than `localhost` or `127.0.0.1`. Tell me exactly what you added.
4. **Withdraw-to-self only.** The executor may only call withdraw or redeem functions whose recipient is my Safe. Enforce this twice: in code (an allowlist checked before signing) and on-chain (Zodiac Roles permissions; see §8.4). The bot key must never be able to call `transfer` or `approve`, or send funds anywhere else.
5. **Simulate before sending.** Simulate every transaction against the latest block first. Abort if it reverts, or if the simulated result isn't exactly "position down, Safe up by the expected amount."
6. **No facts from memory.** Never hardcode contract addresses, ABIs, function signatures, event names, or incident block numbers from memory. Verify each one against official sources (protocol docs, official address books, verified contracts on block explorers, public postmortems) and record the source in a code comment or in `docs/SOURCES.md`.
7. **Fail safe on bad data.** Any decision that moves money must rest on data confirmed by at least two independent RPC providers at the same block. If confirmation fails, alert loudly and keep retrying, but never exit on unconfirmed data. Record this trade-off in an ADR.
8. **No tuning to noise.** Detection thresholds change only with supporting evidence from the replay harness (§9), recorded in `docs/TUNING_LOG.md`. A single day of results is never enough.

---

## 3. How to work on this project

- **Session start:** Read `CLAUDE.md`, `docs/PROGRESS.md`, and the relevant sections of this spec. Each session starts without memory of earlier ones, so these files are the project's memory.
- **CLAUDE.md:** Create it in Phase 0 and keep it short (well under 200 lines): the safety rules in brief, build and test commands, conventions, and pointers to this spec and `docs/PROGRESS.md`. Don't copy this spec into it.
- **PROGRESS.md:** After every milestone, record what's done, what's next, open questions for me, known issues, and the date.
- **Decisions:** Make reasonable decisions without waiting for me, and record significant ones as short ADRs in `docs/adr/NNNN-title.md` (context, decision, alternatives, consequences). Stop to ask only when something is truly blocking. Meanwhile, use mocks or placeholders and list the question in `PROGRESS.md`.
- **Plan each phase first:** Before coding a phase, write its plan (tasks, risks, test plan) into `PROGRESS.md`.
- **Definition of done for any task:** Code, tests, and docs are updated; `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; and the phase's acceptance criteria are met.
- **Commits:** Small, focused commits with clear messages, at least one per milestone. Never commit secrets, reports, or cached data.
- **Research:** For protocol details, read the official docs and the deployed contracts' verified ABIs. Save useful notes in `docs/research/`.

---

## 4. Tech stack

Use these unless you find a concrete reason not to, and record any change in an ADR:

- TypeScript (strict mode), the current Node.js LTS, and pnpm
- viem for all chain access (multicall, logs, block watching, simulation)
- zod for validating config and all external data
- SQLite via better-sqlite3, with versioned migrations and WAL mode
- vitest for tests and fast-check for property-based tests
- pino for structured JSON logs and prom-client for Prometheus metrics
- commander for the CLI
- Foundry (anvil, cast) for Ethereum and Base forks in tests
- Safe's protocol-kit and the Zodiac Roles Modifier v2 tooling for Phase 8 (verify current package names)
- `@bgd-labs/aave-address-book` for Aave addresses (verify it covers the target markets), and Morpho's official docs for Morpho addresses
- ESLint and Prettier, plus GitHub Actions CI running lint, typecheck, and unit tests. Fork and integration tests run in a separate job only when RPC secrets are available.
- Docker and docker-compose for deployment

---

## 5. Architecture

### 5.1 Pipeline

```
new block on each chain (after N confirmations)
  │
  ▼
Collectors: protocol adapters, price sources, watchers
  │   (every read in a snapshot is pinned to one block number)
  ▼
Snapshot store (SQLite)
  │
  ▼
Signal detectors: pure functions over snapshots → signals + evidence
  │
  ▼
Risk engine: one state machine per position → decisions + DecisionRecords
  │
  ▼
Action planner
  ├──▶ Notifier (Telegram, Discord, console)
  ├──▶ Paper executor (simulates on a fork, never signs)
  └──▶ Live executor (Phase 8, gated, Safe + Roles only)
  │
  ▼
Reports, metrics, decision log
```

Design principles:

- **One code path for live and replay.** The pipeline takes an injected `BlockSource` and `Clock`, so the replay harness runs exactly the same detectors and risk engine as production.
- **Pure detectors.** Given snapshots and history windows, a detector returns signals with evidence. No I/O happens inside detectors.
- **Explainable decisions.** Every risk-state change writes a `DecisionRecord` containing the inputs, detector outputs, the rule that fired, block numbers, and the config hash.
- **Idempotent and restartable.** On restart, resume from the last fully processed block on each chain and backfill any gaps.

### 5.2 Repository layout

```
sentinel/
  CLAUDE.md
  README.md
  config/
    sentinel.example.yaml
  docs/
    SPEC.md                (this file)
    PROGRESS.md
    ARCHITECTURE.md
    THREAT_MODEL.md
    RUNBOOK.md
    SOURCES.md
    DETECTORS.md
    REPLAY_RESULTS.md
    TUNING_LOG.md
    DAILY_REVIEW.md
    adr/
    research/
  scenarios/               (replay scenario definitions, YAML)
  reports/                 (generated; git-ignored)
  src/
    core/                  (types, config schema, clock, errors, logger, ids)
    chain/                 (RPC pool, quorum reads, block source, reorg handling)
    protocols/
      aave-v3/
      morpho-blue/
      morpho-vaults/
    prices/                (Chainlink, DEX, CEX, aggregation)
    watchers/              (governance/config changes, token supply, large holders)
    signals/               (one file per detector, plus a registry)
    risk/                  (state machine, policies, decision records)
    actions/               (planner, simulator, paper executor, live executor, safe-roles)
    notify/                (Telegram, Discord, console, dedup and escalation)
    storage/               (SQLite, migrations, repositories)
    replay/                (archive fetcher, cache, runner, scoring)
    reports/               (daily and weekly reports)
    ops/                   (metrics, health server)
    cli/                   (commands)
  test/
    unit/  property/  integration/  e2e/  replay/  fixtures/
  scripts/                 (fork setup, Safe + Roles setup on forks)
  docker/
```

### 5.3 Core interfaces

These are sketches. Refine them as needed, but keep the separation of concerns.

```ts
type ChainId = number;
type Address = `0x${string}`;

interface BlockRef {
  chainId: ChainId;
  number: bigint;
  hash: `0x${string}`;
  timestamp: number;
}

interface ProtocolAdapter {
  id: string; // e.g. "aave-v3:ethereum:core"
  discoverPositions(owner: Address, at: BlockRef): Promise<Position[]>;
  snapshotMarkets(marketIds: string[], at: BlockRef): Promise<MarketSnapshot[]>;
  collateralExposure(marketId: string, at: BlockRef): Promise<CollateralExposure[]>;
  withdrawable(position: Position, at: BlockRef): Promise<WithdrawEstimate>;
  buildWithdraw(position: Position, amount: bigint | 'max', recipient: Address): TxRequest;
  decodeEvents(logs: Log[]): ProtocolEvent[];
}

interface MarketSnapshot {
  marketId: string;
  block: BlockRef;
  totalSupplied: bigint;
  totalBorrowed: bigint;
  availableLiquidity: bigint;
  utilization: number;
  supplyRate: number;
  borrowRate: number;
  flags: { paused: boolean; frozen: boolean };
  oraclePrices: Record<string /* asset */, bigint>;
  badDebt?: bigint;
  raw: unknown; // protocol-specific extras, validated with zod
}

type SignalFamily = 'pool_flow' | 'collateral' | 'peg' | 'governance' | 'infra';

interface Detector {
  id: string; // e.g. "D06_oracle_market_deviation"
  family: SignalFamily;
  evaluate(ctx: DetectorContext): Signal[]; // pure, no I/O
}

interface Signal {
  detectorId: string;
  family: SignalFamily;
  subject: { kind: 'market' | 'asset' | 'vault' | 'position' | 'infra'; id: string };
  severity: 'info' | 'watch' | 'danger' | 'critical';
  standaloneCritical?: boolean; // may trigger a full exit without corroboration
  value: number;
  threshold: number;
  evidence: Record<string, unknown>; // raw numbers, block numbers, source IDs
}
```

---

## 6. Data collection

### 6.1 RPC layer

- Keep a provider pool for each chain with at least two independent providers (primary and secondary), plus health scoring, rate limiting, retries with jittered backoff, and failover.
- **Block pinning:** Every snapshot reads all of its values at one specific block number.
- **Quorum reads:** Decision-critical values (balances, liquidity, oracle prices, pause and freeze flags) are read from two providers at the same block and compared. Mismatches become infra signals.
- **Reorg handling:** Process blocks after a configurable confirmation depth per chain. Detect reorgs by parent-hash mismatch and roll back any derived data.
- **Head-lag monitoring:** Compare provider heads with each other and with wall-clock time.
- Use multicall to keep call volume down, and cache immutable data (market parameters, token decimals).

### 6.2 Aave v3 adapter

For each watched reserve, read: total supplied, total borrowed, available liquidity, utilization, supply and borrow rates, supply and borrow caps, frozen and paused status, and the collateral parameters of every asset borrowers can post against this pool. Read my position (aToken balance) and oracle prices from the market's official oracle. Decode Supply, Withdraw, Borrow, Repay, and LiquidationCall events, plus configuration-change events from the pool configurator. If the deployed Aave version tracks reserve deficits (bad debt), read those too. Use the official data provider contracts where helpful.

Determine which Aave version each market runs. If a watched position or replay scenario involves Aave v4, add a v4 adapter behind the same interface.

For a stablecoin supplier, the real risk is the pool's whole collateral base (every asset borrowers can post against it), not just the stablecoin. Compute `collateralExposure` for each watched reserve from on-chain borrower data where feasible, or from a documented approximation, and record the method in an ADR.

### 6.3 Morpho Blue adapter

Read market state (total supply and borrow assets and shares, last update, fee), market parameters (loan token, collateral token, oracle, interest rate model, liquidation LTV), the oracle's `price()`, and my supply position. Morpho oracle prices use 1e36-based scaling adjusted for token decimals, so verify the exact convention in Morpho's docs. Decode Supply, Withdraw, Borrow, Repay, and Liquidate events, including any realized bad debt.

### 6.4 Morpho vault adapter

Read the ERC-4626 state (`totalAssets`, plus `maxWithdraw` and `maxRedeem` for my address), the vault's allocation across markets (supply and withdraw queues, caps), its roles (owner, curator, guardian, allocators), the timelock length, and any pending timelocked changes. Decode reallocation and configuration events, such as cap submissions and changes and role or timelock changes. Verify exact event names from the deployed ABI, and adjust for Vault V2's different structure if a watched vault uses it.

Compute:

- **Look-through exposure:** my share of the vault's assets in each underlying market, and therefore my exposure to each collateral asset and oracle.
- **Vault withdrawable liquidity:** idle assets, plus, for each market in the withdraw queue, the smaller of the vault's supply there and that market's available liquidity.

### 6.5 Prices and pegs

- **Sources:** Chainlink feeds; on-chain DEX prices (for example Uniswap v3 time-weighted averages via `observe()`, and Curve stable pools); and the public ticker APIs of at least two centralized exchanges (for example Coinbase and Kraken).
- Aggregate with a median, reject outliers, detect staleness for each source, and store every raw quote with its timestamp.
- For each collateral asset behind a watched market, track **both** the price the lending market uses (its oracle) and an independent market price.

### 6.6 Watchers

- **Governance and config:** Aave configurator changes and executed governance payloads affecting watched markets; Morpho vault timelocked submissions and role changes; new collateral listings; oracle changes; pauses and freezes.
- **Token supply:** For every collateral asset in the exposure graph, track `totalSupply` changes and large mints, especially of bridge-minted tokens.
- **Large holders:** From event logs, maintain the top suppliers and borrowers of each watched market or vault, their shares, and their recent movements. Track the health of the largest borrowers wherever the protocol makes that computable.

---

## 7. Signal detectors

Implement each detector in its own file with a doc comment (purpose, inputs, formula, default thresholds, known sources of false positives), unit tests on synthetic data, and an entry in `docs/DETECTORS.md`. Every signal must carry its evidence: the raw values, block numbers, and source IDs behind it.

All thresholds below are **placeholders**. They live in config and are tuned only through replay (§9).

| ID | Detector | Family | Starting thresholds (placeholders) |
|---|---|---|---|
| D01 | Utilization level | pool_flow | watch ≥ 90%, danger ≥ 95%, critical ≥ 99% |
| D02 | Utilization velocity | pool_flow | danger if utilization rises 10+ points within 1 hour |
| D03 | Exit coverage: available liquidity ÷ my position, plus estimated blocks to exit | pool_flow | watch < 20×, danger < 5×, critical < 1.5× |
| D04 | Abnormal net outflows vs. a robust baseline (median and MAD) over 5-minute, 1-hour, and 6-hour windows | pool_flow | watch at z ≥ 4, danger at z ≥ 8 |
| D05 | Large-holder exits and concentration shifts | pool_flow | watch if a top-10 supplier withdraws ≥ 25% of its balance within 1 hour |
| D06 | Oracle vs. market price deviation per collateral asset, sustained for N blocks | collateral | watch ≥ 2%, danger ≥ 5%, critical ≥ 10% (standalone critical) |
| D07 | Fixed or frozen oracle: oracle price flat while the market price moves (the xUSD pattern) | collateral | danger if the oracle is unchanged while the market moves ≥ 3%; critical at ≥ 10% |
| D08 | Collateral supply anomaly: mint spikes vs. history (the rsETH pattern) | collateral | danger if supply rises 5%+ within 1 hour without matching known flows; critical if paired with borrowing against the new supply |
| D09 | Collateral liquidation depth: whether liquidations can clear at a reasonable price given DEX depth | collateral | watch if collateral in the market exceeds what DEX depth can absorb at ≤ 5% slippage |
| D10 | Peg deviation of the stablecoin I hold | peg | watch ≥ 0.5%, danger ≥ 2%, critical ≥ 5% (alert-only by default) |
| D11 | Bad debt or a deficit appears in a watched market | collateral | critical when realized bad debt reaches a configured amount (standalone critical) |
| D12 | Risky governance or config change (new collateral, oracle swap, cap jump, shortened timelock, role change) | governance | severity set per change type |
| D13 | Vault allocation drift into new or risky markets | governance | watch on any new market; danger if the new market triggers collateral detectors |
| D14 | Contagion: an asset flagged anywhere escalates every market exposed to it, including through vault look-through | collateral | inherits the source severity minus one level, unless exposure exceeds a configured share |
| D15 | Share of pool debt held by borrowers close to liquidation | collateral | watch if ≥ 20% of debt has a health factor below 1.05 |
| D16 | Infra health: head lag, provider disagreement, stale sources, reorgs | infra | watch or danger by lag and duration; never triggers an exit |

You may add detectors; record the reason in an ADR. Keep correlated detectors in the same family so the risk engine doesn't double-count them.

---

## 8. Risk engine and actions

### 8.1 State machine

Each position has a state: `NORMAL → WATCH → DANGER → CRITICAL`.

- **Escalation** is driven by the strongest signals across families.
- **Corroboration:** Entering `DANGER` or `CRITICAL` requires signals from **at least two different families**. The exceptions are detectors marked standalone-critical (D06 at critical, and D11), plus any others you justify in an ADR.
- **Rate of change counts:** Fast deterioration can escalate earlier than a stable reading at the same level.
- **Hysteresis:** De-escalation requires readings below a lower threshold for a minimum dwell time. Add cooldowns to prevent flapping.
- **Manual controls:** acknowledge, mute for a set duration, force a level, and a global kill switch for execution.
- Every transition writes a `DecisionRecord`.

Write property-based tests for invariants such as:

- Signals from a single family (other than standalone-critical ones) can never cause an exit.
- Infra signals alone never cause an exit.
- De-escalation never skips its dwell time.
- The same inputs always produce the same decision.

### 8.2 Action policy

- `WATCH` → alert
- `DANGER` → alert, plus a partial withdrawal (configurable, for example 50%)
- `CRITICAL` → alert, plus a full exit
- **Standing rule:** Alert (and optionally reduce the position) whenever a position exceeds a configured share of its pool's available liquidity.

### 8.3 Withdrawal planner

- Compute what's withdrawable right now: for Aave, my balance vs. available liquidity; for Morpho Blue, my supply vs. market liquidity; for vaults, `maxWithdraw`.
- If a pool can't pay everything, withdraw what's available and retry on every new block until the exit is complete, cancelled, or the state de-escalates.
- Raise priority fees step by step, up to a configured cap.
- Track nonces and pending transactions. Never double-send, and handle replacements, reverts, and dropped transactions.
- Use a private-transaction RPC where available (for example Flashbots Protect on Ethereum mainnet). Research the options for Base and record the choice in an ADR.

### 8.4 Execution modes and permissions

- `off` (default): The planner only writes logs.
- `paper`: Plan, simulate on a fork of the current block, and record what would have happened. Never sign anything.
- `live`: Allowed only after Phase 8 is complete **and** I enable it myself, per chain, in config. Never enable it yourself.

The permission model for live mode:

- Funds sit in a **Safe** that I own with my own wallet.
- The bot's key is a member of a **Zodiac Roles Modifier v2** role on that Safe. The role is scoped to the specific pool and vault contracts, to withdraw and redeem functions only, and to parameter conditions requiring the recipient (and owner, where relevant) to be the Safe itself. Verify the right condition operators in the Roles v2 docs. No `transfer`, `approve`, or any other function is allowed. Add rate limits or allowances if the Roles version supports them.
- The bot key holds only a small amount of gas money.
- Provide scripts that set all of this up **on a local fork only**, plus a written guide for me to set it up on mainnet myself.
- **Kill switch:** a config flag, a CLI command, and a Telegram `/kill` command, all of which only *disable* execution. Re-enabling requires the CLI with an explicit confirmation.

### 8.5 Depeg of the stablecoin I hold

The default response is an alert only. A forced sale locks in what may be a temporary drop; USDC briefly traded around 87 cents in March 2023 and then recovered. Any automatic swap feature must be off by default, configured separately, and documented in an ADR.

### 8.6 Daily exit drill

Once a day, fork the latest block and simulate a full exit of every position through the real executor path (Roles-scoped, if configured). Report pass or fail, the gas estimate, and the estimated blocks to exit given current liquidity. This catches broken permissions, ABI changes, and paused withdrawals before a crisis does.

---

## 9. Replay harness and testing

### 9.1 Replay engine

- **Deterministic:** It feeds historical blocks through the same pipeline, using an injected `BlockSource` and `Clock`.
- **Cached:** It fetches historical state and logs through an archive-capable RPC and caches responses on disk (content-addressed and git-ignored), so reruns are fast and work offline.
- **Reported:** Each run outputs a timeline of signals and state changes, decisions with evidence, and scores.

### 9.2 Scenarios

Store each scenario as YAML in `scenarios/` with: a description, chains, block range, markets and vaults, a simulated position for me, ground-truth events with timestamps, and source links. Research exact block ranges from public postmortems and on-chain data. **Do not guess them.**

1. **USDC depeg, March 2023** (Ethereum; Aave v3 stablecoin reserves). Tests D10 and the alert-only depeg policy.
2. **Stream Finance xUSD collapse, late October to November 2025.** Lending markets on Morpho, Euler, and Silo accepted xUSD as collateral while pricing it at a fixed value. When xUSD crashed, liquidations didn't trigger and lenders were left with bad debt. Tests D07, D06, D11, D14, and vault look-through. Research which chains and markets were affected. If they're on chains or protocols Sentinel doesn't support, either add minimal read-only support for the replay or reconstruct the scenario from recorded market data, and document the choice.
3. **KelpDAO rsETH bridge exploit, April 18–20, 2026.** An attacker used unbacked rsETH as collateral to borrow from Aave, and billions of dollars in deposits left Aave within two days. Tests D08, D04, D01–D03, D05, and D14, including how the watched stablecoin reserves behaved during the rush to withdraw.
4. **Quiet periods:** At least 30 recent days per chain with no major incident, to measure false alarms.
5. **Synthetic stress tests** (fault injection): utilization spike, frozen oracle, depeg, whale exit, RPC outage, provider disagreement, reorg, gas spike, and paused withdrawals.

### 9.3 Scoring

For each scenario, report:

- **Lead time:** from the first `WATCH`, `DANGER`, and `CRITICAL` state to the scenario's defined point of no return
- **Recoverable share:** how much of my simulated position could actually have been withdrawn, given real liquidity at each block
- **False alarms per week** (from the quiet periods)
- **Gas** that would have been spent

Save a summary table in `docs/REPLAY_RESULTS.md`, and regenerate it whenever detectors or thresholds change.

### 9.4 Test suites

- **Unit:** every detector, the risk engine, the planners, config parsing, and price aggregation.
- **Property-based:** the risk-engine invariants in §8.1, plus planner invariants (never plan a withdrawal to anyone but the Safe; never exceed the position).
- **Integration (Anvil forks):** Adapters return the same values as direct contract calls at pinned blocks on Ethereum and Base.
- **End-to-end (Anvil fork):** Deploy a Safe with the Roles setup, deposit into Aave and a Morpho vault, trigger a synthetic crisis, and verify the bot exits to the Safe. **Negative tests:** the bot key attempting `transfer`, `approve`, or a withdrawal to any other address must revert.
- **Replay regression:** golden-output tests for each scenario.
- **Chaos:** Kill providers, inject stale data, and force reorgs mid-run.
- **Coverage target:** at least 85% of lines in `signals/`, `risk/`, and `actions/`.

---

## 10. Notifications and reports

### 10.1 Notifications

- Build a notifier interface with Telegram (primary), Discord webhook, and console implementations.
- Each alert includes: the position, its level, the signals that fired with their key numbers, the block number, block explorer links, and the action taken or planned.
- Deduplicate and rate-limit alerts. Repeat critical alerts until I acknowledge them.
- Telegram commands work only from allowlisted chat IDs: `/status`, `/positions`, `/ack <id>`, `/mute <id> <duration>`, and `/kill`.

### 10.2 Daily report

Generate it at 00:00 UTC into `reports/YYYY-MM-DD.md` and `reports/YYYY-MM-DD.json`, containing:

- Positions, balances, and yield earned, compared with a configurable benchmark (for example the pool's base supply rate or a benchmark vault)
- Every alert, with its evidence and current label
- State transitions and a summary of decision records
- Actions taken or simulated, and gas spent
- The exit drill result and blocks to exit for each position
- Data quality: provider uptime, lag, disagreements, and stale sources
- The config hash and any config changes
- Open questions for me

### 10.3 Labeling and weekly review

- **Labeling CLI:** `sentinel label <alertId> true|false|unsure --note "..."`
- **Weekly report:** alert precision based on my labels, false alarms per detector, and threshold candidates for review. Candidates must be tested in replay before any change is made (safety rule 8).

---

## 11. Operations

- A health endpoint and a Prometheus `/metrics` endpoint (block lag, detector timings, provider errors, state counts), plus an optional Grafana dashboard JSON
- A Dockerfile, docker-compose, and a systemd unit as an alternative; graceful shutdown; automatic resume and gap backfill
- SQLite backups and log rotation
- `docs/RUNBOOK.md`: setup, configuration, daily operation, reading alerts, incident response, using the kill switch, and revoking the bot's role from the Safe
- `docs/THREAT_MODEL.md`: a compromised server, a leaked bot key, malicious RPC data, a Telegram account takeover, and a dependency supply-chain attack, with mitigations for each

---

## 12. CLI

```
sentinel doctor                      # check config, RPC quorum, database, notifier
sentinel watch                       # run the live pipeline
sentinel positions                   # show discovered positions and exposure
sentinel replay <scenario>           # run a replay and write its report
sentinel report [--date YYYY-MM-DD]  # generate a daily report
sentinel label <alertId> <verdict> [--note "..."]
sentinel drill                       # run the exit drill now
sentinel kill                        # disable execution immediately
sentinel resume --confirm            # re-enable execution (CLI only)
```

---

## 13. Phases and acceptance criteria

Work through these in order. Don't start a phase until the previous one meets its criteria.

### Phase 0: Research and plan

- Read the official docs for Aave v3, Morpho Blue, Morpho vaults, Safe, and Zodiac Roles v2. Note which Aave and Morpho vault versions are live on Ethereum and Base.
- Write `ARCHITECTURE.md`, a first draft of `THREAT_MODEL.md`, `SOURCES.md`, initial ADRs, `CLAUDE.md`, and a detailed task breakdown for every phase in `PROGRESS.md`.
- List everything you need from me (§15).
- **Done when:** the docs exist and the plan covers every phase, including tests.

### Phase 1: Foundations

- Repo scaffold, strict TypeScript, lint and format, CI, config schema (with environment-variable substitution) and example config, logger, SQLite with migrations, RPC pool with quorum reads, block source with reorg handling, `sentinel doctor`, and the `PreToolUse` safety hook from §2.
- **Done when:** `doctor` passes against configured RPCs (or mocks), reorg tests pass, and CI is green.

### Phase 2: Read-only protocol adapters

- Aave v3, Morpho Blue, and Morpho vault adapters, with position discovery, look-through exposure, and withdrawable estimates.
- **Done when:** fork integration tests on Ethereum and Base match direct contract reads at pinned blocks.

### Phase 3: Prices and watchers

- Chainlink, DEX, and CEX price sources with aggregation, plus the governance/config, token supply, and large-holder watchers.
- **Done when:** unit and fork tests pass, and raw quotes and events are stored and queryable.

### Phase 4: Detectors

- D01 through D16, each with docs and unit tests.
- **Done when:** every detector has tests for normal, borderline, and alarming inputs, plus at least one known false-positive case.

### Phase 5: Risk engine, alerts, and daily report (watch-only MVP)

- The state machine, decision records, notifiers, Telegram commands, daily report, and labeling CLI.
- **Done when:** `sentinel watch` runs for 24 hours against real chains without crashing, delivers test alerts, and writes a complete daily report. This is the first version I will actually run.

### Phase 6: Replay harness

- The replay engine, caching, the scenarios in §9.2, scoring, and `REPLAY_RESULTS.md`.
- **Done when:** every scenario runs from cache and the results are documented, including honest notes on what Sentinel would have missed.

### Phase 7: Paper mode and exit drills

- The withdrawal planner, fork simulator, paper executor, and daily drill.
- **Done when:** replays show what paper mode would have done, and the drill runs and reports correctly.

### Phase 8: Guarded live execution (forks only)

- The live executor, Safe and Roles setup scripts for forks, private transaction submission, the kill switch, the end-to-end and negative permission tests, and a step-by-step guide for me to set up the Safe and role on mainnet myself.
- **Done when:** all end-to-end and negative tests pass on forks. Do **not** enable live mode on any real network. I will do that myself after reviewing everything.

### Phase 9: Hardening

- Chaos tests, metrics, Docker deployment, the runbook, a final threat model review, and a dependency audit.
- **Done when:** chaos tests pass and the runbook covers every alert type and the kill switch.

### Phase 10 (optional, last): Risk-adjusted allocation

- Start this only after I confirm the watchdog has run reliably. Allocate across a whitelist of markets I approve, ranking them by yield after gas costs, adjusted for Sentinel's risk scores. Move funds only when the expected gain over a configured time horizon clearly exceeds the costs. Compare results against a benchmark in the daily report.

---

## 14. Example configuration (shape only)

```yaml
safe:
  address: "0xYOUR_SAFE"             # public address only

chains:
  ethereum:
    chainId: 1
    confirmations: 2                 # placeholder
    rpc:
      - { name: primary, url: "${ETH_RPC_PRIMARY}" }
      - { name: secondary, url: "${ETH_RPC_SECONDARY}" }
  base:
    chainId: 8453
    confirmations: 5                 # placeholder
    rpc:
      - { name: primary, url: "${BASE_RPC_PRIMARY}" }
      - { name: secondary, url: "${BASE_RPC_SECONDARY}" }

positions:
  - { protocol: aave-v3, chain: ethereum, market: core, asset: USDC }
  - { protocol: morpho-vault, chain: base, vault: "0xVAULT_ADDRESS" }

detectors:
  D01_utilization: { watch: 0.90, danger: 0.95, critical: 0.99 }
  D10_peg: { watch: 0.005, danger: 0.02, critical: 0.05 }
  # ...every detector, validated by the zod schema

policy:
  danger: { action: partial_withdraw, fraction: 0.5 }
  critical: { action: full_exit }
  maxShareOfAvailableLiquidity: 0.05

execution:
  mode: off                          # off | paper | live (only I ever set live)
  maxPriorityFeeGwei: { ethereum: 50, base: 1 }   # placeholders

notify:
  telegram: { tokenEnv: TELEGRAM_BOT_TOKEN, allowedChatIds: [] }

reports:
  dailyUtcHour: 0
  benchmark: { kind: pool_base_rate }
```

---

## 15. What I'll provide (use mocks until I do)

- RPC URLs for Ethereum and Base from two different providers, at least one with archive access for the replays
- The public addresses to watch, including my Safe (public addresses only, never keys)
- A Telegram bot token and chat ID
- Tools on my machine: Node.js LTS, pnpm, Foundry, and Docker. Check for them and tell me if anything is missing.
- For Phase 8 testing, nothing secret: fork tests use Anvil's built-in test accounts.

---

## 16. Daily review loop (after Phase 5)

When I start a session with "Daily review for YYYY-MM-DD":

1. Read `PROGRESS.md`, that day's report, and any new labels.
2. Summarize what happened, and flag anything that looks wrong: bugs, data problems, or noisy detectors.
3. Fix bugs directly, with tests.
4. For threshold or logic changes, run the relevant replays first, and propose only changes that improve results without increasing misses. Record them in `TUNING_LOG.md`.
5. Update `PROGRESS.md`.

---

## Start now

Begin Phase 0. Before writing any code, read the official protocol docs, draft the architecture and threat model, create `CLAUDE.md`, and put the full task breakdown in `docs/PROGRESS.md`. Then continue into Phase 1, and keep going phase by phase for as long as the session allows, updating `PROGRESS.md` at every milestone.
