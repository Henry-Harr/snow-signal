#!/usr/bin/env node
import { Command } from 'commander';
import { privateKeyToAccount } from 'viem/accounts';

import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { PriceUpdate } from '../core/types.js';
import { evaluateAllPositions } from '../stoploss/engine.js';
import { executeStopLoss, type ExecuteStopLossOptions } from '../stoploss/executor.js';
import { startMarketPriceFeed } from '../polymarket/websocket-client.js';
import { ClobRestClient } from '../polymarket/rest-client.js';
import type { ClobApiCredentials } from '../polymarket/hmac-auth.js';
import { openDatabase } from '../storage/db.js';
import { TriggerLogRepository } from '../storage/trigger-log-repository.js';

const program = new Command();
const logger = createLogger();

program
  .name('stoploss')
  .description('Polymarket stop-loss bot: watches live prices, sells when a configured threshold is crossed');

program
  .command('run')
  .description('Start watching configured positions and running their stop-losses')
  .option('-c, --config <path>', 'path to config JSON file', 'config/stoploss.json')
  .option('-d, --db <path>', 'path to SQLite database file', 'stoploss.sqlite')
  .action((opts: { config: string; db: string }) => {
    const config = loadConfig(opts.config);
    logger.info(
      { executionMode: config.executionMode, positions: config.positions.length },
      'starting stoploss bot',
    );

    const privateKey = process.env['WALLET_PRIVATE_KEY'];
    if (!privateKey) {
      throw new Error('WALLET_PRIVATE_KEY not set in the environment.');
    }
    const account = privateKeyToAccount(privateKey as `0x${string}`);

    let restClient: ClobRestClient | undefined;
    if (config.executionMode === 'live') {
      const apiKey = process.env['CLOB_API_KEY'];
      const apiSecret = process.env['CLOB_API_SECRET'];
      const passphrase = process.env['CLOB_API_PASSPHRASE'];
      if (!apiKey || !apiSecret || !passphrase) {
        throw new Error(
          'executionMode is "live" but CLOB_API_KEY/CLOB_API_SECRET/CLOB_API_PASSPHRASE are not all set.',
        );
      }
      const creds: ClobApiCredentials = { apiKey, apiSecret, passphrase, address: account.address };
      restClient = new ClobRestClient(creds);
      logger.warn('LIVE execution mode — real orders will be signed and submitted.');
    } else {
      logger.info('paper execution mode — no real orders will be sent.');
    }

    const executeOptions: ExecuteStopLossOptions =
      config.executionMode === 'live' && restClient
        ? { mode: 'live', account, makerAddress: account.address, restClient }
        : { mode: 'paper' };

    const db = openDatabase(opts.db);
    const triggerLog = new TriggerLogRepository(db);
    const alreadyTriggered = new Set<string>();

    const onPrice = (price: PriceUpdate): void => {
      const triggers = evaluateAllPositions(config.positions, price);
      for (const trigger of triggers) {
        if (alreadyTriggered.has(trigger.position.tokenId)) continue; // one shot per position per run
        alreadyTriggered.add(trigger.position.tokenId);

        void (async () => {
          const outcome = await executeStopLoss(trigger, executeOptions);
          triggerLog.record(outcome, new Date());
          logger.info(
            {
              label: trigger.position.label,
              kind: outcome.kind,
              triggerPrice: outcome.trigger.triggerPrice,
              limitPrice: outcome.limitPrice,
              orderId: outcome.orderId,
              errorMsg: outcome.errorMsg,
            },
            'stop-loss triggered',
          );
        })();
      }
    };

    const feed = startMarketPriceFeed({
      tokenIds: config.positions.map((p) => p.tokenId),
      onPrice,
      onError: (err) => logger.error({ err }, 'price feed error'),
    });

    const shutdown = (): void => {
      logger.info('shutting down');
      feed.close();
      db.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  logger.error({ err: error }, 'fatal error');
  process.exitCode = 1;
});
