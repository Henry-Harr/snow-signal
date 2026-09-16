import { startAnvilFork } from '../chain/anvil.js';
import { createViemContractReadClient, type ContractReadClient } from '../chain/client.js';
import { RpcPool } from '../chain/rpc-pool.js';
import type { SentinelConfig } from '../core/config.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Address, BlockRef, ChainId, ProtocolAdapter } from '../core/types.js';
import { AaveV3Adapter } from '../protocols/aave-v3/adapter.js';
import { MorphoVaultAdapter } from '../protocols/morpho-vault/adapter.js';
import type { ActionRecommendation } from '../risk/types.js';
import type { WithdrawalCampaignRepository } from '../storage/withdrawal-campaign-repository.js';
import { planWithdrawal } from './planner.js';
import { simulateWithdrawal } from './simulator.js';
import type { WithdrawalCampaign, WithdrawalSimulationResult } from './types.js';

/**
 * The paper executor (docs/SPEC.md §8.4: "`paper`: plan, simulate on a fork of the
 * current block, and record what would have happened. Never sign anything."). Spawns
 * its own short-lived Anvil fork pinned to `at` — the same confirmed block the
 * pipeline's own decision was just made from, so the plan sees exactly the state
 * that triggered it — re-discovers the position fresh on that fork, plans a
 * withdrawal step (`./planner.ts`), and, if there's a step to take, drives it through
 * the fork simulator (`./simulator.ts`), which itself never signs anything
 * (impersonation only, safety rule 2). Persists campaign state either way via
 * `campaigns`, so the next call (next confirmed block) picks up where this one left
 * off — "retry on every new block" (spec §8.3) is the pipeline calling this again,
 * not this function looping internally.
 *
 * Only reads through one RPC URL (via Anvil's own fork), not a quorum-checked pool:
 * safety rule 7's two-independent-provider requirement applies to the *decision*
 * this call is reacting to (already corroborated upstream by the risk engine's own
 * quorum-backed live reads) — nothing here is safety-critical since paper mode never
 * moves real funds. Same reasoning already established for the replay engine's own
 * single-URL pools (`src/replay/runner.ts`).
 */

export interface PaperExecutorPosition {
  positionId: string;
  protocol: 'aave-v3' | 'morpho-vault';
  marketId: string;
  assetSymbol: string;
}

export type PaperExecutionOutcome =
  | { kind: 'no-position' }
  | { kind: 'none' }
  | { kind: 'cancelled'; campaign: WithdrawalCampaign }
  | { kind: 'already-complete'; campaign: WithdrawalCampaign }
  | { kind: 'no-liquidity'; campaign: WithdrawalCampaign }
  | { kind: 'simulated'; result: WithdrawalSimulationResult };

export interface RunPaperExecutionOptions {
  chain: string;
  chainId: ChainId;
  config: SentinelConfig;
  clock: Clock;
  logger?: Logger;
  campaigns: WithdrawalCampaignRepository;
  /** An archive/full-node RPC URL for this chain — Anvil forks from it. */
  forkUrl: string;
  position: PaperExecutorPosition;
  safeAddress: Address;
  action: ActionRecommendation;
  at: BlockRef;
}

