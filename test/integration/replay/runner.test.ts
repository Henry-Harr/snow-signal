import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runReplayScenario } from '../../../src/replay/runner.js';
import type { ReplayScenario } from '../../../src/replay/scenario.js';
import { createLogger } from '../../../src/core/logger.js';

/**
 * Live-network integration test for the replay engine (`src/replay/runner.ts`),
 * against the **real** archive RPC (not an Anvil fork — replay's whole design point,
 * per docs/SPEC.md §9.1, is to work directly off a real archive-capable RPC through
 * the disk cache, so this is the one place in the test suite that's supposed to hit
 * a real network directly). Reuses the same pinned Ethereum block
 * (`test/integration/core/pipeline.test.ts`'s block 25,987,000) that's already known
 * to hold real bad debt in Aave's Core USDC reserve — so this test both proves the
 * replay engine's wiring (cache, synthetic position, `runOnce` integration) *and*
 * cross-checks that it reaches the same real-world finding as the live-pipeline fork
 * test, from an entirely different code path (archive RPC + disk cache instead of an
 * Anvil fork).
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const logger = createLogger({ level: 'silent' });

const describeIfNetworked = ETH_URL ? describe : describe.skip;

function tinyIncidentScenario(): ReplayScenario {
  return {
    id: 'replay-engine-smoke-test',
    description: 'Single real block already known to hold Aave Core USDC bad debt.',
    kind: 'incident',
    chain: 'ethereum',
    chainId: 1,
    position: { protocol: 'aave-v3', market: 'core', asset: 'USDC' },
    blockRange: { from: 25_987_000n, to: 25_987_000n },
    sampleIntervalBlocks: 1n,
    simulatedPositionBalanceRaw: '1000000000',
    groundTruth: [
      {
        at: '2026-01-01T00:00:00.000Z',
        blockNumber: 25_987_000n,
        description: 'test fixture',
        pointOfNoReturn: true,
      },
    ],
    sources: [{ url: 'https://etherscan.io', note: 'test fixture, not a real citation' }],
  };
}

describeIfNetworked('runReplayScenario (live archive RPC + disk cache)', () => {
  it('replays a real block, persists a decision, and reads real withdrawable liquidity', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'sentinel-replay-cache-'));
    const policy = {
      watch: { action: 'alert' as const },
      danger: { action: 'partial_withdraw' as const, fraction: 0.5 },
      critical: { action: 'full_exit' as const },
      maxShareOfAvailableLiquidity: 0.05,
    };

    const result = await runReplayScenario(tinyIncidentScenario(), {
      archiveRpcUrls: [ETH_URL!, ETH_URL!],
      cacheDir,
      policy,
      logger,
    });

    expect(result.blocksProcessed).toBe(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.level).toBe('CRITICAL');
    expect(result.decisions[0]!.rule).toContain('D11_bad_debt');

    expect(result.withdrawable).toHaveLength(1);
    expect(result.withdrawable[0]!.blockNumber).toBe(25_987_000n);
    expect(result.withdrawable[0]!.totalPosition).toBe(1_000_000_000n);
    expect(result.withdrawable[0]!.availableNow).toBeGreaterThanOrEqual(0n);
  }, 60_000);

  it('is fast the second time (cache hit) and produces the same decision', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'sentinel-replay-cache-'));
    const policy = {
      watch: { action: 'alert' as const },
      danger: { action: 'partial_withdraw' as const, fraction: 0.5 },
      critical: { action: 'full_exit' as const },
      maxShareOfAvailableLiquidity: 0.05,
    };
    const scenario = tinyIncidentScenario();

    await runReplayScenario(scenario, { archiveRpcUrls: [ETH_URL!, ETH_URL!], cacheDir, policy, logger });

    const start = Date.now();
    const second = await runReplayScenario(scenario, {
      archiveRpcUrls: [ETH_URL!, ETH_URL!],
      cacheDir,
      policy,
      logger,
    });
    const elapsedMs = Date.now() - start;

    expect(second.decisions[0]!.level).toBe('CRITICAL');
    // Generous bound — the point is "no real network round trips," not a tight SLA.
    expect(elapsedMs).toBeLessThan(5000);
  }, 60_000);
});
