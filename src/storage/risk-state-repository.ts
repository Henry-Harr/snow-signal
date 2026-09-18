import type { SentinelDatabase } from './db.js';
import type { PositionRiskState, RiskLevel } from '../risk/types.js';

interface RiskStateRow {
  position_id: string;
  level: string;
  since: string;
  pending_deescalation_level: string | null;
  pending_deescalation_since: string | null;
  acked_decision_id: number | null;
  muted_until: string | null;
  forced_level: string | null;
  last_notified_signal_key: string | null;
}

function rowToState(row: RiskStateRow): PositionRiskState {
  return {
    positionId: row.position_id,
    level: row.level as RiskLevel,
    since: new Date(row.since),
    ...(row.pending_deescalation_level !== null && row.pending_deescalation_since !== null
      ? {
          pendingDeescalation: {
            rawLevel: row.pending_deescalation_level as RiskLevel,
            since: new Date(row.pending_deescalation_since),
          },
        }
      : {}),
    manualControls: {
      ...(row.acked_decision_id !== null ? { ackedDecisionId: String(row.acked_decision_id) } : {}),
      ...(row.muted_until !== null ? { mutedUntil: new Date(row.muted_until) } : {}),
      ...(row.forced_level !== null ? { forcedLevel: row.forced_level as RiskLevel } : {}),
    },
    ...(row.last_notified_signal_key !== null
      ? { lastNotifiedSignalKey: row.last_notified_signal_key }
      : {}),
  };
}

/** Persists the current per-position `PositionRiskState` (docs/SPEC.md #8.1) —
 * UPSERT, not append-only, since this is "where things stand right now" (see
 * migration 7's own comment). The history of how it got here lives in
 * `decision_records` instead. */
export class RiskStateRepository {
  constructor(private readonly db: SentinelDatabase) {}

  get(positionId: string): PositionRiskState | undefined {
    const row = this.db
      .prepare(`SELECT * FROM risk_state WHERE position_id = ?`)
      .get(positionId) as RiskStateRow | undefined;
    return row ? rowToState(row) : undefined;
  }

  save(state: PositionRiskState, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO risk_state
           (position_id, level, since, pending_deescalation_level, pending_deescalation_since,
            acked_decision_id, muted_until, forced_level, last_notified_signal_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (position_id) DO UPDATE SET
           level = excluded.level,
           since = excluded.since,
           pending_deescalation_level = excluded.pending_deescalation_level,
           pending_deescalation_since = excluded.pending_deescalation_since,
           acked_decision_id = excluded.acked_decision_id,
           muted_until = excluded.muted_until,
           forced_level = excluded.forced_level,
           last_notified_signal_key = excluded.last_notified_signal_key,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.positionId,
        state.level,
        state.since.toISOString(),
        state.pendingDeescalation?.rawLevel ?? null,
        state.pendingDeescalation?.since.toISOString() ?? null,
        state.manualControls.ackedDecisionId ? Number(state.manualControls.ackedDecisionId) : null,
        state.manualControls.mutedUntil?.toISOString() ?? null,
        state.manualControls.forcedLevel ?? null,
        state.lastNotifiedSignalKey ?? null,
        now.toISOString(),
      );
  }

  /** Every currently-persisted position state — used to resume all positions on
   * startup rather than requiring the caller to already know every position id. */
  findAll(): PositionRiskState[] {
    const rows = this.db.prepare(`SELECT * FROM risk_state`).all() as RiskStateRow[];
    return rows.map(rowToState);
  }
}
