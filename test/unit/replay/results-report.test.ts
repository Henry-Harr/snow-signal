import { describe, expect, it } from 'vitest';

import { generateReplayResultsMarkdown } from '../../../src/replay/results-report.js';
import type { IncidentScore, QuietScore } from '../../../src/replay/scoring.js';
import type { SyntheticScenarioResult } from '../../../src/replay/synthetic-scenario.js';

function incidentScore(overrides: Partial<IncidentScore> = {}): IncidentScore {
  return {
    kind: 'incident',
    scenarioId: 'test-incident',
    pointOfNoReturnAt: new Date('2026-01-01T12:00:00.000Z'),
    pointOfNoReturnBlock: 100n,
    leadTime: {
      watch: { level: 'WATCH', at: new Date('2026-01-01T10:00:00.000Z'), leadSeconds: 7200 },
      danger: undefined,
      critical: undefined,
    },
    recoverableShareAtPointOfNoReturn: 0.5,
    finalLevel: 'WATCH',
    blocksProcessed: 10,
    gasSpentWei: undefined,
    ...overrides,
  };
}

function quietScore(overrides: Partial<QuietScore> = {}): QuietScore {
  return {
    kind: 'quiet',
    scenarioId: 'test-quiet',
    durationDays: 30,
    falseAlarmCount: 2,
    falseAlarmsPerWeek: 0.47,
    blocksProcessed: 100,
    ...overrides,
  };
}

describe('generateReplayResultsMarkdown', () => {
  it('renders incident and quiet sections with real figures', () => {
    const md = generateReplayResultsMarkdown([incidentScore(), quietScore()], [], new Date('2026-01-02T00:00:00.000Z'));
    expect(md).toContain('# Replay results');
    expect(md).toContain('test-incident');
    expect(md).toContain('50.0%'); // recoverable share
    expect(md).toContain('test-quiet');
    expect(md).toContain('0.47');
  });

  it('marks a lead time reached only after the point of no return as a miss', () => {
    const score = incidentScore({
      leadTime: {
        watch: undefined,
        danger: undefined,
        critical: { level: 'CRITICAL', at: new Date('2026-01-01T14:00:00.000Z'), leadSeconds: -7200 },
      },
    });
    const md = generateReplayResultsMarkdown([score], [], new Date());
    expect(md).toContain('after');
    expect(md).toContain('a miss');
  });

  it('never fabricates a gas figure', () => {
    const md = generateReplayResultsMarkdown([incidentScore()], [], new Date());
    expect(md).toContain('not available');
  });

  it('renders synthetic scenario pass/fail results', () => {
    const results: SyntheticScenarioResult[] = [
      {
        scenario: { id: 'utilization-spike', description: '', expectedMinLevel: 'WATCH', buildContext: () => ({ at: { chainId: 1, number: 0n, hash: '0x0', timestamp: 0 }, markets: [], assets: [], infra: [], priorSignals: [], assetExposure: {} }) },
        signals: [],
        decision: {
          positionId: 'p',
          at: new Date(),
          blockNumber: 0n,
          previousLevel: 'NORMAL',
          level: 'WATCH',
          rawLevel: 'WATCH',
          signals: [],
          rule: 'test',
          action: { kind: 'alert' },
          standingAlert: false,
          configHash: 'test',
        },
        passed: true,
      },
    ];
    const md = generateReplayResultsMarkdown([], results, new Date());
    expect(md).toContain('utilization-spike');
    expect(md).toContain('PASS');
  });

  it('renders a failures section only when there are failures', () => {
    const withFailures = generateReplayResultsMarkdown([], [], new Date(), [
      { scenarioPath: 'scenarios/broken.yaml', error: 'RPC rejected the range' },
    ]);
    expect(withFailures).toContain('Scenarios that failed to run');
    expect(withFailures).toContain('scenarios/broken.yaml');

    const withoutFailures = generateReplayResultsMarkdown([], [], new Date());
    expect(withoutFailures).not.toContain('Scenarios that failed to run');
  });
});
