import { erc4626Abi } from 'viem';

import { createCachingContractReadClient } from './archive-client.js';
import { DiskCache } from './cache.js';
import { ReplayBlockSource } from './block-source.js';
import { ReplayScenarioError, type ReplayScenario } from './scenario.js';
import {
  createViemContractReadClient,
  type ContractCallResult,
  type ContractReadClient,
} from '../chain/client.js';
import { RpcPool } from '../chain/rpc-pool.js';
import { FixedClock, SystemClock } from '../core/clock.js';
import type { SentinelConfig } from '../core/config.js';
import { resolveAssetAddress } from '../core/known-assets.js';
import type { Logger } from '../core/logger.js';
import { runOnce, type PipelineDeps } from '../core/pipeline.js';
import type { Address, BlockRef, Position } from '../core/types.js';
import { AlertDispatcher } from '../notify/dispatcher.js';
import { AaveV3Adapter } from '../protocols/aave-v3/adapter.js';
import { MorphoVaultAdapter } from '../protocols/morpho-vault/adapter.js';
import type { DecisionRecord } from '../storage/decision-record-repository.js';
import { DecisionRecordRepository } from '../storage/decision-record-repository.js';
import { openDatabase } from '../storage/db.js';
import { MarketSnapshotRepository } from '../storage/market-snapshot-repository.js';
import { ProtocolEventRepository } from '../storage/protocol-event-repository.js';
import { RiskStateRepository } from '../storage/risk-state-repository.js';
import { defaultDetectors } from '../signals/registry.js';
import { DEFAULT_DWELL_SECONDS } from '../risk/types.js';

/**
 * The replay runner (docs/SPEC.md §9.1): drives `src/core/pipeline.ts`'s `runOnce` —
 * the exact same function `sentinel watch` calls — over a scenario's block range
 * instead of newly-confirmed live blocks, through a disk-cached archive RPC pool
 * instead of a live one, with a synthetic `Position` instead of live discovery (ADR
 * 0009). Everything downstream of "which block, which position" is unmodified live
 * code, per docs/ARCHITECTURE.md #2's one-code-path principle.
 *
 * Uses `defaultDetectors()` and `DEFAULT_DWELL_SECONDS` — the exact same values
 * `sentinel watch` uses — deliberately, not a scenario-specific override: see
 * docs/PROGRESS.md's "Known Issues" (Phase 6 session) for why `config.detectors`
 * isn't actually wired up to anything yet, live or replay.
 */

/** A single owner address the replay runner uses for every synthetic position — never
 * a real user's address, since replay never touches anyone's actual holdings. */
const REPLAY_SYNTHETIC_OWNER = '0x000000000000000000000000000000000000dEaD' as Address;

export interface ReplayWithdrawableSample {
  blockNumber: bigint;
  availableNow: bigint;
  totalPosition: bigint;
}

export interface ReplayRunResult {
  scenario: ReplayScenario;
  /** Every decision recorded for the scenario's synthetic position, oldest first. */
  decisions: DecisionRecord[];
  /** Real withdrawable liquidity for the synthetic position at each sampled block —
   * the input to the "recoverable share" score (docs/SPEC.md §9.3). */
  withdrawable: ReplayWithdrawableSample[];
  blocksProcessed: number;
}

export interface RunReplayScenarioOptions {
  /** At least 2 archive-capable RPC URLs (`RpcPool` itself enforces this) — can point
   * at the same URL twice if only one archive provider is configured, at the cost of
   * quorum reads no longer being an independent cross-check during that run. */
  archiveRpcUrls: [string, string, ...string[]];
  cacheDir: string;
  policy: SentinelConfig['policy'];
  logger?: Logger;
}

function marketIdFor(scenario: ReplayScenario): string {
  return scenario.position.protocol === 'aave-v3'
    ? `aave-v3:${scenario.chain}:${scenario.position.market}:${scenario.position.asset}`
    : `morpho-vault:${scenario.chain}:${scenario.position.vault}`;
}

