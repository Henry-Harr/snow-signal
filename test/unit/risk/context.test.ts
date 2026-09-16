import { describe, expect, it } from 'vitest';

import { buildAssetExposure, normalizeAaveOraclePrice } from '../../../src/risk/context.js';
import { AAVE_V3_ASSETS } from '../../../src/protocols/aave-v3/addresses.js';
import { UNISWAP_V3_POOLS } from '../../../src/prices/uniswap-v3-addresses.js';
import type { CollateralExposure } from '../../../src/core/types.js';

describe('normalizeAaveOraclePrice', () => {
  it('divides by 1e8 (Aave USD scale)', () => {
    expect(normalizeAaveOraclePrice(99_980_000n)).toBeCloseTo(0.9998, 6);
    expect(normalizeAaveOraclePrice(240_400_000_000n)).toBeCloseTo(2404, 6);
  });
});

function exposure(overrides: Partial<CollateralExposure> = {}): CollateralExposure {
  return {
    marketId: 'aave-v3:ethereum:core',
    asset: UNISWAP_V3_POOLS['ethereum']!['WETH']!.token1,
    shareOfCollateralBase: 0.5,
    method: 'approximate',
    raw: {},
    ...overrides,
  };
}

describe('buildAssetExposure', () => {
  it('groups exposures by resolved symbol', () => {
    const result = buildAssetExposure('ethereum', [
      { marketId: 'aave-v3:ethereum:core', collateralExposure: [exposure()] },
    ]);
    expect(result['WETH']).toEqual([
      { marketId: 'aave-v3:ethereum:core', shareOfCollateralBase: 0.5 },
    ]);
  });

  it('skips exposures for an asset with no known symbol', () => {
    const result = buildAssetExposure('ethereum', [
      {
        marketId: 'aave-v3:ethereum:core',
        collateralExposure: [exposure({ asset: '0x0000000000000000000000000000000000dEaD' })],
      },
    ]);
    expect(result).toEqual({});
  });

  it('combines exposure entries for the same symbol across multiple markets', () => {
    const result = buildAssetExposure('ethereum', [
      {
        marketId: 'm1',
        collateralExposure: [exposure({ marketId: 'm1', shareOfCollateralBase: 0.3 })],
      },
      {
        marketId: 'm2',
        collateralExposure: [exposure({ marketId: 'm2', shareOfCollateralBase: 0.7 })],
      },
    ]);
    expect(result['WETH']).toEqual([
      { marketId: 'm1', shareOfCollateralBase: 0.3 },
      { marketId: 'm2', shareOfCollateralBase: 0.7 },
    ]);
  });

  it('resolves USDC exposures via the Aave asset registry', () => {
    const result = buildAssetExposure('base', [
      {
        marketId: 'aave-v3:base:core',
        collateralExposure: [
          exposure({ marketId: 'aave-v3:base:core', asset: AAVE_V3_ASSETS['base']!['USDC']! }),
        ],
      },
    ]);
    expect(result['USDC']).toHaveLength(1);
  });

  it('returns an empty object for no markets', () => {
    expect(buildAssetExposure('ethereum', [])).toEqual({});
  });
});
