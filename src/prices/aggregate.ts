import type { PriceQuote } from './types.js';

/**
 * Pure price-aggregation math (docs/SPEC.md #6.5: "aggregate with a median, reject
 * outliers, detect staleness for each source"). No I/O — same purity discipline as
 * `src/signals/**` (docs/ARCHITECTURE.md), so this is trivially unit-testable and
 * replay-deterministic. Detectors (Phase 4) call `aggregatePrice`, not the pieces
 * directly, but the pieces are exported and tested individually since each is a
 * distinct, independently-wrong-able piece of math.
 */

export function median(values: number[]): number {
  if (values.length === 0) throw new RangeError('median of an empty array is undefined');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Median absolute deviation — a robust (outlier-resistant) spread measure, used
 * instead of standard deviation because a single wild quote shouldn't blow out the
 * threshold that's supposed to catch it. */
export function medianAbsoluteDeviation(values: number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

export interface OutlierRejectionResult {
  kept: PriceQuote[];
  rejected: PriceQuote[];
}

/**
 * Rejects quotes more than `madMultiplier` median-absolute-deviations from the
 * median. With fewer than 3 quotes there's nothing statistically meaningful to
 * reject against (MAD of 2 points is either 0 or degenerate) — every quote is kept
 * and it's on the caller (or a later corroboration check) to weigh a thin sample
 * appropriately. A MAD of exactly 0 (every quote identical) keeps everything too,
 * rather than rejecting on a zero-width band.
 */
export function rejectOutliers(quotes: PriceQuote[], madMultiplier = 5): OutlierRejectionResult {
  if (quotes.length < 3) return { kept: quotes, rejected: [] };

  const values = quotes.map((q) => q.price);
  const m = median(values);
  const mad = medianAbsoluteDeviation(values);
  if (mad === 0) return { kept: quotes, rejected: [] };

  const kept: PriceQuote[] = [];
  const rejected: PriceQuote[] = [];
  for (const quote of quotes) {
    if (Math.abs(quote.price - m) <= madMultiplier * mad) kept.push(quote);
    else rejected.push(quote);
  }
  // Never reject everything — an all-outlier result almost always means the median
  // itself was thin/degenerate, not that every source is simultaneously wrong.
  return kept.length === 0 ? { kept: quotes, rejected: [] } : { kept, rejected };
}

/** A quote older than `maxAgeSeconds` relative to `nowEpochSeconds` is stale — the
 * source may have stopped updating (a frozen oracle, a dead API) rather than
 * agreeing the price hasn't moved. */
export function isStale(
  quote: PriceQuote,
  nowEpochSeconds: number,
  maxAgeSeconds: number,
): boolean {
  return nowEpochSeconds - quote.fetchedAt > maxAgeSeconds;
}

export interface AggregatedPrice {
  asset: string;
  quoteAsset: string;
  price: number;
  /** Quotes that went into `price`, after staleness filtering and outlier rejection. */
  contributingQuotes: PriceQuote[];
  staleQuotes: PriceQuote[];
  outlierQuotes: PriceQuote[];
}

/**
 * The full pipeline: drop stale quotes, reject outliers among what's left, take the
 * median of what survives. Throws if nothing survives — callers (detectors, Phase 4)
 * must decide what "no usable price" means for them (e.g. an infra/staleness signal),
 * not silently get a misleading number back.
 */
export function aggregatePrice(
  quotes: PriceQuote[],
  nowEpochSeconds: number,
  maxAgeSeconds: number,
  madMultiplier = 5,
): AggregatedPrice {
  if (quotes.length === 0) {
    throw new RangeError('aggregatePrice: no quotes given');
  }
  const asset = quotes[0]!.asset;
  const quoteAsset = quotes[0]!.quoteAsset;

  const fresh: PriceQuote[] = [];
  const staleQuotes: PriceQuote[] = [];
  for (const q of quotes) {
    (isStale(q, nowEpochSeconds, maxAgeSeconds) ? staleQuotes : fresh).push(q);
  }

  if (fresh.length === 0) {
    throw new RangeError(`aggregatePrice: every quote for ${asset}/${quoteAsset} is stale`);
  }

  const { kept, rejected } = rejectOutliers(fresh, madMultiplier);

  return {
    asset,
    quoteAsset,
    price: median(kept.map((q) => q.price)),
    contributingQuotes: kept,
    staleQuotes,
    outlierQuotes: rejected,
  };
}
