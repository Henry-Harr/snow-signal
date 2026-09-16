import type { DecisionRecord } from '../../../src/storage/decision-record-repository.js';
import type { DataQualitySummary, PositionSummary } from '../../../src/reports/types.js';

export function position(overrides: Partial<PositionSummary> = {}): PositionSummary {
  return {
    positionId: 'aave-v3:ethereum:core:USDC',
    protocol: 'aave-v3',
    chainId: 1,
    asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    assetSymbol: 'USDC',
    balance: 1_000_000_000n,
    balanceDecimals: 6,
    supplyRateApr: 0.045,
    benchmarkAprLabel: 'pool base rate',
    benchmarkApr: 0.04,
    ...overrides,
  };
}

export function decisionRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 1,
    positionId: 'aave-v3:ethereum:core:USDC',
    at: new Date('2026-01-01T12:00:00Z'),
    blockNumber: 21_500_000n,
    previousLevel: 'NORMAL',
    level: 'WATCH',
    rawLevel: 'WATCH',
    signals: [
      {
        detectorId: 'D01_utilization_level',
        family: 'pool_flow',
        subject: { kind: 'market', id: 'aave-v3:ethereum:core' },
        severity: 'watch',
        value: 0.91,
        threshold: 0.9,
        evidence: {},
      },
    ],
    rule: 'watch: no corroboration required',
    action: { kind: 'alert' },
    standingAlert: false,
    configHash: 'abc123',
    ...overrides,
  };
}

export function dataQuality(overrides: Partial<DataQualitySummary> = {}): DataQualitySummary {
  return {
    chainId: 1,
    providerUptime: 0.999,
    averageHeadLagBlocks: 1.2,
    disagreementCount: 0,
    staleSourceCount: 0,
    ...overrides,
  };
}
