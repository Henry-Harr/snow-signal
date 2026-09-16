import { SystemClock, type Clock } from '../core/clock.js';
import { openDatabase } from '../storage/db.js';
import { DecisionLabelRepository } from '../storage/decision-label-repository.js';
import { DecisionRecordRepository } from '../storage/decision-record-repository.js';

/**
 * `sentinel label <decisionId> <label> [notes]` (docs/SPEC.md §10.3). Free-form
 * `label` text (not a fixed `true|false|unsure` enum, despite spec's example
 * wording) — see `DecisionLabelRepository`'s own doc comment for why: Phase 6
 * (replay scoring, the actual consumer) hasn't defined its taxonomy yet.
 */
export interface LabelOptions {
  dbPath: string;
  decisionId: number;
  label: string;
  notes?: string;
  clock?: Clock;
}

export type LabelResult =
  { ok: true; positionId: string; level: string } | { ok: false; reason: string };

export function runLabel(options: LabelOptions): LabelResult {
  const db = openDatabase(options.dbPath);
  try {
    const decisionRecords = new DecisionRecordRepository(db);
    const record = decisionRecords.findById(options.decisionId);
    if (!record) {
      return { ok: false, reason: `No decision found with id ${options.decisionId}.` };
    }

    const decisionLabels = new DecisionLabelRepository(db);
    const clock = options.clock ?? new SystemClock();
    decisionLabels.set(options.decisionId, options.label, options.notes, clock.now());

    return { ok: true, positionId: record.positionId, level: record.level };
  } finally {
    db.close();
  }
}
