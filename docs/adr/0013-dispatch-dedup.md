# 0013: Notification dispatch dedup — only re-alert on real change

## Context

Found 2026-09-18, the user's first real production deployment: `src/core/pipeline.ts`
dispatched a notification on **every poll** for which the decision level was anything
other than `NORMAL` (or `standingAlert` was set) — not just when the decision actually
changed. Combined with ADR 0008's de-escalation dwell timer (a position can sit at a
stale `WATCH` for up to an hour after its raw signals have genuinely cleared, waiting
out the dwell window before the stored level catches up), this meant a position could
receive a near-identical "still WATCH" alert on literally every poll interval — the
user observed this directly, pasting repeated `Rule: no qualifying signals` alerts a
few minutes apart, all for the same still-WATCH position.

Safety-relevant framing: this is a notification problem, not a decision problem —
`decide()`, `DecisionRecordRepository`, and the risk state machine's own correctness
(ADR 0008) are entirely unaffected and unchanged. Every decision is still recorded on
every poll, exactly as before; only whether the notifier is actually invoked for that
decision changes.

## Decision

`computeDispatchDedup(decision, priorLastNotifiedSignalKey)` (`src/core/pipeline.ts`,
pure, directly unit-tested) decides whether a given `Decision` is worth dispatching:

- **Always notify on a level change**, in either direction — including recovering
  toward `NORMAL` (that path is still separately gated by the pre-existing
  `level === 'NORMAL' && !standingAlert` skip, unchanged by this ADR) and any
  escalation or de-escalation step.
- **Always notify when `standingAlert` is set** — D03's existing "keep reminding
  regardless" mechanic (ADR 0008) is left completely untouched by this dedup rule.
- **Otherwise, notify only if the *set* of contributing detector ids differs from the
  set that drove the most recently *dispatched* alert for this position** (sorted,
  comma-joined detector ids — order-independent, family-independent). A brand new
  detector joining the picture (e.g. a governance-family signal appearing on a
  position already sitting at `WATCH` from a pool-flow one) is real, actionable new
  information and always dispatches, even though the level itself didn't move.
- **A poll with no qualifying signals at all is never itself grounds to notify**, and
  deliberately does **not** overwrite the remembered signal key — a quiet lull
  between two occurrences of the *same* detector (it fires, briefly clears during the
  dwell window, then fires again) is treated as a continuation, not two separate
  events worth two separate pings. Only a poll that actually gets dispatched updates
  the remembered key.

The remembered key lives on `PositionRiskState.lastNotifiedSignalKey` (migration 12,
`src/storage/migrations.ts`) — persisted the same way every other piece of per-position
state already is (idempotent/restartable, ADR 0008's own framing), not a separate
notifier-side cache that would lose its memory on every restart.

## Alternatives considered

- **Strict transition-only** (dispatch only when `level` itself changes, nothing else):
  rejected — this would have silently swallowed the exact governance-change alert
  (D12) the user specifically confirmed was worth reading, purely because the position
  happened to already be sitting at `WATCH` from an unrelated pool-flow signal at the
  time. Losing a genuinely new signal because the *level* didn't move is a worse
  failure mode than some residual, still-real noise.
- **Compare against the immediately preceding poll's decision** (no persisted memory,
  just look at the last `decision_records` row) rather than "the last *dispatched*
  decision": rejected after tracing through the actual noise pattern — this doesn't
  correctly dedup a detector that flickers on, briefly clears during a dwell window,
  then re-fires; comparing only to the immediately preceding poll would treat the
  "cleared" poll as a real change and then treat the re-firing as *another* real
  change, re-notifying twice for what's really one ongoing condition.
- **A periodic "still elevated" heartbeat** (re-notify every N minutes while sustained
  non-`NORMAL`, in addition to change-driven alerts): not implemented — real added
  complexity (tracking a last-notified timestamp, choosing an interval) for a need
  that isn't yet demonstrated; the daily report already gives a periodic, lower-noise
  summary of standing state. Revisit if losing "yep it's still there" reassurance
  between real changes turns out to matter in practice.

## Consequences

- A position that never changes which detector(s) are firing, and never changes
  level, now sends exactly one notification (the initial transition) instead of one
  per poll for as long as the condition persists — this is the entire point.
- `decision_records` remains a complete, unedited history regardless of dispatch
  dedup — `sentinel report`/`findSince` and anything reading the decision log directly
  sees every poll's decision exactly as before; only the notifier's own behavior
  changed.
- A bug in this dedup logic fails in the safe direction for `standingAlert` and level
  changes (both always bypass it unconditionally), so the failure mode of a defect
  here is "too many notifications," never "a real escalation goes unreported."
