# 0005: Depeg response is alert-only by default

## Context

Spec §8.5: when the stablecoin the user holds depegs, the default response must be
alert-only, not an automatic swap or forced exit. Rationale given in the spec: a
forced sale locks in what may be a temporary drop — USDC traded near $0.87 in March
2023 and fully recovered within days. Any automatic-swap feature must ship off by
default, configured separately, and documented in an ADR (this one).

## Decision

- D10 (peg deviation) at any severity (watch/danger/critical) never, by itself,
  triggers a withdrawal or exit action. It is explicitly excluded from the standard
  `DANGER → partial_withdraw` / `CRITICAL → full_exit` action policy (spec §8.2) even
  though other detectors at the same severity levels do trigger those actions.
- This is enforced structurally, not just by threshold choice: the action policy
  evaluator treats D10 as alert-only regardless of its severity, rather than relying on
  D10's thresholds happening to never reach the policy's action-triggering severity.
  (A future threshold retuning of D10 must not accidentally make it action-triggering
  by default — that would require a deliberate, separate opt-in, not a threshold edit.)
- No automatic swap-out-of-depegged-stablecoin feature exists in the codebase at all
  as of Phase 0–7. If one is ever built, it must: ship disabled by default, live behind
  its own explicit config flag separate from the general action policy, and get its
  own ADR at the time it's proposed (this ADR only covers "depeg does not trigger the
  standard withdrawal policy," not "swap features are pre-approved").
- A depegged stablecoin sitting in a lending pool can still coincide with *other*
  detectors firing (e.g. D01 utilization spiking as everyone tries to exit that pool,
  or D11 bad debt appearing) — those detectors' own action policies still apply
  normally. This ADR only exempts the peg-deviation signal itself from being an
  action trigger; it does not blanket-exempt a pool experiencing a depeg-driven bank
  run from the pool_flow detectors that would fire independently of D10.

## Alternatives considered

- **Auto-exit above the critical peg threshold**: rejected per spec — this is the
  literal behavior the spec says not to build by default, given the USDC 2023
  precedent of a sharp, temporary depeg followed by full recovery. Locking in a loss on
  a stablecoin that then recovers is a worse outcome than riding it out, in the
  general case.

## Consequences

- The user must react manually to a depeg alert if they decide the situation is
  actually terminal (vs. temporary) — Sentinel will not make that call for them. This
  is intentional given the spec's explicit priority ordering (never lose/misdirect
  funds > detect early > reduce false alarms).
- If the user later wants an opt-in auto-response to sustained/critical depegs, that's
  a Phase 10-or-later feature request needing its own design and ADR, not a threshold
  change to D10.
