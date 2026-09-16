import Database from 'better-sqlite3';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ChainStateRepository } from '../../../src/storage/chain-state-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { BlockRef } from '../../../src/core/types.js';

const CHAIN_ID = 1;

/** Property (docs/SPEC.md #6.1 reorg handling): after rolling back from block N, no
 * block numbered N or higher remains recorded, and the repository's own
 * last-processed cursor (if any) is always below N. This must hold for any chain
 * length and any rollback point within it. */
describe('ChainStateRepository.rollbackFrom property', () => {
  it('never leaves a processed block >= the rollback point, for any chain length and rollback point', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }).chain((chainLength) =>
          fc.record({
            chainLength: fc.constant(chainLength),
            rollbackAt: fc.integer({ min: 0, max: chainLength - 1 }),
          }),
        ),
        ({ chainLength, rollbackAt }) => {
          const db = new Database(':memory:');
          runMigrations(db);
          const repo = new ChainStateRepository(db);

          let parentHash: `0x${string}` = '0x0';
          for (let i = 0; i < chainLength; i++) {
            const hash = `0xblock${i}` as `0x${string}`;
            const block: BlockRef = { chainId: CHAIN_ID, number: BigInt(i), hash, timestamp: i };
            repo.recordProcessed(block, parentHash);
            parentHash = hash;
          }

          repo.rollbackFrom(CHAIN_ID, BigInt(rollbackAt));

          for (let i = rollbackAt; i < chainLength; i++) {
            expect(repo.getBlockHash(CHAIN_ID, BigInt(i))).toBeUndefined();
          }

          const last = repo.getLastProcessed(CHAIN_ID);
          if (last !== undefined) {
            expect(last.number).toBeLessThan(BigInt(rollbackAt));
          }

          db.close();
        },
      ),
      { numRuns: 50 },
    );
  });
});