function scenarioConfig(scenario: ReplayScenario): SentinelConfig['positions'][number] {
  return scenario.position.protocol === 'aave-v3'
    ? {
        protocol: 'aave-v3',
        chain: scenario.chain,
        market: scenario.position.market,
        asset: scenario.position.asset,
      }
    : { protocol: 'morpho-vault', chain: scenario.chain, vault: scenario.position.vault };
}

async function resolveSyntheticAssetAddress(
  scenario: ReplayScenario,
  pool: RpcPool<ContractReadClient>,
  at: BlockRef,
): Promise<Address> {
  if (scenario.position.protocol === 'aave-v3') {
    const resolved = resolveAssetAddress(scenario.chain, scenario.position.asset);
    if (!resolved) {
      throw new ReplayScenarioError(
        `${scenario.id}: unknown asset symbol "${scenario.position.asset}" on chain "${scenario.chain}" (src/core/known-assets.ts doesn't have it)`,
      );
    }
    return resolved;
  }

  const vault = scenario.position.vault as Address;
  return pool.bestEffortRead(async (client) => {
    const [result] = await client.multicall(
      [{ address: vault, abi: erc4626Abi, functionName: 'asset' }],
      at.number,
    );
    return unwrapAddress(result, `${scenario.id}: vault.asset()`);
  });
}

function unwrapAddress(result: ContractCallResult | undefined, context: string): Address {
  if (!result) throw new ReplayScenarioError(`${context}: missing multicall result`);
  if (result.status === 'failure')
    throw new ReplayScenarioError(`${context}: ${result.error.message}`);
  return result.result as Address;
}

async function buildSyntheticPosition(
  scenario: ReplayScenario,
  pool: RpcPool<ContractReadClient>,
  marketId: string,
  at: BlockRef,
): Promise<Position> {
  const asset = await resolveSyntheticAssetAddress(scenario, pool, at);
  return {
    id: `${marketId}:${REPLAY_SYNTHETIC_OWNER}`,
    protocol: scenario.position.protocol,
    chainId: scenario.chainId,
    marketId,
    owner: REPLAY_SYNTHETIC_OWNER,
    asset,
    balance: BigInt(scenario.simulatedPositionBalanceRaw),
  };
}

async function readWithdrawable(
  scenario: ReplayScenario,
  pool: RpcPool<ContractReadClient>,
  position: Position,
  at: BlockRef,
  logger: Logger | undefined,
): Promise<ReplayWithdrawableSample> {
  const adapter =
    scenario.position.protocol === 'aave-v3'
      ? new AaveV3Adapter({
          chain: scenario.chain,
          market: scenario.position.market,
          chainId: scenario.chainId,
          watchedAssets: [scenario.position.asset],
          pool,
          ...(logger ? { logger } : {}),
        })
      : new MorphoVaultAdapter({
          chain: scenario.chain,
          chainId: scenario.chainId,
          vaultAddress: scenario.position.vault as Address,
          pool,
          ...(logger ? { logger } : {}),
        });

  const estimate = await adapter.withdrawable(position, at);
  return {
    blockNumber: at.number,
    availableNow: estimate.availableNow,
    totalPosition: estimate.totalPosition,
  };
}

