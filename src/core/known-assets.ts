import { AAVE_V3_ASSETS } from '../protocols/aave-v3/addresses.js';
import { UNISWAP_V3_POOLS } from '../prices/uniswap-v3-addresses.js';
import type { Address } from './types.js';

/**
 * Address ↔ symbol resolution for the assets Sentinel is actually configured to
 * watch — the join ADR 0007 flagged as "not a detector's job" and deferred to the
 * context assembler (`src/risk/context.ts`). Deliberately built by *reusing* the
 * addresses already independently verified elsewhere (`aave-v3/addresses.ts`,
 * `uniswap-v3-addresses.ts`) rather than re-typing them — this file adds no new
 * facts, only a reverse lookup over facts that already exist and are already cited
 * in docs/SOURCES.md.
 *
 * Scoped to exactly what `config/sentinel.yaml` currently watches (USDC on both
 * chains, WETH as the one collateral asset with a Chainlink + Uniswap v3 pool
 * configured) — extending this to a new asset means adding it to those source files
 * first (with the same on-chain verification discipline, safety rule 6), which
 * naturally makes it available here too.
 */
function buildRegistry(): Record<ChainKey, Record<Address, string>> {
  const registry: Record<string, Record<Address, string>> = { ethereum: {}, base: {} };

  for (const [chain, assets] of Object.entries(AAVE_V3_ASSETS)) {
    registry[chain] ??= {};
    for (const [symbol, address] of Object.entries(assets)) {
      registry[chain][address] = symbol;
    }
  }

  for (const [chain, pools] of Object.entries(UNISWAP_V3_POOLS)) {
    registry[chain] ??= {};
    for (const poolInfo of Object.values(pools)) {
      registry[chain][poolInfo.token0] ??= poolInfo.baseIsToken0
        ? poolInfo.baseSymbol
        : poolInfo.quoteSymbol;
      registry[chain][poolInfo.token1] ??= poolInfo.baseIsToken0
        ? poolInfo.quoteSymbol
        : poolInfo.baseSymbol;
    }
  }

  return registry;
}

type ChainKey = 'ethereum' | 'base';

const REGISTRY = buildRegistry();

/** The asset's symbol if known, else the address itself (still a usable, if less
 * readable, display value — never throws for an unknown asset). */
export function resolveAssetSymbol(chain: string, address: Address): string {
  return REGISTRY[chain as ChainKey]?.[address] ?? address;
}

/** The reverse direction: this chain's address for a known symbol, if any. */
export function resolveAssetAddress(chain: string, symbol: string): Address | undefined {
  const chainRegistry = REGISTRY[chain as ChainKey];
  if (!chainRegistry) return undefined;
  for (const [address, sym] of Object.entries(chainRegistry)) {
    if (sym === symbol) return address as Address;
  }
  return undefined;
}
