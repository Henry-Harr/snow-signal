import { describe, expect, it } from 'vitest';

import { resolveAssetAddress, resolveAssetSymbol } from '../../../src/core/known-assets.js';
import { AAVE_V3_ASSETS } from '../../../src/protocols/aave-v3/addresses.js';
import { UNISWAP_V3_POOLS } from '../../../src/prices/uniswap-v3-addresses.js';

describe('resolveAssetSymbol', () => {
  it('resolves USDC on both chains from the Aave address registry', () => {
    expect(resolveAssetSymbol('ethereum', AAVE_V3_ASSETS['ethereum']!['USDC']!)).toBe('USDC');
    expect(resolveAssetSymbol('base', AAVE_V3_ASSETS['base']!['USDC']!)).toBe('USDC');
  });

  it('resolves WETH on both chains from the Uniswap pool registry', () => {
    expect(resolveAssetSymbol('ethereum', UNISWAP_V3_POOLS['ethereum']!['WETH']!.token1)).toBe(
      'WETH',
    );
    expect(resolveAssetSymbol('base', UNISWAP_V3_POOLS['base']!['WETH']!.token0)).toBe('WETH');
  });

  it('falls back to the address itself for an unknown asset, rather than throwing', () => {
    const unknown = '0x0000000000000000000000000000000000dEaD';
    expect(resolveAssetSymbol('ethereum', unknown)).toBe(unknown);
  });

  it('returns the address as-is for an unconfigured chain', () => {
    const addr = AAVE_V3_ASSETS['ethereum']!['USDC']!;
    expect(resolveAssetSymbol('arbitrum', addr)).toBe(addr);
  });
});

describe('resolveAssetAddress', () => {
  it('is the inverse of resolveAssetSymbol for known assets', () => {
    expect(resolveAssetAddress('ethereum', 'USDC')).toBe(AAVE_V3_ASSETS['ethereum']!['USDC']);
    expect(resolveAssetAddress('base', 'WETH')).toBe(UNISWAP_V3_POOLS['base']!['WETH']!.token0);
  });

  it('returns undefined for an unknown symbol or chain', () => {
    expect(resolveAssetAddress('ethereum', 'NOT_A_REAL_ASSET')).toBeUndefined();
    expect(resolveAssetAddress('arbitrum', 'USDC')).toBeUndefined();
  });
});
