import type { Signal, SignalSeverity } from '../core/types.js';

/**
 * Risk engine types (docs/SPEC.md #8.1, docs/ARCHITECTURE.md #5, docs/adr/0002). One
 * state-machine instance per **position** (spec's own wording, confirmed by ADR
 * 0002) — a specific (protocol, chain, market-or-vault, asset) the user holds
 * directly, matching `Position.id` (`src/core/types.ts`).
 */
export type RiskLevel = 'NORMAL' | 'WATCH' | 'DANGER' | 'CRITICAL';

export const RISK_LEVEL_ORDER: readonly RiskLevel[] = ['NORMAL', 'WATCH', 'DANGER', 'CRITICAL'];

export function riskLevelRank(level: RiskLevel): number {
  return RISK_LEVEL_ORDER.indexOf(level);
}

/** What the action policy (spec §8.2) recommends for the current level. Still just a
 * recommendation in Phase 5 — nothing in this phase actually withdraws anything; the
 * withdrawal planner (spec §8.3) is Phase 7. */
export type ActionKind = 'none' | 'alert' | 'partial_withdraw' | 'full_exit';

export interface ActionRecommendation {
  kind: ActionKind;
  /** Only present for `partial_withdraw`. */
  fraction?: number;
  /** `true` when the kill switch (docs/SPEC.md #8.4) suppressed a would-be
   * withdrawal action down to `alert` — kept visible in the record rather than
   * silently downgrading, so a report/audit can tell "nothing needed doing" apart
   * from "something needed doing and the kill switch stopped it." */
  suppressedByKillSwitch?: boolean;
}

/** Per-position manual controls (spec §8.1 "acknowledge, mute for a set duration,
 * force a level") — persisted so they survive a restart (docs/ARCHITECTURE.md #2,
 * "idempotent and restartable"). The global kill switch (spec §8.4) is *not* here —
 * it's one flag for the whole system, not per position (`GlobalControls` below). */
export interface ManualControls {
  /** Sustained until explicitly re-acked on a new decision — see `decide()`'s doc
   * comment for exactly when an ack is considered "consumed." */
  ackedDecisionId?: string;
  /** Notifications are suppressed until this time; the state machine and
   * `DecisionRecord`s are unaffected (docs/THREAT_MODEL.md: "/ack and /mute suppress
   * notification noise, not the underlying DecisionRecords"). */
  mutedUntil?: Date;
  /** Overrides the computed level entirely until cleared — spec's "force a level." */
  forcedLevel?: RiskLevel;
}

export interface PositionRiskState {
  positionId: string;
  level: RiskLevel;
  /** When the current `level` was entered. */
  since: Date;
  /** The raw (pre-hysteresis) level computed from the latest signals, and when that
   * reading first differed from `level` — tracks the de-escalation dwell timer.
   * `undefined` when `rawLevel === level` (nothing pending). */
  pendingDeescalation?: { rawLevel: RiskLevel; since: Date };
  manualControls: ManualControls;
}

export function initialPositionRiskState(positionId: string, now: Date): PositionRiskState {
  return { positionId, level: 'NORMAL', since: now, manualControls: {} };
}

/** One global flag, not per-position (spec §8.4: "a global kill switch for
 * execution"). Only ever *suppresses* actions down to `alert` — never itself causes
 * an action, and clearing it requires an explicit, separate step (spec: "re-enabling
 * requires the CLI with an explicit confirmation") — that CLI-confirmation flow is
 * Phase 8 (gated behind live execution existing at all); this phase only implements
 * the flag itself and the Telegram `/kill` command that can set (never clear) it. */
export interface GlobalControls {
  killSwitchActive: boolean;
}

export const DEFAULT_GLOBAL_CONTROLS: GlobalControls = { killSwitchActive: false };

/** Hysteresis dwell time (ADR 0008) — not yet configurable in `sentinel.yaml` and not
 * yet backed by replay-harness evidence for a different value (safety rule 8: "a
 * single day of results is never enough"). One hour is a reasonable starting point.
 * Shared by `sentinel watch` (`src/cli/watch.ts`) and the replay engine
 * (`src/replay/runner.ts`) so both exercise the same dwell behavior — a scenario
 * result is only meaningful as "what would a real run have done" if it uses the same
 * constants a real run does. Revisit via `docs/TUNING_LOG.md` once Phase 6 exists (it
 * does now — see docs/PROGRESS.md's Known Issues for why threshold/dwell tuning still
 * can't actually be *applied* yet). */
export const DEFAULT_DWELL_SECONDS = 3600;

/** Explainable decision log (spec §5.1, §8.1: "every transition writes a
 * DecisionRecord containing the inputs, detector outputs, the rule that fired, block
 * numbers, and the config hash"). Written on every `decide()` call, not just on a
 * level *change* — an unchanged-level decision is still evidence of what was
 * evaluated and why nothing moved (docs/ARCHITECTURE.md #2: append-only).
 *
 * Deliberately has **no `id` field** — `decide()` is a pure function (spec §8.1's
 * determinism invariant: "the same inputs always produce the same decision"), and an
 * app-generated id (`generateId`, timestamp + random) would make its output
 * non-repeatable for reasons that have nothing to do with the decision itself. The
 * id is assigned by whoever persists a `Decision` (the storage repository, using
 * SQLite's own `AUTOINCREMENT`, the same pattern every other table in this codebase
 * already uses) — see `DecisionRecordRow` in `src/storage/decision-record-repository.ts`. */
export interface Decision {
  positionId: string;
  at: Date;
  blockNumber: bigint;
  previousLevel: RiskLevel;
  level: RiskLevel;
  /** The level `decide()` computed from signals alone, before hysteresis/manual
   * overrides were applied — lets a report distinguish "the market got better" from
   * "a human forced this down." */
  rawLevel: RiskLevel;
  /** Every signal considered for this position this evaluation (already pre-filtered
   * to ones whose `subject` matches this position/its market — see `decide()`'s doc
   * comment). */
  signals: Signal[];
  /** Which rule actually produced `rawLevel` — human-readable, e.g.
   * `"corroborated across 2 families"`, `"standalone-critical: D11_bad_debt"`,
   * `"single-family cap: pool_flow only"`. */
  rule: string;
  action: ActionRecommendation;
  /** Set when this decision's evaluation also satisfied the "standing rule" (spec
   * §8.2: alert whenever a position exceeds a configured share of its pool's
   * available liquidity, i.e. a D03 signal fired) — an unconditional alert that
   * bypasses corroboration, tracked separately from `action` since it can be true
   * even when the position's own level is still `NORMAL`. */
  standingAlert: boolean;
  configHash: string;
}

/** The highest severity present, or `undefined` for an empty array — a small shared
 * helper since several places need "worst signal" without needing the full
 * corroboration logic `state-machine.ts` implements. */
const SEVERITY_ORDER: readonly SignalSeverity[] = ['info', 'watch', 'danger', 'critical'];

export function severityRank(severity: SignalSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}
