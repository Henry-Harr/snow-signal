import type { Address } from '../core/types.js';

/**
 * Uniswap v3 factory and pool addresses for the DEX price source (docs/SPEC.md #6.5).
 * Safety rule 6 (docs/SPEC.md #2): every address below was verified on-chain this
 * session (2026-09-16) via `cast call`, not taken from memory — see docs/SOURCES.md
 * for the exact calls and reasoning behind the fee-tier choice.
 *
 * The factory address is the same on Ethereum and Base (deterministic CREATE2
 * deployment from `@uniswap/v3-core@1.0.0`) — confirmed by calling `owner()` on both
 * chains and getting a sane, non-reverting address back.
 */
export const UNISWAP_V3_FACTORY: Address = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

export interface UniswapV3PoolInfo {
  pool: Address;
  token0: Address;
  token1: Address;
  /** ERC-20 `decimals()` for token0/token1, verified on-chain — needed to convert the
   * pool's raw tick price into a human-readable one. */
  decimals0: number;
  decimals1: number;
  /** Which side is the asset Sentinel is pricing vs. which is the quote asset, so the
   * source knows which direction to invert the tick-derived ratio. */
  baseSymbol: string;
  quoteSymbol: string;
  /** `true` if `token0` is the base (priced) asset, `false` if `token1` is — needed
   * because Uniswap v3's tick always prices token1 in terms of token0, and token
   * order (which one is token0) isn't consistent across pools (it's whichever
   * address sorts lower), so this can't be inferred from symbols alone. */
  baseIsToken0: boolean;
  feeTier: number;
}

/**
 * One pool per (chain, base asset) pair, chosen as the deepest-liquidity fee tier
 * among the four standard tiers (100/500/3000/10000) — verified by reading
 * `liquidity()` on each candidate pool returned by `factory.getPool()` this session,
 * not assumed from the fee tier that's typically deepest on other chains (Base's
 * WETH/USDC liquidity turned out to be deepest at the 0.3% tier, not the 0.05% tier
 * that's deepest on Ethereum — see docs/SOURCES.md).
 */
export const UNISWAP_V3_POOLS: Record<string, Record<string, UniswapV3PoolInfo>> = {
  ethereum: {
    WETH: {
      pool: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
      token0: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      token1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
      decimals0: 6,
      decimals1: 18,
      baseSymbol: 'WETH',
      quoteSymbol: 'USDC',
      baseIsToken0: false, // WETH is token1 here
      feeTier: 500,
    },
  },
  base: {
    WETH: {
      pool: '0x6c561B446416E1A00E8E93E221854d6eA4171372',
      token0: '0x4200000000000000000000000000000000000006', // WETH
      token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
      decimals0: 18,
      decimals1: 6,
      baseSymbol: 'WETH',
      quoteSymbol: 'USDC',
      baseIsToken0: true, // WETH is token0 here
      feeTier: 3000,
    },
  },
};

export function resolveUniswapV3Pool(chain: string, asset: string): UniswapV3PoolInfo | undefined {
  return UNISWAP_V3_POOLS[chain]?.[asset];
}
