import type { ScenarioScore } from './scoring.js';
import type { SyntheticScenarioResult } from './synthetic-scenario.js';

/**
 * Generates `docs/REPLAY_RESULTS.md` (docs/SPEC.md §9.3: "save a summary table...
 * and regenerate it whenever detectors or thresholds change"). Pure — takes already-
 * computed scores, no I/O of its own.
 */

function fmtSeconds(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.abs(seconds);
  if (abs < 3600) return `${sign}${(abs / 60).toFixed(0)}m`;
  if (abs < 86_400) return `${sign}${(abs / 3600).toFixed(1)}h`;
  return `${sign}${(abs / 86_400).toFixed(1)}d`;
}

function fmtPct(fraction: number | undefined): string {
  return fraction === undefined ? '—' : `${(fraction * 100).toFixed(1)}%`;
}

function incidentSection(score: Extract<ScenarioScore, { kind: 'incident' }>): string {
  const lead = (level: 'watch' | 'danger' | 'critical'): string => {
    const sample = score.leadTime[level];
    if (!sample) return '_never reached_';
    return sample.leadSeconds >= 0
      ? `${fmtSeconds(sample.leadSeconds)} before`
      : `${fmtSeconds(sample.leadSeconds)} (**after** — a miss)`;
  };

  return [
    `### ${score.scenarioId}`,
    '',
    `- Point of no return: ${score.pointOfNoReturnAt.toISOString()} (block ${score.pointOfNoReturnBlock})`,
    `- Lead time to WATCH: ${lead('watch')}`,
    `- Lead time to DANGER: ${lead('danger')}`,
    `- Lead time to CRITICAL: ${lead('critical')}`,
    `- Recoverable share at point of no return: ${fmtPct(score.recoverableShareAtPointOfNoReturn)}`,
    `- Final decision level: ${score.finalLevel}`,
    `- Gas spent: _not available — needs the withdrawal planner, Phase 7_`,
    `- Blocks sampled: ${score.blocksProcessed}`,
    '',
  ].join('\n');
}

function quietSection(score: Extract<ScenarioScore, { kind: 'quiet' }>): string {
  return [
    `### ${score.scenarioId}`,
    '',
    `- Duration: ${score.durationDays.toFixed(1)} days`,
    `- False alarms: ${score.falseAlarmCount}`,
    `- False alarms per week: ${score.falseAlarmsPerWeek.toFixed(2)}`,
    `- Blocks sampled: ${score.blocksProcessed}`,
    '',
  ].join('\n');
}

function syntheticSection(results: SyntheticScenarioResult[]): string {
  if (results.length === 0) return '_No synthetic fault-injection scenarios run._';
  const rows = results.map(
    (r) =>
      `| ${r.scenario.id} | ${r.scenario.expectedMinLevel} | ${r.decision.level} | ${r.passed ? 'PASS' : '**FAIL**'} |`,
  );
  return [
    '| Scenario | Expected min. level | Actual level | Result |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

export function generateReplayResultsMarkdown(
  scores: ScenarioScore[],
  syntheticResults: SyntheticScenarioResult[],
  generatedAt: Date,
): string {
  const incidents = scores.filter((s): s is Extract<ScenarioScore, { kind: 'incident' }> => s.kind === 'incident');
  const quiet = scores.filter((s): s is Extract<ScenarioScore, { kind: 'quiet' }> => s.kind === 'quiet');

  return [
    '# Replay results',
    '',
    `_Regenerated ${generatedAt.toISOString()} by \`sentinel replay\` (docs/SPEC.md §9.3) — regenerate whenever detectors or thresholds change, per that section's own instruction._`,
    '',
    '## Incident scenarios',
    '',
    incidents.length > 0 ? incidents.map(incidentSection).join('\n') : '_None run._',
    '## Quiet periods (false-alarm rate)',
    '',
    quiet.length > 0 ? quiet.map(quietSection).join('\n') : '_None run._',
    '## Synthetic fault-injection scenarios',
    '',
    syntheticSection(syntheticResults),
    '',
  ].join('\n');
}
