import type { SentinelDatabase } from './db.js';
import type { TokenSupplySnapshot } from '../watchers/token-supply.js';

interface TokenSupplyRow {
  asset: string;
  chain_id: number;
  total_supply: string;
  block_number: string;
  fetched_at: number;
}

function rowToSnapshot(row: TokenSupplyRow): TokenSupplySnapshot {
  return {
    asset: row.asset as `0x${string}`,
    chainId: row.chain_id,
    totalSupply: BigInt(row.total_supply),
    blockNumber: BigInt(row.block_number),
    fetchedAt: row.fetched_at,
  };
}

/** Stores `totalSupply()` time-series readings (docs/SPEC.md #6.6) — append-only;
 * re-recording the same (asset, chain, block) is a silent no-op. */
export class TokenSupplyRepository {
  constructor(private readonly db: SentinelDatabase) {}

  record(snapshot: TokenSupplySnapshot): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO token_supply_snapshots
           (asset, chain_id, total_supply, block_number, fetched_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.asset,
        snapshot.chainId,
        snapshot.totalSupply.toString(),
        snapshot.blockNumber.toString(),
        snapshot.fetchedAt,
      );
  }

  /** Every snapshot for `asset` on `chainId` at or above `sinceBlock`, oldest first —
   * the shape a "how fast is supply growing" check needs. */
  findRecent(asset: `0x${string}`, chainId: number, sinceBlock: bigint): TokenSupplySnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM token_supply_snapshots
         WHERE asset = ? AND chain_id = ? AND CAST(block_number AS INTEGER) >= ?
         ORDER BY CAST(block_number AS INTEGER) ASC`,
      )
      .all(asset, chainId, Number(sinceBlock)) as TokenSupplyRow[];
    return rows.map(rowToSnapshot);
  }
}
