import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ChainClient } from '../../../src/chain/client.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import { QuorumError } from '../../../src/core/errors.js';

function poolReturning(values: bigint[]): RpcPool {
  const providers = values.map((value, index) => ({
    name: `p${index}`,
    client: {
      getBlockNumber: () => Promise.resolve(value),
      getBlock: (): ReturnType<ChainClient['getBlock']> => {
        throw new Error('not used in this test');
      },
    } satisfies ChainClient,
  }));
  return new RpcPool(providers, undefined, { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 });
}

/** Property (docs/adr/0003, docs/SPEC.md #6.1): quorumRead's decision must depend
 * only on whether the successful providers' values agree — never on which specific
 * values they are. */
describe('RpcPool.quorumRead property', () => {
  it('always succeeds with that value when every provider returns the same value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.integer({ min: 2, max: 5 }),
        async (value, providerCount) => {
          const pool = poolReturning(Array.from({ length: providerCount }, () => value));
          const result = await pool.quorumRead((client) => client.getBlockNumber());
          expect(result).toBe(value);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('always throws QuorumError when any two providers disagree', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .tuple(fc.bigInt({ min: 0n, max: 10_000_000n }), fc.bigInt({ min: 0n, max: 10_000_000n }))
          .filter(([a, b]) => a !== b),
        async ([a, b]) => {
          const pool = poolReturning([a, b]);
          await expect(pool.quorumRead((client) => client.getBlockNumber())).rejects.toThrow(
            QuorumError,
          );
        },
      ),
      { numRuns: 25 },
    );
  });
});
