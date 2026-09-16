import { z } from 'zod';

import type { PriceQuote, PriceSource } from './types.js';
import type { Clock } from '../core/clock.js';
import type { BlockRef } from '../core/types.js';
import type { Logger } from '../core/logger.js';

/**
 * CEX ticker price sources (docs/SPEC.md #6.5: "the public ticker APIs of at least
 * two centralized exchanges, for example Coinbase and Kraken"). Both endpoints
 * verified live this session (2026-09-16, direct `curl`) — see docs/SOURCES.md.
 *
 * Neither exchange's simple ticker endpoint returns its own "as of" timestamp, so
 * `fetchedAt` is when Sentinel polled it (`clock.now()`), read through the injected
 * `Clock` rather than `Date.now()` (docs/ARCHITECTURE.md #2) so replay can feed a
 * historical timestamp — CEX sources aren't replayable from cache the way an
 * archive-RPC-backed on-chain read is (a REST API has no historical query), so Phase
 * 6's replay harness will need its own answer for this (cached recordings from a live
 * run, most likely) — out of scope here.
 *
 * `WETH`/`USDC` are the only symbols mapped right now — deliberately conservative:
 * `WETH` prices correctly against Coinbase/Kraken's `ETH` ticker (1:1 wrapped), but
 * something like `wstETH` does **not** trade 1:1 with `ETH` and has no direct major-
 * CEX ticker, so it's left unmapped rather than silently priced wrong.
 */
const CEX_SYMBOL_MAP: Record<string, string> = {
  WETH: 'ETH',
  USDC: 'USDC',
};

function resolveCexSymbol(asset: string): string | undefined {
  return CEX_SYMBOL_MAP[asset];
}

export interface CexPriceSourceOptions {
  clock: Clock;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

const coinbaseSpotSchema = z.object({
  data: z.object({ amount: z.string(), base: z.string(), currency: z.string() }),
});

export class CoinbasePriceSource implements PriceSource {
  readonly id = 'coinbase';
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(options: CexPriceSourceOptions) {
    this.clock = options.clock;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  async fetchQuotes(assets: string[], _at: BlockRef): Promise<PriceQuote[]> {
    const fetchedAt = Math.floor(this.clock.now().getTime() / 1000);
    const results = await Promise.all(
      assets.map(async (asset): Promise<PriceQuote | undefined> => {
        const symbol = resolveCexSymbol(asset);
        if (!symbol) {
          this.logger?.debug({ asset }, 'no Coinbase symbol mapping known');
          return undefined;
        }
        const response = await this.fetchImpl(
          `https://api.coinbase.com/v2/prices/${symbol}-USD/spot`,
        );
        if (!response.ok) {
          this.logger?.warn(
            { asset, symbol, status: response.status },
            'Coinbase spot price request failed',
          );
          return undefined;
        }
        const body = coinbaseSpotSchema.parse(await response.json());
        const price = Number(body.data.amount);
        if (!Number.isFinite(price) || price <= 0) {
          this.logger?.warn(
            { asset, symbol, amount: body.data.amount },
            'Coinbase returned a non-positive price',
          );
          return undefined;
        }
        return { source: this.id, asset, quoteAsset: 'USD', price, fetchedAt, raw: body.data };
      }),
    );
    return results.filter((q): q is PriceQuote => q !== undefined);
  }
}

const krakenTickerSchema = z.object({
  error: z.array(z.string()),
  result: z.record(z.string(), z.object({ c: z.tuple([z.string(), z.string()]) })),
});

export class KrakenPriceSource implements PriceSource {
  readonly id = 'kraken';
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(options: CexPriceSourceOptions) {
    this.clock = options.clock;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  async fetchQuotes(assets: string[], _at: BlockRef): Promise<PriceQuote[]> {
    const fetchedAt = Math.floor(this.clock.now().getTime() / 1000);
    const results = await Promise.all(
      assets.map(async (asset): Promise<PriceQuote | undefined> => {
        const symbol = resolveCexSymbol(asset);
        if (!symbol) {
          this.logger?.debug({ asset }, 'no Kraken symbol mapping known');
          return undefined;
        }
        const response = await this.fetchImpl(
          `https://api.kraken.com/0/public/Ticker?pair=${symbol}USD`,
        );
        if (!response.ok) {
          this.logger?.warn(
            { asset, symbol, status: response.status },
            'Kraken ticker request failed',
          );
          return undefined;
        }
        const body = krakenTickerSchema.parse(await response.json());
        if (body.error.length > 0) {
          this.logger?.warn({ asset, symbol, errors: body.error }, 'Kraken returned an error');
          return undefined;
        }
        // Kraken keys the result by its own internal pair name (e.g. "XETHZUSD" for
        // an "ETHUSD" query), not the queried pair string — take whatever single
        // entry came back rather than guessing the key format.
        const entry = Object.values(body.result)[0];
        if (!entry) {
          this.logger?.warn({ asset, symbol }, 'Kraken returned no ticker entry');
          return undefined;
        }
        const price = Number(entry.c[0]); // [0] = last trade closed price
        if (!Number.isFinite(price) || price <= 0) {
          this.logger?.warn(
            { asset, symbol, price: entry.c[0] },
            'Kraken returned a non-positive price',
          );
          return undefined;
        }
        return { source: this.id, asset, quoteAsset: 'USD', price, fetchedAt, raw: entry };
      }),
    );
    return results.filter((q): q is PriceQuote => q !== undefined);
  }
}
