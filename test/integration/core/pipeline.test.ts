import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';
import { runOnce, type PipelineDeps } from '../../../src/core/pipeline.js';
import { defaultDetectors } from '../../../src/signals/registry.js';
import { AlertDispatcher } from '../../../src/notify/dispatcher.js';
import { ConsoleNotifier } from '../../../src/notify/console.js';
import { DecisionRecordRepository } from '../../../src/storage/decision-record-repository.js';
import { MarketSnapshotRepository } from '../../../src/storage/market-snapshot-repository.js';
import { ProtocolEventRepository } from '../../../src/storage/protocol-event-repository.js';
import { RiskStateRepository } from '../../../src/storage/risk-state-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import { SystemClock } from '../../../src/core/clock.js';
import {
  createViemContractReadClient,
  type ContractReadClient,
} from '../../../src/chain/client.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import type { SentinelConfig } from '../../../src/core/config.js';
import type { BlockRef, ChainId } from '../../../src/core/types.js';

/**
 * Fork integration test (docs/SPEC.md #9.4) for the full pipeline
 * (`src/core/pipeline.ts`) — the strongest available check on this session's whole
 * context-assembly/wiring effort, given how much of it (address/symbol joins, event
 * fetching, ledger computation, detector registry, risk engine) only makes sense
 * exercised together against real chain data rather than piece by piece. Same block
 * pins as every other Phase 2/3 fork test (both pools/markets predate these blocks
 * by years).
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const BASE_URL = process.env['BASE_RPC_ARCHIVE'];

const SAFE_ADDRESS = '0x04E779d093549Da687C51ea0c2Ae8AE2174e3465' as const;

function testConfig(chain: string): SentinelConfig {
  return {
    safe: { address: SAFE_ADDRESS },
    chains: {},
    positions:
      chain === 'ethereum'
        ? [{ protocol: 'aave-v3', chain: 'ethereum', market: 'core', asset: 'USDC' }]
        : [
            { protocol: 'aave-v3', chain: 'base', market: 'core', asset: 'USDC' },
            {
              protocol: 'morpho-vault',
              chain: 'base',
              vault: '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61',
            },
          ],
    detectors: {},
    policy: {
      watch: { action: 'alert' },
      danger: { action: 'partial_withdraw', fraction: 0.5 },
      critical: { action: 'full_exit' },
      maxShareOfAvailableLiquidity: 0.05,
    },
    execution: { mode: 'off', maxPriorityFeeGwei: {} },
    notify: {},
    reports: { dailyUtcHour: 0, benchmark: { kind: 'pool_base_rate' } },
  };
}

interface ChainCase {
  chain: string;
  chainId: ChainId;
  forkUrl: string | undefined;
  forkBlockNumber: bigint;
}

const CHAIN_CASES: ChainCase[] = [
  { chain: 'ethereum', chainId: 1, forkUrl: ETH_URL, forkBlockNumber: 25_987_000n },
  { chain: 'base', chainId: 8453, forkUrl: BASE_URL, forkBlockNumber: 51_370_000n },
];

for (const testCase of CHAIN_CASES) {
  const describeIfForkable = testCase.forkUrl ? describe : describe.skip;

  describeIfForkable(`pipeline runOnce (fork integration, ${testCase.chain})`, () => {
    let fork: AnvilFork;
    let deps: PipelineDeps;
    let at: BlockRef;

    beforeAll(async () => {
      fork = await startAnvilFork({
        forkUrl: testCase.forkUrl!,
        forkBlockNumber: testCase.forkBlockNumber,
      });
      const client = createViemContractReadClient(fork.rpcUrl, testCase.chainId);
      const pool = new RpcPool<ContractReadClient>([
        { name: 'fork-a', client },
        { name: 'fork-b', client },
      ]);
      const db = new Database(':memory:');
      runMigrations(db);

      deps = {
        chain: testCase.chain,
        chainId: testCase.chainId,
        pool,
        config: testConfig(testCase.chain),
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
      at = {
        chainId: testCase.chainId,
        number: testCase.forkBlockNumber,
        hash: '0x0',
        timestamp: 1_700_000_000,
      };
    }, 60_000);

    afterAll(async () => {
      await fork?.stop();
    });

    it('runs end to end against real chain data without throwing, and persists a decision per position', async () => {
      await expect(runOnce(deps, at)).resolves.toBeUndefined();

      const positionIds =
        testCase.chain === 'ethereum'
          ? ['aave-v3:ethereum:core:USDC']
          : [
              'aave-v3:base:core:USDC',
              'morpho-vault:base:0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61',
            ];

      for (const positionId of positionIds) {
        const decisions = deps.repos.decisionRecords.findRecentForPosition(positionId, 10);
        expect(decisions).toHaveLength(1);
        expect(['NORMAL', 'WATCH', 'DANGER', 'CRITICAL']).toContain(decisions[0]!.level);

        const state = deps.repos.riskState.get(positionId);
        expect(state?.level).toBe(decisions[0]!.level);
      }

      // A market snapshot was actually stored for at least one position.
      const marketId =
        testCase.chain === 'ethereum' ? 'aave-v3:ethereum:core:USDC' : 'aave-v3:base:core:USDC';
      expect(deps.repos.marketSnapshots.findLatest(marketId)).toBeDefined();
    }, 60_000);

    it('is safe to run twice in a row against the same block (idempotent event storage)', async () => {
      await expect(runOnce(deps, at)).resolves.toBeUndefined();
    }, 60_000);
  });
}
