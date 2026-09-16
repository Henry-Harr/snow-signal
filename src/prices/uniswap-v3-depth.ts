import { resolveUniswapV3Pool } from './uniswap-v3-addresses.js';
import type { ContractCallResult, ContractReadClient } from '../chain/client.js';
import type { RpcPool } from '../chain/rpc-pool.js';
import { AdapterError } from '../core/errors.js';
import type { BlockRef } from '../core/types.js';
import type { DexDepthSnapshot } from '../signals/types.js';

/**
 * Live Uniswap v3 pool state for D09's liquidation-depth estimate
 * (`src/signals/D09_liquidation_depth.ts`) — `liquidity()` and `slot0()`'s
 * `sqrtPriceX96`, neither of which `src/prices/uniswap-v3.ts` reads (it only needs
 * `observe()` for the TWAP). Kept as a separate module rather than folded into that
 * file since it serves a different consumer (the context assembler building
 * `DexDepthSnapshot`, not a `PriceSource`) — see ADR 0007's consequences section,
 * which flagged this exact gap when Phase 4 deferred it.
 *
 * ABI verified directly on-chain this session (2026-09-16) — the same `slot0()`
 * tuple shape (`uint160,int24,uint16,uint16,uint16,uint8,bool`) already confirmed via
 * `cast call` against both watched pools during Phase 3 (see docs/SOURCES.md's
 * Uniswap v3 section); `liquidity()` (`uint128`) is the same interface every
 * Uniswap v3 pool implements.
 */
const poolStateAbi = [
  {
    type: 'function',
    name: 'liquidity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const;

function unwrap(result: ContractCallResult | undefined, context: string): unknown {
  if (!result) throw new AdapterError(`${context}: missing multicall result`);
  if (result.status === 'failure') throw new AdapterError(`${context}: ${result.error.message}`);
  return result.result;
}

/** `undefined` when no pool is configured for this (chain, asset) — matching
 * `UniswapV3PriceSource`'s own "silently skip, don't error" convention for assets
 * outside its known set. */
export async function fetchDexDepthSnapshot(
  pool: RpcPool<ContractReadClient>,
  chain: string,
  asset: string,
  at: BlockRef,
): Promise<DexDepthSnapshot | undefined> {
  const poolInfo = resolveUniswapV3Pool(chain, asset);
  if (!poolInfo) return undefined;

  const ctx = `dexDepth:${chain}:${asset}`;
  // Depth isn't itself a decision-critical value the way a price/balance is
  // (D09 is already explicitly an approximation — see its own doc comment) —
  // best-effort read, matching the governance/large-holder watchers' treatment of
  // bulk/derived reads.
  return pool.bestEffortRead(async (client) => {
    const [liquidityResult, slot0Result] = await client.multicall(
      [
        { address: poolInfo.pool, abi: poolStateAbi, functionName: 'liquidity' },
        { address: poolInfo.pool, abi: poolStateAbi, functionName: 'slot0' },
      ],
      at.number,
    );
    const liquidity = unwrap(liquidityResult, `${ctx} liquidity()`) as bigint;
    const slot0 = unwrap(slot0Result, `${ctx} slot0()`) as readonly [
      bigint,
      number,
      number,
      number,
      number,
      number,
      boolean,
    ];
    return {
      pool: poolInfo.pool,
      liquidity,
      sqrtPriceX96: slot0[0],
      decimals0: poolInfo.decimals0,
      decimals1: poolInfo.decimals1,
      baseIsToken0: poolInfo.baseIsToken0,
    };
  });
}
