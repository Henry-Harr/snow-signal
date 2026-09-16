import { LiveBlockSource } from '../chain/block-source.js';
import { createViemContractReadClient, type ContractReadClient } from '../chain/client.js';
import { RpcPool } from '../chain/rpc-pool.js';
import { SystemClock, type Clock } from '../core/clock.js';
import { loadConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import { positionsForChain, runOnce, type PipelineDeps } from '../core/pipeline.js';
import { AlertDispatcher } from '../notify/dispatcher.js';
import { ConsoleNotifier } from '../notify/console.js';
import { DiscordNotifier } from '../notify/discord.js';
import { TelegramNotifier } from '../notify/telegram.js';
import type { Notifier } from '../notify/types.js';
import { pollTelegramUpdatesOnce, type TelegramPollOptions } from '../notify/telegram-poll.js';
import type { TelegramCommandDeps } from '../notify/telegram-commands.js';
import { defaultDetectors } from '../signals/registry.js';
import { ChainStateRepository } from '../storage/chain-state-repository.js';
import { openDatabase } from '../storage/db.js';
import { DecisionRecordRepository } from '../storage/decision-record-repository.js';
import { GlobalControlsRepository } from '../storage/global-controls-repository.js';
import { MarketSnapshotRepository } from '../storage/market-snapshot-repository.js';
import { ProtocolEventRepository } from '../storage/protocol-event-repository.js';
import { RiskStateRepository } from '../storage/risk-state-repository.js';

/**
 * `sentinel watch` (docs/SPEC.md §11, docs/PROGRESS.md Phase 5 "done when": runs
 * against real chains without crashing, delivers alerts, writes daily reports —
 * reports themselves are `sentinel report`'s job, run separately/on a schedule per
 * spec's `dailyUtcHour`, not driven from inside this loop). Polls every configured
 * chain's `LiveBlockSource` on a fixed interval, runs the pipeline (`src/core/
 * pipeline.ts`) once per newly confirmed block, and (if a Telegram bot token is
 * configured) polls for incoming commands on the same cadence.
 *
 * A failure processing one chain's poll (an RPC hiccup, an adapter read reverting on
 * an unexpected reserve shape, etc.) is logged and the loop continues rather than
 * crashing the whole process — matching docs/ARCHITECTURE.md #2's "idempotent and
 * restartable" design: the next poll picks up from `ChainStateRepository`'s stored
 * cursor exactly where this one left off.
 */

const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Hysteresis dwell time (ADR 0008) — not yet configurable in `sentinel.yaml` and not
 * yet backed by replay-harness evidence for a different value (safety rule 8: "a
 * single day of results is never enough"). One hour is a reasonable starting point;
 * revisit via `docs/TUNING_LOG.md` once the replay harness (Phase 6) exists. */
const DEFAULT_DWELL_SECONDS = 3600;

export interface WatchOptions {
  configPath: string;
  dbPath: string;
  logger: Logger;
  pollIntervalMs?: number;
  clock?: Clock;
  /** For tests: stop after this many poll iterations instead of running forever. */
  maxIterations?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWatch(options: WatchOptions): Promise<void> {
  const logger = options.logger;
  const { config, hash: configHash } = loadConfig(options.configPath);
  const db = openDatabase(options.dbPath);
  const clock = options.clock ?? new SystemClock();

  const chainState = new ChainStateRepository(db);
  const repos = {
    marketSnapshots: new MarketSnapshotRepository(db),
    protocolEvents: new ProtocolEventRepository(db),
    decisionRecords: new DecisionRecordRepository(db),
    riskState: new RiskStateRepository(db),
  };
  const globalControls = new GlobalControlsRepository(db);

  const allPositionIds = Object.keys(config.chains).flatMap((chain) =>
    positionsForChain(config, chain).map((p) => p.positionId),
  );

  const notifiers: Notifier[] = [new ConsoleNotifier({ logger })];

  if (config.notify.discordWebhookEnv) {
    const webhookUrl = process.env[config.notify.discordWebhookEnv];
    if (webhookUrl) {
      notifiers.push(new DiscordNotifier({ webhookUrl, logger }));
    } else {
      logger.warn(
        { envVar: config.notify.discordWebhookEnv },
        'Discord webhook configured but the env var is not set — Discord notifications disabled',
      );
    }
  }

  let telegramPollOptions: TelegramPollOptions | undefined;
  const telegramConfig = config.notify.telegram;
  if (telegramConfig) {
    const botToken = process.env[telegramConfig.tokenEnv];
    if (botToken && telegramConfig.allowedChatIds.length > 0) {
      notifiers.push(
        new TelegramNotifier({ botToken, chatIds: telegramConfig.allowedChatIds, logger }),
      );
      const commandDeps: TelegramCommandDeps = {
        riskState: repos.riskState,
        decisionRecords: repos.decisionRecords,
        globalControls,
        positionIds: allPositionIds,
        clock,
      };
      telegramPollOptions = {
        botToken,
        allowedChatIds: telegramConfig.allowedChatIds,
        commandDeps,
        logger,
      };
    } else {
      logger.warn(
        { tokenEnv: telegramConfig.tokenEnv },
        'Telegram configured but token/allowedChatIds are incomplete — Telegram disabled (console notifier still active)',
      );
    }
  }

  const dispatcher = new AlertDispatcher({ notifiers, clock, logger });
  const detectors = defaultDetectors();

  const chainRuntimes = Object.entries(config.chains).map(([chain, chainConfig]) => {
    const providers = chainConfig.rpc.map((rpc) => ({
      name: rpc.name,
      client: createViemContractReadClient(rpc.url, chainConfig.chainId),
    }));
    const pool = new RpcPool<ContractReadClient>(providers, logger);
    const blockSource = new LiveBlockSource({
      chainId: chainConfig.chainId,
      confirmations: chainConfig.confirmations,
      pool,
      chainState,
      logger,
    });
    return { chain, chainId: chainConfig.chainId, pool, blockSource };
  });

  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let telegramOffset: number | undefined;
  let iterations = 0;

  try {
    while (running) {
      for (const { chain, chainId, pool, blockSource } of chainRuntimes) {
        try {
          const newBlocks = await blockSource.poll();
          for (const block of newBlocks) {
            const deps: PipelineDeps = {
              chain,
              chainId,
              pool,
              config,
              clock,
              logger,
              detectors,
              dispatcher,
              repos,
              killSwitchActive: globalControls.isKillSwitchActive(),
              dwellSeconds: DEFAULT_DWELL_SECONDS,
              configHash,
            };
            await runOnce(deps, block);
          }
        } catch (error) {
          logger.error({ chain, err: error }, 'pipeline iteration failed, will retry next poll');
        }
      }

      if (telegramPollOptions) {
        try {
          telegramOffset = await pollTelegramUpdatesOnce(telegramPollOptions, telegramOffset);
        } catch (error) {
          logger.error({ err: error }, 'Telegram poll failed, will retry next poll');
        }
      }

      iterations++;
      if (options.maxIterations !== undefined && iterations >= options.maxIterations) break;
      if (running) await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    db.close();
  }
}
