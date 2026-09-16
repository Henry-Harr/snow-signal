import { describe, expect, it } from 'vitest';

import { generateDailyReport } from '../../../src/reports/daily-report.js';
import type { DailyReportInput } from '../../../src/reports/types.js';
import { dataQuality, decisionRecord, position } from './helpers.js';

function baseInput(overrides: Partial<DailyReportInput> = {}): DailyReportInput {
  return {
    date: '2026-01-01',
    generatedAt: new Date('2026-01-02T00:00:00Z'),
    positions: [position()],
    decisions: [],
    labels: new Map(),
    dataQuality: [dataQuality()],
    exitDrillResults: [],
    gasSpentWei: 0n,
    ...overrides,
  };
}

describe('generateDailyReport', () => {
  it('lists positions with balance, supply APR, and benchmark comparison', () => {
    const report = generateDailyReport(baseInput());
    expect(report.markdown).toContain('aave-v3:ethereum:core:USDC');
    expect(report.markdown).toContain('1000.000000 USDC');
    expect(report.markdown).toContain('4.50%');
    expect(report.json['positions']).toEqual([
      expect.objectContaining({ positionId: 'aave-v3:ethereum:core:USDC', balance: '1000000000' }),
    ]);
  });

  it('shows "no benchmark reading" when the benchmark is unavailable, rather than a misleading number', () => {
    const report = generateDailyReport(
      baseInput({ positions: [position({ benchmarkApr: undefined })] }),
    );
    expect(report.markdown).toContain('no benchmark reading');
  });

  it('reports "no alerts" and "no transitions" when every decision stayed at NORMAL', () => {
    const report = generateDailyReport(
      baseInput({
        decisions: [decisionRecord({ previousLevel: 'NORMAL', level: 'NORMAL', standingAlert: false })],
      }),
    );
    expect(report.markdown).toContain('No alerts today');
    expect(report.markdown).toContain('No state transitions today');
  });

  it('includes an alert for any decision above NORMAL, with its signals and evidence', () => {
    const report = generateDailyReport(baseInput({ decisions: [decisionRecord()] }));
    expect(report.markdown).toContain('decision #1');
    expect(report.markdown).toContain('D01_utilization_level');
    expect(report.markdown).toContain('value=0.91');
    expect(report.json['alerts']).toHaveLength(1);
  });

  it('includes a standingAlert decision as an alert even when the level is NORMAL', () => {
    const report = generateDailyReport(
      baseInput({
        decisions: [decisionRecord({ level: 'NORMAL', previousLevel: 'NORMAL', standingAlert: true })],
      }),
    );
    expect(report.markdown).not.toContain('No alerts today');
    expect((report.json['alerts'] as unknown[]).length).toBe(1);
  });

  it('shows the current label when one exists, and "_unlabeled_" otherwise', () => {
    const labeled = generateDailyReport(
      baseInput({
        decisions: [decisionRecord()],
        labels: new Map([[1, { decisionId: 1, label: 'false_positive', labeledAt: new Date() }]]),
      }),
    );
    expect(labeled.markdown).toContain('**false_positive**');

    const unlabeled = generateDailyReport(baseInput({ decisions: [decisionRecord()] }));
    expect(unlabeled.markdown).toContain('_unlabeled_');
  });

  it('lists a state transition separately from an alert with no level change', () => {
    const report = generateDailyReport(
      baseInput({ decisions: [decisionRecord({ previousLevel: 'WATCH', level: 'DANGER' })] }),
    );
    expect(report.markdown).toContain('WATCH -> DANGER');
    expect(report.json['transitions']).toHaveLength(1);
  });

  it('lists a planned withdrawal action and always reports gas spent as 0 (execution mode off)', () => {
    const report = generateDailyReport(
      baseInput({
        decisions: [decisionRecord({ action: { kind: 'partial_withdraw', fraction: 0.5 } })],
        gasSpentWei: 0n,
      }),
    );
    expect(report.markdown).toContain('partial withdrawal (50%)');
    expect(report.markdown).toContain('not executed');
    expect(report.markdown).toContain('Gas spent: 0 wei');
  });

  it('states nothing is held to drill when no results are given', () => {
    const report = generateDailyReport(baseInput());
    expect(report.markdown).toContain('No positions currently held — nothing to drill');
  });

  it('renders exit drill results when present', () => {
    const report = generateDailyReport(
      baseInput({
        exitDrillResults: [
          { positionId: 'p1', passed: true, gasEstimate: 21_000n, estimatedBlocksToExit: 0 },
        ],
      }),
    );
    expect(report.markdown).toContain('pass');
    expect(report.markdown).toContain('21000');
  });

  it('reports "not tracked" for provider uptime when unavailable, not a misleading 0%', () => {
    const report = generateDailyReport(
      baseInput({ dataQuality: [dataQuality({ providerUptime: undefined })] }),
    );
    expect(report.markdown).toContain('not tracked');
  });

  it('produces JSON-serializable output (bigints stringified) without throwing', () => {
    const report = generateDailyReport(
      baseInput({
        decisions: [decisionRecord()],
        exitDrillResults: [{ positionId: 'p1', passed: true, gasEstimate: 1n, estimatedBlocksToExit: 1 }],
      }),
    );
    expect(() => JSON.stringify(report.json)).not.toThrow();
  });
});
