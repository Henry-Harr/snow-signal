import { existsSync } from 'node:fs';

import { createViemChainClient } from '../chain/client.js';
import { RpcPool } from '../chain/rpc-pool.js';
import { loadConfig, type SentinelConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import { openDatabase } from '../storage/db.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  overallOk: boolean;
}

export interface DoctorOptions {
  configPath: string;
  dbPath: string;
  logger: Logger;
  /** Per-chain timeout for the RPC quorum check, so a hung provider doesn't hang
   * `doctor` forever. */
  rpcTimeoutMs?: number;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function checkConfig(options: DoctorOptions): { config?: SentinelConfig; check: DoctorCheck } {
  if (!existsSync(options.configPath)) {
    return {
      check: {
        name: 'config',
        status: 'skipped',
        detail: `No config file at ${options.configPath}. Copy config/sentinel.example.yaml and fill it in.`,
      },
    };
  }

  try {
    const { config } = loadConfig(options.configPath);
    return {
      config,
      check: { name: 'config', status: 'ok', detail: `Loaded and validated ${options.configPath}` },
    };
  } catch (error) {
    return {
      check: {
        name: 'config',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function checkChainQuorum(
  chainName: string,
  chain: SentinelConfig['chains'][string],
  options: DoctorOptions,
): Promise<DoctorCheck> {
  try {
    const providers = chain.rpc.map((rpc) => ({
      name: rpc.name,
      client: createViemChainClient(rpc.url, chain.chainId),
    }));
    const pool = new RpcPool(providers, options.logger);
    const head = await withTimeout(
      pool.getConservativeHead(),
      options.rpcTimeoutMs ?? 10_000,
      `${chainName} quorum head check`,
    );
    return {
      name: `chain:${chainName}`,
      status: 'ok',
      detail: `Quorum head confirmed at block ${head}`,
    };
  } catch (error) {
    return {
      name: `chain:${chainName}`,
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkDatabase(options: DoctorOptions): DoctorCheck {
  try {
    const db = openDatabase(options.dbPath);
    db.close();
    return { name: 'database', status: 'ok', detail: `Opened and migrated ${options.dbPath}` };
  } catch (error) {
    return {
      name: 'database',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Checks every notifier channel actually configured — Telegram and Discord are
 * independent (`notifySchema`), so a Discord-only setup must not be reported as
 * "not configured" just because Telegram isn't set. Overall status is `ok` if at
 * least one channel is fully working, `warn` if something's configured but
 * incomplete (or nothing beyond console is configured at all). */
function checkNotifier(config: SentinelConfig | undefined): DoctorCheck {
  if (!config) {
    return { name: 'notifier', status: 'skipped', detail: 'No config loaded' };
  }

  const details: string[] = [];
  let anyFullyConfigured = false;

  if (config.notify.telegram) {
    const tokenSet = Boolean(process.env[config.notify.telegram.tokenEnv]);
    if (!tokenSet) {
      details.push(`Telegram configured but ${config.notify.telegram.tokenEnv} is not set`);
    } else if (config.notify.telegram.allowedChatIds.length === 0) {
      details.push(
        'Telegram token is set but allowedChatIds is empty — no commands will be accepted from anyone',
      );
    } else {
      details.push('Telegram token present, chat allowlist configured');
      anyFullyConfigured = true;
    }
  }

  if (config.notify.discordWebhookEnv) {
    const webhookSet = Boolean(process.env[config.notify.discordWebhookEnv]);
    if (!webhookSet) {
      details.push(`Discord configured but ${config.notify.discordWebhookEnv} is not set`);
    } else {
      details.push('Discord webhook configured');
      anyFullyConfigured = true;
    }
  }

  if (details.length === 0) {
    return {
      name: 'notifier',
      status: 'warn',
      detail: 'No Telegram or Discord notifier configured — alerts will only appear in console/logs',
    };
  }

  return {
    name: 'notifier',
    status: anyFullyConfigured ? 'ok' : 'warn',
    detail: details.join('; '),
  };
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const { config, check: configCheck } = checkConfig(options);
  checks.push(configCheck);

  if (config) {
    for (const [chainName, chain] of Object.entries(config.chains)) {
      checks.push(await checkChainQuorum(chainName, chain, options));
    }
  } else {
    checks.push({ name: 'chains', status: 'skipped', detail: 'No config loaded' });
  }

  checks.push(checkDatabase(options));
  checks.push(checkNotifier(config));

  const overallOk = checks.every(
    (check) => check.status === 'ok' || check.status === 'warn' || check.status === 'skipped',
  );
  return { checks, overallOk };
}
