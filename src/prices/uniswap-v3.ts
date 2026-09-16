import { z } from 'zod';

import { resolveUniswapV3Pool, type UniswapV3PoolInfo } from './uniswap-v3-addresses.js';
import type { PriceQuote, PriceSource } from './types.js';
import type { ContractCall, ContractCallResult, ContractReadClient } from '../chain/client.js';
import type { RpcPool } from '../chain/rpc-pool.js';
import { AdapterError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { BlockRef, ChainId } from '../core/types.js';

/** `IUniswapV3PoolDerivedState.observe` — standard across every Uniswap v3 pool,
 * confirmed directly against both pools in `uniswap-v3-addresses.ts` this session via
 * `cast call` (each returned two well-formed `int56[]`/`uint160[]` pairs). */
const uniswapV3PoolAbi = [
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

function unwrap(result: ContractCallResult | undefined, context: string): unknown {
  if (!result) throw new AdapterError(`${context}: missing multicall result`);
  if (result.status === 'failure') throw new AdapterError(`${context}: ${result.error.message}`);
  return result.result;
}

const observeSchema = z.tuple([z.array(z.bigint()), z.array(z.bigint())]);

/** Time-weighted average tick over `[now - windowSeconds, now]`, from two
 * `tickCumulative` snapshots (docs/SPEC.md #6.5: "Uniswap v3 time-weighted averages
 * via `observe()`"). Matches Uniswap's own `OracleLibrary.consult` rounding: integer
 * division truncates toward zero in Solidity, so a negative, non-exact delta needs an
 * explicit floor correction to match the reference implementation. Pure — exported for
 * direct unit testing without mocking a chain client. */
export function averageTick(
  tickCumulativeOld: bigint,
  tickCumulativeNew: bigint,
  windowSeconds: number,
): number {
  const delta = tickCumulativeNew - tickCumulativeOld;
  const window = BigInt(windowSeconds);
  let avgTick = delta / window;
  if (delta < 0n && delta % window !== 0n) avgTick -= 1n;
  return Number(avgTick);
}

/** Converts a tick into a human-readable price of the pool's base asset in terms of
 * its quote asset. Uniswap v3 defines `1.0001^tick` as the raw ratio of token1 to
 * token0 in each token's smallest unit; `10^(decimals0 - decimals1)` rescales that to
 * whole-token units, and the result is inverted when the base asset is token0 (since
 * the raw ratio is always token1-per-token0). Pure — exported for direct unit testing.
 */
export function tickToPrice(tick: number, pool: UniswapV3PoolInfo): number {
  const token1PerToken0 = Math.pow(1.0001, tick) * 10 ** (pool.decimals0 - pool.decimals1);
  return pool.baseIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
}

export interface UniswapV3PriceSourceOptions {
  chain: string;
  chainId: ChainId;
  pool: RpcPool<ContractReadClient>;
  /** TWAP window in seconds. Default 900 (15 minutes) — long enough to resist a
   * single-block manipulation attempt, short enough to track real moves. */
  windowSeconds?: number;
  logger?: Logger;
}

/** Uniswap v3 TWAP price source (docs/SPEC.md #6.5), an independent on-chain
 * cross-check against the Chainlink feed a lending market's oracle actually uses.
 * Quotes are denominated in the pool's quote asset (`USDC` for every pool currently
 * configured), not `USD` — composing that into a USD figure, if a caller ever needs
 * exact precision there, means also pulling the USDC/USD price (Chainlink or CEX) and
 * multiplying; this source doesn't do that composition itself. Only covers assets
 * with a known pool in `uniswap-v3-addresses.ts`; others are silently skipped, same
 * convention as `ChainlinkPriceSource`. */
export class UniswapV3PriceSource implements PriceSource {
  readonly id: string;
  private readonly chain: string;
  private readonly chainId: ChainId;
  private readonly pool: RpcPool<ContractReadClient>;
  private readonly windowSeconds: number;
  private readonly logger: Logger | undefined;

  constructor(options: UniswapV3PriceSourceOptions) {
    this.id = `uniswap-v3:${options.chain}`;
    this.chain = options.chain;
    this.chainId = options.chainId;
    this.pool = options.pool;
    this.windowSeconds = options.windowSeconds ?? 900;
    this.logger = options.logger;
  }

  async fetchQuotes(assets: string[], at: BlockRef): Promise<PriceQuote[]> {
    const known = assets
      .map((asset) => ({ asset, poolInfo: resolveUniswapV3Pool(this.chain, asset) }))
      .filter((entry): entry is { asset: string; poolInfo: UniswapV3PoolInfo } => {
        if (!entry.poolInfo) {
          this.logger?.debug({ chain: this.chain, asset: entry.asset }, 'no Uniswap v3 pool known');
          return false;
        }
        return true;
      });
    if (known.length === 0) return [];

    const calls: ContractCall[] = known.map(({ poolInfo }) => ({
      address: poolInfo.pool,
      abi: uniswapV3PoolAbi,
      functionName: 'observe',
      args: [[this.windowSeconds, 0]],
    }));

    // Prices are decision-critical (docs/SPEC.md #6.1) — quorum-read.
    const results = await this.pool.quorumRead((client) => client.multicall(calls, at.number));

    return known.map(({ asset, poolInfo }, i) => {
      const ctx = `${this.id}:${asset}`;
      const [tickCumulatives] = observeSchema.parse(unwrap(results[i], `${ctx} observe()`));
      const [cumulativeOld, cumulativeNew] = tickCumulatives;
      if (cumulativeOld === undefined || cumulativeNew === undefined) {
        throw new AdapterError(`${ctx}: observe() returned too few tickCumulatives`);
      }
      const tick = averageTick(cumulativeOld, cumulativeNew, this.windowSeconds);
      const price = tickToPrice(tick, poolInfo);

      return {
        source: this.id,
        asset,
        quoteAsset: poolInfo.quoteSymbol,
        price,
        fetchedAt: at.timestamp,
        chainId: this.chainId,
        blockNumber: at.number,
        raw: {
          pool: poolInfo.pool,
          feeTier: poolInfo.feeTier,
          windowSeconds: this.windowSeconds,
          averageTick: tick,
          tickCumulativeOld: cumulativeOld,
          tickCumulativeNew: cumulativeNew,
        },
      };
    });
  }
}
