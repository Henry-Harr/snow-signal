import type { SentinelDatabase } from './db.js';
import type { ProtocolEvent } from '../core/types.js';

interface ProtocolEventRow {
  category: string;
  protocol: string;
  chain_id: number;
  market_id: string;
  event_name: string;
  block_number: string;
  transaction_hash: string;
  log_index: number;
  args: string;
}

function rowToEvent(row: ProtocolEventRow): ProtocolEvent {
  return {
    protocol: row.protocol,
    chainId: row.chain_id,
    marketId: row.market_id,
    eventName: row.event_name,
    blockNumber: BigInt(row.block_number),
    transactionHash: row.transaction_hash as `0x${string}`,
    logIndex: row.log_index,
    args: JSON.parse(row.args) as Record<string, unknown>,
  };
}

export type WatcherCategory = 'governance' | 'token-supply' | 'large-holder';

/** Stores decoded protocol events from every watcher (docs/SPEC.md #6.6) —
 * append-only; re-recording an event already seen (same chain/tx/logIndex) is a
 * silent no-op (`INSERT OR IGNORE`), which is what makes re-scanning an overlapping
 * block range safe. */
export class ProtocolEventRepository {
  constructor(private readonly db: SentinelDatabase) {}

  record(category: WatcherCategory, event: ProtocolEvent): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO protocol_events
           (category, protocol, chain_id, market_id, event_name, block_number, transaction_hash, log_index, args)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        category,
        event.protocol,
        event.chainId,
        event.marketId,
        event.eventName,
        event.blockNumber.toString(),
        event.transactionHash,
        event.logIndex,
        JSON.stringify(event.args, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      );
  }

  recordAll(category: WatcherCategory, events: ProtocolEvent[]): void {
    const tx = this.db.transaction((es: ProtocolEvent[]) => {
      for (const e of es) this.record(category, e);
    });
    tx(events);
  }

  /** Every stored event for `marketId` at or above `sinceBlock`, oldest first (the
   * natural order for replaying "what happened to this market recently"). */
  findByMarket(marketId: string, sinceBlock: bigint): ProtocolEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM protocol_events
         WHERE market_id = ? AND CAST(block_number AS INTEGER) >= ?
         ORDER BY CAST(block_number AS INTEGER) ASC, log_index ASC`,
      )
      .all(marketId, Number(sinceBlock)) as ProtocolEventRow[];
    return rows.map(rowToEvent);
  }
}
