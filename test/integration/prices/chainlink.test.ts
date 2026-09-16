import { createPublicClient, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';
import { ChainlinkPriceSource } from '../../../src/prices/chainlink.js';
import { resolveChainlinkFeed } from '../../../src/prices/chainlink-addresses.js';
import {
  createViemContractReadClient,
  type ContractReadClient,
} from '../../../src/chain/client.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import type { BlockRef, ChainId } from '../../../src/core/types.js';

/**
 * Fork integration test (docs/SPEC.md #9.4). Needs a local `anvil` (Foundry) plus
 * `ETH_RPC_ARCHIVE`/`BASE_RPC_ARCHIVE` set (see test/integration/README.md) — each
 * chain's suite skips cleanly if its RPC var isn't set.
 */
const aggregatorV3Abi = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
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
  // Must be recent enough that both feed contracts actually have code at this block —
  // an earlier pinned block (34,000,000, reused from the Morpho fork tests) predated
  // these specific feeds' deployment on Base and failed with "returned no data" per
  // the same failure mode documented in test/integration/README.md.
  {
    chain: 'base',
    chainId: 8453,
    forkUrl: process.env['BASE_RPC_ARCHIVE'],
    forkBlockNumber: 51_370_000n,
  },
];

for (const testCase of CHAIN_CASES) {
  const describeIfForkable = testCase.forkUrl ? describe : describe.skip;

  describeIfForkable(`ChainlinkPriceSource (fork integration, ${testCase.chain})`, () => {
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

    it('USDC/USD is close to $1 and matches a direct latestRoundData() call', async () => {
      const source = new ChainlinkPriceSource({
        chain: testCase.chain,
        chainId: testCase.chainId,
        pool: rpcPool,
      });
      const [quote] = await source.fetchQuotes(['USDC'], at);
      expect(quote).toBeDefined();
      expect(quote!.price).toBeGreaterThan(0.9);
      expect(quote!.price).toBeLessThan(1.1);

      const feed = resolveChainlinkFeed(testCase.chain, 'USDC')!;
      const directClient = createPublicClient({ transport: http(fork.rpcUrl) });
      const direct = await directClient.readContract({
        address: feed.address,
        abi: aggregatorV3Abi,
        functionName: 'latestRoundData',
        blockNumber: testCase.forkBlockNumber,
      });
      expect(quote!.price).toBeCloseTo(Number(direct[1]) / 1e8, 10);
      expect(quote!.fetchedAt).toBe(Number(direct[3]));
    });

    it('WETH/USD is a plausible ETH price and matches a direct call', async () => {
      const source = new ChainlinkPriceSource({
        chain: testCase.chain,
        chainId: testCase.chainId,
        pool: rpcPool,
      });
      const [quote] = await source.fetchQuotes(['WETH'], at);
      expect(quote).toBeDefined();
      // Sanity band wide enough to not be a maintenance burden, tight enough to catch
      // a decimals/scaling bug (which would be off by orders of magnitude).
      expect(quote!.price).toBeGreaterThan(100);
      expect(quote!.price).toBeLessThan(100_000);

      const feed = resolveChainlinkFeed(testCase.chain, 'WETH')!;
      const directClient = createPublicClient({ transport: http(fork.rpcUrl) });
      const direct = await directClient.readContract({
        address: feed.address,
        abi: aggregatorV3Abi,
        functionName: 'latestRoundData',
        blockNumber: testCase.forkBlockNumber,
      });
      expect(quote!.price).toBeCloseTo(Number(direct[1]) / 1e8, 10);
    });
  });
}
