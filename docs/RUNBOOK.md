# Runbook

Setup, day-to-day operation, reading alerts, incident response, the kill switch, and
revoking the bot's Safe access. `docs/SPEC.md` is the authoritative spec; this is the
"what do I actually do" companion for someone running Sentinel, not necessarily the
person who built it.

## 1. Setup

1. **Prerequisites**: Node.js 22+, pnpm, and either Docker or systemd for deployment
   (`docker/README.md` covers both). Run `sentinel doctor` any time to sanity-check
   your setup — see §2.
2. **Config**: copy `config/sentinel.example.yaml` to `config/sentinel.yaml` and fill
   in your real Safe address, watched positions, and RPC provider references. Copy
   `.env.example` to `.env` and fill in the real RPC URLs / bot tokens the config
   references via `${VAR_NAME}` (never put secrets directly in `sentinel.yaml` —
   safety rule 1, `docs/SPEC.md` §2).
3. **At least two independent RPC providers per chain** are required
   (`src/core/config.ts`'s schema enforces this) — decision-critical reads are
   confirmed at the same block across both before Sentinel trusts them (safety rule
   7). Two different providers, not two URLs from the same vendor.
4. **Validate**: `sentinel doctor -c config/sentinel.yaml` checks the config parses,
   both RPC providers for each chain answer, the database opens and migrates, and
   notifiers are configured. Fix everything it flags before going further.
5. **Deploy**: `docker/README.md` (Docker, recommended, or systemd as an
   alternative). Both run `sentinel watch` continuously and give you graceful
   shutdown, automatic resume after a restart, log rotation, and a daily backup
   schedule — see that doc for the exact commands.
6. **If you ever want live execution** (Sentinel actually withdrawing funds, not
   just alerting): `docs/MAINNET_SETUP.md` — deploying the Safe + Zodiac Roles
   module, scoping the bot's on-chain permissions, and verifying them on a fork
   before trusting them on mainnet. Read §5 "Incident response" below first —
   as of this writing live execution is deliberately **not** wired into the
   automatic pipeline yet (`docs/adr/0012-live-executor-not-wired-into-pipeline.md`),
   so this step doesn't make Sentinel start moving funds by itself.

## 2. Configuration reference

`config/sentinel.example.yaml` is the authoritative, commented reference for every
field; `src/core/config.ts` is the zod schema that actually validates it. The
highlights:

- **`safe.address`**: your Safe. Everything Sentinel watches and (if ever live)
  withdraws to is scoped to this one address.
- **`chains`** / **`positions`**: which chains to watch and which specific
  (protocol, market/vault, asset) positions to track.
- **`detectors`**: per-detector thresholds. **Known gap** (docs/PROGRESS.md "Known
  issues"): this section isn't actually wired to the running detectors yet —
  `defaultDetectors()` always uses its own Phase 4 built-in defaults regardless of
  what's written here. Don't rely on editing this file to change real behavior until
  that's fixed.
- **`policy`**: what to do at each level — `watch`/`danger`/`critical`, each an
  `alert`, `partial_withdraw` (with a `fraction`), or `full_exit`.
  `maxShareOfAvailableLiquidity` is the standing check that fires regardless of
  detector state if a position is simply too large relative to what's actually
  withdrawable right now.
- **`execution.mode`**: `off` (alert/plan only — the default), `paper` (also
  simulates the planned withdrawal on a local fork and records what *would* have
  happened — this runs automatically as part of `sentinel watch`), or `live` (see
  §1 point 6 and §5 below — not automatically wired in yet regardless of this
  setting).
- **`notify`**: console (always on), Discord (webhook), Telegram (bot token +
  allowlisted chat IDs — commands are restricted to these chats only).
- **`reports`**: what hour (UTC) the daily report's `benchmark` compares against.
- **`ops`**: the Prometheus `/metrics` + `/health` endpoint — `metricsEnabled`,
  `metricsPort` (default 9469), `metricsHost` (default `127.0.0.1`, i.e. not
  reachable from outside the host/container by default — `docs/THREAT_MODEL.md` §1).

Never hand-tune a detector threshold based on one day's alerts — safety rule 8
requires replay-harness evidence and a `docs/TUNING_LOG.md` entry first.

## 3. Daily operation

- **`sentinel watch`** is the one long-running process — polls every configured
  chain, runs detectors, updates each position's risk state, dispatches alerts, and
  (in `paper` mode) records simulated withdrawal outcomes. It's idempotent and
  restartable: a restart resumes from the last block it processed
  (`ChainStateRepository`, SQLite) rather than re-processing or skipping anything.
- **`sentinel report`** generates the daily report
  (`reports/YYYY-MM-DD.{md,json}`, git-ignored) — every decision recorded that day,
  summarized, with a benchmark comparison if configured. Run it on a schedule (cron/
  systemd timer) separate from `watch` — it isn't triggered automatically.
- **`sentinel drill`** forks the current chain state and simulates a full exit of
  every currently-held position, right now, without touching anything real — a
  standing "can we actually get out if we needed to" check. Worth running on a
  schedule (e.g. daily) independent of whether anything is currently alerting.
- **`sentinel label <decisionId> <label> [notes...]`** labels a past decision (e.g.
  `false_positive`, `correct`) for replay scoring — see `docs/SPEC.md` §10.3.
- **`sentinel backup`** takes an online SQLite backup (safe to run while `watch` is
  running) and prunes old backups — schedule it (docker/systemd both give you a
  ready-made schedule, see `docker/README.md`).
- **Metrics/health**: `GET /health` (liveness) and `GET /metrics` (Prometheus —
  blocks processed, decisions by level, RPC provider health, alert dispatch
  outcomes, pipeline run duration) on `ops.metricsPort` (default 9469), bound to
  `ops.metricsHost` (default localhost-only).
- **Logs** are structured JSON on stdout (pino) with secrets redacted by key-name
  pattern (`src/core/logger.ts`) — set `LOG_LEVEL` to `debug` for more detail while
  investigating something, `info` (the default) day to day.

## 4. Reading alerts

Every alert (console/Discord/Telegram) is the same underlying text
(`src/notify/format.ts`):

```
[CRITICAL] aave-v3 (chain 1) — USDC
Position: aave-v3:ethereum:core:USDC
Transition: NORMAL -> CRITICAL (raw: CRITICAL)
Rule: standalone-critical: D11_bad_debt
Signals:
  - D01_utilization_level [pool_flow] watch: value=0.92 threshold=0.9
  - D11_bad_debt [collateral] critical: value=1604836 threshold=1
Block: 25987000 (https://etherscan.io/block/25987000)
Action: full exit [planned, not yet executed — execution mode off]
Decision id: 1 (ack with /ack 1)
At: 2026-09-17T16:46:00.283Z
```

- **Level** (`NORMAL` → `WATCH` → `DANGER` → `CRITICAL`) is the position's current
  risk state — a hysteresis state machine (`docs/adr/0008`), not a single
  detector's raw output; **Transition** shows what actually changed, **raw** is
  what the detectors alone would say before hysteresis/dwell time is applied.
  `docs/DETECTORS.md` documents every `D`-numbered detector: what it measures,
  its formula, and known false-positive sources.
- **Rule** names which detector(s) actually drove this decision.
- **Action** is what the configured policy recommends for this level — in `off`
  mode (the default) this is always a *plan*, never something that already
  happened; see §5.
- **Decision id** is stable and referenced everywhere (the daily report, `sentinel
  label`, `/ack`) — every decision carries its own evidence (raw values, block
  numbers, source IDs), so you can always trace *why* an alert fired back to the
  real data, not just its conclusion.

**Telegram commands** (restricted to `notify.telegram.allowedChatIds`):
`/status`, `/positions`, `/ack <decisionId>`, `/mute <positionId> <duration e.g.
30m/2h/1d>`, `/kill`. There is deliberately no `/resume` — re-enabling execution
after a kill is CLI-only (§6).

## 5. Incident response

**Read this before you need it.** As of this writing, Sentinel in every execution
mode only **alerts and plans** — `off` mode never touches anything real, `paper`
mode simulates against a disposable local fork, and `live` mode's executor
(`src/actions/live-executor.ts`) exists and is fork-tested but is **not yet wired
into `sentinel watch`'s automatic pipeline** (`docs/adr/0012`). A `CRITICAL` alert
does not mean Sentinel is already withdrawing your funds — it means it's telling you
to, with everything you need to verify and act:

1. **Read the alert** (§4) — which position, which detector(s), the actual on-chain
   values behind them, and the block/block-explorer link so you can verify
   independently rather than taking the alert's word for it.
2. **Cross-check with `sentinel drill`** — confirms right now, on a real fork, that
   a full exit of this position would actually succeed and for how much, before you
   act on anything.
3. **Withdraw manually** — via the Safe UI/CLI, or your own tooling, to your Safe.
   This is the only path today; there is no automatic live execution yet.
4. **If you're unsure whether the alert itself is right** (a possible false
   positive): `sentinel label <decisionId> false_positive "<why>"` records it for
   later replay-harness review (safety rule 8) — do this in addition to, not
   instead of, checking the position for real if the stakes justify it.
5. **If Sentinel itself seems to be misbehaving** (spamming alerts, wrong data,
   anything that makes you distrust its output) — activate the kill switch (§6)
   and investigate; it only suppresses *action recommendations*, alerts still fire,
   so you keep visibility while you sort it out.
6. **If you suspect the bot key or host is compromised** — revoke the bot's
   on-chain Safe access immediately (§7); this doesn't depend on Sentinel's own
   code or uptime at all, unlike the kill switch.

## 6. Kill switch

- **`sentinel kill`**: activates the global kill switch — every position's action
  recommendation is suppressed down to `alert` (visible in the alert text as
  `suppressedByKillSwitch`); detection and alerting keep running normally. Also
  reachable via the Telegram `/kill` command.
- **`sentinel resume --confirm`**: clears it. CLI-only, and the `--confirm` flag is
  mandatory — there is deliberately no Telegram equivalent, so re-enabling
  execution can never happen from a single chat message (`docs/SPEC.md` §8.4).
- The kill switch is a **software** control — it stops Sentinel from
  *recommending* action, nothing more. It has no effect on-chain and doesn't touch
  the bot's actual permissions. For a compromise scenario, use §7 instead (or in
  addition).

## 7. Revoking the bot's Safe access

The on-chain backstop, independent of Sentinel's own code or uptime — use this if
you suspect the bot key or host is compromised, or you're decommissioning Sentinel
entirely. Full detail in `docs/MAINNET_SETUP.md`'s "Revoking access" section; in
short, any one of:

- `Roles.revokeTarget(<role key>, <pool/vault address>)`, or
- `Roles.assignRoles(<bot address>, [<role key>], [false])` to pull the bot out of
  the role entirely, or
- `disableModule` the Roles module from the Safe directly.

Any of these immediately removes the bot's ability to call anything through the
Safe, with no dependency on whether Sentinel's process is even still running.
