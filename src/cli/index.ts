#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Command } from 'commander';

import { runBackup } from './backup.js';
import { runDoctor } from './doctor.js';
import { runDrillCommand } from './drill.js';
import { runKill, runResume } from './kill.js';
import { runLabel } from './label.js';
import { runReplay } from './replay.js';
import { runReport } from './report.js';
import { runScanLiquidations } from './scan-liquidations.js';
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
  .description(
    'Replay scenarios against archived chain data and write docs/REPLAY_RESULTS.md (docs/SPEC.md #9)',
  )
  .argument('[scenarios...]', 'scenario YAML file paths (default: every file in scenarios/)')
  .option('-c, --config <path>', 'path to config file', 'config/sentinel.yaml')
  .option('--cache-dir <path>', 'disk cache directory for archive RPC responses', '.replay-cache')
  .option('--out <path>', 'where to write the results markdown', 'docs/REPLAY_RESULTS.md')
  .action(
    async (scenarioArgs: string[], opts: { config: string; cacheDir: string; out: string }) => {
      const scenarioPaths =
        scenarioArgs.length > 0
          ? scenarioArgs
          : readdirSync('scenarios')
              .filter((f) => f.endsWith('.yaml'))
              .map((f) => join('scenarios', f));

      const { scenarioResults, failures, syntheticResults, resultsPath } = await runReplay(
        scenarioPaths,
        {
          configPath: opts.config,
          cacheDir: opts.cacheDir,
          resultsPath: opts.out,
          logger,
        },
      );

      for (const { scenario, score } of scenarioResults) {
        console.log(
          `${scenario.id}: ${score.kind === 'incident' ? score.finalLevel : `${score.falseAlarmsPerWeek.toFixed(2)} false alarms/week`}`,
        );
      }
      for (const failure of failures) {
        console.error(`${failure.scenarioPath}: FAILED — ${failure.error}`);
      }
      for (const result of syntheticResults) {
        console.log(`${result.scenario.id}: ${result.passed ? 'PASS' : 'FAIL'}`);
      }
      console.log(`Results written to ${resultsPath}`);
      if (failures.length > 0) process.exitCode = 1;
    },
  );

program
  .command('drill')
  .description(
    'Fork the latest block and simulate a full exit of every position (docs/SPEC.md §8.6)',
  )
  .option('-c, --config <path>', 'path to config file', 'config/sentinel.yaml')
  .action(async (opts: { config: string }) => {
    const results = await runDrillCommand({ configPath: opts.config, logger });
    if (results.length === 0) {
      console.log('No positions currently held — nothing to drill.');
      return;
    }
    let anyFailed = false;
    for (const r of results) {
      const status = r.passed ? 'PASS' : 'FAIL';
      const gas = r.gasEstimate !== undefined ? r.gasEstimate.toString() : 'n/a';
      const blocks =
        r.estimatedBlocksToExit !== undefined ? r.estimatedBlocksToExit.toString() : 'unknown';
      console.log(`[${status}] ${r.positionId} — gas: ${gas}, estimated steps to exit: ${blocks}`);
      if (!r.passed) anyFailed = true;
    }
    process.exitCode = anyFailed ? 1 : 0;
  });

program
  .command('kill')
  .description('Activate the global kill switch — suppresses all withdrawal actions down to alert-only (docs/SPEC.md §8.4)')
  .option('-d, --db <path>', 'path to SQLite database file', 'sentinel.sqlite')
  .action((opts: { db: string }) => {
    runKill({ dbPath: opts.db });
    console.log('Kill switch activated. Withdrawal actions are suppressed to alert-only.');
    console.log('Re-enable with: sentinel resume --confirm');
  });

program
  .command('resume')
  .description('Clear the global kill switch — CLI-only, requires --confirm (docs/SPEC.md §8.4)')
  .option('-d, --db <path>', 'path to SQLite database file', 'sentinel.sqlite')
  .option('--confirm', 'explicit confirmation required to clear the kill switch', false)
  .action((opts: { db: string; confirm: boolean }) => {
    const result = runResume({ dbPath: opts.db, confirm: opts.confirm });
    if (!result.ok) {
      console.error(result.reason);
      process.exitCode = 1;
      return;
    }
    console.log('Kill switch cleared. Withdrawal actions will resume per policy.');
  });

program
  .command('backup')
  .description(
    'Take an online SQLite backup (safe to run while sentinel watch is running) and prune old backups (docs/SPEC.md §9)',
  )
  .option('-d, --db <path>', 'path to SQLite database file', 'sentinel.sqlite')
  .option('-o, --out-dir <path>', 'directory to write backups into', 'backups')
  .option('--retain <count>', 'how many most-recent backups to keep', '14')
  .action(async (opts: { db: string; outDir: string; retain: string }) => {
    const retentionCount = Number.parseInt(opts.retain, 10);
    if (!Number.isFinite(retentionCount) || retentionCount < 1) {
      console.error(`--retain must be a positive integer, got "${opts.retain}"`);
      process.exitCode = 1;
      return;
    }
    const result = await runBackup({
      dbPath: opts.db,
      outDir: opts.outDir,
      retentionCount,
      logger,
    });
    console.log(`Backup written to ${result.backupPath}`);
    if (result.deletedPaths.length > 0) {
      console.log(`Pruned ${result.deletedPaths.length} old backup(s): ${result.deletedPaths.join(', ')}`);
    }
  });

program
  .command('scan-liquidations')
  .description(
    'Detection-only Aave v3 liquidation scanner (docs/adr/0014) — logs theoretical opportunities, never sends a transaction',
  )
  .option('-c, --config <path>', 'path to config file', 'config/sentinel.yaml')
  .option('-d, --db <path>', 'path to SQLite database file', 'sentinel.sqlite')
  .option('--chain <chain>', 'chain to scan (ethereum or base)', 'ethereum')
  .option('--market <market>', 'Aave v3 market to scan', 'core')
  .action(async (opts: { config: string; db: string; chain: string; market: string }) => {
    if (opts.chain !== 'ethereum' && opts.chain !== 'base') {
      console.error(`--chain must be "ethereum" or "base", got "${opts.chain}"`);
      process.exitCode = 1;
      return;
    }
    const opportunities = await runScanLiquidations({
      configPath: opts.config,
      dbPath: opts.db,
      chain: opts.chain,
      market: opts.market,
      logger,
    });
    if (opportunities.length === 0) {
      console.log('No liquidatable positions found.');
      return;
    }
    for (const o of opportunities) {
      console.log(
        `${o.user}: repay ${o.debtSymbol} / seize ${o.collateralSymbol}, gross profit ~$${(Number(o.grossProfitBase) / 1e8).toFixed(2)} (health factor ${(Number(o.healthFactor) / 1e18).toFixed(4)})`,
      );
    }
    console.log(`\n${opportunities.length} opportunity(ies) logged to ${opts.db}.`);
  });

notYetImplemented('positions', 'Phase 2');

program.parseAsync(process.argv).catch((error: unknown) => {
  logger.error({ err: error }, 'sentinel CLI failed');
  process.exitCode = 1;
});
