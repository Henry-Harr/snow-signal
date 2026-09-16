import type { SentinelDatabase } from './db.js';
import type { PaperExecutionOutcome } from '../actions/paper-executor.js';

export interface PaperExecutionEntry {
  positionId: string;
  at: Date;
  blockNumber: bigint;
  outcome: PaperExecutionOutcome;
}

export interface PaperExecutionRecord {
  id: number;
  positionId: string;
  at: Date;
  blockNumber: bigint;
  outcome: PaperExecutionOutcome['kind'];
  stepAmount: bigint | undefined;
  passed: boolean | undefined;
  gasUsed: bigint | undefined;
  failureReason: string | undefined;
}

interface PaperExecutionRow {
  id: number;
  position_id: string;
  at: string;
  block_number: string;
  outcome: string;
  step_amount: string | null;
  passed: number | null;
  gas_used: string | null;
  failure_reason: string | null;
}

function rowToRecord(row: PaperExecutionRow): PaperExecutionRecord {
  return {
    id: row.id,
    positionId: row.position_id,
    at: new Date(row.at),
    blockNumber: BigInt(row.block_number),
    outcome: row.outcome as PaperExecutionOutcome['kind'],
    stepAmount: row.step_amount === null ? undefined : BigInt(row.step_amount),
    passed: row.passed === null ? undefined : row.passed === 1,
    gasUsed: row.gas_used === null ? undefined : BigInt(row.gas_used),
    failureReason: row.failure_reason ?? undefined,
  };
}

/** Append-only audit log for `runPaperExecution` calls (docs/SPEC.md §8.4, migration
 * 11) — "record what would have happened." Deliberately not written for the `'none'`
 * outcome (nothing was planned, so there's nothing to record) — see the migration's
 * own comment. */
export class PaperExecutionRepository {
  constructor(private readonly db: SentinelDatabase) {}

  record(entry: PaperExecutionEntry): number {
    const stepAmount =
      entry.outcome.kind === 'simulated' ? entry.outcome.result.plan.stepAmount : undefined;
    const passed = entry.outcome.kind === 'simulated' ? entry.outcome.result.passed : undefined;
    const gasUsed = entry.outcome.kind === 'simulated' ? entry.outcome.result.gasUsed : undefined;
    const failureReason =
      entry.outcome.kind === 'simulated' ? entry.outcome.result.failureReason : undefined;

    const result = this.db
      .prepare(
        `INSERT INTO paper_executions
           (position_id, at, block_number, outcome, step_amount, passed, gas_used, failure_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.positionId,
        entry.at.toISOString(),
        entry.blockNumber.toString(),
        entry.outcome.kind,
        stepAmount === undefined ? null : stepAmount.toString(),
        passed === undefined ? null : passed ? 1 : 0,
        gasUsed === undefined ? null : gasUsed.toString(),
        failureReason ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  findByPosition(positionId: string, limit = 50): PaperExecutionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM paper_executions WHERE position_id = ? ORDER BY at DESC LIMIT ?`)
      .all(positionId, limit) as PaperExecutionRow[];
    return rows.map(rowToRecord);
  }
}
