import type { ReplayRunResult } from './runner.js';
import type { ReplayScenario } from './scenario.js';
import { riskLevelRank, type RiskLevel } from '../risk/types.js';

/**
 * Replay scoring (docs/SPEC.md §9.3): "for each scenario, report: lead time,
 * recoverable share, false alarms per week, gas." Pure functions over a
 * `ReplayRunResult` (`src/replay/runner.ts`) — no I/O, so scoring logic is testable
 * without a real replay run.
 */

export interface LeadTimeSample {
  level: RiskLevel;
  at: Date;
  /** Positive: Sentinel reached this level this many seconds *before* the point of
   * no return (a real lead time). Negative: it reached this level *after* — too
   * late to have mattered. */
  leadSeconds: number;
}

export interface IncidentScore {
  kind: 'incident';
  scenarioId: string;
  pointOfNoReturnAt: Date;
  pointOfNoReturnBlock: bigint;
  /** First time each level was reached, if ever, and the lead time before the point
   * of no return — `undefined` for a level the scenario never reached at all (a
   * miss, not just a late reaction). */
  leadTime: {
    watch: LeadTimeSample | undefined;
    danger: LeadTimeSample | undefined;
    critical: LeadTimeSample | undefined;
  };
  /** Fraction (0-1) of the simulated position that was actually withdrawable at the
   * last sampled block at or before the point of no return — `undefined` if no
   * sample exists at or before it (the scenario's block range starts after the point
   * of no return, a scenario-authoring error). */
  recoverableShareAtPointOfNoReturn: number | undefined;
  finalLevel: RiskLevel;
  blocksProcessed: number;
  /** Always `undefined` in Phase 6 — a real gas figure needs the withdrawal planner
   * (Phase 7), which doesn't exist yet. Kept as an explicit field (rather than
   * omitted) so the score's shape already matches what spec §9.3 asks for, with the
   * gap stated plainly instead of silently missing. */
  gasSpentWei: undefined;
}

export interface QuietScore {
  kind: 'quiet';
  scenarioId: string;
  durationDays: number;
  /** Every decision that was an alert (non-NORMAL level, or a standing alert) —
   * by definition a false alarm, since a quiet scenario has no real incident. */
  falseAlarmCount: number;
  falseAlarmsPerWeek: number;
  blocksProcessed: number;
}

export type ScenarioScore = IncidentScore | QuietScore;

function findFirstAtLeast(
  decisions: ReplayRunResult['decisions'],
  level: RiskLevel,
): { at: Date } | undefined {
  return decisions.find((d) => riskLevelRank(d.level) >= riskLevelRank(level));
}

function leadTimeSample(
  decisions: ReplayRunResult['decisions'],
  level: RiskLevel,
  pointOfNoReturnAt: Date,
): LeadTimeSample | undefined {
  const first = findFirstAtLeast(decisions, level);
  if (!first) return undefined;
  const leadSeconds = (pointOfNoReturnAt.getTime() - first.at.getTime()) / 1000;
  return { level, at: first.at, leadSeconds };
}

export function scoreIncident(scenario: ReplayScenario, result: ReplayRunResult): IncidentScore {
  const pointOfNoReturn = scenario.groundTruth.find((e) => e.pointOfNoReturn);
  if (!pointOfNoReturn) {
    throw new Error(`${scenario.id}: incident scenarios must have a pointOfNoReturn event`);
  }
  const pointOfNoReturnAt = new Date(pointOfNoReturn.at);

  const sortedByBlock = [...result.withdrawable].sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
  );
  const atOrBefore = sortedByBlock.filter((w) => w.blockNumber <= pointOfNoReturn.blockNumber);
  const nearestSample = atOrBefore[atOrBefore.length - 1];
  const recoverableShareAtPointOfNoReturn =
    nearestSample && nearestSample.totalPosition > 0n
      ? Number(nearestSample.availableNow) / Number(nearestSample.totalPosition)
      : undefined;

  const finalLevel = result.decisions[result.decisions.length - 1]?.level ?? 'NORMAL';

  return {
    kind: 'incident',
    scenarioId: scenario.id,
    pointOfNoReturnAt,
    pointOfNoReturnBlock: pointOfNoReturn.blockNumber,
    leadTime: {
      watch: leadTimeSample(result.decisions, 'WATCH', pointOfNoReturnAt),
      danger: leadTimeSample(result.decisions, 'DANGER', pointOfNoReturnAt),
      critical: leadTimeSample(result.decisions, 'CRITICAL', pointOfNoReturnAt),
    },
    recoverableShareAtPointOfNoReturn,
    finalLevel,
    blocksProcessed: result.blocksProcessed,
    gasSpentWei: undefined,
  };
}

export function scoreQuiet(scenario: ReplayScenario, result: ReplayRunResult): QuietScore {
  const durationSeconds =
    Number(scenario.blockRange.to - scenario.blockRange.from) *
    (scenario.chain === 'base' ? 2 : 12); // rough per-chain block time, same estimate src/core/pipeline.ts uses
  const durationDays = durationSeconds / 86_400;

  const falseAlarmCount = result.decisions.filter(
    (d) => d.level !== 'NORMAL' || d.standingAlert,
  ).length;
  const falseAlarmsPerWeek = durationDays > 0 ? (falseAlarmCount / durationDays) * 7 : 0;

  return {
    kind: 'quiet',
    scenarioId: scenario.id,
    durationDays,
    falseAlarmCount,
    falseAlarmsPerWeek,
    blocksProcessed: result.blocksProcessed,
  };
}

export function scoreScenario(scenario: ReplayScenario, result: ReplayRunResult): ScenarioScore {
  return scenario.kind === 'incident'
    ? scoreIncident(scenario, result)
    : scoreQuiet(scenario, result);
}
