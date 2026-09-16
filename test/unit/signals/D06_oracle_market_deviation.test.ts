import { describe, expect, it } from 'vitest';

import {
  createD06Detector,
  D06_ID,
  deviationAt,
} from '../../../src/signals/D06_oracle_market_deviation.js';
import { assetContext, assetPricePoint, detectorContext, priceQuote } from './helpers.js';

function pointAt(oraclePrice: number, marketPrice: number) {
  return assetPricePoint({ oraclePrice, marketQuotes: [priceQuote({ price: marketPrice })] });
}

describe('deviationAt', () => {
  it('computes the fractional deviation between oracle and median market price', () => {
    const point = assetPricePoint({
      oraclePrice: 100,
      marketQuotes: [priceQuote({ price: 90 }), priceQuote({ price: 92 })],
    });
    expect(deviationAt(point)).toBeCloseTo(0.09, 5); // |100-91|/100
  });

  it('returns undefined with no independent quotes', () => {
    expect(deviationAt(assetPricePoint({ marketQuotes: [] }))).toBeUndefined();
  });
});

describe('D06 oracle vs market price deviation', () => {
  const detector = createD06Detector();

  it('emits no signal when oracle and market agree', () => {
    const ctx = detectorContext({
      assets: [
        assetContext({
          current: pointAt(100, 100),
          history: [pointAt(100, 100), pointAt(100, 100)],
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('does not fire on a single-block spike that is not sustained (false-positive guard)', () => {
    const ctx = detectorContext({
      assets: [
        assetContext({
          current: pointAt(100, 80), // 20% deviation, but...
          history: [pointAt(100, 100), pointAt(100, 100)], // ...prior readings were fine
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits watch for a sustained borderline deviation', () => {
    const ctx = detectorContext({
      assets: [
        assetContext({
          symbol: 'WETH',
          current: pointAt(100, 98),
          history: [pointAt(100, 98), pointAt(100, 98)],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({
      detectorId: D06_ID,
      family: 'collateral',
      subject: { kind: 'asset', id: 'WETH' },
      severity: 'watch',
      standaloneCritical: false,
    });
  });

  it('emits standalone-critical for a sustained large deviation', () => {
    const ctx = detectorContext({
      assets: [
        assetContext({
          current: pointAt(100, 85),
          history: [pointAt(100, 85), pointAt(100, 85)],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({ severity: 'critical', standaloneCritical: true });
  });

  it('does not fire without enough history to judge "sustained" (false-positive guard: new asset)', () => {
    const ctx = detectorContext({
      assets: [assetContext({ current: pointAt(100, 80), history: [pointAt(100, 80)] })],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });
});
