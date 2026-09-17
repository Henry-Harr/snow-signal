import { SystemClock, type Clock } from '../core/clock.js';
import { openDatabase } from '../storage/db.js';
import { GlobalControlsRepository } from '../storage/global-controls-repository.js';

/**
 * `sentinel kill` / `sentinel resume --confirm` (docs/SPEC.md §8.4: "a config flag, a
 * CLI command, and a Telegram `/kill` command, all of which only *disable* execution.
 * Re-enabling requires the CLI with an explicit confirmation."). `runKill` mirrors
 * what the Telegram `/kill` handler already does (`src/notify/telegram-commands.ts`);
 * `runResume` is CLI-only by design — there is deliberately no Telegram `/resume`, so
 * re-enabling execution after a kill can never happen from a chat message alone.
 */
export interface KillOptions {
  dbPath: string;
  clock?: Clock;
}

export function runKill(options: KillOptions): void {
  const db = openDatabase(options.dbPath);
  try {
    const clock = options.clock ?? new SystemClock();
    new GlobalControlsRepository(db).activateKillSwitch(clock.now());
  } finally {
    db.close();
  }
}

export interface ResumeOptions {
  dbPath: string;
  /** The CLI's own `--confirm` flag, not merely calling this function — see the
   * doc comment above. `false`/omitted is refused rather than silently ignored, so
   * a caller can't accidentally clear the kill switch by forgetting a flag. */
  confirm: boolean;
  clock?: Clock;
}

export type ResumeResult = { ok: true } | { ok: false; reason: string };

export function runResume(options: ResumeOptions): ResumeResult {
  if (!options.confirm) {
    return {
      ok: false,
      reason: 'Refusing to clear the kill switch without --confirm (docs/SPEC.md §8.4).',
    };
  }
  const db = openDatabase(options.dbPath);
  try {
    const clock = options.clock ?? new SystemClock();
    new GlobalControlsRepository(db).deactivateKillSwitch(clock.now());
    return { ok: true };
  } finally {
    db.close();
  }
}
