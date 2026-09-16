import { describe, expect, it } from 'vitest';

import {
  createD09Detector,
  D09_ID,
  estimateDexDepth,
} from '../../../src/signals/D09_liquidation_depth.js';
import { assetContext, detectorContext, dexDepthSnapshot } from './helpers.js';

describe('estimateDexDepth', () => {
  it('computes the token0-side depth at a clean 75%-slippage multiplier of exactly 1', () => {
    // 1/sqrt(1-0.75) - 1 = 1/0.5 - 1 = 1, so depth = liquidity/sqrtP exactly.
    const dex = dexDepthSnapshot({
      liquidity: 1_000_000n,
      sqrtPriceX96: 2n ** 96n,
      baseIsToken0: true,
    });
    expect(estimateDexDepth(dex, 0.75)).toBeCloseTo(1_000_000, 6);
  });

  it('computes the token1-side depth the same way when sqrtP = 1 (symmetric point)', () => {
    const dex = dexDepthSnapshot({
      liquidity: 1_000_000n,
      sqrtPriceX96: 2n ** 96n,
      baseIsToken0: false,
    });
    expect(estimateDexDepth(dex, 0.75)).toBeCloseTo(1_000_000, 6);
  });

  it('scales inversely with sqrtP for token0 and directly with sqrtP for token1', () => {
    const sqrtPriceX96At2 = 2n ** 97n; // sqrtP = 2
    const token0Depth = estimateDexDepth(
      dexDepthSnapshot({
        liquidity: 1_000_000n,
        sqrtPriceX96: sqrtPriceX96At2,
        baseIsToken0: true,
      }),
      0.75,
    );
    const token1Depth = estimateDexDepth(
      dexDepthSnapshot({
        liquidity: 1_000_000n,
        sqrtPriceX96: sqrtPriceX96At2,
        baseIsToken0: false,
      }),
      0.75,
    );
    expect(token0Depth).toBeCloseTo(500_000, 6); // 1_000_000 / 2
    expect(token1Depth).toBeCloseTo(2_000_000, 6); // 1_000_000 * 2
  });

  it('divides by 10^decimals for the collateral side', () => {
    const dex = dexDepthSnapshot({
      liquidity: 1_000_000n,
      sqrtPriceX96: 2n ** 96n,
      baseIsToken0: true,
      decimals0: 6,
    });
    expect(estimateDexDepth(dex, 0.75)).toBeCloseTo(1, 6); // 1_000_000 / 10^6
  });

  it('depth grows with the slippage tolerance (more slippage allowed -> more absorbable)', () => {
    const dex = dexDepthSnapshot({
      liquidity: 1_000_000n,
      sqrtPriceX96: 2n ** 96n,
      baseIsToken0: true,
    });
    expect(estimateDexDepth(dex, 0.1)).toBeLessThan(estimateDexDepth(dex, 0.5));
  });
});

describe('D09 liquidation depth', () => {
  const detector = createD09Detector();

  it('emits no signal when collateral fits comfortably within DEX depth', () => {
    const ctx = detectorContext({
      assets: [
        assetContext({
          collateralAmount: 10,
          dexDepth: dexDepthSnapshot({
            liquidity: 1_000_000n,
            sqrtPriceX96: 2n ** 96n,
            baseIsToken0: true,
          }),
        }),
      ],
    });
    // depth at 5% slippage with these params is large (liquidity ~2.6e4), 10 << that.
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('skips assets with no collateralAmount or no dexDepth data', () => {
    const ctx = detectorContext({
      assets: [assetContext()], // default builder leaves collateralAmount/dexDepth unset
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits watch when collateral just exceeds the depth estimate', () => {
    // Using the clean 75%-slippage point: depth = liquidity exactly.
    const detectorAt75 = createD09Detector(undefined, 0.75);
    const ctx = detectorContext({
      assets: [
        assetContext({
          symbol: 'WETH',
          collateralAmount: 1_100_000, // > depth (1_000_000)
          dexDepth: dexDepthSnapshot({
            liquidity: 1_000_000n,
            sqrtPriceX96: 2n ** 96n,
            baseIsToken0: true,
          }),
        }),
      ],
    });
    const [signal] = detectorAt75.evaluate(ctx);
    expect(signal).toMatchObject({
      detectorId: D09_ID,
      family: 'collateral',
      subject: { kind: 'asset', id: 'WETH' },
      severity: 'watch',
    });
  });

  it('emits critical when collateral is many multiples of the depth estimate', () => {
    const detectorAt75 = createD09Detector(undefined, 0.75);
    const ctx = detectorContext({
      assets: [
        assetContext({
          collateralAmount: 10_000_000, // 10x the depth estimate
          dexDepth: dexDepthSnapshot({
            liquidity: 1_000_000n,
            sqrtPriceX96: 2n ** 96n,
            baseIsToken0: true,
          }),
        }),
      ],
    });
    const [signal] = detectorAt75.evaluate(ctx);
    expect(signal?.severity).toBe('critical');
  });
});
