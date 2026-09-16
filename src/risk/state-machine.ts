import { D03_ID } from '../signals/D03_exit_coverage.js';
import type { SentinelConfig } from '../core/config.js';
import type { Signal, SignalFamily } from '../core/types.js';
import {
  riskLevelRank,
  severityRank,
  type ActionKind,
  type ActionRecommendation,
  type Decision,
  type PositionRiskState,
  type RiskLevel,
} from './types.js';

/**
 * The risk engine state machine (docs/SPEC.md #8.1). See ADR 0008 for the exact
 * algorithm this implements and the reasoning behind each rule — this file is the
 * implementation, that ADR is the design record.
 */

export interface DecideInput {
  positionId: string;
  /** The position's own market/vault id (`Position.marketId`) — signals scoped to
   * this market/vault, in addition to ones scoped to `positionId` directly, are
   * "relevant" (see ADR 0008's first bullet). */
  marketOrVaultId: string;
  /** Every signal from this evaluation pass — `decide()` filters internally, so
   * callers don't need to pre-filter (docs/adr/0002: a position only hears about
   * asset-level risk via D14's market-level projection, which this function relies
   * on but doesn't itself special-case). */
  signals: Signal[];
  state: PositionRiskState;
  now: Date;
  blockNumber: bigint;
  configHash: string;
  policy: SentinelConfig['policy'];
  killSwitchActive: boolean;
  /** Minimum time a de-escalating raw level must hold before the stored level
   * actually drops (ADR 0008). */
  dwellSeconds: number;
}

export interface DecideResult {
  state: PositionRiskState;
  decision: Decision;
}

function isRelevant(signal: Signal, positionId: string, marketOrVaultId: string): boolean {
  if (signal.subject.kind === 'position') return signal.subject.id === positionId;
  if (signal.subject.kind === 'market' || signal.subject.kind === 'vault') {
    return signal.subject.id === marketOrVaultId;
  }
  return false;
}

interface RawLevelResult {
  level: RiskLevel;
  rule: string;
}

/** Computes the corroboration-gated raw level from the relevant signal set — the
 * core of ADR 0008's corroboration rule. Exported for direct unit testing of this
 * piece in isolation from the rest of the state machine. */
export function computeRawLevel(relevant: Signal[]): RawLevelResult {
  const nonInfra = relevant.filter((s) => s.family !== 'infra');

  const standaloneCritical = nonInfra.find(
    (s) => s.standaloneCritical && s.severity === 'critical',
  );
  if (standaloneCritical) {
    return { level: 'CRITICAL', rule: `standalone-critical: ${standaloneCritical.detectorId}` };
  }

  const qualifying = nonInfra.filter((s) => severityRank(s.severity) >= severityRank('watch'));
  const families = new Set(qualifying.map((s) => s.family));

  const naiveLevel = severityToLevel(strongestSeverity(nonInfra));
  if (riskLevelRank(naiveLevel) <= riskLevelRank('WATCH')) {
    return {
      level: naiveLevel,
      rule: naiveLevel === 'NORMAL' ? 'no qualifying signals' : 'watch: no corroboration required',
    };
  }

  if (families.size >= 2) {
    return {
      level: naiveLevel,
      rule: `corroborated across ${families.size} families (${[...families].sort().join(', ')})`,
    };
  }

  const onlyFamily: SignalFamily | undefined = [...families][0];
  return {
    level: 'WATCH',
    rule: `single-family cap: ${onlyFamily ?? 'unknown'} only, no corroboration`,
  };
}

function strongestSeverity(signals: Signal[]): Signal['severity'] {
  let strongest: Signal['severity'] = 'info';
  for (const s of signals) {
    if (severityRank(s.severity) > severityRank(strongest)) strongest = s.severity;
  }
  return strongest;
}

function severityToLevel(severity: Signal['severity']): RiskLevel {
  switch (severity) {
    case 'critical':
      return 'CRITICAL';
    case 'danger':
      return 'DANGER';
    case 'watch':
      return 'WATCH';
    default:
      return 'NORMAL';
  }
}

/** Applies ADR 0008's hysteresis rule to move from the stored state toward
 * `rawLevel`. Exported for direct unit testing of the dwell-timer edge cases. */
export function applyHysteresis(
  state: PositionRiskState,
  rawLevel: RiskLevel,
  now: Date,
  dwellSeconds: number,
): PositionRiskState {
  const rawRank = riskLevelRank(rawLevel);
  const storedRank = riskLevelRank(state.level);

  const { pendingDeescalation: _pending, ...stateWithoutPending } = state;

  if (rawRank >= storedRank) {
    // Escalation (or staying put) always applies immediately — ADR 0008's
    // rate-of-change rule — and clears any de-escalation that was pending.
    const level = rawLevel;
    return { ...stateWithoutPending, level, since: level === state.level ? state.since : now };
  }

  // rawRank < storedRank: a de-escalation candidate.
  const pending = state.pendingDeescalation;
  if (!pending || pending.rawLevel !== rawLevel) {
    // New target (or first time going below) — (re)start the dwell timer, but the
    // stored level doesn't move yet.
    return { ...state, pendingDeescalation: { rawLevel, since: now } };
  }

  const dwelled = (now.getTime() - pending.since.getTime()) / 1000 >= dwellSeconds;
  if (!dwelled) return state; // still waiting, no change

  return { ...stateWithoutPending, level: rawLevel, since: now };
}

function computeAction(
  level: RiskLevel,
  policy: SentinelConfig['policy'],
  killSwitchActive: boolean,
): ActionRecommendation {
  if (level === 'NORMAL') return { kind: 'none' };

  const spec =
    level === 'WATCH' ? policy.watch : level === 'DANGER' ? policy.danger : policy.critical;
  const kind: ActionKind = spec?.action ?? 'alert';

  if (killSwitchActive && (kind === 'partial_withdraw' || kind === 'full_exit')) {
    return { kind: 'alert', suppressedByKillSwitch: true };
  }
  if (kind === 'partial_withdraw' && spec && 'fraction' in spec) {
    return { kind, fraction: spec.fraction };
  }
  return { kind };
}

export function decide(input: DecideInput): DecideResult {
  const relevant = input.signals.filter((s) =>
    isRelevant(s, input.positionId, input.marketOrVaultId),
  );

  const { level: computedRawLevel, rule: computedRule } = computeRawLevel(relevant);

  const forcedLevel = input.state.manualControls.forcedLevel;
  const afterHysteresis = applyHysteresis(
    input.state,
    computedRawLevel,
    input.now,
    input.dwellSeconds,
  );

  const nextState: PositionRiskState = forcedLevel
    ? {
        ...afterHysteresis,
        level: forcedLevel,
        since: afterHysteresis.level === forcedLevel ? afterHysteresis.since : input.now,
      }
    : afterHysteresis;

  const rule = forcedLevel
    ? `manually forced to ${forcedLevel} (raw: ${computedRule})`
    : computedRule;

  const action = computeAction(nextState.level, input.policy, input.killSwitchActive);
  const standingAlert = relevant.some((s) => s.detectorId === D03_ID);

  const decision: Decision = {
    positionId: input.positionId,
    at: input.now,
    blockNumber: input.blockNumber,
    previousLevel: input.state.level,
    level: nextState.level,
    rawLevel: computedRawLevel,
    signals: relevant,
    rule,
    action,
    standingAlert,
    configHash: input.configHash,
  };

  return { state: nextState, decision };
}
