import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  handleTelegramCommand,
  isAllowedChatId,
  parseDuration,
  parseTelegramCommand,
  type TelegramCommandDeps,
} from '../../../src/notify/telegram-commands.js';
import { DecisionRecordRepository } from '../../../src/storage/decision-record-repository.js';
import { GlobalControlsRepository } from '../../../src/storage/global-controls-repository.js';
import { RiskStateRepository } from '../../../src/storage/risk-state-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import { FixedClock } from '../../../src/core/clock.js';
import type { Decision } from '../../../src/risk/types.js';

describe('parseDuration', () => {
  it.each([
    ['30s', 30],
    ['45m', 2700],
    ['2h', 7200],
    ['1d', 86_400],
  ])('parses %s as %d seconds', (text, expected) => {
    expect(parseDuration(text)).toBe(expected);
  });

  it('returns undefined for an unrecognized format', () => {
    expect(parseDuration('soon')).toBeUndefined();
    expect(parseDuration('5')).toBeUndefined();
    expect(parseDuration('5x')).toBeUndefined();
  });
});

describe('parseTelegramCommand', () => {
  it('parses /status and /positions', () => {
    expect(parseTelegramCommand('/status')).toEqual({ kind: 'status' });
    expect(parseTelegramCommand('/positions')).toEqual({ kind: 'positions' });
  });

  it('parses /ack <id>', () => {
    expect(parseTelegramCommand('/ack 42')).toEqual({ kind: 'ack', decisionId: 42 });
  });

  it('parses /mute <positionId> <duration>', () => {
    expect(parseTelegramCommand('/mute aave-v3:ethereum:core:USDC 1h')).toEqual({
      kind: 'mute',
      positionId: 'aave-v3:ethereum:core:USDC',
      durationSeconds: 3600,
    });
  });

  it('parses /kill', () => {
    expect(parseTelegramCommand('/kill')).toEqual({ kind: 'kill' });
  });

  it('treats a malformed /ack or /mute as unknown rather than guessing', () => {
    expect(parseTelegramCommand('/ack notanumber')).toEqual({
      kind: 'unknown',
      raw: '/ack notanumber',
    });
    expect(parseTelegramCommand('/mute p1 notaduration')).toMatchObject({ kind: 'unknown' });
    expect(parseTelegramCommand('/mute')).toMatchObject({ kind: 'unknown' });
  });

  it('is case-insensitive on the command itself', () => {
    expect(parseTelegramCommand('/STATUS')).toEqual({ kind: 'status' });
  });

  it('falls back to unknown for anything else', () => {
    expect(parseTelegramCommand('hello')).toEqual({ kind: 'unknown', raw: 'hello' });
  });
});

describe('isAllowedChatId', () => {
  it('allows only chat ids in the list', () => {
    expect(isAllowedChatId('111', ['111', '222'])).toBe(true);
    expect(isAllowedChatId('333', ['111', '222'])).toBe(false);
    expect(isAllowedChatId('111', [])).toBe(false);
  });
});

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    positionId: 'aave-v3:ethereum:core:USDC',
    at: new Date('2026-01-01T00:00:00Z'),
    blockNumber: 100n,
    previousLevel: 'NORMAL',
    level: 'DANGER',
    rawLevel: 'DANGER',
    signals: [],
    rule: 'test',
    action: { kind: 'partial_withdraw', fraction: 0.5 },
    standingAlert: false,
    configHash: 'hash',
    ...overrides,
  };
}

describe('handleTelegramCommand', () => {
  let deps: TelegramCommandDeps;
  let riskState: RiskStateRepository;
  let decisionRecords: DecisionRecordRepository;
  let globalControls: GlobalControlsRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    riskState = new RiskStateRepository(db);
    decisionRecords = new DecisionRecordRepository(db);
    globalControls = new GlobalControlsRepository(db);
    deps = {
      riskState,
      decisionRecords,
      globalControls,
      positionIds: ['aave-v3:ethereum:core:USDC', 'morpho-vault:base:0xVAULT'],
      clock: new FixedClock(new Date('2026-01-01T12:00:00Z')),
    };
  });

  it('/status reports each configured position at NORMAL when nothing is persisted yet', () => {
    const reply = handleTelegramCommand({ kind: 'status' }, deps);
    expect(reply).toContain('aave-v3:ethereum:core:USDC: NORMAL');
    expect(reply).toContain('morpho-vault:base:0xVAULT: NORMAL');
  });

  it('/status reflects a persisted risk state', () => {
    riskState.save(
      {
        positionId: 'aave-v3:ethereum:core:USDC',
        level: 'CRITICAL',
        since: new Date(),
        manualControls: {},
      },
      new Date(),
    );
    expect(handleTelegramCommand({ kind: 'status' }, deps)).toContain(
      'aave-v3:ethereum:core:USDC: CRITICAL',
    );
  });

  it('/positions lists every configured position', () => {
    expect(handleTelegramCommand({ kind: 'positions' }, deps)).toBe(
      'aave-v3:ethereum:core:USDC\nmorpho-vault:base:0xVAULT',
    );
  });

  it("/ack <id> stores the ack against that decision's position", () => {
    const id = decisionRecords.record(decision());
    const reply = handleTelegramCommand({ kind: 'ack', decisionId: id }, deps);
    expect(reply).toContain(`Acked decision ${id}`);
    expect(riskState.get('aave-v3:ethereum:core:USDC')?.manualControls.ackedDecisionId).toBe(
      String(id),
    );
  });

  it('/ack for an unknown id reports that clearly, without touching risk_state', () => {
    const reply = handleTelegramCommand({ kind: 'ack', decisionId: 999 }, deps);
    expect(reply).toContain('No decision found');
    expect(riskState.findAll()).toEqual([]);
  });

  it('/mute sets mutedUntil relative to the clock', () => {
    const reply = handleTelegramCommand(
      { kind: 'mute', positionId: 'aave-v3:ethereum:core:USDC', durationSeconds: 3600 },
      deps,
    );
    expect(reply).toContain('2026-01-01T13:00:00.000Z');
    expect(riskState.get('aave-v3:ethereum:core:USDC')?.manualControls.mutedUntil).toEqual(
      new Date('2026-01-01T13:00:00Z'),
    );
  });

  it('/kill activates the global kill switch', () => {
    expect(globalControls.isKillSwitchActive()).toBe(false);
    const reply = handleTelegramCommand({ kind: 'kill' }, deps);
    expect(reply).toContain('Kill switch activated');
    expect(globalControls.isKillSwitchActive()).toBe(true);
  });

  it('an unknown command explains the available commands rather than doing nothing silently', () => {
    const reply = handleTelegramCommand({ kind: 'unknown', raw: 'blah' }, deps);
    expect(reply).toContain('Unknown command');
    expect(reply).toContain('/status');
  });
});
