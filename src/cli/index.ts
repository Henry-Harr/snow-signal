#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Command } from 'commander';

import { runDoctor } from './doctor.js';
import { runLabel } from './label.js';
import { runReplay } from './replay.js';
import { runReport } from './report.js';
import { runWatch } from './watch.js';
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

program
  .command('watch')
  .description('Run the live pipeline: poll every configured chain, detect, decide, alert')
  .option('-c, --config <path>', 'path to config file', 'config/sentinel.yaml')
  .option('-d, --db <path>', 'path to SQLite database file', 'sentinel.sqlite')
  .option('--poll-interval-ms <ms>', 'how often to poll each chain for new blocks', '15000')
  .action(async (opts: { config: string; db: string; pollIntervalMs: string }) => {
    await runWatch({
      configPath: opts.config,
      dbPath: opts.db,
      logger,
      pollIntervalMs: Number(opts.pollIntervalMs),
    });
  });

program
  .command('report')
  .description('Generate the daily report (docs/SPEC.md #10.2) into reports/YYYY-MM-DD.{md,json}')
  .option('-c, --config <path>', 'path to config file', 'config/sentinel.yaml')
  .option('-d, --db <path>', 'path to SQLite database file', 'sentinel.sqlite')
  .option('--date <date>', 'UTC calendar date, YYYY-MM-DD (defaults to today)')
  .option('--reports-dir <path>', 'directory to write the report into', 'reports')
  .action(async (opts: { config: string; db: string; date?: string; reportsDir: string }) => {
    const { mdPath, jsonPath } = await runReport({
      configPath: opts.config,
      dbPath: opts.db,
      reportsDir: opts.reportsDir,
      ...(opts.date ? { date: opts.date } : {}),
      logger,
    });
    console.log(`Report written to ${mdPath} and ${jsonPath}`);
  });

program
  .command('label')
  .description('Label a decision record for later replay scoring (docs/SPEC.md #10.3)')
  .argument('<decisionId>', 'decision record id, e.g. from a Telegram alert or the daily report')
  .argument('<label>', 'free-form label, e.g. true/false/unsure')
  .argument('[notes...]', 'optional notes')
  .option('-d, --db <path>', 'path to SQLite database file', 'sentinel.sqlite')
  .action((decisionIdRaw: string, label: string, notes: string[], opts: { db: string }) => {
    const decisionId = Number(decisionIdRaw);
    if (!Number.isInteger(decisionId)) {
      console.error(`"${decisionIdRaw}" is not a valid decision id.`);
      process.exitCode = 1;
      return;
    }
    const result = runLabel({
      dbPath: opts.db,
      decisionId,
      label,
      ...(notes.length > 0 ? { notes: notes.join(' ') } : {}),
    });
    if (!result.ok) {
      console.error(result.reason);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Labeled decision ${decisionId} (${result.positionId}, ${result.level}) as "${label}".`,
    );
  });

program
  .command('replay')
  .description('Replay scenarios against archived chain data and write docs/REPLAY_RESULTS.md (docs/SPEC.md #9)')
  .argument('[scenarios...]', 'scenario YAML file paths (default: every file in scenarios/)')
  .option('-c, --config <path>', 'path to config file', 'config/sentinel.yaml')
  .option('--cache-dir <path>', 'disk cache directory for archive RPC responses', '.replay-cache')
  .option('--out <path>', 'where to write the results markdown', 'docs/REPLAY_RESULTS.md')
  .action(async (scenarioArgs: string[], opts: { config: string; cacheDir: string; out: string }) => {
    const scenarioPaths =
      scenarioArgs.length > 0
        ? scenarioArgs
        : readdirSync('scenarios')
            .filter((f) => f.endsWith('.yaml'))
            .map((f) => join('scenarios', f));

    const { scenarioResults, syntheticResults, resultsPath } = await runReplay(scenarioPaths, {
      configPath: opts.config,
      cacheDir: opts.cacheDir,
      resultsPath: opts.out,
      logger,
    });

    for (const { scenario, score } of scenarioResults) {
      console.log(`${scenario.id}: ${score.kind === 'incident' ? score.finalLevel : `${score.falseAlarmsPerWeek.toFixed(2)} false alarms/week`}`);
    }
    for (const result of syntheticResults) {
      console.log(`${result.scenario.id}: ${result.passed ? 'PASS' : 'FAIL'}`);
    }
    console.log(`Results written to ${resultsPath}`);
  });

notYetImplemented('positions', 'Phase 2');
notYetImplemented('drill', 'Phase 7');
notYetImplemented('kill', 'Phase 8');
notYetImplemented('resume', 'Phase 8');

program.parseAsync(process.argv).catch((error: unknown) => {
  logger.error({ err: error }, 'sentinel CLI failed');
  process.exitCode = 1;
});
