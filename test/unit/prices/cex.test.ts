import { describe, expect, it, vi } from 'vitest';

import { CoinbasePriceSource, KrakenPriceSource } from '../../../src/prices/cex.js';
import { FixedClock } from '../../../src/core/clock.js';
import type { BlockRef } from '../../../src/core/types.js';

const AT: BlockRef = { chainId: 1, number: 0n, hash: '0x0', timestamp: 0 };
const clock = new FixedClock(new Date('2026-09-16T00:00:00Z'));
const expectedFetchedAt = Math.floor(new Date('2026-09-16T00:00:00Z').getTime() / 1000);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('CoinbasePriceSource', () => {
  it('fetches and normalizes a spot price for a mapped asset', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { amount: '2404.52', base: 'ETH', currency: 'USD' } }),
      );
    const source = new CoinbasePriceSource({ clock, fetchImpl });

    const [quote] = await source.fetchQuotes(['WETH'], AT);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.coinbase.com/v2/prices/ETH-USD/spot');
    expect(quote).toEqual({
      source: 'coinbase',
      asset: 'WETH',
      quoteAsset: 'USD',
      price: 2404.52,
      fetchedAt: expectedFetchedAt,
      raw: { amount: '2404.52', base: 'ETH', currency: 'USD' },
    });
  });

  it('skips an asset with no known CEX symbol mapping', async () => {
    const fetchImpl = vi.fn();
    const source = new CoinbasePriceSource({ clock, fetchImpl });
    const quotes = await source.fetchQuotes(['wstETH'], AT);
    expect(quotes).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drops (does not throw for) a failed HTTP request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    const source = new CoinbasePriceSource({ clock, fetchImpl });
    expect(await source.fetchQuotes(['WETH'], AT)).toEqual([]);
  });

  it('drops a non-positive price rather than propagating it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { amount: '0', base: 'USDC', currency: 'USD' } }));
    const source = new CoinbasePriceSource({ clock, fetchImpl });
    expect(await source.fetchQuotes(['USDC'], AT)).toEqual([]);
  });

  it('fetches multiple mapped assets independently', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: { amount: '1.0001', base: 'USDC', currency: 'USD' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: { amount: '2400', base: 'ETH', currency: 'USD' } }),
      );
    const source = new CoinbasePriceSource({ clock, fetchImpl });
    const quotes = await source.fetchQuotes(['USDC', 'WETH'], AT);
    expect(quotes.map((q) => q.asset)).toEqual(['USDC', 'WETH']);
  });
});

describe('KrakenPriceSource', () => {
  it('fetches and normalizes a ticker price, keyed under Kraken’s own pair name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        error: [],
        result: { XETHZUSD: { c: ['2403.61000', '0.02264766'] } },
      }),
    );
    const source = new KrakenPriceSource({ clock, fetchImpl });

    const [quote] = await source.fetchQuotes(['WETH'], AT);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.kraken.com/0/public/Ticker?pair=ETHUSD');
    expect(quote).toEqual({
      source: 'kraken',
      asset: 'WETH',
      quoteAsset: 'USD',
      price: 2403.61,
      fetchedAt: expectedFetchedAt,
      raw: { c: ['2403.61000', '0.02264766'] },
    });
  });

  it('skips an asset with no known CEX symbol mapping', async () => {
    const fetchImpl = vi.fn();
    const source = new KrakenPriceSource({ clock, fetchImpl });
    expect(await source.fetchQuotes(['cbBTC'], AT)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drops a quote when Kraken reports an API error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: ['EQuery:Unknown asset pair'], result: {} }));
    const source = new KrakenPriceSource({ clock, fetchImpl });
    expect(await source.fetchQuotes(['USDC'], AT)).toEqual([]);
  });

  it('drops a failed HTTP request without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    const source = new KrakenPriceSource({ clock, fetchImpl });
    expect(await source.fetchQuotes(['USDC'], AT)).toEqual([]);
  });
});
