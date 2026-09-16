import type { Signal } from '../../../src/core/types.js';
import type { Alert } from '../../../src/notify/types.js';

export function testSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    detectorId: 'D01_utilization_level',
    family: 'pool_flow',
    subject: { kind: 'market', id: 'aave-v3:ethereum:core' },
    severity: 'danger',
    value: 0.96,
    threshold: 0.95,
    evidence: {},
    ...overrides,
  };
}

export function testAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    decisionId: 1,
    positionId: 'aave-v3:ethereum:core:USDC',
    protocol: 'aave-v3',
    chainId: 1,
    asset: 'USDC',
    level: 'DANGER',
    previousLevel: 'WATCH',
    rawLevel: 'DANGER',
    signals: [testSignal()],
    rule: 'corroborated across 2 families',
    blockNumber: 21_500_000n,
    blockExplorerUrl: 'https://etherscan.io/block/21500000',
    action: { kind: 'partial_withdraw', fraction: 0.5 },
    standingAlert: false,
    at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}
