import { createViemContractReadClient, type ContractReadClient } from '../chain/client.js';
import { RpcPool } from '../chain/rpc-pool.js';
import type { Clock } from '../core/clock.js';
import type { SentinelConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import { positionsForChain } from '../core/pipeline.js';
import type { Address, BlockRef, ChainId } from '../core/types.js';
import type { ExitDrillResult } from '../reports/types.js';
import { openDatabase } from '../storage/db.js';
import { WithdrawalCampaignRepository } from '../storage/withdrawal-campaign-repository.js';
import { runPaperExecution, type PaperExecutionOutcome, type PaperExecutorPosition } from './paper-executor.js';

/**
 * The daily exit drill (docs/SPEC.md §8.6): "fork the latest block and simulate a
 * full exit of every position ... report pass or fail, the gas estimate, and the
 * estimated blocks to exit given current liquidity." Runs unconditionally —
 * regardless of `config.execution.mode` — since this is a standing health check
 * ("catches broken permissions, ABI changes, and paused withdrawals before a crisis
 * does"), not a reaction to any particular decision. Roles-scoping ("through the
 * real executor path (Roles-scoped, if configured)") is Phase 8; this drives the
 * same paper executor paths does (`./paper-executor.ts`).
 *
 * Reuses `runPaperExecution` for the actual plan/simulate/verify work rather than
 * re-implementing it, forcing the action to `full_exit` regardless of the position's
 * real current risk level — but against a throwaway, in-memory campaign repository
 * per position, so a drill run never touches (or is confused with) a real in-progress
 * withdrawal campaign.
 */

async function latestBlockRef(
  pool: RpcPool<ContractReadClient>,
  chainId: ChainId,
): Promise<BlockRef> {
  const number = await pool.getConservativeHead();
  const block = await pool.bestEffortRead((client) => client.getBlock(number));
  return { chainId, number: block.number, hash: block.hash, timestamp: Number(block.timestamp) };
}

/** A coarse liquidity-based proxy for "blocks to exit," not a real time estimate —
 * this codebase has no model of how fast pool liquidity replenishes. `1` if the
 * first step already completes the exit; otherwise the number of *additional*
 * same-sized steps the current liquidity snapshot implies, rounded up. Good enough
 * to flag "this is going to take a while" without pretending to real precision. */
function estimatedBlocksToExit(
  targetAmount: bigint,
  stepAmount: bigint,
  wouldComplete: boolean,
): number | undefined {
  if (stepAmount <= 0n) return undefined;
  if (wouldComplete) return 1;
  return Number((targetAmount + stepAmount - 1n) / stepAmount);
}

function outcomeToDrillResult(
  positionId: string,
  outcome: PaperExecutionOutcome,
): ExitDrillResult | undefined {
  switch (outcome.kind) {
    case 'no-position':
    case 'none':
    case 'cancelled':
      // Nothing currently held (or nothing to exit) — nothing to drill. 'none' and
      // 'cancelled' are unreachable for a forced full_exit action with no prior
      // campaign, but handled the same way defensively.
      return undefined;
    case 'already-complete':
      return { positionId, passed: true, gasEstimate: undefined, estimatedBlocksToExit: 0 };
    case 'no-liquidity':
      return { positionId, passed: false, gasEstimate: undefined, estimatedBlocksToExit: undefined };
    case 'simulated': {
      const { plan, passed, gasUsed } = outcome.result;
      return {
        positionId,
        passed,
        gasEstimate: gasUsed,
        estimatedBlocksToExit: passed
          ? estimatedBlocksToExit(plan.campaign.targetAmount, plan.stepAmount, plan.wouldComplete)
          : undefined,
      };
    }
  }
}

export interface RunExitDrillOptions {
  config: SentinelConfig;
  clock: Clock;
  logger?: Logger;
}

export async function runExitDrill(options: RunExitDrillOptions): Promise<ExitDrillResult[]> {
  const results: ExitDrillResult[] = [];
  const safeAddress = options.config.safe.address as Address;

  for (const [chain, chainConfig] of Object.entries(options.config.chains)) {
    const positions = positionsForChain(options.config, chain);
    if (positions.length === 0) continue;

    const providers = chainConfig.rpc.map((rpc) => ({
      name: rpc.name,
      client: createViemContractReadClient(rpc.url, chainConfig.chainId),
    }));
    const pool = new RpcPool<ContractReadClient>(providers, options.logger);

    let at: BlockRef;
    try {
      at = await latestBlockRef(pool, chainConfig.chainId);
    } catch (error) {
      options.logger?.error(
        { chain, err: error },
        'exit drill: could not read chain head via quorum, skipping this chain',
      );
      continue;
    }

    for (const position of positions) {
      const paperPosition: PaperExecutorPosition = {
        positionId: position.positionId,
        protocol: position.protocol,
        marketId: position.marketId,
        assetSymbol: position.assetSymbol,
      };
      const scratchDb = openDatabase(':memory:');
      try {
        const campaigns = new WithdrawalCampaignRepository(scratchDb);
        const outcome = await runPaperExecution({
          chain,
          chainId: chainConfig.chainId,
          config: options.config,
          clock: options.clock,
          ...(options.logger ? { logger: options.logger } : {}),
          campaigns,
          forkUrl: chainConfig.rpc[0]!.url,
          position: paperPosition,
          safeAddress,
          action: { kind: 'full_exit' },
          at,
        });
        const result = outcomeToDrillResult(position.positionId, outcome);
        if (result) results.push(result);
      } catch (error) {
        options.logger?.error(
          { positionId: position.positionId, err: error },
          'exit drill failed for this position',
        );
        results.push({
          positionId: position.positionId,
          passed: false,
          gasEstimate: undefined,
          estimatedBlocksToExit: undefined,
        });
      } finally {
        scratchDb.close();
      }
    }
  }

  return results;
}
