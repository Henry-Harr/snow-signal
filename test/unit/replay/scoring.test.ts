import { describe, expect, it } from 'vitest';

import { scoreIncident, scoreQuiet } from '../../../src/replay/scoring.js';
import type { ReplayRunResult } from '../../../src/replay/runner.js';
import type { ReplayScenario } from '../../../src/replay/scenario.js';
import type { DecisionRecord } from '../../../src/storage/decision-record-repository.js';

function scenario(overrides: Partial<ReplayScenario> = {}): ReplayScenario {
  return {
    id: 'test-scenario',
    description: 'test',
    kind: 'incident',
    chain: 'ethereum',
    chainId: 1,
    position: { protocol: 'aave-v3', market: 'core', asset: 'USDC' },
    blockRange: { from: 100n, to: 200n },
    sampleIntervalBlocks: 10n,
    simulatedPositionBalanceRaw: '1000000000',
    groundTruth: [
      { at: '2026-01-01T12:00:00.000Z', blockNumber: 150n, description: 'poNR', pointOfNoReturn: true },
    ],
    sources: [{ url: 'https://example.com', note: 'test' }],
    ...overrides,
  };
}

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 1,
    positionId: 'aave-v3:ethereum:core:USDC',
    at: new Date('2026-01-01T10:00:00.000Z'),
    blockNumber: 120n,
    previousLevel: 'NORMAL',
    level: 'WATCH',
    rawLevel: 'WATCH',
    signals: [],
    rule: 'test',
    action: { kind: 'alert' },
    standingAlert: false,
    configHash: 'test',
    ...overrides,
  };
}

describe('scoreIncident', () => {
  it('computes positive lead time for a level reached before the point of no return', () => {
    const s = scenario();
    const result: ReplayRunResult = {
      scenario: s,
      decisions: [decision({ level: 'WATCH', at: new Date('2026-01-01T10:00:00.000Z') })],
      withdrawable: [],
      blocksProcessed: 5,
    };
    const score = scoreIncident(s, result);
    expect(score.leadTime.watch?.leadSeconds).toBe(2 * 3600); // 2 hours before poNR
    expect(score.leadTime.danger).toBeUndefined();
    expect(score.leadTime.critical).toBeUndefined();
  });

  it('computes negative lead time when a level was only reached after the point of no return', () => {
    const s = scenario();
    const result: ReplayRunResult = {
      scenario: s,
      decisions: [decision({ level: 'CRITICAL', at: new Date('2026-01-01T14:00:00.000Z') })],
      withdrawable: [],
      blocksProcessed: 5,
    };
    const score = scoreIncident(s, result);
    expect(score.leadTime.critical?.leadSeconds).toBe(-2 * 3600); // 2 hours too late
  });

  it('picks the withdrawable sample at or nearest-before the point of no return block', () => {
    const s = scenario();
    const result: ReplayRunResult = {
      scenario: s,
      decisions: [],
      withdrawable: [
        { blockNumber: 100n, availableNow: 1_000_000_000n, totalPosition: 1_000_000_000n },
        { blockNumber: 140n, availableNow: 500_000_000n, totalPosition: 1_000_000_000n },
        { blockNumber: 160n, availableNow: 0n, totalPosition: 1_000_000_000n }, // after poNR (150) — ignored
      ],
      blocksProcessed: 3,
    };
    const score = scoreIncident(s, result);
    expect(score.recoverableShareAtPointOfNoReturn).toBe(0.5); // the block-140 sample
  });

  it('reports undefined recoverable share when no sample exists at or before the point of no return', () => {
    const s = scenario();
    const result: ReplayRunResult = { scenario: s, decisions: [], withdrawable: [], blocksProcessed: 0 };
    const score = scoreIncident(s, result);
    expect(score.recoverableShareAtPointOfNoReturn).toBeUndefined();
  });

  it('reports the final decision level and never fabricates a gas figure', () => {
    const s = scenario();
    const result: ReplayRunResult = {
      scenario: s,
      decisions: [decision({ level: 'WATCH' }), decision({ level: 'CRITICAL' })],
      withdrawable: [],
      blocksProcessed: 2,
    };
    const score = scoreIncident(s, result);
    expect(score.finalLevel).toBe('CRITICAL');
    expect(score.gasSpentWei).toBeUndefined();
  });

  it('throws for a scenario missing a pointOfNoReturn event', () => {
    const s = scenario({ groundTruth: [] });
    const result: ReplayRunResult = { scenario: s, decisions: [], withdrawable: [], blocksProcessed: 0 };
    expect(() => scoreIncident(s, result)).toThrow(/pointOfNoReturn/);
  });
});

describe('scoreQuiet', () => {
  it('computes a false-alarm-per-week rate from non-NORMAL decisions', () => {
    // 10,080 blocks at 12s/block = 33.6 hours ≈ 1.4 days
    const s = scenario({ kind: 'quiet', blockRange: { from: 0n, to: 10_080n }, groundTruth: [] });
    const result: ReplayRunResult = {
      scenario: s,
      decisions: [decision({ level: 'WATCH' }), decision({ level: 'NORMAL' })],
      withdrawable: [],
      blocksProcessed: 2,
    };
    const score = scoreQuiet(s, result);
    expect(score.falseAlarmCount).toBe(1);
    expect(score.durationDays).toBeCloseTo(1.4, 1);
    expect(score.falseAlarmsPerWeek).toBeCloseTo(5, 0);
  });

  it('counts a standing alert at NORMAL as a false alarm too', () => {
    const s = scenario({ kind: 'quiet', groundTruth: [] });
    const result: ReplayRunResult = {
      scenario: s,
      decisions: [decision({ level: 'NORMAL', standingAlert: true })],
      withdrawable: [],
      blocksProcessed: 1,
    };
    const score = scoreQuiet(s, result);
    expect(score.falseAlarmCount).toBe(1);
  });

  it('reports zero false alarms for an all-NORMAL run', () => {
    const s = scenario({ kind: 'quiet', groundTruth: [] });
    const result: ReplayRunResult = {
      scenario: s,
      decisions: [decision({ level: 'NORMAL' }), decision({ level: 'NORMAL' })],
      withdrawable: [],
      blocksProcessed: 2,
    };
    const score = scoreQuiet(s, result);
    expect(score.falseAlarmCount).toBe(0);
    expect(score.falseAlarmsPerWeek).toBe(0);
  });
});
