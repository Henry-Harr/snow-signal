import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';
import { fetchDexDepthSnapshot } from '../../../src/prices/uniswap-v3-depth.js';
import { UNISWAP_V3_POOLS } from '../../../src/prices/uniswap-v3-addresses.js';
import {
  createViemContractReadClient,
  type ContractReadClient,
} from '../../../src/chain/client.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import type { BlockRef, ChainId } from '../../../src/core/types.js';

/** Fork integration test (docs/SPEC.md #9.4) — same block pins as the other Uniswap
 * v3 fork tests (both pools predate these blocks by years). */
const CHAIN_CASES: {
  chain: string;
  chainId: ChainId;
  forkUrl: string | undefined;
  forkBlockNumber: bigint;
}[] = [
  {
    chain: 'ethereum',
    chainId: 1,
    forkUrl: process.env['ETH_RPC_ARCHIVE'],
    forkBlockNumber: 25_987_000n,
  },
  {
    chain: 'base',
    chainId: 8453,
    forkUrl: process.env['BASE_RPC_ARCHIVE'],
    forkBlockNumber: 51_370_000n,
  },
];

for (const testCase of CHAIN_CASES) {
  const describeIfForkable = testCase.forkUrl ? describe : describe.skip;

  describeIfForkable(`fetchDexDepthSnapshot (fork integration, ${testCase.chain})`, () => {
    let fork: AnvilFork;
    let rpcPool: RpcPool<ContractReadClient>;
    let at: BlockRef;

    beforeAll(async () => {
      fork = await startAnvilFork({
        forkUrl: testCase.forkUrl!,
        forkBlockNumber: testCase.forkBlockNumber,
      });
      const client = createViemContractReadClient(fork.rpcUrl, testCase.chainId);
      rpcPool = new RpcPool([
        { name: 'fork-a', client },
        { name: 'fork-b', client },
      ]);
      at = {
        chainId: testCase.chainId,
        number: testCase.forkBlockNumber,
        hash: '0x0',
        timestamp: 0,
      };
    }, 60_000);

    afterAll(async () => {
      await fork?.stop();
    });

    it('reads real liquidity and sqrtPriceX96 matching the pool config', async () => {
      const snapshot = await fetchDexDepthSnapshot(rpcPool, testCase.chain, 'WETH', at);
      expect(snapshot).toBeDefined();
      expect(snapshot!.liquidity).toBeGreaterThan(0n);
      expect(snapshot!.sqrtPriceX96).toBeGreaterThan(0n);
      expect(snapshot!.pool).toBe(UNISWAP_V3_POOLS[testCase.chain]!['WETH']!.pool);
    });

    it('returns undefined for an asset with no configured pool', async () => {
      expect(
        await fetchDexDepthSnapshot(rpcPool, testCase.chain, 'SOME_UNKNOWN_ASSET', at),
      ).toBeUndefined();
    });
  });
}
