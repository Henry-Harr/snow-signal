import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runDoctor } from '../../../src/cli/doctor.js';
import { createLogger } from '../../../src/core/logger.js';

const logger = createLogger({ level: 'silent' });

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sentinel-doctor-test-'));
}

describe('runDoctor', () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.length = 0;
  });

  it('skips config and chain checks gracefully when no config file exists', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const report = await runDoctor({
      configPath: join(dir, 'does-not-exist.yaml'),
      dbPath: join(dir, 'sentinel.sqlite'),
      logger,
    });

    const configCheck = report.checks.find((c) => c.name === 'config');
    expect(configCheck?.status).toBe('skipped');
    const dbCheck = report.checks.find((c) => c.name === 'database');
    expect(dbCheck?.status).toBe('ok');
    expect(report.overallOk).toBe(true);
  });

  it('reports a failing chain check when RPC providers are unreachable, without crashing', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const configPath = join(dir, 'sentinel.yaml');
    writeFileSync(
      configPath,
      `
safe:
  address: '0x1111111111111111111111111111111111111111'
chains:
  ethereum:
    chainId: 1
    confirmations: 2
    rpc:
      - { name: primary, url: 'http://127.0.0.1:1' }
      - { name: secondary, url: 'http://127.0.0.1:2' }
positions: []
detectors: {}
policy:
  danger: { action: partial_withdraw, fraction: 0.5 }
  critical: { action: full_exit }
  maxShareOfAvailableLiquidity: 0.05
execution:
  mode: off
  maxPriorityFeeGwei: { ethereum: 50 }
notify: {}
reports:
  dailyUtcHour: 0
  benchmark: { kind: pool_base_rate }
`,
    );

    const report = await runDoctor({
      configPath,
      dbPath: join(dir, 'sentinel.sqlite'),
      logger,
      rpcTimeoutMs: 2000,
    });

    const configCheck = report.checks.find((c) => c.name === 'config');
    expect(configCheck?.status).toBe('ok');
    const chainCheck = report.checks.find((c) => c.name === 'chain:ethereum');
    expect(chainCheck?.status).toBe('fail');
    expect(report.overallOk).toBe(false);
  }, 10_000);

  it('skips the notifier check when no config file exists', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const report = await runDoctor({
      configPath: join(dir, 'nope.yaml'),
      dbPath: join(dir, 'sentinel.sqlite'),
      logger,
    });
    const notifierCheck = report.checks.find((c) => c.name === 'notifier');
    expect(notifierCheck?.status).toBe('skipped');
  });

  function configWithNotify(notify: string): string {
    return `
safe:
  address: '0x1111111111111111111111111111111111111111'
chains: {}
positions: []
detectors: {}
policy:
  danger: { action: partial_withdraw, fraction: 0.5 }
  critical: { action: full_exit }
  maxShareOfAvailableLiquidity: 0.05
execution:
  mode: off
  maxPriorityFeeGwei: {}
notify: ${notify}
reports:
  dailyUtcHour: 0
  benchmark: { kind: pool_base_rate }
`;
  }

  it('warns when neither Telegram nor Discord is configured', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const configPath = join(dir, 'sentinel.yaml');
    writeFileSync(configPath, configWithNotify('{}'));

    const report = await runDoctor({ configPath, dbPath: join(dir, 'sentinel.sqlite'), logger });
    const notifierCheck = report.checks.find((c) => c.name === 'notifier');
    expect(notifierCheck?.status).toBe('warn');
    expect(notifierCheck?.detail).toContain('No Telegram or Discord notifier configured');
  });

  it('reports ok for a Discord-only setup, without mentioning Telegram as missing', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const configPath = join(dir, 'sentinel.yaml');
    writeFileSync(
      configPath,
      configWithNotify('{ discordWebhookEnv: SENTINEL_DOCTOR_TEST_DISCORD_URL }'),
    );
    process.env['SENTINEL_DOCTOR_TEST_DISCORD_URL'] = 'https://discord.com/api/webhooks/x/y';

    try {
      const report = await runDoctor({ configPath, dbPath: join(dir, 'sentinel.sqlite'), logger });
      const notifierCheck = report.checks.find((c) => c.name === 'notifier');
      expect(notifierCheck?.status).toBe('ok');
      expect(notifierCheck?.detail).toBe('Discord webhook configured');
    } finally {
      delete process.env['SENTINEL_DOCTOR_TEST_DISCORD_URL'];
    }
  });

  it('warns (not ok) when Discord is configured but the env var is unset', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const configPath = join(dir, 'sentinel.yaml');
    writeFileSync(
      configPath,
      configWithNotify('{ discordWebhookEnv: SENTINEL_DOCTOR_TEST_UNSET_DISCORD_URL }'),
    );

    const report = await runDoctor({ configPath, dbPath: join(dir, 'sentinel.sqlite'), logger });
    const notifierCheck = report.checks.find((c) => c.name === 'notifier');
    expect(notifierCheck?.status).toBe('warn');
    expect(notifierCheck?.detail).toContain('SENTINEL_DOCTOR_TEST_UNSET_DISCORD_URL is not set');
  });
});
