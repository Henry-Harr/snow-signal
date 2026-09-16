import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { PriceQuoteRepository } from '../../../src/storage/price-quote-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { PriceQuote } from '../../../src/prices/types.js';

describe('PriceQuoteRepository', () => {
  let repo: PriceQuoteRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new PriceQuoteRepository(db);
  });

  it('round-trips a quote, including bigint blockNumber and chainId', () => {
    const q: PriceQuote = {
      source: 'chainlink',
      asset: 'USDC',
      quoteAsset: 'USD',
      price: 0.9998,
      fetchedAt: 1_700_000_000,
      chainId: 1,
      blockNumber: 21_500_000n,
      raw: { roundId: 123n, answer: 99980000n },
    };
    repo.record(q);
    const found = repo.findRecent('USDC', 'USD', 0, 2_000_000_000);
    expect(found).toHaveLength(1);
    // `raw` round-trips through JSON, so a bigint inside it comes back as the string
    // it was serialized to — everything else (including the top-level bigint
    // `blockNumber`, which has its own dedicated column) comes back exactly.
    expect(found[0]).toEqual({ ...q, raw: { roundId: '123', answer: '99980000' } });
  });

  it('round-trips a quote with no chain/block context (a CEX source)', () => {
    const q: PriceQuote = {
      source: 'coinbase',
      asset: 'USDC',
      quoteAsset: 'USD',
      price: 1.0001,
      fetchedAt: 1_700_000_100,
      raw: { amount: '1.0001' },
    };
    repo.record(q);
    const [found] = repo.findRecent('USDC', 'USD', 0, 2_000_000_000);
    expect(found).toEqual(q);
    expect(found).not.toHaveProperty('chainId');
    expect(found).not.toHaveProperty('blockNumber');
  });

  it('findRecent filters by asset/quoteAsset and time range, newest first', () => {
    repo.recordAll([
      { source: 'a', asset: 'USDC', quoteAsset: 'USD', price: 1, fetchedAt: 100, raw: {} },
      { source: 'b', asset: 'USDC', quoteAsset: 'USD', price: 1.01, fetchedAt: 200, raw: {} },
      { source: 'c', asset: 'WETH', quoteAsset: 'USD', price: 2400, fetchedAt: 150, raw: {} },
      { source: 'd', asset: 'USDC', quoteAsset: 'USD', price: 1.02, fetchedAt: 900, raw: {} },
    ]);

    const found = repo.findRecent('USDC', 'USD', 50, 500);
    expect(found.map((q) => q.source)).toEqual(['b', 'a']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(repo.findRecent('DOESNOTEXIST', 'USD', 0, 1_000_000_000)).toEqual([]);
  });
});
