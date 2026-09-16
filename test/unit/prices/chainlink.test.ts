import { describe, expect, it } from 'vitest';

import { ChainlinkPriceSource } from '../../../src/prices/chainlink.js';
import type {
  ContractCall,
  ContractCallResult,
  ContractReadClient,
} from '../../../src/chain/client.js';
import { RpcPool, type NamedProvider } from '../../../src/chain/rpc-pool.js';
import { AdapterError } from '../../../src/core/errors.js';
import type { BlockRef } from '../../../src/core/types.js';

const AT: BlockRef = { chainId: 1, number: 21_500_000n, hash: '0xblock', timestamp: 1_700_000_000 };

interface Scenario {
  usdcAnswer: bigint;
  usdcUpdatedAt: bigint;
  wethAnswer: bigint;
}

const defaultScenario: Scenario = {
  usdcAnswer: 99_980_000n, // $0.9998 at 8 decimals
  usdcUpdatedAt: 1_699_999_900n,
  wethAnswer: 240_400_000_000n, // $2404.00 at 8 decimals
};

function mockContractReadClient(scenario: Scenario): ContractReadClient {
  const answer = (call: ContractCall): ContractCallResult => {
    const isUsdcFeed = call.address === '0xEa674bBC33AE708Bc9EB4ba348b04E4eB55b496b';
    const isWethFeed = call.address === '0x5424384B256154046E9667dDFaaa5e550145215e';
    if (call.functionName === 'latestRoundData') {
      if (isUsdcFeed) {
        return {
          status: 'success',
          result: [1n, scenario.usdcAnswer, scenario.usdcUpdatedAt, scenario.usdcUpdatedAt, 1n],
        };
      }
      if (isWethFeed) {
        return {
          status: 'success',
          result: [1n, scenario.wethAnswer, 1_699_999_950n, 1_699_999_950n, 1n],
        };
      }
      return { status: 'failure', error: new Error('unknown feed') };
    }
    if (call.functionName === 'decimals') {
      // uint8 decodes to a plain JS number in viem, not bigint (confirmed against a
      // real fork call — see src/prices/chainlink.ts's comment at the parse site).
      return { status: 'success', result: 8 };
    }
    return { status: 'failure', error: new Error(`unmocked call: ${call.functionName}`) };
  };

  return {
    getBlockNumber: () => Promise.resolve(AT.number),
    getBlock: () =>
      Promise.resolve({
        number: AT.number,
        hash: '0xblock',
        parentHash: '0xparent',
        timestamp: 0n,
      }),
    multicall: (calls) => Promise.resolve(calls.map(answer)),
    getLogs: () => Promise.resolve([]),
  };
}

function makeSource(scenario: Scenario = defaultScenario) {
  const client = mockContractReadClient(scenario);
  const providers: NamedProvider<ContractReadClient>[] = [
    { name: 'a', client },
    { name: 'b', client },
  ];
  const pool = new RpcPool(providers, undefined, { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 });
  return new ChainlinkPriceSource({ chain: 'ethereum', chainId: 1, pool });
}

describe('ChainlinkPriceSource', () => {
  it('has the spec-shaped id', () => {
    expect(makeSource().id).toBe('chainlink:ethereum');
  });

  it('reads a quote for a known asset, normalized by decimals', async () => {
    const [quote] = await makeSource().fetchQuotes(['USDC'], AT);
    expect(quote).toMatchObject({
      source: 'chainlink:ethereum',
      asset: 'USDC',
      quoteAsset: 'USD',
      price: 0.9998,
      fetchedAt: 1_699_999_900,
      chainId: 1,
      blockNumber: 21_500_000n,
    });
  });

  it('reads quotes for multiple known assets in one call', async () => {
    const quotes = await makeSource().fetchQuotes(['USDC', 'WETH'], AT);
    expect(quotes.map((q) => q.asset)).toEqual(['USDC', 'WETH']);
    expect(quotes[1]!.price).toBe(2404);
  });

  it('silently skips an asset with no known feed on this chain, rather than erroring', async () => {
    const quotes = await makeSource().fetchQuotes(['USDC', 'SOME_UNKNOWN_TOKEN'], AT);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.asset).toBe('USDC');
  });

  it('returns an empty array when nothing requested has a known feed', async () => {
    expect(await makeSource().fetchQuotes(['NOPE'], AT)).toEqual([]);
  });

  it('throws AdapterError when a feed reports a non-positive answer', async () => {
    const source = makeSource({ ...defaultScenario, usdcAnswer: 0n });
    await expect(source.fetchQuotes(['USDC'], AT)).rejects.toThrow(AdapterError);
  });
});
