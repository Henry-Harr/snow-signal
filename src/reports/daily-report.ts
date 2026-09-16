import type {
  DailyReport,
  DailyReportInput,
  DataQualitySummary,
  ExitDrillResult,
  PositionSummary,
} from './types.js';
import type { DecisionRecord } from '../storage/decision-record-repository.js';

/**
 * The daily report generator (docs/SPEC.md #10.2). Pure — everything it needs is in
 * `DailyReportInput`, assembled by the pipeline from storage. Generates both the
 * markdown (`reports/YYYY-MM-DD.md`) and JSON (`reports/YYYY-MM-DD.json`) forms from
 * one pass over the same data, so the two never drift apart.
 *
 * **What's genuinely available vs. still a placeholder**, stated plainly rather than
 * silently omitted: positions/balances/state-transitions/alerts/actions-planned all
 * come from real stored data. Gas spent is always `0` while execution mode is `off`
 * (nothing has signed a transaction) — paper mode's simulated gas isn't summed into
 * this total yet (see `docs/PROGRESS.md`); the exit drill's own per-position gas
 * estimates (spec §8.6, `src/actions/exit-drill.ts`) are real, live fork-simulation
 * results, not a placeholder. Provider uptime tracking
 * (`DataQualitySummary.providerUptime`) isn't persisted as a running counter yet
 * either; when `undefined`, the report says so instead of showing a misleading `0%`.
 */
function isAlert(decision: DecisionRecord): boolean {
  return decision.level !== 'NORMAL' || decision.standingAlert;
}

function isTransition(decision: DecisionRecord): boolean {
  return decision.level !== decision.previousLevel;
}

function fmtBalance(balance: bigint, decimals: number): string {
  const negative = balance < 0n;
  const abs = negative ? -balance : balance;
  const s = abs.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals) || '0';
  const frac = decimals > 0 ? '.' + s.slice(s.length - decimals) : '';
  return (negative ? '-' : '') + whole + frac;
}

function fmtPct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

