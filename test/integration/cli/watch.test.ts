import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWatch } from '../../../src/cli/watch.js';
import { createLogger } from '../../../src/core/logger.js';
import { openDatabase } from '../../../src/storage/db.js';
import { DecisionRecordRepository } from '../../../src/storage/decision-record-repository.js';
import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';

/**
 * Fork integration test for `sentinel watch`'s own CLI wiring (`src/cli/watch.ts`) —
 * config loading from a real file, `RpcPool`/`LiveBlockSource` construction per
 * chain, and the polling loop — as opposed to `test/integration/core/pipeline.test.ts`,
 * which exercises `runOnce` directly against hand-built `PipelineDeps`. Both matter:
 * this one is the only test that would have caught a wiring bug (wrong option name,
 * missing repo, etc.) in `runWatch` itself.
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const FORK_BLOCK = 25_987_000n;
const logger = createLogger({ level: 'silent' });

const describeIfForkable = ETH_URL ? describe : describe.skip;

describeIfForkable('sentinel watch (fork integration)', () => {
  let fork: AnvilFork;
  let configPath: string;
  let dbPath: string;

  beforeAll(async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL!, forkBlockNumber: FORK_BLOCK });
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-watch-test-'));
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
ops:
  metricsEnabled: false
`,
    );
  }, 60_000);

  afterAll(async () => {
    await fork?.stop();
  });

  it('polls the fork once, runs the pipeline, and persists a decision — without crashing', async () => {
    await expect(
      runWatch({ configPath, dbPath, logger, pollIntervalMs: 0, maxIterations: 1 }),
    ).resolves.toBeUndefined();

    const db = openDatabase(dbPath);
    const decisions = new DecisionRecordRepository(db).findRecentForPosition(
      'aave-v3:ethereum:core:USDC',
      10,
    );
    db.close();

    expect(decisions.length).toBeGreaterThan(0);
    expect(['NORMAL', 'WATCH', 'DANGER', 'CRITICAL']).toContain(decisions[0]!.level);
  }, 60_000);
});