export async function runReplayScenario(
  scenario: ReplayScenario,
  options: RunReplayScenarioOptions,
): Promise<ReplayRunResult> {
  const cache = new DiskCache(options.cacheDir);
  const providers = options.archiveRpcUrls.map((url, i) => ({
    name: `archive-${i}`,
    client: createCachingContractReadClient(
      createViemContractReadClient(url, scenario.chainId),
      scenario.chainId,
      cache,
    ),
  }));
  const pool = new RpcPool<ContractReadClient>(providers, options.logger);

  const db = openDatabase(':memory:');
  const repos = {
    marketSnapshots: new MarketSnapshotRepository(db),
    protocolEvents: new ProtocolEventRepository(db),
    decisionRecords: new DecisionRecordRepository(db),
    riskState: new RiskStateRepository(db),
  };

  const marketId = marketIdFor(scenario);
  const config: SentinelConfig = {
    safe: { address: REPLAY_SYNTHETIC_OWNER },
    chains: {},
    positions: [scenarioConfig(scenario)],
    detectors: {},
    policy: options.policy,
    execution: { mode: 'off', maxPriorityFeeGwei: {}, liveChains: [], roles: {} },
    notify: {},
    reports: { dailyUtcHour: 0, benchmark: { kind: 'pool_base_rate' } },
  };

  const dispatcher = new AlertDispatcher({ notifiers: [], clock: new SystemClock() });
  const detectors = defaultDetectors();
  const blockSource = new ReplayBlockSource({
    chainId: scenario.chainId,
    pool,
    fromBlock: scenario.blockRange.from,
    toBlock: scenario.blockRange.to,
    sampleIntervalBlocks: scenario.sampleIntervalBlocks,
  });

  const withdrawable: ReplayWithdrawableSample[] = [];
  let blocksProcessed = 0;
  // Tracks the previous sampled block so each step's governance/pool-flow event fetch
  // covers the full gap since the last sample, not just the single current block —
  // see `PipelineDeps.eventsFromBlock`'s doc comment for why this matters for replay
  // specifically. Starts at the scenario's own first block, so the first sample's
  // window is trivially just that one block.
  let previousBlockNumber = scenario.blockRange.from;

  try {
    for (;;) {
      const blocks = await blockSource.poll();
      if (blocks.length === 0) break;
      const at = blocks[0]!;
      const fullGap = previousBlockNumber;

      // Clamp to the free-tier eth_getLogs range cap rather than just warning about
      // it — a provider doesn't silently truncate an over-range query, it hard-errors
      // (confirmed against real archive RPCs in the Phase 6 session: both configured
      // providers rejected an over-range query outright), which would otherwise crash
      // this scenario's whole run instead of degrading gracefully. `MAX_LOG_RANGE`
      // (9) is Alchemy's actual limit, not its own error message's rounder "10 block
      // range" wording — its error response's own suggested corrected range came back
      // with `toBlock - fromBlock === 9` (a real Phase 6 finding, verified against the
      // live error response, not the vendor's prose). This is the mechanism behind
      // the known, documented D05/D12/D13 gap for wide-stride scenarios (ADR 0009's
      // addendum) — clamping just makes that gap fail safe instead of failing loudly.
      const MAX_LOG_RANGE = 9n;
      const eventsFromBlock =
        at.number - fullGap > MAX_LOG_RANGE ? at.number - MAX_LOG_RANGE : fullGap;
      if (at.number - fullGap > MAX_LOG_RANGE) {
        options.logger?.warn(
          { scenario: scenario.id, from: fullGap.toString(), to: at.number.toString() },
          'event fetch window exceeds the free-tier eth_getLogs range cap ' +
            '(docs/PROGRESS.md, src/watchers/governance.ts) — clamped to the last 9 ' +
            'blocks; large-holder/governance events earlier in this gap are dropped. ' +
            'Use a smaller sampleIntervalBlocks for scenarios where D05/D12/D13 fidelity matters',
        );
      }

      const position = await buildSyntheticPosition(scenario, pool, marketId, at);
      const clock = new FixedClock(new Date(at.timestamp * 1000));

      const deps: PipelineDeps = {
        chain: scenario.chain,
        chainId: scenario.chainId,
        pool,
        config,
        clock,
        ...(options.logger ? { logger: options.logger } : {}),
        detectors,
        dispatcher,
        repos,
        killSwitchActive: false,
        dwellSeconds: DEFAULT_DWELL_SECONDS,
        configHash: `replay:${scenario.id}`,
        positionOverrides: { [marketId]: position },
        eventsFromBlock,
      };

      await runOnce(deps, at);
      withdrawable.push(await readWithdrawable(scenario, pool, position, at, options.logger));
      blocksProcessed++;
      previousBlockNumber = at.number + 1n;
    }

    const decisions = repos.decisionRecords.findSince(new Date(0).toISOString());
    return { scenario, decisions, withdrawable, blocksProcessed };
  } finally {
    db.close();
  }
}
