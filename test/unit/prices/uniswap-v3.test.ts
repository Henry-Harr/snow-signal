import { describe, expect, it } from 'vitest';

import { averageTick, tickToPrice, UniswapV3PriceSource } from '../../../src/prices/uniswap-v3.js';
import {
  UNISWAP_V3_POOLS,
  type UniswapV3PoolInfo,
} from '../../../src/prices/uniswap-v3-addresses.js';
import type {
  ContractCall,
  ContractCallResult,
  ContractReadClient,
} from '../../../src/chain/client.js';
import { RpcPool, type NamedProvider } from '../../../src/chain/rpc-pool.js';
import type { BlockRef } from '../../../src/core/types.js';

describe('averageTick', () => {
  it('matches a simple positive delta', () => {
    expect(averageTick(1000n, 5500n, 900)).toBe(5);
  });

  it('floors a negative, non-exact delta toward negative infinity (not toward zero)', () => {
    // delta = -901, window = 900 -> exact quotient -1.0011..., floor is -2, not -1.
    expect(averageTick(1901n, 1000n, 900)).toBe(-2);
  });

  it('handles an exact negative delta without an off-by-one correction', () => {
    expect(averageTick(1900n, 1000n, 900)).toBe(-1);
  });
});

describe('tickToPrice', () => {
  const equalDecimals = (baseIsToken0: boolean): UniswapV3PoolInfo => ({
    pool: '0x0000000000000000000000000000000000000001',
    token0: '0x0000000000000000000000000000000000000002',
    token1: '0x0000000000000000000000000000000000000003',
    decimals0: 18,
    decimals1: 18,
    baseSymbol: 'A',
    quoteSymbol: 'B',
    baseIsToken0,
    feeTier: 500,
  });

  it('is 1 at tick 0 when decimals match', () => {
    expect(tickToPrice(0, equalDecimals(true))).toBe(1);
    expect(tickToPrice(0, equalDecimals(false))).toBe(1);
  });

  it('doubles roughly every ~6931 ticks (ln(2) / ln(1.0001))', () => {
    expect(tickToPrice(6931, equalDecimals(true))).toBeCloseTo(2, 2);
  });

  it('inverts the raw ratio when the base asset is token1 instead of token0', () => {
    const priceAsToken0 = tickToPrice(6931, equalDecimals(true));
    const priceAsToken1 = tickToPrice(6931, equalDecimals(false));
    expect(priceAsToken1).toBeCloseTo(1 / priceAsToken0, 6);
  });

  it('applies the decimals rescale (matches the real Ethereum WETH/USDC pool shape)', () => {
    // token0=USDC(6dp), token1=WETH(18dp), base=WETH=token1 -> price = USDC per WETH.
    const pool = UNISWAP_V3_POOLS['ethereum']!['WETH']!;
    // tick 0 => raw token1-per-token0 ratio of 1, rescaled by 10^(6-18) = 1e-12,
    // inverted (base is token1) => 1e12 USDC per WETH — a nonsense price, but it
    // proves the decimals rescale direction is applied, which is what this test is for.
    expect(tickToPrice(0, pool)).toBeCloseTo(1e12, -6);
  });
});

const AT: BlockRef = { chainId: 1, number: 21_500_000n, hash: '0xblock', timestamp: 1_700_000_000 };
const WETH_POOL = UNISWAP_V3_POOLS['ethereum']!['WETH']!;

function mockContractReadClient(
  tickCumulativeOld: bigint,
  tickCumulativeNew: bigint,
): ContractReadClient {
  const answer = (call: ContractCall): ContractCallResult => {
    if (call.address === WETH_POOL.pool && call.functionName === 'observe') {
      return {
        status: 'success',
        result: [
          [tickCumulativeOld, tickCumulativeNew],
          [0n, 0n],
        ],
      };
    }
    return { status: 'failure', error: new Error('unknown pool') };
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

function makeSource(tickCumulativeOld: bigint, tickCumulativeNew: bigint) {
  const client = mockContractReadClient(tickCumulativeOld, tickCumulativeNew);
  const providers: NamedProvider<ContractReadClient>[] = [
    { name: 'a', client },
    { name: 'b', client },
  ];
  const pool = new RpcPool(providers, undefined, { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 });
  return new UniswapV3PriceSource({ chain: 'ethereum', chainId: 1, pool, windowSeconds: 900 });
}

describe('UniswapV3PriceSource', () => {
  it('has the spec-shaped id', () => {
    expect(makeSource(0n, 900n * 198_494n).id).toBe('uniswap-v3:ethereum');
  });

  it('reads a TWAP-derived quote, denominated in the pool quote asset', async () => {
    // avg tick over the window = 198494 (matches the real pool's observed tick on
    // 2026-09-16, see docs/SOURCES.md) -> roughly $2380-2400/WETH in USDC.
    const [quote] = await makeSource(0n, 900n * 198_494n).fetchQuotes(['WETH'], AT);
    expect(quote).toMatchObject({
      source: 'uniswap-v3:ethereum',
      asset: 'WETH',
      quoteAsset: 'USDC',
      chainId: 1,
      blockNumber: 21_500_000n,
      fetchedAt: 1_700_000_000,
    });
    expect(quote!.price).toBeGreaterThan(1000);
    expect(quote!.price).toBeLessThan(10_000);
  });

  it('silently skips an asset with no known pool on this chain', async () => {
    const quotes = await makeSource(0n, 900n).fetchQuotes(['SOME_UNKNOWN_TOKEN'], AT);
    expect(quotes).toEqual([]);
  });

  it('returns an empty array when nothing requested has a known pool', async () => {
    expect(await makeSource(0n, 900n).fetchQuotes([], AT)).toEqual([]);
  });
});
