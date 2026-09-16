import { runExitDrill } from '../actions/exit-drill.js';
import { SystemClock, type Clock } from '../core/clock.js';
import { loadConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { ExitDrillResult } from '../reports/types.js';

/** `sentinel drill` (docs/SPEC.md §8.6) — a thin CLI wrapper around
 * `runExitDrill` (`src/actions/exit-drill.ts`), which does all the real work. */
export interface DrillOptions {
  configPath: string;
  logger: Logger;
  clock?: Clock;
}

export async function runDrillCommand(options: DrillOptions): Promise<ExitDrillResult[]> {
  const { config } = loadConfig(options.configPath);
  const clock = options.clock ?? new SystemClock();
  return runExitDrill({ config, clock, logger: options.logger });
}
