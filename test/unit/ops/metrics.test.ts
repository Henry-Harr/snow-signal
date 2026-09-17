import { describe, expect, it } from 'vitest';

import {
  recordDecision,
  recordProviderHealth,
  registry,
  rpcProviderConsecutiveFailures,
  rpcProviderLatencyMs,
} from '../../../src/ops/metrics.js';

describe('recordDecision', () => {
  it('increments sentinel_decisions_total labeled by position and level', async () => {
    recordDecision('metrics-test:position', 'CRITICAL');
    const body = await registry.getSingleMetricAsString('sentinel_decisions_total');
    expect(body).toContain('position_id="metrics-test:position"');
    expect(body).toContain('level="CRITICAL"');
  });
});

describe('recordProviderHealth', () => {
  it('sets the failures and latency gauges per provider, and skips latency when undefined', async () => {
    recordProviderHealth('metrics-test-chain', [
      { provider: 'a', consecutiveFailures: 2, lastLatencyMs: 150 },
      { provider: 'b', consecutiveFailures: 0, lastLatencyMs: undefined },
    ]);

    const failures = await rpcProviderConsecutiveFailures.get();
    const latency = await rpcProviderLatencyMs.get();

    expect(
      failures.values.find(
        (v) => v.labels['chain'] === 'metrics-test-chain' && v.labels['provider'] === 'a',
      )?.value,
    ).toBe(2);
    expect(
      latency.values.find(
        (v) => v.labels['chain'] === 'metrics-test-chain' && v.labels['provider'] === 'a',
      )?.value,
    ).toBe(150);
    expect(
      latency.values.find(
        (v) => v.labels['chain'] === 'metrics-test-chain' && v.labels['provider'] === 'b',
      ),
    ).toBeUndefined();
  });
});
