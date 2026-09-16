import type { RpcPool } from './rpc-pool.js';
import { ReorgDetectedError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { BlockRef } from '../core/types.js';
import type { ChainStateRepository } from '../storage/chain-state-repository.js';

/**
 * A source of confirmed blocks for one chain. Both the live pipeline and the replay
 * harness (Phase 6) implement this interface — nothing downstream can tell the
 * difference (docs/ARCHITECTURE.md #1, #2).
 */
export interface BlockSource {
  chainId: number;
  /** Returns every newly confirmed block since the last call, in ascending order.
   * Empty if nothing new has confirmed yet. */
  poll(): Promise<BlockRef[]>;
}

export interface LiveBlockSourceOptions {
  chainId: number;
  confirmations: number;
  pool: RpcPool;
  chainState: ChainStateRepository;
  logger?: Logger;
  /** Safety cap on how many blocks a single reorg-driven rollback may walk back
   * before giving up and surfacing an error for a human to look at, instead of
   * looping indefinitely (docs/SPEC.md #6.1 reorg handling). */
  maxReorgDepth?: number;
}

export class LiveBlockSource implements BlockSource {
  readonly chainId: number;
  private readonly confirmations: number;
  private readonly pool: RpcPool;
  private readonly chainState: ChainStateRepository;
  private readonly logger: Logger | undefined;
  private readonly maxReorgDepth: number;

  constructor(options: LiveBlockSourceOptions) {
    this.chainId = options.chainId;
    this.confirmations = options.confirmations;
    this.pool = options.pool;
    this.chainState = options.chainState;
    this.logger = options.logger;
    this.maxReorgDepth = options.maxReorgDepth ?? 50;
  }

  async poll(): Promise<BlockRef[]> {
    const head = await this.pool.getConservativeHead();
    const confirmedTip = head - BigInt(this.confirmations);
    if (confirmedTip < 0n) return [];

    const lastProcessed = this.chainState.getLastProcessed(this.chainId);
    let cursor = lastProcessed !== undefined ? lastProcessed.number + 1n : confirmedTip;

    const emitted: BlockRef[] = [];
    let reorgWalkbacks = 0;

    while (cursor <= confirmedTip) {
      const block = await this.pool.quorumRead((client) => client.getBlock(cursor));

      const storedParentHash =
        cursor > 0n ? this.chainState.getBlockHash(this.chainId, cursor - 1n) : undefined;

      if (storedParentHash !== undefined && storedParentHash !== block.parentHash) {
        reorgWalkbacks++;
        if (reorgWalkbacks > this.maxReorgDepth) {
          throw new ReorgDetectedError(
            `Reorg walkback exceeded ${this.maxReorgDepth} blocks on chain ${this.chainId} ` +
              `at block ${cursor} — giving up, needs manual investigation`,
            this.chainId,
            cursor,
          );
        }
        this.logger?.warn(
          { chainId: this.chainId, atBlock: cursor.toString() },
          'reorg detected: stored parent hash does not match new block, rolling back',
        );
        this.chainState.rollbackFrom(this.chainId, cursor - 1n);
        cursor -= 1n;
        continue;
      }

      const blockRef: BlockRef = {
        chainId: this.chainId,
        number: block.number,
        hash: block.hash,
        timestamp: Number(block.timestamp),
      };
      this.chainState.recordProcessed(blockRef, block.parentHash);
      emitted.push(blockRef);
      cursor += 1n;
    }

    return emitted;
  }
}
