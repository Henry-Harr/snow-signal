import type { SentinelConfig } from '../../../src/core/config.js';
import type { Signal } from '../../../src/core/types.js';
import type { PositionRiskState } from '../../../src/risk/types.js';
import { initialPositionRiskState } from '../../../src/risk/types.js';

export const POSITION_ID = 'aave-v3:ethereum:core:USDC';
export const MARKET_ID = 'aave-v3:ethereum:core';

export function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    detectorId: 'D01_utilization_level',
    family: 'pool_flow',
    subject: { kind: 'market', id: MARKET_ID },
    severity: 'danger',
    value: 0.96,
    threshold: 0.95,
    evidence: {},
    ...overrides,
  };
}

export function policy(
  overrides: Partial<SentinelConfig['policy']> = {},
): SentinelConfig['policy'] {
  return {
    watch: { action: 'alert' },
    danger: { action: 'partial_withdraw', fraction: 0.5 },
    critical: { action: 'full_exit' },
    maxShareOfAvailableLiquidity: 0.2,
    ...overrides,
  };
}

export function freshState(overrides: Partial<PositionRiskState> = {}): PositionRiskState {
  return {
    ...initialPositionRiskState(POSITION_ID, new Date('2026-01-01T00:00:00Z')),
    ...overrides,
  };
}
