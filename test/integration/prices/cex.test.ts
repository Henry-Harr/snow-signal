import { describe, expect, it } from 'vitest';

import { CoinbasePriceSource, KrakenPriceSource } from '../../../src/prices/cex.js';
import { SystemClock } from '../../../src/core/clock.js';
import type { BlockRef } from '../../../src/core/types.js';

/**
 * Live integration test against the real Coinbase and Kraken public ticker APIs
 * (docs/SPEC.md #9.4) — no anvil/RPC needed, just outbound HTTPS, which this
 * environment already relies on elsewhere (`sentinel doctor`, `pnpm install`, the
 * research this session did to find these endpoints). Both endpoints are public and
 * unauthenticated, verified reachable via direct `curl` on 2026-09-16 (docs/SOURCES.md).
 */
const AT: BlockRef = { chainId: 1, number: 0n, hash: '0x0', timestamp: 0 };

describe('CoinbasePriceSource (live integration)', () => {
  it('returns a plausible real USDC/USD spot price', async () => {
    const source = new CoinbasePriceSource({ clock: new SystemClock() });
    const [quote] = await source.fetchQuotes(['USDC'], AT);
    expect(quote).toBeDefined();
    expect(quote!.price).toBeGreaterThan(0.9);
    expect(quote!.price).toBeLessThan(1.1);
  });

  it('returns a plausible real WETH/USD spot price', async () => {
    const source = new CoinbasePriceSource({ clock: new SystemClock() });
    const [quote] = await source.fetchQuotes(['WETH'], AT);
    expect(quote).toBeDefined();
    expect(quote!.price).toBeGreaterThan(100);
    expect(quote!.price).toBeLessThan(100_000);
  });
});

describe('KrakenPriceSource (live integration)', () => {
  it('returns a plausible real USDC/USD ticker price', async () => {
    const source = new KrakenPriceSource({ clock: new SystemClock() });
    const [quote] = await source.fetchQuotes(['USDC'], AT);
    expect(quote).toBeDefined();
    expect(quote!.price).toBeGreaterThan(0.9);
    expect(quote!.price).toBeLessThan(1.1);
  });

  it('returns a plausible real WETH/USD ticker price', async () => {
    const source = new KrakenPriceSource({ clock: new SystemClock() });
    const [quote] = await source.fetchQuotes(['WETH'], AT);
    expect(quote).toBeDefined();
    expect(quote!.price).toBeGreaterThan(100);
    expect(quote!.price).toBeLessThan(100_000);
  });
});

describe('Coinbase and Kraken agree closely on live prices', () => {
  it('USDC/USD quotes from both exchanges are within 2% of each other', async () => {
    const coinbase = new CoinbasePriceSource({ clock: new SystemClock() });
    const kraken = new KrakenPriceSource({ clock: new SystemClock() });
    const [[cbQuote], [krQuote]] = await Promise.all([
      coinbase.fetchQuotes(['USDC'], AT),
      kraken.fetchQuotes(['USDC'], AT),
    ]);
    expect(cbQuote).toBeDefined();
    expect(krQuote).toBeDefined();
    const diff = Math.abs(cbQuote!.price - krQuote!.price) / cbQuote!.price;
    expect(diff).toBeLessThan(0.02);
  });
});
