import { describe, expect, it } from 'vitest';

import {
  aggregatePrice,
  isStale,
  median,
  medianAbsoluteDeviation,
  rejectOutliers,
} from '../../../src/prices/aggregate.js';
import type { PriceQuote } from '../../../src/prices/types.js';

function quote(source: string, price: number, fetchedAt = 1_000): PriceQuote {
  return { source, asset: 'USDC', quoteAsset: 'USD', price, fetchedAt, raw: {} };
}

describe('median', () => {
  it('throws on an empty array', () => {
    expect(() => median([])).toThrow(RangeError);
  });

  it('returns the middle value for an odd-length array', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middle values for an even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('does not mutate the input array', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('medianAbsoluteDeviation', () => {
  it('is zero when every value is identical', () => {
    expect(medianAbsoluteDeviation([1, 1, 1, 1])).toBe(0);
  });

  it('computes the median distance from the median', () => {
    // values: 1,2,3,4,5 -> median 3 -> deviations 2,1,0,1,2 -> median of those = 1
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBe(1);
  });
});

describe('rejectOutliers', () => {
  it('keeps everything when fewer than 3 quotes are given', () => {
    const quotes = [quote('a', 1), quote('b', 100)];
    expect(rejectOutliers(quotes)).toEqual({ kept: quotes, rejected: [] });
  });

  it('keeps everything when every price is identical (MAD is zero)', () => {
    const quotes = [quote('a', 1), quote('b', 1), quote('c', 1)];
    expect(rejectOutliers(quotes)).toEqual({ kept: quotes, rejected: [] });
  });

  it('rejects a quote far outside the median-absolute-deviation band', () => {
    const quotes = [quote('a', 1.0), quote('b', 1.01), quote('c', 0.99), quote('evil', 50)];
    const { kept, rejected } = rejectOutliers(quotes);
    expect(kept.map((q) => q.source)).toEqual(['a', 'b', 'c']);
    expect(rejected.map((q) => q.source)).toEqual(['evil']);
  });

  it('never rejects every quote, even if the whole set is degenerate', () => {
    // Two clusters far apart with a thin median — a naive implementation could end
    // up rejecting everything relative to a median that sits between the clusters.
    const quotes = [quote('a', 1), quote('b', 1), quote('c', 1000), quote('d', 1000)];
    const { kept, rejected } = rejectOutliers(quotes);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length + rejected.length).toBe(quotes.length);
  });
});

describe('isStale', () => {
  it('is false when the quote is within maxAge', () => {
    expect(isStale(quote('a', 1, 1_000), 1_050, 100)).toBe(false);
  });

  it('is true when the quote is older than maxAge', () => {
    expect(isStale(quote('a', 1, 1_000), 1_200, 100)).toBe(true);
  });

  it('is false exactly at the boundary (age === maxAge)', () => {
    expect(isStale(quote('a', 1, 1_000), 1_100, 100)).toBe(false);
  });
});

describe('aggregatePrice', () => {
  it('throws when given no quotes at all', () => {
    expect(() => aggregatePrice([], 1_000, 100)).toThrow(RangeError);
  });

  it('throws when every quote is stale', () => {
    const quotes = [quote('a', 1, 100), quote('b', 1, 100)];
    expect(() => aggregatePrice(quotes, 10_000, 100)).toThrow(/stale/);
  });

  it('drops stale quotes, rejects outliers among the rest, and medians the survivors', () => {
    const quotes = [
      quote('coinbase', 1.0, 990),
      quote('kraken', 1.0, 990),
      quote('chainlink', 1.001, 990),
      quote('dead-source', 1.0, 100), // stale — far in the past relative to now=1000
      quote('bad-feed', 500, 990), // real-time but a wild outlier
    ];
    const result = aggregatePrice(quotes, 1_000, 100);
    expect(result.asset).toBe('USDC');
    expect(result.quoteAsset).toBe('USD');
    expect(result.staleQuotes.map((q) => q.source)).toEqual(['dead-source']);
    expect(result.outlierQuotes.map((q) => q.source)).toEqual(['bad-feed']);
    expect(result.contributingQuotes.map((q) => q.source).sort()).toEqual([
      'chainlink',
      'coinbase',
      'kraken',
    ]);
    expect(result.price).toBeCloseTo(1.0, 5);
  });

  it('still returns a price from a single fresh, non-stale quote', () => {
    const result = aggregatePrice([quote('solo', 1.23, 990)], 1_000, 100);
    expect(result.price).toBe(1.23);
    expect(result.contributingQuotes).toHaveLength(1);
  });
});
