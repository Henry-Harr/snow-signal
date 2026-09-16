import { createPublicClient, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';
import { UniswapV3PriceSource, averageTick, tickToPrice } from '../../../src/prices/uniswap-v3.js';
import { UNISWAP_V3_POOLS } from '../../../src/prices/uniswap-v3-addresses.js';
import {
  createViemContractReadClient,
  type ContractReadClient,
} from '../../../src/chain/client.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import type { BlockRef, ChainId } from '../../../src/core/types.js';

/**
 * Fork integration test (docs/SPEC.md #9.4). Needs a local `anvil` (Foundry) plus
 * `ETH_RPC_ARCHIVE`/`BASE_RPC_ARCHIVE` set (see test/integration/README.md) — each
 * chain's suite skips cleanly if its RPC var isn't set. Reuses the same block pins as
 * the Chainlink fork test (both pools predate these blocks by years, so there's no
 * "too old" risk — see test/integration/README.md).
 */
const observeAbi = [
  {
    type: 'function',
    name: 'observe',
    stateMutability: 'view',
    inputs: [{ name: 'secondsAgos', type: 'uint32[]' }],
    outputs: [
      { name: 'tickCumulatives', type: 'int56[]' },
      { name: 'secondsPerLiquidityCumulativeX128s', type: 'uint160[]' },
    ],
  },
] as const;

interface ChainCase {
  chain: string;
  chainId: ChainId;
  forkUrl: string | undefined;
  forkBlockNumber: bigint;
}

const CHAIN_CASES: ChainCase[] = [
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

  describeIfForkable(`UniswapV3PriceSource (fork integration, ${testCase.chain})`, () => {
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

    it('WETH/USDC TWAP is a plausible ETH price and matches a direct observe() call', async () => {
      const source = new UniswapV3PriceSource({
        chain: testCase.chain,
        chainId: testCase.chainId,
        pool: rpcPool,
      });
      const [quote] = await source.fetchQuotes(['WETH'], at);
      expect(quote).toBeDefined();
      expect(quote!.quoteAsset).toBe('USDC');
      // Sanity band wide enough to not be a maintenance burden, tight enough to catch
      // a decimals/direction bug (which would be off by orders of magnitude or
      // inverted).
      expect(quote!.price).toBeGreaterThan(100);
      expect(quote!.price).toBeLessThan(100_000);

      const poolInfo = UNISWAP_V3_POOLS[testCase.chain]!['WETH']!;
      const directClient = createPublicClient({ transport: http(fork.rpcUrl) });
      const [tickCumulatives] = await directClient.readContract({
        address: poolInfo.pool,
        abi: observeAbi,
        functionName: 'observe',
        args: [[900, 0]],
        blockNumber: testCase.forkBlockNumber,
      });
      const directTick = averageTick(tickCumulatives[0]!, tickCumulatives[1]!, 900);
      const directPrice = tickToPrice(directTick, poolInfo);
      expect(quote!.price).toBeCloseTo(directPrice, 10);
    });

    it('silently skips an asset with no known pool on this chain', async () => {
      const source = new UniswapV3PriceSource({
        chain: testCase.chain,
        chainId: testCase.chainId,
        pool: rpcPool,
      });
      expect(await source.fetchQuotes(['SOME_UNKNOWN_TOKEN'], at)).toEqual([]);
    });
  });
}
