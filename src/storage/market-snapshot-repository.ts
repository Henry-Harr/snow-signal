import type { SentinelDatabase } from './db.js';
import type { MarketSnapshot } from '../core/types.js';

interface MarketSnapshotRow {
  market_id: string;
  protocol: string;
  chain_id: number;
  block_number: string;
  block_hash: string;
  block_timestamp: number;
  total_supplied: string;
  total_borrowed: string;
  available_liquidity: string;
  utilization: number;
  supply_rate: number;
  borrow_rate: number;
  paused: number;
  frozen: number;
  oracle_prices: string;
  bad_debt: string | null;
  raw: string;
}

function rowToSnapshot(row: MarketSnapshotRow): MarketSnapshot {
  // oracle_prices is stored as a plain JSON object of {asset: stringified bigint} —
  // JSON has no bigint type, so each value round-trips through a string.
  const oraclePricesRaw = JSON.parse(row.oracle_prices) as Record<string, string>;
  const oraclePrices: Record<string, bigint> = {};
  for (const [asset, value] of Object.entries(oraclePricesRaw)) {
    oraclePrices[asset] = BigInt(value);
  }

  return {
    marketId: row.market_id,
    block: {
      chainId: row.chain_id,
      number: BigInt(row.block_number),
      hash: row.block_hash as `0x${string}`,
      timestamp: row.block_timestamp,
    },
    totalSupplied: BigInt(row.total_supplied),
    totalBorrowed: BigInt(row.total_borrowed),
    availableLiquidity: BigInt(row.available_liquidity),
    utilization: row.utilization,
    supplyRate: row.supply_rate,
    borrowRate: row.borrow_rate,
    flags: { paused: row.paused === 1, frozen: row.frozen === 1 },
    oraclePrices,
    ...(row.bad_debt !== null ? { badDebt: BigInt(row.bad_debt) } : {}),
    raw: JSON.parse(row.raw) as unknown,
  };
}

/** Stores `MarketSnapshot` history (docs/SPEC.md #6, #5.1 — see migration 5's own
 * comment for why this didn't exist before Phase 5) — append-only, one row per
 * (market, block), so detectors' history windows are always the real recorded
 * series. */
export class MarketSnapshotRepository {
  constructor(private readonly db: SentinelDatabase) {}

  record(protocol: string, snapshot: MarketSnapshot): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO market_snapshots
           (market_id, protocol, chain_id, block_number, block_hash, block_timestamp,
            total_supplied, total_borrowed, available_liquidity, utilization,
            supply_rate, borrow_rate, paused, frozen, oracle_prices, bad_debt, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.marketId,
        protocol,
        snapshot.block.chainId,
        snapshot.block.number.toString(),
        snapshot.block.hash,
        snapshot.block.timestamp,
        snapshot.totalSupplied.toString(),
        snapshot.totalBorrowed.toString(),
        snapshot.availableLiquidity.toString(),
        snapshot.utilization,
        snapshot.supplyRate,
        snapshot.borrowRate,
        snapshot.flags.paused ? 1 : 0,
        snapshot.flags.frozen ? 1 : 0,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(snapshot.oraclePrices).map(([k, v]) => [k, v.toString()]),
          ),
        ),
        snapshot.badDebt?.toString() ?? null,
        JSON.stringify(snapshot.raw, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      );
  }

  recordAll(protocol: string, snapshots: MarketSnapshot[]): void {
    const tx = this.db.transaction((snaps: MarketSnapshot[]) => {
      for (const s of snaps) this.record(protocol, s);
    });
    tx(snapshots);
  }

  /** Every snapshot for `marketId` at or above `sinceBlock`, oldest first — the
   * shape detectors' `MarketContext.history` needs. */
  findHistory(marketId: string, sinceBlock: bigint): MarketSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM market_snapshots
         WHERE market_id = ? AND CAST(block_number AS INTEGER) >= ?
         ORDER BY CAST(block_number AS INTEGER) ASC`,
      )
      .all(marketId, Number(sinceBlock)) as MarketSnapshotRow[];
    return rows.map(rowToSnapshot);
  }

  findLatest(marketId: string): MarketSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM market_snapshots
         WHERE market_id = ?
         ORDER BY CAST(block_number AS INTEGER) DESC
         LIMIT 1`,
      )
      .get(marketId) as MarketSnapshotRow | undefined;
    return row ? rowToSnapshot(row) : undefined;
  }
}
