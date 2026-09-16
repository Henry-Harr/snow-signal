import type { SentinelDatabase } from './db.js';

export interface DecisionLabel {
  decisionId: number;
  label: string;
  notes?: string;
  labeledAt: Date;
}

interface DecisionLabelRow {
  decision_id: number;
  label: string;
  notes: string | null;
  labeled_at: string;
}

function rowToLabel(row: DecisionLabelRow): DecisionLabel {
  return {
    decisionId: row.decision_id,
    label: row.label,
    ...(row.notes !== null ? { notes: row.notes } : {}),
    labeledAt: new Date(row.labeled_at),
  };
}

/** Human-assigned labels on decisions (docs/SPEC.md, "Labeling CLI"; see migration
 * 9's own comment) — free-form label text rather than a fixed enum, since Phase 6
 * (replay scoring, the actual consumer of these) hasn't defined its taxonomy yet;
 * constraining it here would just mean guessing at Phase 6's needs. */
export class DecisionLabelRepository {
  constructor(private readonly db: SentinelDatabase) {}

  set(decisionId: number, label: string, notes: string | undefined, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO decision_labels (decision_id, label, notes, labeled_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (decision_id) DO UPDATE SET
           label = excluded.label, notes = excluded.notes, labeled_at = excluded.labeled_at`,
      )
      .run(decisionId, label, notes ?? null, now.toISOString());
  }

  get(decisionId: number): DecisionLabel | undefined {
    const row = this.db
      .prepare(`SELECT * FROM decision_labels WHERE decision_id = ?`)
      .get(decisionId) as DecisionLabelRow | undefined;
    return row ? rowToLabel(row) : undefined;
  }

  /** Every label for the given decision ids, keyed by decision id — the shape the
   * daily report needs ("every alert, with its evidence and current label") without
   * an N+1 query per decision. */
  findForDecisions(decisionIds: number[]): Map<number, DecisionLabel> {
    if (decisionIds.length === 0) return new Map();
    const placeholders = decisionIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM decision_labels WHERE decision_id IN (${placeholders})`)
      .all(...decisionIds) as DecisionLabelRow[];
    return new Map(rows.map((row) => [row.decision_id, rowToLabel(row)]));
  }
}
