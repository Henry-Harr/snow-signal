# Threat Model

Status: final Phase 9 review complete (2026-09-17) — every mitigation below that says
"Phase N" for N ≤ 9 is now actually implemented and verified, not aspirational; see
each section for what's still open. Revisit any time a new attack surface is added
(new adapter, a new notification channel, live execution actually wired into the
automatic pipeline — `docs/adr/0012`).

For each threat: what it is, why it matters, and the mitigations Sentinel implements
or plans to implement, with the phase that delivers each mitigation.

## 1. Compromised server (host running Sentinel)

**Threat:** An attacker gains shell or filesystem access to the machine running
Sentinel (compromised dependency, exposed port, stolen SSH key, malicious insider on a
shared host).

**Impact if unmitigated:** Read of RPC API keys, Telegram bot token, and the bot's
private key/keystore → attacker can drain the bot key's gas balance, spoof alerts, or
(if execution is live) attempt withdrawals.

**Mitigations:**

- Bot private key is never a plaintext secret checked into the repo; it lives in an
  encrypted keystore or env var outside the repo (`.env*` and keystores are
  git-ignored; `.env.example` ships only placeholders). Phase 1.
- Even with full key compromise, the bot key can only sign transactions the on-chain
  Zodiac Roles permissions allow: withdraw/redeem to the Safe, on an allowlisted set of
  pool/vault contracts. It cannot call `transfer`, `approve`, or send to any address
  other than the configured Safe. Phase 8 — verified against a real fork
  (`test/integration/actions/safe-roles-setup.test.ts`): a `transfer`, an `approve`,
  and a withdrawal to any recipient other than the Safe all revert. This is the
  load-bearing mitigation — code is a defense-in-depth layer, the Roles Modifier is
  the actual boundary that survives host compromise.
- The bot key holds only a small, replenishable amount of gas money — capped
  blast radius even before Roles scoping is considered. Phase 8.
- Dependency supply-chain hardening (§5) reduces the odds a compromised dependency is
  how the attacker got in in the first place.
- Least-privilege deployment: no inbound ports beyond the metrics/health endpoint,
  which itself binds to `127.0.0.1` by default (`config.ops.metricsHost`, not
  reachable from outside the container/host unless deliberately widened); the Docker
  image and the systemd unit both run as a dedicated non-root user
  (`docker/Dockerfile`, `docker/systemd/sentinel.service`). Phase 9, implemented —
  see `docker/README.md`.
- Neither `GET /health` nor `GET /metrics` require authentication — an accepted
  gap, not an oversight: the default `127.0.0.1`-only bind means reaching them at all
  already requires host/container access, at which point the attacker has
  read/write access to far more sensitive things (the SQLite database, `.env`)
  than a metrics endpoint would add. Add auth (or a reverse proxy in front of it)
  before ever widening `metricsHost` beyond localhost.

## 2. Leaked bot key (without host compromise — e.g. accidental commit, log leak)

**Threat:** The bot's private key ends up somewhere an attacker can read it, without
the attacker otherwise compromising the host.

**Mitigations:**

- Pre-commit secret scanning (gitleaks) blocks committing anything that looks like a
  key. Phase 1.
- Logger is configured to never log full config objects or anything under an env var
  matching `*_KEY`, `*_TOKEN`, `*_SECRET` — redaction at the pino serializer level, not
  as an afterthought at each call site. Phase 1.
- Same on-chain Roles scoping as §1 bounds the damage regardless of how the key leaked.
- Kill switch (config flag, CLI `sentinel kill`, Telegram `/kill`) lets the user disable
  execution immediately on suspicion of a leak, and revoking the bot's Safe role is
  documented as an incident-response step in `docs/RUNBOOK.md` §7. Phase 8/9, done.
- `sentinel backup`'s output (`docker/README.md`) is a full copy of the SQLite
  database — decision history and configured positions, no bot key or RPC secret
  (those live only in `.env`/the keystore, never in the database) — but still worth
  protecting with the same filesystem permissions as the live database, since it's
  a second copy of real operational data. Phase 9.

## 3. Malicious or wrong RPC data

**Threat:** A single RPC provider (compromised, buggy, or intentionally adversarial —
e.g. a "free" endpoint the user later swaps in) returns fabricated or stale balances,
liquidity, oracle prices, or pause/freeze flags, trying to either suppress a real alert
or trigger a false withdrawal.

**Mitigations:**

- Quorum reads: every decision-critical value is read from ≥2 independent providers at
  the same block number and compared; mismatches raise an infra signal (D16) rather
  than silently trusting one answer. Phase 1/2.
- Safety rule 7: any decision that moves money requires two-provider confirmation at
  the same block; on confirmation failure, Sentinel alerts loudly and keeps retrying
  but never treats unconfirmed data as license to act (nor to stay silent — the failure
  itself is the alert). Recorded as ADR 0003. Phase 9's chaos test
  (`test/integration/core/pipeline-chaos.test.ts`) proves this against two real,
  genuinely disagreeing forks: `runOnce` throws and persists zero decisions rather
  than acting on either provider's version of the truth.
- Reorg detection (parent-hash mismatch) plus a configurable confirmation depth reduce
  the window where a soon-to-be-orphaned block's data can drive a decision. Phase 1;
  proven against a real reorg on a fork in Phase 9
  (`test/integration/chain/reorg.test.ts`), not just the mocked unit tests.
- Pre-send simulation (safety rule 5) against the latest block catches a wrong-data-driven
  transaction before it's broadcast: if simulation doesn't show exactly "position down,
  Safe up by the expected amount," the send aborts. Phase 8.

