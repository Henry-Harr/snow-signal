#!/usr/bin/env node
import { Command } from 'commander';

import { runDoctor } from './doctor.js';
import { createLogger } from '../core/logger.js';

const program = new Command();
const logger = createLogger({ name: 'sentinel-cli' });

program
  .name('sentinel')
  .description('Sentinel: a DeFi stablecoin position watchdog')
  .version('0.1.0');

program
  .command('doctor')
  .description('Check config, RPC quorum, database, and notifier setup')
  .option('-c, --config <path>', 'path to config file', 'config/sentinel.yaml')
  .option('-d, --db <path>', 'path to SQLite database file', 'sentinel.sqlite')
  .action(async (opts: { config: string; db: string }) => {
    const report = await runDoctor({ configPath: opts.config, dbPath: opts.db, logger });
    for (const check of report.checks) {
      const symbol = { ok: '✓', warn: '!', fail: '✗', skipped: '–' }[check.status];
      console.log(`[${symbol}] ${check.name}: ${check.detail}`);
    }
    process.exitCode = report.overallOk ? 0 : 1;
  });

const notYetImplemented = (name: string, phase: string) =>
  program
    .command(name)
    .description(`Not yet implemented — see docs/PROGRESS.md (${phase})`)
    .action(() => {
      logger.warn({ command: name, phase }, 'command not yet implemented');
      process.exitCode = 1;
    });

notYetImplemented('watch', 'Phase 5');
notYetImplemented('positions', 'Phase 2');
notYetImplemented('replay', 'Phase 6');
notYetImplemented('report', 'Phase 5');
notYetImplemented('label', 'Phase 5');
notYetImplemented('drill', 'Phase 7');
notYetImplemented('kill', 'Phase 8');
notYetImplemented('resume', 'Phase 8');

program.parseAsync(process.argv).catch((error: unknown) => {
  logger.error({ err: error }, 'sentinel CLI failed');
  process.exitCode = 1;
});
