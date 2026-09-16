# 0008: Risk engine state machine — corroboration, rate-of-change, hysteresis, manual controls

## Context

Spec §8.1 specifies the state machine's rules in prose (`NORMAL → WATCH → DANGER →
CRITICAL`, corroboration across ≥2 families except standalone-critical detectors,
"rate of change counts," hysteresis-gated de-escalation, manual controls) but not a
precise algorithm. Four exact design questions had to be settled before writing
`decide()`, each safety-relevant per CLAUDE.md (`docs/SPEC.md` §2 rule 7-adjacent:
never act on a decision that skipped its own stated safeguards).

## Decision

- **Which signals reach a position.** `decide()` filters the full signal set (the
  registry's combined output, docs/adr/0007) down to ones whose `subject` matches this
  position directly (`kind: 'position', id: position.id`) or its market/vault
  (`kind: 'market' | 'vault', id: position.marketId`). Per docs/adr/0002, asset-level
  collateral risk reaches a position only through D14 (contagion) having already
  projected it onto the exposed market(s) — the risk engine itself never looks at
  asset-subject signals directly. This makes D14 load-bearing for correctness (ADR
  0002 already flagged this); nothing new here, just confirming the risk engine relies
  on it.
- **Corroboration.** Signals are grouped by family, **excluding `infra`** — an infra
  signal is always visible in the `DecisionRecord`'s evidence but never counts toward
  the "≥2 families" requirement and can never itself be standalone-critical (D16 never
  sets that flag; see its own doc comment). Reaching `DANGER`/`CRITICAL` needs either a
  standalone-critical signal at `critical` severity among the relevant, non-infra set,
  or qualifying signals (severity ≥ `watch`) from at least 2 distinct non-infra
  families. If only one non-infra family qualifies and none of it is standalone-
  critical, the computed (raw) level is **capped at `WATCH`**, however severe that one
  family's signal is — this is the direct mechanism that satisfies both invariants
  spec §8.1 asks for property tests on ("a single family can never cause an exit,"
  "infra alone never causes an exit"): capping at `WATCH` means `DANGER`/`CRITICAL` —
  the levels whose action policy can withdraw — are structurally unreachable without
  corroboration.
- **Rate of change.** Escalation (raw level rank increasing) is applied **immediately**
  on the same evaluation, including jumping more than one level at once (`NORMAL` →
  `CRITICAL` in one step, if warranted) — no dwell time gates escalation at all. This
  is what "fast deterioration can escalate earlier than a stable reading at the same
  level" means in practice: there is no artificial floor under how fast the state can
  rise, only under how fast it can fall (below). Individual detectors that need their
  own "sustained N blocks" confirmation (D06, D07, D04's windowed baseline) already
  build that into the _signal itself_ before it ever reaches the risk engine — the
  state machine doesn't re-impose a second confirmation delay on top of that.
- **Hysteresis (de-escalation only).** A drop in raw level below the current stored
  level starts (or continues) a dwell timer: `pendingDeescalation = {rawLevel, since}`.
  The stored level only actually drops once the raw level has held at that _same_
  target for `dwellSeconds` continuously. If the raw level changes to a _different_
  value while still below the stored level (e.g. trending `CRITICAL → DANGER →
WATCH` in quick succession), the dwell timer **restarts** at the new target rather
  than continuing to accumulate toward the old one — a de-escalation that can't hold
  steady at one target for the full window hasn't actually stabilized yet. If the raw
  level ever returns to or above the stored level, the pending timer is cleared
  entirely (real escalation always wins immediately, per the rule above).
- **Manual controls**, matching the "ack/mute don't touch `DecisionRecord`s" line
  already in `docs/THREAT_MODEL.md`:
  - `forcedLevel` overrides the _stored_ level unconditionally (the computed raw level
    is still recorded, for auditability, as what would have happened without the
    override) until a human explicitly clears it — `decide()` never clears it itself.
  - `mutedUntil` and `ackedDecisionId` affect only the **notifier** (repeat-until-ack,
    rate-limiting) — never the state machine or the decision log. This matches spec's
    own framing ("manual controls" are listed as part of the state machine section,
    but their actual effect, per the threat model doc already checked in, is
    notification suppression, not decision suppression).
  - The global kill switch (spec §8.4) is a single system-wide flag, not per position
    (`GlobalControls`, separate from `ManualControls`) — it downgrades a computed
    `partial_withdraw`/`full_exit` action to `alert` (`suppressedByKillSwitch: true`
    on the record) but never touches the computed _level_, since alerting and
    explainability must keep working even with execution killed.
- **Determinism and the `id` field.** `decide()` (`src/risk/state-machine.ts`) is a
  pure function returning a `Decision` (`src/risk/types.ts`) with **no `id`** — an
  app-generated id (`generateId`, timestamp + random) would make the literal return
  value non-repeatable for reasons unrelated to the decision itself, directly
  contradicting spec's own determinism invariant. The id is assigned only once a
  `Decision` is persisted (`DecisionRecordRepository`, SQLite `AUTOINCREMENT`, the
  same pattern every other table already uses) — the persisted row type is called
  `DecisionRecord` (spec's own term) to distinguish it from the pure `Decision` a
  fresh `decide()` call returns.
- **The "standing rule"** (spec §8.2: alert whenever a position exceeds a configured
  share of its pool's available liquidity) is implemented as `standingAlert: boolean`
  on the `DecisionRecord`, set whenever a D03 (exit coverage) signal is present in the
  relevant set — **independent of and not gated by corroboration**. A position can be
  `NORMAL` (D03 alone can't reach `DANGER` without a second family) and still carry
  `standingAlert: true`, and the notifier treats that as an unconditional alert
  regardless of level. D03's own thresholds already encode "this position is a large
  share of what's available" (`docs/SOURCES.md`/`D03_exit_coverage.ts`'s own
  formula), so reusing its signal instead of recomputing the share independently
  avoids a second, possibly-inconsistent implementation of the same check.

## Alternatives considered

- **A fixed confirmation delay before escalation too** (symmetric with de-escalation's
  dwell time): rejected — spec explicitly calls out that fast deterioration should
  escalate _earlier_, not on the same timer as recovery; a symmetric dwell would
  directly contradict that.
- **Counting `infra` toward corroboration**: rejected outright by spec §8.1's second
  invariant ("infra signals alone never cause an exit") — if infra could pair with one
  other family to reach `DANGER`, an infra-plus-one-real-family combination would
  still not be "two real signal families," which is what corroboration is supposed to
  mean.
- **Letting the de-escalation dwell timer keep accumulating toward the _original_
  target even as the raw level continues improving past it**: rejected — a level that
  blows straight through its dwell target (e.g. observed dropping `CRITICAL → NORMAL`
  in one step) should re-time against `NORMAL`, not credit time accumulated while
  still notionally "heading toward `DANGER`."

## Consequences

- A position's `DecisionRecord` history is a complete audit trail even during a
  muted/acked/forced period — nothing about manual controls ever creates a gap in the
  explainability log, which is the property CLAUDE.md's "never lose or misdirect
  funds > detect early > reduce false alarms" priority ordering depends on being true.
- The corroboration-cap mechanism means a bug in D14 (failing to propagate an
  asset-level signal to an exposed market) doesn't just under-report — it can silently
  cap a position at `WATCH` when it should have corroborated into `DANGER`/`CRITICAL`.
  ADR 0002 already flagged D14 as load-bearing; this ADR sharpens exactly how.
