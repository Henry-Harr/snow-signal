import { describe, expect, it } from 'vitest';

import {
  createD07Detector,
  D07_ID,
  findFrozenSince,
} from '../../../src/signals/D07_frozen_oracle.js';
import { assetContext, assetPricePoint, detectorContext, priceQuote } from './helpers.js';

function pointAt(oraclePrice: number, marketPrice: number) {
  return assetPricePoint({ oraclePrice, marketQuotes: [priceQuote({ price: marketPrice })] });
}

describe('findFrozenSince', () => {
  it('finds the oldest matching point when the oracle has been flat long enough', () => {
    const current = pointAt(100, 100);
    const history = [pointAt(99, 99), pointAt(100, 90), pointAt(100, 95)];
    const frozen = findFrozenSince(current, history, 2);
    expect(frozen?.marketQuotes[0]?.price).toBe(90);
  });

  it('requires at least minFlatReadings matching points', () => {
    const current = pointAt(100, 100);
    const history = [pointAt(99, 99), pointAt(100, 90)]; // only 1 matching point
    expect(findFrozenSince(current, history, 2)).toBeUndefined();
  });

  it('stops at the first non-matching point walking backward', () => {
    const current = pointAt(100, 100);
    const history = [pointAt(100, 90), pointAt(99, 99), pointAt(100, 95)];
    // Walking newest->oldest: index2(100)==match, index1(99)!=100 -> stop. Only 1 match.
    expect(findFrozenSince(current, history, 2)).toBeUndefined();
  });
});

describe('D07 frozen oracle', () => {
  const detector = createD07Detector();

  it('emits no signal when the oracle is actively updating', () => {
    const ctx = detectorContext({
      assets: [
        assetContext({
          current: pointAt(105, 105),
          history: [pointAt(100, 100), pointAt(102, 102)],
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('does not fire when the oracle is flat but the market has not moved (stable, not stuck)', () => {
    const ctx = detectorContext({
      assets: [
        assetContext({
          current: pointAt(100, 100.1),
          history: [pointAt(100, 100), pointAt(100, 99.9)],
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits danger when the oracle is flat while the market moves past the spec-anchored 3%', () => {
    const ctx = detectorContext({
      assets: [
        assetContext({
          symbol: 'xUSD',
          current: pointAt(100, 96),
          history: [pointAt(100, 99), pointAt(100, 100)],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({
      detectorId: D07_ID,
      family: 'collateral',
      subject: { kind: 'asset', id: 'xUSD' },
      severity: 'danger',
    });
  });

  it('emits critical for a large divergence while frozen', () => {
    const ctx = detectorContext({
      assets: [
        assetContext({
          current: pointAt(100, 85),
          history: [pointAt(100, 98), pointAt(100, 100)],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.severity).toBe('critical');
  });

  it('does not fire on a single coincidental match (false-positive guard)', () => {
    const ctx = detectorContext({
      assets: [
        assetContext({
          current: pointAt(100, 80),
          history: [pointAt(99, 99), pointAt(100, 100)], // only the newest history point matches
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });
});
