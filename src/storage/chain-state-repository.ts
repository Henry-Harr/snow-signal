import type { SentinelDatabase } from './db.js';
import type { BlockRef } from '../core/types.js';

interface ChainStateRow {
  chain_id: number;
  last_processed_block: string;
  last_processed_hash: string;
}

interface ProcessedBlockRow {
  block_number: string;
  block_hash: string;
  parent_hash: string;
  timestamp: number;
}

/**
 * Tracks, per chain, the last fully processed block and the hash/parent-hash of every
 * processed block — enough to detect a reorg (new block's parent hash doesn't match
 * the stored hash at height - 1) and to roll back cleanly (docs/SPEC.md #6.1, #5.1
 * "idempotent and restartable").
 */
export class ChainStateRepository {
  constructor(private readonly db: SentinelDatabase) {}

  getLastProcessed(chainId: number): { number: bigint; hash: `0x${string}` } | undefined {
    const row = this.db.prepare('SELECT * FROM chain_state WHERE chain_id = ?').get(chainId) as
      ChainStateRow | undefined;
    if (!row) return undefined;
    return {
      number: BigInt(row.last_processed_block),
      hash: row.last_processed_hash as `0x${string}`,
    };
  }

  getBlockHash(chainId: number, number: bigint): `0x${string}` | undefined {
    const row = this.db
      .prepare('SELECT block_hash FROM processed_blocks WHERE chain_id = ? AND block_number = ?')
      .get(chainId, number.toString()) as Pick<ProcessedBlockRow, 'block_hash'> | undefined;
    return row?.block_hash as `0x${string}` | undefined;
  }

  /** Records a block as processed and advances `last_processed_block`. Call only
   * after `parentHash` has been checked against `getBlockHash(chainId, block.number -
   * 1n)` for a reorg. */
  recordProcessed(block: BlockRef, parentHash: `0x${string}`): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO processed_blocks
             (chain_id, block_number, block_hash, parent_hash, timestamp)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(block.chainId, block.number.toString(), block.hash, parentHash, block.timestamp);
      this.db
        .prepare(
          `INSERT INTO chain_state (chain_id, last_processed_block, last_processed_hash, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(chain_id) DO UPDATE SET
             last_processed_block = excluded.last_processed_block,
             last_processed_hash = excluded.last_processed_hash,
             updated_at = excluded.updated_at`,
        )
        .run(block.chainId, block.number.toString(), block.hash, now);
    });
    tx();
  }

  /** Deletes every processed block at or above `fromNumber` and resets
   * `last_processed_block` to `fromNumber - 1` (or clears it entirely if that would
   * go negative), so the block source reprocesses from the new canonical chain after
   * a detected reorg. */
  rollbackFrom(chainId: number, fromNumber: bigint): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM processed_blocks WHERE chain_id = ? AND CAST(block_number AS INTEGER) >= ?',
        )
        .run(chainId, Number(fromNumber));

      const previousNumber = fromNumber - 1n;
      if (previousNumber < 0n) {
        this.db.prepare('DELETE FROM chain_state WHERE chain_id = ?').run(chainId);
        return;
      }
      const previousHash = this.getBlockHash(chainId, previousNumber);
      if (previousHash) {
        this.db
          .prepare(
            'UPDATE chain_state SET last_processed_block = ?, last_processed_hash = ?, updated_at = ? WHERE chain_id = ?',
          )
          .run(previousNumber.toString(), previousHash, new Date().toISOString(), chainId);
      } else {
        this.db.prepare('DELETE FROM chain_state WHERE chain_id = ?').run(chainId);
      }
    });
    tx();
  }
}
