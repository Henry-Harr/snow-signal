import { describe, expect, it } from 'vitest';

import { createD10Detector, D10_ID } from '../../../src/signals/D10_peg_deviation.js';
import { detectorContext, marketContext, position, priceQuote } from './helpers.js';

describe('D10 peg deviation', () => {
  const detector = createD10Detector();

  it('emits no signal when the stablecoin is at peg', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          position: position(),
          positionAssetQuotes: [priceQuote({ price: 0.999 }), priceQuote({ price: 1.001 })],
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('skips markets with no position held', () => {
    const ctx = detectorContext({
      markets: [marketContext({ positionAssetQuotes: [priceQuote({ price: 0.5 })] })],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('skips when there are no independent quotes yet', () => {
    const ctx = detectorContext({
      markets: [marketContext({ position: position(), positionAssetQuotes: [] })],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits watch at a small deviation', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          position: position(),
          positionAssetQuotes: [priceQuote({ price: 0.994 })],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({ detectorId: D10_ID, family: 'peg', severity: 'watch' });
  });

  it('is never standalone-critical, even at a severe depeg (ADR 0005)', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          position: position({ id: 'aave-v3:ethereum:core:USDC' }),
          positionAssetQuotes: [priceQuote({ price: 0.5 })], // a severe, crisis-level depeg
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.severity).toBe('critical');
    expect(signal?.standaloneCritical).toBe(false);
  });

  it('reacts on the deviation from a $1.00 peg specifically, not from a market oracle', () => {
    // Even with no oraclePrices/AssetContext data anywhere in the context, D10 still
    // fires — it only needs the fixed $1.00 reference and independent quotes.
    const ctx = detectorContext({
      markets: [
        marketContext({ position: position(), positionAssetQuotes: [priceQuote({ price: 1.03 })] }),
      ],
      assets: [],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.severity).toBe('danger');
  });
});
