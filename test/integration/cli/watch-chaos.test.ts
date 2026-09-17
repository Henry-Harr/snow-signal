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
 * Chaos test (docs/SPEC.md §9 Phase 9, docs/PROGRESS.md's chaos-test checklist item):
 * one configured chain is completely unreachable (both its RPC providers point at a
 * port nothing is listening on) while the other is a real, healthy fork. Proves
 * `sentinel watch`'s own claimed resilience (`src/cli/watch.ts`'s doc comment: "a
 * failure processing one chain's poll ... is logged and the loop continues") against
 * a real failure, not just by reading the code — the happy-path fork test
 * (`watch.test.ts`) never exercises this branch at all.
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const FORK_BLOCK = 25_987_000n;
const logger = createLogger({ level: 'silent' });

const describeIfForkable = ETH_URL ? describe : describe.skip;

// A port nothing listens on in this sandbox — deliberately unreachable, not merely
// slow, to exercise the "provider connection refused" branch specifically.
const UNREACHABLE_RPC = 'http://127.0.0.1:1';

describeIfForkable('sentinel watch (chaos: one chain fully unreachable)', () => {
  let fork: AnvilFork;
  let configPath: string;
  let dbPath: string;

  beforeAll(async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL!, forkBlockNumber: FORK_BLOCK });
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-watch-chaos-test-'));
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
  base:
    chainId: 8453
    confirmations: 0
    rpc:
      - { name: a, url: '${UNREACHABLE_RPC}' }
      - { name: b, url: '${UNREACHABLE_RPC}' }
positions:
  - { protocol: aave-v3, chain: ethereum, market: core, asset: USDC }
  - { protocol: aave-v3, chain: base, market: core, asset: USDC }
detectors: {}
policy:
  danger: { action: partial_withdraw, fraction: 0.5 }
  critical: { action: full_exit }
  maxShareOfAvailableLiquidity: 0.05
execution:
  mode: off
  maxPriorityFeeGwei: { ethereum: 50, base: 1 }
notify: {}
reports:
  dailyUtcHour: 0
  benchmark: { kind: pool_base_rate }
`,
    );
  }, 60_000);

  afterAll(async () => {
    await fork?.stop();
  });

  it('still processes the healthy chain and persists its decision, without throwing, despite the other chain being unreachable', async () => {
    await expect(
      runWatch({ configPath, dbPath, logger, pollIntervalMs: 0, maxIterations: 1 }),
    ).resolves.toBeUndefined();

    const db = openDatabase(dbPath);
    const decisionRecords = new DecisionRecordRepository(db);
    const ethereumDecisions = decisionRecords.findRecentForPosition(
      'aave-v3:ethereum:core:USDC',
      10,
    );
    const baseDecisions = decisionRecords.findRecentForPosition('aave-v3:base:core:USDC', 10);
    db.close();

    expect(ethereumDecisions.length).toBeGreaterThan(0);
    expect(baseDecisions.length).toBe(0);
  }, 60_000);
});
