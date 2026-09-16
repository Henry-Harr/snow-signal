import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AaveV3Adapter } from '../../../src/protocols/aave-v3/adapter.js';
import type { Address, BlockRef } from '../../../src/core/types.js';
import { createSequentialMockReader, ok } from '../../fixtures/mock-contract-reader.js';

const POOL = '0x3333333333333333333333333333333333333333' as Address;
const DATA_PROVIDER = '0x4444444444444444444444444444444444444444' as Address;
const ORACLE = '0x5555555555555555555555555555555555555555' as Address;
const AT: BlockRef = { chainId: 1, number: 100n, hash: '0xblock', timestamp: 1000 };

function addressAt(i: number): Address {
  return `0x${(i + 1).toString(16).padStart(40, '0')}`;
}

/** Property (docs/adr/0001): however many collateral-enabled reserves a pool has,
 * and whatever their relative sizes and prices, their computed shares always sum to
 * 1 (up to floating-point tolerance) and each share is non-negative. */
describe('AaveV3Adapter.collateralExposure property', () => {
  it('shares always sum to 1 across any number of collateral-enabled reserves with nonzero value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            decimals: fc.constantFrom(6, 8, 18),
            totalAToken: fc.bigInt({ min: 1n, max: 10n ** 30n }),
            price: fc.bigInt({ min: 1n, max: 10n ** 15n }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (reserves) => {
          const assets = reserves.map((_, i) => addressAt(i));
          const adapter = new AaveV3Adapter({
            id: 'aave-v3:ethereum:core',
            chainId: 1,
            addresses: { pool: POOL, protocolDataProvider: DATA_PROVIDER, oracle: ORACLE },
            reader: createSequentialMockReader([
              [ok(assets)],
              reserves.flatMap((reserve) => [
                ok([
                  BigInt(reserve.decimals),
                  8000n,
                  8250n,
                  10500n,
                  1000n,
                  true,
                  true,
                  false,
                  true,
                  false,
                ]),
                ok([0n, 0n, reserve.totalAToken, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0]),
                ok(reserve.price),
              ]),
            ]),
          });

          return adapter.collateralExposure(assets[0]!, AT).then((exposure) => {
            const totalShare = exposure.reduce((sum, e) => sum + e.share, 0);
            expect(totalShare).toBeCloseTo(1, 6);
            expect(exposure.every((e) => e.share >= 0)).toBe(true);
          });
        },
      ),
      { numRuns: 30 },
    );
  });
});