function buildAdapter(
  options: RunPaperExecutionOptions,
  pool: RpcPool<ContractReadClient>,
): ProtocolAdapter {
  if (options.position.protocol === 'aave-v3') {
    const [, chain, market] = options.position.marketId.split(':');
    return new AaveV3Adapter({
      chain: chain!,
      market: market!,
      chainId: options.chainId,
      watchedAssets: [options.position.assetSymbol],
      pool,
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }
  const [, chain, vaultAddress] = options.position.marketId.split(':');
  return new MorphoVaultAdapter({
    chain: chain!,
    chainId: options.chainId,
    vaultAddress: vaultAddress as Address,
    pool,
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

function priorityFeeCapFor(options: RunPaperExecutionOptions): number {
  return options.config.execution.maxPriorityFeeGwei[options.chain] ?? 0;
}

export async function runPaperExecution(
  options: RunPaperExecutionOptions,
): Promise<PaperExecutionOutcome> {
  const fork = await startAnvilFork({
    forkUrl: options.forkUrl,
    forkBlockNumber: options.at.number,
  });
  try {
    const providers = [0, 1].map((i) => ({
      name: `fork-${i}`,
      client: createViemContractReadClient(fork.rpcUrl, options.chainId),
    }));
    const pool = new RpcPool<ContractReadClient>(providers, options.logger);
    const adapter = buildAdapter(options, pool);

    const discovered = await adapter.discoverPositions(options.safeAddress, options.at);
    const position = discovered.find((p) => p.marketId === options.position.marketId);
    const existingCampaign = options.campaigns.get(options.position.positionId);

    if (!position) {
      if (existingCampaign?.status === 'in_progress') {
        options.campaigns.save({
          ...existingCampaign,
          status: 'cancelled',
          updatedAt: options.clock.now(),
        });
      }
      return { kind: 'no-position' };
    }

    const withdrawEstimate = await adapter.withdrawable(position, options.at);

    const planOutcome = planWithdrawal({
      positionId: options.position.positionId,
      action: options.action,
      positionBalance: position.balance,
      withdrawEstimate,
      existingCampaign,
      buildTx: (amount) => adapter.buildWithdraw(position, amount, options.safeAddress),
      now: options.clock.now(),
      priorityFee: { capGwei: priorityFeeCapFor(options) },
    });

    if (planOutcome.kind === 'none') return { kind: 'none' };
    if (planOutcome.kind === 'cancelled' || planOutcome.kind === 'already-complete') {
      options.campaigns.save(planOutcome.campaign);
      return planOutcome;
    }

    const { plan } = planOutcome;
    if (!plan.tx || plan.stepAmount === 0n) {
      options.campaigns.save(plan.campaign);
      return { kind: 'no-liquidity', campaign: plan.campaign };
    }

    const simOutcome = await simulateWithdrawal({
      rpcUrl: fork.rpcUrl,
      chainId: options.chainId,
      safeAddress: options.safeAddress,
      tx: plan.tx,
      assetAddress: position.asset,
      expectedAmount: plan.stepAmount,
    });

    // Protocol-specific "position down" half of safety rule 5 — `simulateWithdrawal`
    // only verifies the generic "Safe's ERC-20 balance went up" half (see that
    // module's doc comment); re-read the position on this same fork, now one block
    // past `at` since the simulated tx mined, and confirm it actually decreased by
    // the expected amount too.
    const afterBlockNumber = await pool.bestEffortRead((client) => client.getBlockNumber());
    const afterBlock = await pool.bestEffortRead((client) => client.getBlock(afterBlockNumber));
    const afterRef: BlockRef = {
      chainId: options.chainId,
      number: afterBlock.number,
      hash: afterBlock.hash,
      timestamp: Number(afterBlock.timestamp),
    };
    const afterDiscovered = await adapter.discoverPositions(options.safeAddress, afterRef);
    const positionBalanceAfter =
      afterDiscovered.find((p) => p.marketId === options.position.marketId)?.balance ?? 0n;
    const actualDecrease = position.balance - positionBalanceAfter;
    // `position.balance` was read at `at`, one block *before* the withdrawal tx
    // mined — an interest-bearing position keeps accruing in that gap, so the true
    // pre-tx balance is slightly higher than `position.balance`, and the measured
    // decrease comes in slightly *under* `stepAmount` even for a fully correct
    // withdrawal (the accrued sliver is left behind as dust rather than swept up,
    // since `buildWithdraw` was deliberately given an exact amount, not `'max'` —
    // see `./planner.ts`'s own doc comment on why). A one-block-of-interest
    // tolerance (capped, floor of 1 wei so a zero-amount step can't slip through)
    // absorbs that without hiding a real shortfall: a genuine bug (wrong recipient,
    // fee-on-transfer asset, bad calldata) loses far more than a few parts-per-
    // million of the withdrawal.
    const accrualTolerance = plan.stepAmount / 1_000_000n > 0n ? plan.stepAmount / 1_000_000n : 1n;
    const shortfall = plan.stepAmount - actualDecrease;
    const positionDecreasedByExpected = shortfall >= 0n && shortfall <= accrualTolerance;

    const passed = simOutcome.passed && positionDecreasedByExpected;
    const failureReason = !simOutcome.passed
      ? simOutcome.failureReason
      : !positionDecreasedByExpected
        ? `position balance decreased by ${actualDecrease.toString()}, expected ~${plan.stepAmount.toString()} (tolerance ${accrualTolerance.toString()})`
        : undefined;

    const updatedCampaign: WithdrawalCampaign = passed
      ? {
          ...plan.campaign,
          withdrawnSoFar: plan.campaign.withdrawnSoFar + plan.stepAmount,
          status: plan.wouldComplete ? 'complete' : 'in_progress',
        }
      : plan.campaign;
    options.campaigns.save(updatedCampaign);

    const result: WithdrawalSimulationResult = {
      plan: { ...plan, campaign: updatedCampaign },
      passed,
      gasUsed: simOutcome.gasUsed,
      failureReason,
    };
    return { kind: 'simulated', result };
  } finally {
    await fork.stop();
  }
}
