import type { Address } from '../../core/types.js';

/**
 * Addresses for the Aave v3 markets Sentinel currently watches (config/sentinel.yaml:
 * `aave-v3` positions on `ethereum` and `base`, market `core`). Safety rule 6
 * (docs/SPEC.md #2): every address here was pulled directly from an official source
 * this session, not from memory — see docs/SOURCES.md for the fetch dates.
 *
 * Source: `@aave-dao/aave-address-book`,
 * raw.githubusercontent.com/aave-dao/aave-address-book/main/src/AaveV3{Ethereum,Base}.sol
 * (fetched 2026-09-16). These are proxy addresses; re-fetch before trusting them again
 * in a future session, since Aave can upgrade the implementation behind a proxy
 * without changing this address, but a *replacement* deployment would.
 *
 * USDC token addresses: developers.circle.com/stablecoins/usdc-contract-addresses
 * (fetched 2026-09-16) — native, Circle-issued USDC on each chain.
 */
export interface AaveV3MarketAddresses {
  pool: Address;
  poolDataProvider: Address;
  // No static oracle address here: the address book's `ORACLE` export was not
  // independently re-fetched this session (only `POOL` / `AAVE_PROTOCOL_DATA_PROVIDER`
  // were). Rather than hardcode a third unverified literal, the adapter resolves it at
  // runtime, on-chain, via `IPool.ADDRESSES_PROVIDER()` →
  // `IPoolAddressesProvider.getPriceOracle()` — see adapter.ts.
}

export const AAVE_V3_MARKETS: Record<string, Record<string, AaveV3MarketAddresses>> = {
  ethereum: {
    core: {
      pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
      poolDataProvider: '0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD',
    },
  },
  base: {
    core: {
      pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
      poolDataProvider: '0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A',
    },
  },
};

export const AAVE_V3_ASSETS: Record<string, Record<string, Address>> = {
  ethereum: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  base: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
};

export function resolveAaveV3Market(chain: string, market: string): AaveV3MarketAddresses {
  const addresses = AAVE_V3_MARKETS[chain]?.[market];
  if (!addresses) {
    throw new Error(`No known Aave v3 addresses for chain=${chain} market=${market}`);
  }
  return addresses;
}

export function resolveAaveV3Asset(chain: string, asset: string): Address {
  const address = AAVE_V3_ASSETS[chain]?.[asset];
  if (!address) {
    throw new Error(`No known address for asset=${asset} on chain=${chain}`);
  }
  return address;
}
