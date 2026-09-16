import type { SentinelDatabase } from './db.js';
import type { PriceQuote } from '../prices/types.js';

interface PriceQuoteRow {
  source: string;
  asset: string;
  quote_asset: string;
  chain_id: number | null;
  price: number;
  fetched_at: number;
  block_number: string | null;
  raw: string;
}

function rowToQuote(row: PriceQuoteRow): PriceQuote {
  return {
    source: row.source,
    asset: row.asset,
    quoteAsset: row.quote_asset,
    price: row.price,
    fetchedAt: row.fetched_at,
    ...(row.chain_id !== null ? { chainId: row.chain_id } : {}),
    ...(row.block_number !== null ? { blockNumber: BigInt(row.block_number) } : {}),
    raw: JSON.parse(row.raw) as unknown,
  };
}

/** Stores every raw price quote from every source (docs/SPEC.md #6.5) — append-only,
 * never overwritten, so aggregation/outlier logic can always be recomputed from the
 * original inputs. */
export class PriceQuoteRepository {
  constructor(private readonly db: SentinelDatabase) {}

  record(quote: PriceQuote): void {
    this.db
      .prepare(
        `INSERT INTO price_quotes
           (source, asset, quote_asset, chain_id, price, fetched_at, block_number, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        quote.source,
        quote.asset,
        quote.quoteAsset,
        quote.chainId ?? null,
        quote.price,
        quote.fetchedAt,
        quote.blockNumber?.toString() ?? null,
        JSON.stringify(quote.raw, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      );
  }

  recordAll(quotes: PriceQuote[]): void {
    const tx = this.db.transaction((qs: PriceQuote[]) => {
      for (const q of qs) this.record(q);
    });
    tx(quotes);
  }

  /** Every quote for `asset`/`quoteAsset` with `fetchedAt` in `[sinceEpochSeconds,
   * untilEpochSeconds]` (inclusive), newest first — the shape aggregation and
   * detectors need: "every recent quote for this asset." */
  findRecent(
    asset: string,
    quoteAsset: string,
    sinceEpochSeconds: number,
    untilEpochSeconds: number,
  ): PriceQuote[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM price_quotes
         WHERE asset = ? AND quote_asset = ? AND fetched_at BETWEEN ? AND ?
         ORDER BY fetched_at DESC`,
      )
      .all(asset, quoteAsset, sinceEpochSeconds, untilEpochSeconds) as PriceQuoteRow[];
    return rows.map(rowToQuote);
  }
}
