import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createViemContractReadClient, type ContractReadClient } from '../../../src/chain/client.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import { QuorumError } from '../../../src/core/errors.js';
import { SystemClock } from '../../../src/core/clock.js';
import type { SentinelConfig } from '../../../src/core/config.js';
import { runOnce, type PipelineDeps } from '../../../src/core/pipeline.js';
import type { BlockRef } from '../../../src/core/types.js';
import { AlertDispatcher } from '../../../src/notify/dispatcher.js';
import { ConsoleNotifier } from '../../../src/notify/console.js';
import { defaultDetectors } from '../../../src/signals/registry.js';
import { DecisionRecordRepository } from '../../../src/storage/decision-record-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import { MarketSnapshotRepository } from '../../../src/storage/market-snapshot-repository.js';
import { ProtocolEventRepository } from '../../../src/storage/protocol-event-repository.js';
import { RiskStateRepository } from '../../../src/storage/risk-state-repository.js';
import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';

/**
 * Chaos test (docs/SPEC.md §9 Phase 9, safety rule 7: "never act on unconfirmed
 * data"): the two configured providers genuinely disagree — they're two independent
 * forks pinned to different blocks, standing in for "one provider is stale/broken/
 * lying." Proves the *whole pipeline*, not just `RpcPool.quorumRead` in isolation
 * (already covered by `test/unit/chain/rpc-pool.test.ts` and
 * `test/property/chain/rpc-pool-quorum.test.ts`), fails loudly and persists no
 * decision at all rather than silently completing on one provider's version of the
 * truth.
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const describeIfForkable = ETH_URL ? describe : describe.skip;

const SAFE_ADDRESS = '0x04E779d093549Da687C51ea0c2Ae8AE2174e3465' as const;
const POSITION_ID = 'aave-v3:ethereum:core:USDC';

function testConfig(): SentinelConfig {
  return {
    safe: { address: SAFE_ADDRESS },
    chains: {},
    positions: [{ protocol: 'aave-v3', chain: 'ethereum', market: 'core', asset: 'USDC' }],
    detectors: {},
    policy: {
      watch: { action: 'alert' },
      danger: { action: 'partial_withdraw', fraction: 0.5 },
      critical: { action: 'full_exit' },
      maxShareOfAvailableLiquidity: 0.05,
    },
    execution: { mode: 'off', maxPriorityFeeGwei: {}, liveChains: [], roles: {} },
    notify: {},
    reports: { dailyUtcHour: 0, benchmark: { kind: 'pool_base_rate' } },
  };
}

describeIfForkable('pipeline runOnce (chaos: providers genuinely disagree)', () => {
  let forkA: AnvilFork | undefined;
  let forkB: AnvilFork | undefined;

  afterEach(async () => {
    await forkA?.stop();
    await forkB?.stop();
    forkA = undefined;
    forkB = undefined;
  });

  it('throws QuorumError and persists no decision, rather than acting on one provider alone', async () => {
    // Two real forks, pinned ~1000 blocks apart — genuinely different market state
    // (utilization, liquidity, etc.), standing in for a disagreeing/stale provider.
    const laterBlock = 25_987_000n;
    forkA = await startAnvilFork({ forkUrl: ETH_URL!, forkBlockNumber: laterBlock });
    forkB = await startAnvilFork({ forkUrl: ETH_URL!, forkBlockNumber: laterBlock - 1_000n });

    const pool = new RpcPool<ContractReadClient>([
      { name: 'provider-a', client: createViemContractReadClient(forkA.rpcUrl, 1) },
      { name: 'provider-b', client: createViemContractReadClient(forkB.rpcUrl, 1) },
    ]);
    const db = new Database(':memory:');
    runMigrations(db);

    const deps: PipelineDeps = {
      chain: 'ethereum',
      chainId: 1,
      pool,
      config: testConfig(),
      clock: new SystemClock(),
      detectors: defaultDetectors(),
      dispatcher: new AlertDispatcher({
        notifiers: [new ConsoleNotifier()],
        clock: new SystemClock(),
      }),
      repos: {
        marketSnapshots: new MarketSnapshotRepository(db),
        protocolEvents: new ProtocolEventRepository(db),
        decisionRecords: new DecisionRecordRepository(db),
        riskState: new RiskStateRepository(db),
      },
      killSwitchActive: false,
      dwellSeconds: 3600,
      configHash: 'test-hash',
    };
    const at: BlockRef = { chainId: 1, number: laterBlock, hash: '0x0', timestamp: 1_700_000_000 };

    await expect(runOnce(deps, at)).rejects.toBeInstanceOf(QuorumError);

    const decisions = deps.repos.decisionRecords.findRecentForPosition(POSITION_ID, 10);
    expect(decisions).toHaveLength(0);
  }, 60_000);
});
