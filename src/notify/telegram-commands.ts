import { initialPositionRiskState } from '../risk/types.js';
import type { Clock } from '../core/clock.js';
import type { DecisionRecordRepository } from '../storage/decision-record-repository.js';
import type { GlobalControlsRepository } from '../storage/global-controls-repository.js';
import type { RiskStateRepository } from '../storage/risk-state-repository.js';

/**
 * Telegram command parsing and handling (docs/SPEC.md #10.1: `/status`,
 * `/positions`, `/ack <id>`, `/mute <id> <duration>`, `/kill`, restricted to
 * allowlisted chat IDs). Parsing is pure (`parseTelegramCommand`); handling
 * (`handleTelegramCommand`) touches storage, so it's tested against real in-memory
 * SQLite repositories (the same pattern every other repository test in this codebase
 * uses) rather than against fakes.
 */
export type TelegramCommand =
  | { kind: 'status' }
  | { kind: 'positions' }
  | { kind: 'ack'; decisionId: number }
  | { kind: 'mute'; positionId: string; durationSeconds: number }
  | { kind: 'kill' }
  | { kind: 'unknown'; raw: string };

/** `30s`/`45m`/`2h`/`1d` → seconds. Returns `undefined` for anything else, rather
 * than guessing a unit. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+)(s|m|h|d)$/.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unitSeconds = { s: 1, m: 60, h: 3600, d: 86_400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return amount * unitSeconds;
}

export function parseTelegramCommand(text: string): TelegramCommand {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case '/status':
      return { kind: 'status' };
    case '/positions':
      return { kind: 'positions' };
    case '/ack': {
      const decisionId = Number(parts[1]);
      if (!parts[1] || !Number.isInteger(decisionId)) return { kind: 'unknown', raw: text };
      return { kind: 'ack', decisionId };
    }
    case '/mute': {
      const positionId = parts[1];
      const durationSeconds = parts[2] ? parseDuration(parts[2]) : undefined;
      if (!positionId || durationSeconds === undefined) return { kind: 'unknown', raw: text };
      return { kind: 'mute', positionId, durationSeconds };
    }
    case '/kill':
      return { kind: 'kill' };
    default:
      return { kind: 'unknown', raw: text };
  }
}

export function isAllowedChatId(chatId: string, allowedChatIds: string[]): boolean {
  return allowedChatIds.includes(chatId);
}

export interface TelegramCommandDeps {
  riskState: RiskStateRepository;
  decisionRecords: DecisionRecordRepository;
  globalControls: GlobalControlsRepository;
  /** Every configured position id, for `/status` and `/positions`. */
  positionIds: string[];
  clock: Clock;
}

export function handleTelegramCommand(command: TelegramCommand, deps: TelegramCommandDeps): string {
  switch (command.kind) {
    case 'status': {
      if (deps.positionIds.length === 0) return 'No positions configured.';
      return deps.positionIds
        .map((id) => `${id}: ${deps.riskState.get(id)?.level ?? 'NORMAL'}`)
        .join('\n');
    }

    case 'positions':
      return deps.positionIds.length > 0 ? deps.positionIds.join('\n') : 'No positions configured.';

    case 'ack': {
      const record = deps.decisionRecords.findById(command.decisionId);
      if (!record) return `No decision found with id ${command.decisionId}.`;

      const now = deps.clock.now();
      const state =
        deps.riskState.get(record.positionId) ?? initialPositionRiskState(record.positionId, now);
      deps.riskState.save(
        {
          ...state,
          manualControls: { ...state.manualControls, ackedDecisionId: String(command.decisionId) },
        },
        now,
      );
      return `Acked decision ${command.decisionId} for ${record.positionId} (level ${record.level}).`;
    }

    case 'mute': {
      const now = deps.clock.now();
      const state =
        deps.riskState.get(command.positionId) ?? initialPositionRiskState(command.positionId, now);
      const mutedUntil = new Date(now.getTime() + command.durationSeconds * 1000);
      deps.riskState.save(
        { ...state, manualControls: { ...state.manualControls, mutedUntil } },
        now,
      );
      return `Muted ${command.positionId} until ${mutedUntil.toISOString()}.`;
    }

    case 'kill':
      deps.globalControls.activateKillSwitch(deps.clock.now());
      return (
        'Kill switch activated — execution suppressed system-wide (downgraded to alert-only). ' +
        'Re-enabling requires the CLI with an explicit confirmation.'
      );

    case 'unknown':
      return `Unknown command: ${command.raw}\nAvailable: /status /positions /ack <id> /mute <positionId> <duration> /kill`;
  }
}
