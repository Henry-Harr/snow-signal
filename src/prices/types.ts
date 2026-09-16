import type { BlockRef, ChainId } from '../core/types.js';

/**
 * One raw price observation from one source (docs/SPEC.md #6.5). Kept as a plain,
 * storable record — `PriceSource.fetchQuotes` returns these, `PriceQuoteRepository`
 * stores every one of them (never overwritten), and `aggregate.ts` consumes arrays of
 * them. `asset`/`quoteAsset` are symbols (e.g. `"USDC"`, `"USD"`), not addresses —
 * the common denominator across on-chain feeds, DEX pools, and CEX tickers, none of
 * which share a single address space.
 */
export interface PriceQuote {
  source: string;
  asset: string;
  quoteAsset: string;
  price: number;
  /** Epoch seconds. For on-chain sources, the feed's own last-updated timestamp
   * (not necessarily the block being read at); for CEX sources, when Sentinel polled
   * it — always read through a `Clock`, never `Date.now()` directly (docs/
   * ARCHITECTURE.md #2), so replay can feed historical timestamps. */
  fetchedAt: number;
  /** Present for on-chain sources — the block the read was pinned to. */
  chainId?: ChainId;
  blockNumber?: bigint;
  /** Protocol-specific extras, zod-validated by the source before being placed here
   * (docs/SPEC.md #6: RPC/API responses are never trusted without a schema). */
  raw: unknown;
}

export interface PriceSource {
  id: string;
  /** Reads (or polls) a price for every requested asset symbol. `at` pins on-chain
   * sources to a specific block, per docs/ARCHITECTURE.md #1 ("every read in a
   * snapshot is pinned to one block number"); CEX sources ignore `at.number` (there's
   * no block-pinning concept for an off-chain ticker) but still tag `fetchedAt` from
   * the same pipeline pass. */
  fetchQuotes(assets: string[], at: BlockRef): Promise<PriceQuote[]>;
}
