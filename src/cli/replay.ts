import { writeFileSync } from 'node:fs';

import { loadConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import { generateReplayResultsMarkdown } from '../replay/results-report.js';
import { runReplayScenario, type ReplayRunResult } from '../replay/runner.js';
import { loadScenario, type ReplayScenario } from '../replay/scenario.js';
import { scoreScenario, type ScenarioScore } from '../replay/scoring.js';
import {
  runSyntheticScenario,
  SYNTHETIC_SCENARIOS,
  type SyntheticScenarioResult,
} from '../replay/synthetic-scenario.js';

/**
 * `sentinel replay [scenarios...]` (docs/SPEC.md §12, §9). Runs each named scenario
 * file (or, with `all: true`, every real scenario plus every synthetic
 * fault-injection scenario) and writes `docs/REPLAY_RESULTS.md`.
 */
export interface RunReplayOptions {
  configPath: string;
  cacheDir: string;
  resultsPath: string;
  logger: Logger;
  clock?: { now(): Date };
}

export interface RunReplayResult {
  scenarioResults: { scenario: ReplayScenario; result: ReplayRunResult; score: ScenarioScore }[];
  /** Scenarios that failed to run — a network hiccup or a real archive-RPC
   * limitation (docs/adr/0009) on one scenario must never discard every other
   * scenario's already-completed results, so a failure here is recorded rather than
   * thrown past this loop. */
  failures: { scenarioPath: string; error: string }[];
  syntheticResults: SyntheticScenarioResult[];
  resultsPath: string;
}

export async function runReplay(
  scenarioPaths: string[],
  options: RunReplayOptions,
): Promise<RunReplayResult> {
  const { config } = loadConfig(options.configPath);
  const logger = options.logger;

  const scenarioResults: RunReplayResult['scenarioResults'] = [];
  const failures: RunReplayResult['failures'] = [];
  for (const path of scenarioPaths) {
    try {
      const scenario = loadScenario(path);
      const chainConfig = config.chains[scenario.chain];
      if (!chainConfig) {
        throw new Error(
          `Scenario ${scenario.id}: chain "${scenario.chain}" is not configured in ${options.configPath}`,
        );
      }
      const archiveRpcUrls = chainConfig.rpc.map((rpc) => rpc.url) as [string, string, ...string[]];

      logger.info({ scenario: scenario.id }, 'running replay scenario');
      const result = await runReplayScenario(scenario, {
        archiveRpcUrls,
        cacheDir: options.cacheDir,
        policy: config.policy,
        logger,
      });
      const score = scoreScenario(scenario, result);
      scenarioResults.push({ scenario, result, score });
    } catch (error) {
      logger.error({ path, err: error }, 'scenario failed, continuing with the rest');
      failures.push({
        scenarioPath: path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const syntheticResults = SYNTHETIC_SCENARIOS.map((scenario) =>
    runSyntheticScenario(scenario, config.policy),
  );

  const now = (options.clock ?? { now: () => new Date() }).now();
  const markdown = generateReplayResultsMarkdown(
    scenarioResults.map((r) => r.score),
    syntheticResults,
    now,
    failures,
  );
  writeFileSync(options.resultsPath, markdown, 'utf-8');

  return { scenarioResults, failures, syntheticResults, resultsPath: options.resultsPath };
}
