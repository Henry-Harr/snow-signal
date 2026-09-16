import type { BlockSource } from '../chain/block-source.js';
import type { ContractReadClient } from '../chain/client.js';
import type { RpcPool } from '../chain/rpc-pool.js';
import type { BlockRef, ChainId } from '../core/types.js';

/**
 * A `BlockSource` (same interface `LiveBlockSource` implements — docs/ARCHITECTURE.md
 * #2's "one code path for live and replay") that walks a fixed historical block range
 * at a configurable stride instead of polling for newly confirmed blocks. See ADR
 * 0009 for why a stride rather than every single block.
 */
export interface ReplayBlockSourceOptions {
  chainId: ChainId;
  pool: RpcPool<ContractReadClient>;
  fromBlock: bigint;
  toBlock: bigint;
  sampleIntervalBlocks: bigint;
}

export class ReplayBlockSource implements BlockSource {
  readonly chainId: ChainId;
  private readonly pool: RpcPool<ContractReadClient>;
  private readonly toBlock: bigint;
  private readonly sampleIntervalBlocks: bigint;
  private cursor: bigint;

  constructor(options: ReplayBlockSourceOptions) {
    this.chainId = options.chainId;
    this.pool = options.pool;
    this.toBlock = options.toBlock;
    this.sampleIntervalBlocks = options.sampleIntervalBlocks;
    this.cursor = options.fromBlock;
  }

  /** One sampled block per call, matching `LiveBlockSource.poll()`'s per-call
   * granularity (the replay runner drives the loop, calling this once per step —
   * `[]` signals the range is exhausted). */
  async poll(): Promise<BlockRef[]> {
    if (this.cursor > this.toBlock) return [];

    const blockNumber = this.cursor;
    const block = await this.pool.bestEffortRead((client) => client.getBlock(blockNumber));
    this.cursor += this.sampleIntervalBlocks;

    return [
      {
        chainId: this.chainId,
        number: block.number,
        hash: block.hash,
        timestamp: Number(block.timestamp),
      },
    ];
  }

  /** Whether the range is exhausted — lets the runner stop without an extra `poll()`
   * round trip just to find out. */
  get done(): boolean {
    return this.cursor > this.toBlock;
  }
}
