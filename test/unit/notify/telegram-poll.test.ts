import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pollTelegramUpdatesOnce } from '../../../src/notify/telegram-poll.js';
import { DecisionRecordRepository } from '../../../src/storage/decision-record-repository.js';
import { GlobalControlsRepository } from '../../../src/storage/global-controls-repository.js';
import { RiskStateRepository } from '../../../src/storage/risk-state-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import { FixedClock } from '../../../src/core/clock.js';
import type { TelegramCommandDeps } from '../../../src/notify/telegram-commands.js';

function fetchReturning(getUpdatesResult: unknown): typeof fetch {
  return vi.fn((url: string) => {
    if (url.includes('/getUpdates')) {
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true, result: getUpdatesResult }),
      });
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  }) as unknown as typeof fetch;
}

describe('pollTelegramUpdatesOnce', () => {
  let commandDeps: TelegramCommandDeps;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    commandDeps = {
      riskState: new RiskStateRepository(db),
      decisionRecords: new DecisionRecordRepository(db),
      globalControls: new GlobalControlsRepository(db),
      positionIds: [],
      clock: new FixedClock(new Date('2026-01-01T00:00:00Z')),
    };
  });

  it('returns the same offset when there are no updates', async () => {
    const fetchImpl = fetchReturning([]);
    const next = await pollTelegramUpdatesOnce(
      { botToken: 'tok', allowedChatIds: [], commandDeps, fetchImpl },
      5,
    );
    expect(next).toBe(5);
  });

  it('handles an allowlisted command and replies, advancing the offset past it', async () => {
    const fetchImpl = fetchReturning([
      { update_id: 10, message: { chat: { id: 111 }, text: '/status' } },
    ]);
    const next = await pollTelegramUpdatesOnce(
      { botToken: 'tok', allowedChatIds: ['111'], commandDeps, fetchImpl },
      undefined,
    );
    expect(next).toBe(11);

    const mock = fetchImpl as ReturnType<typeof vi.fn>;
    const sendCall = mock.mock.calls.find((call: unknown[]) =>
      (call[0] as string).includes('/sendMessage'),
    );
    expect(sendCall).toBeDefined();
  });

  it('ignores a command from a non-allowlisted chat and does not reply', async () => {
    const fetchImpl = fetchReturning([
      { update_id: 10, message: { chat: { id: 999 }, text: '/kill' } },
    ]);
    await pollTelegramUpdatesOnce(
      { botToken: 'tok', allowedChatIds: ['111'], commandDeps, fetchImpl },
      undefined,
    );

    const mock = fetchImpl as ReturnType<typeof vi.fn>;
    const sendCall = mock.mock.calls.find((call: unknown[]) =>
      (call[0] as string).includes('/sendMessage'),
    );
    expect(sendCall).toBeUndefined();
    expect(commandDeps.globalControls.isKillSwitchActive()).toBe(false);
  });

  it('advances the offset past every update even when a message has no text', async () => {
    const fetchImpl = fetchReturning([
      { update_id: 10, message: { chat: { id: 111 } } }, // e.g. a photo, no text
      { update_id: 11, message: { chat: { id: 111 }, text: '/status' } },
    ]);
    const next = await pollTelegramUpdatesOnce(
      { botToken: 'tok', allowedChatIds: ['111'], commandDeps, fetchImpl },
      undefined,
    );
    expect(next).toBe(12);
  });
});