## 4. Telegram account takeover

**Threat:** An attacker gains control of the Telegram account/chat used for alerts and
commands (SIM-swap, session hijack, phished login).

**Impact if unmitigated:** Attacker could send `/kill` to silence Sentinel right before
acting elsewhere, or `/ack`/`/mute` alerts to hide a real incident from the user.

**Mitigations:**

- Commands are only accepted from an explicit allowlist of chat IDs in config, checked
  server-side on every incoming update — not just "whoever has the bot token."
  Phase 5.
- `/kill` can only ever _disable_ execution — an attacker who takes over Telegram can
  make Sentinel stop acting, which is the fail-safe direction, but can never use
  Telegram alone to _enable_ or expand execution. Re-enabling (`sentinel resume
--confirm`) is CLI-only, on the host, not reachable from Telegram at all. Phase 8.
- `/ack` and `/mute` suppress notification noise, not the underlying `DecisionRecord`s
  or state transitions — the daily report and `sentinel status`/`sentinel positions`
  still show the true state regardless of acked/muted alerts, so a hidden alert doesn't
  mean a hidden incident. Phase 5.
- Discord webhook and console notifiers as independent channels mean a single
  compromised channel doesn't fully blind the user if more than one is configured.

## 5. Dependency supply-chain attack

**Threat:** A malicious or compromised update to a direct or transitive npm dependency
(viem, better-sqlite3, a Safe/Zodiac SDK, etc.) introduces code that exfiltrates
secrets, tampers with detector logic, or rewrites transaction recipients.

**Mitigations:**

- Lockfile committed, CI installs with a frozen lockfile (`pnpm install
--frozen-lockfile`), so upgrades are an explicit, reviewed diff, not silent drift.
  Phase 1.
- **Phase 9 dependency audit (2026-09-17)**: `pnpm audit --prod` — **zero**
  vulnerabilities in anything that actually ships (everything under
  `dependencies` in `package.json`: viem, better-sqlite3, commander, pino,
  prom-client, yaml, zod). `pnpm audit` (all deps, including dev) found 7
  advisories (1 critical, 1 high, 5 moderate), every one of them in `vitest`'s own
  transitive chain (`vitest` → `vite`/`@vitest/mocker` → `esbuild`) — arbitrary
  file read via Vitest's UI server and Vite dev-server path-traversal/CORS issues.
  Triaged and accepted for now, not silently ignored: (a) `docker/Dockerfile`'s
  `pnpm prune --prod` build stage strips `vitest` and everything else in
  `devDependencies` entirely before the runtime image is assembled — confirmed by
  actually running the pruned output (this session's Docker-build simulation,
  `docker/Dockerfile`'s commit); (b) every advisory requires either the Vitest UI
  server or a Vite dev server to be running and network-reachable, and this
  project only ever runs `vitest run`/`vitest` (watch mode), never `--ui` or a
  `vite dev` server. The fix requires `vitest` ≥4.1.11 — a two-major-version jump
  from the pinned `^2.1.8` that (tried and reverted this session) also needs a
  coordinated `vite` bump and breaks `vitest.workspace.ts` resolution as currently
  configured; deferred as a deliberate, tracked follow-up
  (`docs/PROGRESS.md` "Known issues") rather than pushed through un-migrated and
  un-tested. Re-run `pnpm audit --prod` (not just `pnpm audit`) before every
  release as the actual gate — the dev-only findings don't block one.
- The recipient allowlist check for any signed transaction lives in Sentinel's own code
  path, immediately before signing, re-validated against config — not trusted from a
  dependency's return value. Even a compromised planner/executor dependency still has
  to get past the Zodiac Roles on-chain scoping to actually move funds anywhere but the
  Safe. Phase 8.
- Minimize the dependency surface on anything in the signing path specifically: prefer
  well-known, widely-audited packages (viem, Safe's own protocol-kit, gnosisguild's own
  zodiac-roles-sdk) over ad-hoc or low-usage libraries for that code path.

## Open items / not yet fully designed

- **Done this phase, no longer open**: formal incident-response runbook
  (`docs/RUNBOOK.md`, all seven sections); chaos-testing §3's confirmation-quorum
  and reorg-handling claims against real forks
  (`test/integration/{core/pipeline-chaos,chain/reorg,cli/watch-chaos}.test.ts`);
  least-privilege deployment (non-root container/systemd user, localhost-only
  metrics bind by default); the dependency audit above.
- **Still open**: rate limiting / abuse handling on the metrics and health HTTP
  endpoints if ever exposed beyond localhost — current posture is still "don't
  expose them" (§1), so this remains deliberately undesigned rather than
  half-built; revisit if that default is ever deliberately widened.
- **Still open**: the `vitest`-chain dependency findings (§5) — tracked, not
  forgotten, pending a coordinated `vitest`/`vite` major-version migration outside
  the scope of a routine audit.
- **New from this phase, not yet closed**: live execution's own code path
  (`src/actions/live-executor.ts`) is fork-tested but still not wired into
  `sentinel watch`'s automatic pipeline (`docs/adr/0012`) — from a threat-model
  angle this is actually a *mitigation* today (an attacker who fully compromises
  the host still can't make Sentinel autonomously send a live transaction, because
  nothing calls that path automatically yet), but it means the live-execution
  threat surface described in §1/§2 is not yet fully exercised end-to-end in
  production; revisit this document again when that wiring lands.
