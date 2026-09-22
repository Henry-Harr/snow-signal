import type { StopLossDatabase } from './db.js';
import type { ExecutionOutcome } from '../stoploss/executor.js';

export class TriggerLogRepository {
  constructor(private readonly db: StopLossDatabase) {}

  record(outcome: ExecutionOutcome, at: Date): number {
    const result = this.db
      .prepare(
        `INSERT INTO trigger_log
           (at, label, token_id, trigger_price, limit_price, maker_amount, taker_amount, kind, order_id, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at.toISOString(),
        outcome.trigger.position.label,
        outcome.trigger.position.tokenId,
        outcome.trigger.triggerPrice,
        outcome.limitPrice,
        outcome.makerAmount.toString(),
        outcome.takerAmount.toString(),
        outcome.kind,
        outcome.orderId ?? null,
        outcome.errorMsg ?? null,
      );
    return Number(result.lastInsertRowid);
  }
}
