import { describe, expect, it } from 'vitest';

import { AlertDispatcher, newDedupState, shouldSendAlert } from '../../../src/notify/dispatcher.js';
import type { Notifier } from '../../../src/notify/types.js';
import { FixedClock } from '../../../src/core/clock.js';
import { testAlert } from './helpers.js';

describe('shouldSendAlert', () => {
  it('sends the first time for a given position/level/rule', () => {
    expect(
      shouldSendAlert({
        alert: testAlert(),
        muted: false,
        acked: false,
        now: new Date(),
        dedup: newDedupState(),
        rateLimitSeconds: 900,
        criticalRepeatSeconds: 600,
      }),
    ).toBe(true);
  });

  it('never sends while muted, regardless of everything else', () => {
    expect(
      shouldSendAlert({
        alert: testAlert({ level: 'CRITICAL' }),
        muted: true,
        acked: false,
        now: new Date(),
        dedup: newDedupState(),
        rateLimitSeconds: 900,
        criticalRepeatSeconds: 600,
      }),
    ).toBe(false);
  });

  it('rate-limits a repeated non-critical alert with the same rule within the window', () => {
    const dedup = newDedupState();
    const now = new Date('2026-01-01T00:00:00Z');
    dedup.lastSentAt.set(`${testAlert().positionId}:${testAlert().level}:${testAlert().rule}`, now);
    const soon = new Date(now.getTime() + 60_000); // 1 minute later, within a 900s window
    expect(
      shouldSendAlert({
        alert: testAlert(),
        muted: false,
        acked: false,
        now: soon,
        dedup,
        rateLimitSeconds: 900,
        criticalRepeatSeconds: 600,
      }),
    ).toBe(false);
  });

  it('sends again once the rate-limit window has passed', () => {
    const dedup = newDedupState();
    const now = new Date('2026-01-01T00:00:00Z');
    dedup.lastSentAt.set(`${testAlert().positionId}:${testAlert().level}:${testAlert().rule}`, now);
    const later = new Date(now.getTime() + 901_000);
    expect(
      shouldSendAlert({
        alert: testAlert(),
        muted: false,
        acked: false,
        now: later,
        dedup,
        rateLimitSeconds: 900,
        criticalRepeatSeconds: 600,
      }),
    ).toBe(true);
  });

  it('a rule change at the same level resends immediately (not deduped against the old reason)', () => {
    const dedup = newDedupState();
    const now = new Date('2026-01-01T00:00:00Z');
    dedup.lastSentAt.set(`${testAlert().positionId}:${testAlert().level}:old rule`, now);
    expect(
      shouldSendAlert({
        alert: testAlert({ rule: 'a different rule' }),
        muted: false,
        acked: false,
        now: new Date(now.getTime() + 1000),
        dedup,
        rateLimitSeconds: 900,
        criticalRepeatSeconds: 600,
      }),
    ).toBe(true);
  });

  it('repeats an unacked CRITICAL alert on the critical-repeat cadence, ignoring the normal rate limit', () => {
    const dedup = newDedupState();
    const now = new Date('2026-01-01T00:00:00Z');
    const alert = testAlert({ level: 'CRITICAL' });
    dedup.lastCriticalRepeatAt.set(alert.positionId, now);

    const tooSoon = new Date(now.getTime() + 500_000); // < 600s
    expect(
      shouldSendAlert({
        alert,
        muted: false,
        acked: false,
        now: tooSoon,
        dedup,
        rateLimitSeconds: 900,
        criticalRepeatSeconds: 600,
      }),
    ).toBe(false);

    const afterRepeatWindow = new Date(now.getTime() + 601_000);
    expect(
      shouldSendAlert({
        alert,
        muted: false,
        acked: false,
        now: afterRepeatWindow,
        dedup,
        rateLimitSeconds: 900,
        criticalRepeatSeconds: 600,
      }),
    ).toBe(true);
  });

  it('once acked, a CRITICAL alert stops using the fast repeat cadence and follows the normal rate limit instead', () => {
    const dedup = newDedupState();
    const now = new Date('2026-01-01T00:00:00Z');
    const alert = testAlert({ level: 'CRITICAL' });
    // Both timers primed as if this exact alert was just sent a moment ago.
    dedup.lastCriticalRepeatAt.set(alert.positionId, now);
    dedup.lastSentAt.set(`${alert.positionId}:${alert.level}:${alert.rule}`, now);

    const soon = new Date(now.getTime() + 1000);
    // Unacked: would repeat again well before the 900s rate limit, on the fast
    // 600s critical-repeat cadence — but 1s hasn't cleared that either, so still no.
    expect(
      shouldSendAlert({
        alert,
        muted: false,
        acked: false,
        now: soon,
        dedup,
        rateLimitSeconds: 900,
        criticalRepeatSeconds: 600,
      }),
    ).toBe(false);

    // Acked: now governed by the normal (longer) rate limit — still blocked this soon,
    // for a different reason than the unacked case (proving it took the other branch).
    expect(
      shouldSendAlert({
        alert,
        muted: false,
        acked: true,
        now: soon,
        dedup,
        rateLimitSeconds: 900,
        criticalRepeatSeconds: 600,
      }),
    ).toBe(false);

    // Past the fast critical-repeat window but still within the normal rate limit:
    // unacked would now resend, acked must not.
    const pastCriticalRepeat = new Date(now.getTime() + 601_000);
    expect(
      shouldSendAlert({
        alert,
        muted: false,
        acked: false,
        now: pastCriticalRepeat,
        dedup,
        rateLimitSeconds: 900,
        criticalRepeatSeconds: 600,
      }),
    ).toBe(true);
    expect(
      shouldSendAlert({
        alert,
        muted: false,
        acked: true,
        now: pastCriticalRepeat,
        dedup,
        rateLimitSeconds: 900,
        criticalRepeatSeconds: 600,
      }),
    ).toBe(false);
  });
});

function fakeNotifier(sent: unknown[]): Notifier {
  return {
    id: 'fake',
    send: (alert) => {
      sent.push(alert);
      return Promise.resolve();
    },
  };
}

describe('AlertDispatcher', () => {
  it('sends to every configured notifier and updates dedup state on success', async () => {
    const sentA: unknown[] = [];
    const sentB: unknown[] = [];
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    const dispatcher = new AlertDispatcher({
      notifiers: [fakeNotifier(sentA), fakeNotifier(sentB)],
      clock,
    });

    await dispatcher.dispatch(testAlert(), false, false);
    expect(sentA).toHaveLength(1);
    expect(sentB).toHaveLength(1);

    // Immediately dispatching the same alert again is deduped.
    await dispatcher.dispatch(testAlert(), false, false);
    expect(sentA).toHaveLength(1);
  });

  it('does not send anything while muted', async () => {
    const sent: unknown[] = [];
    const dispatcher = new AlertDispatcher({
      notifiers: [fakeNotifier(sent)],
      clock: new FixedClock(new Date()),
    });
    await dispatcher.dispatch(testAlert(), true, false);
    expect(sent).toHaveLength(0);
  });

  it('does not let one failing notifier stop the others from being tried', async () => {
    const sentOk: unknown[] = [];
    const failing: Notifier = {
      id: 'failing',
      send: () => Promise.reject(new Error('boom')),
    };
    const dispatcher = new AlertDispatcher({
      notifiers: [failing, fakeNotifier(sentOk)],
      clock: new FixedClock(new Date()),
    });
    await expect(dispatcher.dispatch(testAlert(), false, false)).resolves.toBeUndefined();
    expect(sentOk).toHaveLength(1);
  });
});
