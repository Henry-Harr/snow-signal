# Threat Model (draft)

Status: first draft, Phase 0. Revisit at the end of Phase 9 ("final threat model
review") and any time a new attack surface is added (new adapter, live execution,
new notification channel).

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
  other than the configured Safe. Phase 8. This is the load-bearing mitigation — code
  is a defense-in-depth layer, the Roles Modifier is the actual boundary.
  boundary that survives host compromise.
- The bot key holds only a small, replenishable amount of gas money — capped
  blast radius even before Roles scoping is considered. Phase 8.
- Dependency supply-chain hardening (§5) reduces the odds a compromised dependency is
  how the attacker got in in the first place.
- Least-privilege deployment: no inbound ports beyond the metrics/health endpoint
  (bind to localhost or an internal network by default), container runs as non-root.
  Phase 9.

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
  documented as an incident-response step in `docs/RUNBOOK.md`. Phase 8/9.

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
  itself is the alert). Recorded as ADR 0003.
- Reorg detection (parent-hash mismatch) plus a configurable confirmation depth reduce
  the window where a soon-to-be-orphaned block's data can drive a decision. Phase 1.
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
- `/kill` can only ever *disable* execution — an attacker who takes over Telegram can
  make Sentinel stop acting, which is the fail-safe direction, but can never use
  Telegram alone to *enable* or expand execution. Re-enabling (`sentinel resume
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
- `pnpm audit` (or equivalent) run as part of CI/Phase 9 dependency audit; findings
  triaged rather than ignored.
- The recipient allowlist check for any signed transaction lives in Sentinel's own code
  path, immediately before signing, re-validated against config — not trusted from a
  dependency's return value. Even a compromised planner/executor dependency still has
  to get past the Zodiac Roles on-chain scoping to actually move funds anywhere but the
  Safe. Phase 8.
- Minimize the dependency surface on anything in the signing path specifically: prefer
  well-known, widely-audited packages (viem, Safe's own protocol-kit, gnosisguild's own
  zodiac-roles-sdk) over ad-hoc or low-usage libraries for that code path.

## Open items / not yet fully designed

- Formal incident-response runbook entries for each threat above (owned by
  `docs/RUNBOOK.md`, Phase 9).
- Rate limiting / abuse handling on the metrics and health HTTP endpoints if ever
  exposed beyond localhost (Phase 9 — default posture is: don't expose them).
- Chaos-testing several of the above (§3's "kill providers, inject stale data, force
  reorgs mid-run") is explicitly scheduled for Phase 9, not before.
