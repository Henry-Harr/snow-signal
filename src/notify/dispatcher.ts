import type { Alert, Notifier } from './types.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';

/**
 * Alert dispatch: dedup, rate-limit, and repeat-until-ack for CRITICAL (docs/SPEC.md
 * #10.1). `shouldSendAlert` is the pure decision (unit-testable on its own); a
 * `Decision` never at `NORMAL` reaches here at all (the caller only dispatches
 * alerts for `WATCH`/`DANGER`/`CRITICAL`, or a `standingAlert`) — see
 * `src/core/pipeline.ts` for where that filtering happens.
 */
export interface DedupState {
  /** Last send time per `${positionId}:${level}:${rule}` — a rule change (a
   * different reason at the same level) is treated as a new, worth-resending alert
   * rather than deduped against the old reason. */
  lastSentAt: Map<string, Date>;
  /** Last send time per `positionId`, for CRITICAL's separate repeat-until-ack
   * timer (independent of the rate limit above, and on a shorter default cadence). */
  lastCriticalRepeatAt: Map<string, Date>;
}

export function newDedupState(): DedupState {
  return { lastSentAt: new Map(), lastCriticalRepeatAt: new Map() };
}

export interface ShouldSendInput {
  alert: Alert;
  muted: boolean;
  acked: boolean;
  now: Date;
  dedup: DedupState;
  rateLimitSeconds: number;
  criticalRepeatSeconds: number;
}

function dedupKey(alert: Alert): string {
  return `${alert.positionId}:${alert.level}:${alert.rule}`;
}

/** Pure send/no-send decision — does not mutate `dedup` (the caller,
 * `AlertDispatcher.dispatch`, updates it only after a real send succeeds). */
export function shouldSendAlert(input: ShouldSendInput): boolean {
  if (input.muted) return false;

  if (input.alert.level === 'CRITICAL' && !input.acked) {
    const last = input.dedup.lastCriticalRepeatAt.get(input.alert.positionId);
    if (!last) return true;
    return (input.now.getTime() - last.getTime()) / 1000 >= input.criticalRepeatSeconds;
  }

  const last = input.dedup.lastSentAt.get(dedupKey(input.alert));
  if (!last) return true;
  return (input.now.getTime() - last.getTime()) / 1000 >= input.rateLimitSeconds;
}

export interface AlertDispatcherOptions {
  notifiers: Notifier[];
  clock: Clock;
  rateLimitSeconds?: number;
  criticalRepeatSeconds?: number;
  logger?: Logger;
}

export class AlertDispatcher {
  private readonly notifiers: Notifier[];
  private readonly clock: Clock;
  private readonly rateLimitSeconds: number;
  private readonly criticalRepeatSeconds: number;
  private readonly logger: Logger | undefined;
  private readonly dedup: DedupState = newDedupState();

  constructor(options: AlertDispatcherOptions) {
    this.notifiers = options.notifiers;
    this.clock = options.clock;
    this.rateLimitSeconds = options.rateLimitSeconds ?? 900; // 15 minutes
    this.criticalRepeatSeconds = options.criticalRepeatSeconds ?? 600; // 10 minutes
    this.logger = options.logger;
  }

  async dispatch(alert: Alert, muted: boolean, acked: boolean): Promise<void> {
    const now = this.clock.now();
    const send = shouldSendAlert({
      alert,
      muted,
      acked,
      now,
      dedup: this.dedup,
      rateLimitSeconds: this.rateLimitSeconds,
      criticalRepeatSeconds: this.criticalRepeatSeconds,
    });
    if (!send) return;

    const results = await Promise.allSettled(this.notifiers.map((n) => n.send(alert)));
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.logger?.error(
          { notifier: this.notifiers[i]?.id, err: result.reason, positionId: alert.positionId },
          'notifier send failed',
        );
      }
    }

    this.dedup.lastSentAt.set(dedupKey(alert), now);
    if (alert.level === 'CRITICAL') this.dedup.lastCriticalRepeatAt.set(alert.positionId, now);
  }
}