function positionsSection(positions: PositionSummary[]): string {
  if (positions.length === 0) return '_No positions configured._';
  const rows = positions.map((p) => {
    const balanceText = `${fmtBalance(p.balance, p.balanceDecimals)} ${p.assetSymbol}`;
    const benchmarkText =
      p.benchmarkApr === undefined
        ? '_no benchmark reading_'
        : `${fmtPct(p.benchmarkApr)} (${p.benchmarkAprLabel}), delta ${fmtPct(p.supplyRateApr - p.benchmarkApr)}`;
    return `| ${p.positionId} | ${p.protocol} | ${p.chainId} | ${balanceText} | ${fmtPct(p.supplyRateApr)} | ${benchmarkText} |`;
  });
  return [
    '| Position | Protocol | Chain | Balance | Supply APR | vs. benchmark |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function alertsSection(
  alerts: DecisionRecord[],
  labels: DailyReportInput['labels'],
): string {
  if (alerts.length === 0) return '_No alerts today._';
  return alerts
    .map((d) => {
      const label = labels.get(d.id);
      const labelText = label ? `**${label.label}**${label.notes ? ` — ${label.notes}` : ''}` : '_unlabeled_';
      const signalLines = d.signals
        .map((s) => `  - ${s.detectorId} [${s.family}] ${s.severity}: value=${s.value} threshold=${s.threshold}`)
        .join('\n');
      return (
        `### ${d.at.toISOString()} — ${d.positionId} (decision #${d.id})\n` +
        `- Level: ${d.previousLevel} -> ${d.level} (raw: ${d.rawLevel})\n` +
        `- Rule: ${d.rule}\n` +
        `- Standing alert: ${d.standingAlert}\n` +
        `- Label: ${labelText}\n` +
        (signalLines ? `- Signals:\n${signalLines}\n` : '')
      );
    })
    .join('\n');
}

function transitionsSection(transitions: DecisionRecord[]): string {
  if (transitions.length === 0) return '_No state transitions today._';
  const rows = transitions.map(
    (d) => `| ${d.at.toISOString()} | ${d.positionId} | ${d.previousLevel} -> ${d.level} | #${d.id} |`,
  );
  return ['| At | Position | Transition | Decision |', '|---|---|---|---|', ...rows].join('\n');
}

function actionsSection(decisions: DecisionRecord[], gasSpentWei: bigint): string {
  const actioned = decisions.filter((d) => d.action.kind !== 'none' && d.action.kind !== 'alert');
  const lines: string[] = [];
  if (actioned.length === 0) {
    lines.push('_No withdrawal actions were planned today._');
  } else {
    for (const d of actioned) {
      const detail =
        d.action.kind === 'partial_withdraw'
          ? `partial withdrawal (${((d.action.fraction ?? 0) * 100).toFixed(0)}%)`
          : 'full exit';
      lines.push(`- ${d.positionId} (#${d.id}): ${detail} planned — not executed (execution mode off)`);
    }
  }
  lines.push('', `Gas spent: ${gasSpentWei} wei`);
  return lines.join('\n');
}

function exitDrillSection(results: ExitDrillResult[]): string {
  if (results.length === 0) {
    return '_No positions currently held — nothing to drill._';
  }
  const rows = results.map(
    (r) =>
      `| ${r.positionId} | ${r.passed ? 'pass' : 'FAIL'} | ${r.gasEstimate ?? '—'} | ${r.estimatedBlocksToExit ?? '—'} |`,
  );
  return ['| Position | Result | Gas estimate | Blocks to exit |', '|---|---|---|---|', ...rows].join('\n');
}

function dataQualitySection(dataQuality: DataQualitySummary[]): string {
  if (dataQuality.length === 0) return '_No data quality metrics recorded._';
  const rows = dataQuality.map(
    (d) =>
      `| ${d.chainId} | ${d.providerUptime === undefined ? 'not tracked' : fmtPct(d.providerUptime)} | ${d.averageHeadLagBlocks.toFixed(1)} | ${d.disagreementCount} | ${d.staleSourceCount} |`,
  );
  return [
    '| Chain | Provider uptime | Avg head lag (blocks) | Disagreements | Stale sources |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function decisionToJson(d: DecisionRecord, labels: DailyReportInput['labels']) {
  const label = labels.get(d.id);
  return {
    id: d.id,
    positionId: d.positionId,
    at: d.at.toISOString(),
    blockNumber: d.blockNumber.toString(),
    previousLevel: d.previousLevel,
    level: d.level,
    rawLevel: d.rawLevel,
    rule: d.rule,
    standingAlert: d.standingAlert,
    action: d.action,
    signals: d.signals,
    label: label ? { label: label.label, notes: label.notes } : null,
  };
}

export function generateDailyReport(input: DailyReportInput): DailyReport {
  const alerts = input.decisions.filter(isAlert);
  const transitions = input.decisions.filter(isTransition);

  const markdown = [
    `# Daily report — ${input.date}`,
    '',
    `_Generated ${input.generatedAt.toISOString()}_`,
    '',
    '## Positions',
    '',
    positionsSection(input.positions),
    '',
    '## Alerts',
    '',
    alertsSection(alerts, input.labels),
    '',
    '## State transitions',
    '',
    transitionsSection(transitions),
    '',
    '## Actions',
    '',
    actionsSection(input.decisions, input.gasSpentWei),
    '',
    '## Exit drill',
    '',
    exitDrillSection(input.exitDrillResults),
    '',
    '## Data quality',
    '',
    dataQualitySection(input.dataQuality),
    '',
  ].join('\n');

  const json = {
    date: input.date,
    generatedAt: input.generatedAt.toISOString(),
    positions: input.positions.map((p) => ({ ...p, balance: p.balance.toString() })),
    alerts: alerts.map((d) => decisionToJson(d, input.labels)),
    transitions: transitions.map((d) => decisionToJson(d, input.labels)),
    actions: input.decisions
      .filter((d) => d.action.kind !== 'none' && d.action.kind !== 'alert')
      .map((d) => decisionToJson(d, input.labels)),
    gasSpentWei: input.gasSpentWei.toString(),
    exitDrillResults: input.exitDrillResults.map((r) => ({
      ...r,
      gasEstimate: r.gasEstimate?.toString(),
    })),
    dataQuality: input.dataQuality,
  };

  return { markdown, json };
}
