import type { SentinelDatabase } from './db.js';
import type { Decision, RiskLevel } from '../risk/types.js';
import type { Signal } from '../core/types.js';

/** A persisted `Decision` — see `src/risk/types.ts`'s doc comment on `Decision` for
 * why the id lives only here, not on the pure in-memory type. */
export interface DecisionRecord extends Decision {
  id: number;
}

interface DecisionRecordRow {
  id: number;
  position_id: string;
  at: string;
  block_number: string;
  previous_level: string;
  level: string;
  raw_level: string;
  signals: string;
  rule: string;
  action: string;
  standing_alert: number;
  config_hash: string;
}

function rowToRecord(row: DecisionRecordRow): DecisionRecord {
  return {
    id: row.id,
    positionId: row.position_id,
    at: new Date(row.at),
    blockNumber: BigInt(row.block_number),
    previousLevel: row.previous_level as RiskLevel,
    level: row.level as RiskLevel,
    rawLevel: row.raw_level as RiskLevel,
    signals: JSON.parse(row.signals, (_key, value: unknown) =>
      typeof value === 'string' && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value,
    ) as Signal[],
    rule: row.rule,
    action: JSON.parse(row.action) as Decision['action'],
    standingAlert: row.standing_alert === 1,
    configHash: row.config_hash,
  };
}

/** Stores the risk engine's `Decision`s (docs/SPEC.md #5.1, #8.1; docs/adr/0008) —
 * append-only, written on every `decide()` call. `signals` is stored with bigints
 * marked (`"123n"`) rather than silently stringified plain, so `Signal.value`/
 * `.threshold` (numbers) aren't confused with bigint-valued `evidence` fields on the
 * way back out — evidence shapes vary per detector and some do carry raw bigints. */
export class DecisionRecordRepository {
  constructor(private readonly db: SentinelDatabase) {}

  record(decision: Decision): number {
    const result = this.db
      .prepare(
        `INSERT INTO decision_records
           (position_id, at, block_number, previous_level, level, raw_level, signals,
            rule, action, standing_alert, config_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.positionId,
        decision.at.toISOString(),
        decision.blockNumber.toString(),
        decision.previousLevel,
        decision.level,
        decision.rawLevel,
        JSON.stringify(decision.signals, (_key, value: unknown) =>
          typeof value === 'bigint' ? `${value.toString()}n` : value,
        ),
        decision.rule,
        JSON.stringify(decision.action),
        decision.standingAlert ? 1 : 0,
        decision.configHash,
      );
    return Number(result.lastInsertRowid);
  }

  findById(id: number): DecisionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM decision_records WHERE id = ?`).get(id) as
      DecisionRecordRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Most recent decisions for `positionId`, newest first. */
  findRecentForPosition(positionId: string, limit: number): DecisionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM decision_records WHERE position_id = ? ORDER BY at DESC LIMIT ?`)
      .all(positionId, limit) as DecisionRecordRow[];
    return rows.map(rowToRecord);
  }

  /** Every decision at or after `sinceIso` (an ISO timestamp), across every
   * position, oldest first — the daily report's "every alert" / "state transitions"
   * sections read through this. */
  findSince(sinceIso: string): DecisionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM decision_records WHERE at >= ? ORDER BY at ASC`)
      .all(sinceIso) as DecisionRecordRow[];
    return rows.map(rowToRecord);
  }
}
