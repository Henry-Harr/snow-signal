import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runReport } from '../../../src/cli/report.js';
import { FixedClock } from '../../../src/core/clock.js';
import { createLogger } from '../../../src/core/logger.js';
import { openDatabase } from '../../../src/storage/db.js';
import { DecisionRecordRepository } from '../../../src/storage/decision-record-repository.js';
import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';

/**
 * Fork integration test for `sentinel report` (`src/cli/report.ts`). A decision
 * record is seeded directly (not via the live pipeline — that path is already
 * covered by `test/integration/core/pipeline.test.ts` and `test/integration/cli/
 * watch.test.ts`) so this test's own job — exercising the live position/balance read
 * this command does that nothing else does — isn't obscured by also depending on the
 * pipeline producing a decision at this exact block.
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const FORK_BLOCK = 25_987_000n;
const logger = createLogger({ level: 'silent' });

const describeIfForkable = ETH_URL ? describe : describe.skip;

describeIfForkable('sentinel report (fork integration)', () => {
  let fork: AnvilFork;
  let dir: string;
  let configPath: string;
  let dbPath: string;

  beforeAll(async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL!, forkBlockNumber: FORK_BLOCK });
    dir = mkdtempSync(join(tmpdir(), 'sentinel-report-test-'));
    configPath = join(dir, 'sentinel.yaml');
    dbPath = join(dir, 'sentinel.sqlite');
    writeFileSync(
      configPath,
      `
safe:
  address: '0x04E779d093549Da687C51ea0c2Ae8AE2174e3465'
chains:
  ethereum:
    chainId: 1
    confirmations: 0
    rpc:
      - { name: a, url: '${fork.rpcUrl}' }
      - { name: b, url: '${fork.rpcUrl}' }
positions:
  - { protocol: aave-v3, chain: ethereum, market: core, asset: USDC }
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

    const db = openDatabase(dbPath);
    new DecisionRecordRepository(db).record({
      positionId: 'aave-v3:ethereum:core:USDC',
      at: new Date('2026-09-16T08:00:00.000Z'),
      blockNumber: FORK_BLOCK,
      previousLevel: 'NORMAL',
      level: 'CRITICAL',
      rawLevel: 'CRITICAL',
      signals: [],
      rule: 'standalone-critical: D11_bad_debt',
      action: { kind: 'full_exit' },
      standingAlert: false,
      configHash: 'test-hash',
    });
    db.close();
  }, 60_000);

  afterAll(async () => {
    await fork?.stop();
  });

  it('writes a daily report combining stored decisions with a live position/balance read', async () => {
    const clock = new FixedClock(new Date('2026-09-16T12:00:00.000Z'));
    const { mdPath, jsonPath } = await runReport({
      configPath,
      dbPath,
      reportsDir: join(dir, 'reports'),
      date: '2026-09-16',
      logger,
      clock,
    });

    const markdown = readFileSync(mdPath, 'utf-8');
    expect(markdown).toContain('# Daily report — 2026-09-16');
    expect(markdown).toContain('D11_bad_debt');

    const json = JSON.parse(readFileSync(jsonPath, 'utf-8')) as {
      alerts: unknown[];
      positions: unknown[];
      dataQuality: { chainId: number }[];
    };
    expect(json.alerts).toHaveLength(1);
    expect(json.dataQuality).toEqual([
      {
        chainId: 1,
        providerUptime: undefined,
        averageHeadLagBlocks: 0,
        disagreementCount: 0,
        staleSourceCount: 0,
      },
    ]);
  }, 60_000);
});
