import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runReplayScenario } from '../../../src/replay/runner.js';
import { loadScenario, type ReplayScenario } from '../../../src/replay/scenario.js';
import { createLogger } from '../../../src/core/logger.js';

const POLICY = {
  watch: { action: 'alert' as const },
  danger: { action: 'partial_withdraw' as const, fraction: 0.5 },
  critical: { action: 'full_exit' as const },
  maxShareOfAvailableLiquidity: 0.05,
};

/**
 * Live-network integration test for the replay engine (`src/replay/runner.ts`),
 * against the **real** archive RPC (not an Anvil fork — replay's whole design point,
 * per docs/SPEC.md §9.1, is to work directly off a real archive-capable RPC through
 * the disk cache, so this is the one place in the test suite that's supposed to hit
 * a real network directly). Reuses the same pinned Ethereum block
 * (`test/integration/core/pipeline.test.ts`'s block 25,987,000) — so this test both
 * proves the replay engine's wiring (cache, synthetic position, `runOnce`
 * integration) *and* cross-checks that it reaches the same result as the
 * live-pipeline fork test, from an entirely different code path (archive RPC + disk
 * cache instead of an Anvil fork).
 *
 * That block holds real, small, persistent Aave Core USDC reserve deficit (~$1.60 —
 * `docs/TUNING_LOG.md`'s 2026-09-16/18 entries), which is real bad debt but below
 * `D11_bad_debt`'s materiality threshold since that threshold was corrected
 * (`docs/adr` — the same entries) — expect `NORMAL` here, not `CRITICAL`. This test
 * used to assert `CRITICAL` before that fix landed; that was itself the exact false
 * positive the fix corrects, not a real finding worth preserving.
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const logger = createLogger({ level: 'silent' });

const describeIfNetworked = ETH_URL ? describe : describe.skip;

function tinyIncidentScenario(): ReplayScenario {
  return {
    id: 'replay-engine-smoke-test',
    description: 'Single real block already known to hold Aave Core USDC bad debt.',
    kind: 'incident',
    chain: 'ethereum',
    chainId: 1,
    position: { protocol: 'aave-v3', market: 'core', asset: 'USDC' },
    blockRange: { from: 25_987_000n, to: 25_987_000n },
    sampleIntervalBlocks: 1n,
    simulatedPositionBalanceRaw: '1000000000',
    groundTruth: [
      {
        at: '2026-01-01T00:00:00.000Z',
        blockNumber: 25_987_000n,
        description: 'test fixture',
        pointOfNoReturn: true,
      },
    ],
    sources: [{ url: 'https://etherscan.io', note: 'test fixture, not a real citation' }],
  };
}

describeIfNetworked('runReplayScenario (live archive RPC + disk cache)', () => {
  it('replays a real block, persists a decision, and reads real withdrawable liquidity', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'sentinel-replay-cache-'));

    const result = await runReplayScenario(tinyIncidentScenario(), {
      archiveRpcUrls: [ETH_URL!, ETH_URL!],
      cacheDir,
      policy: POLICY,
      logger,
    });

    expect(result.blocksProcessed).toBe(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.level).toBe('NORMAL');

    expect(result.withdrawable).toHaveLength(1);
    expect(result.withdrawable[0]!.blockNumber).toBe(25_987_000n);
    expect(result.withdrawable[0]!.totalPosition).toBe(1_000_000_000n);
    expect(result.withdrawable[0]!.availableNow).toBeGreaterThanOrEqual(0n);
  }, 60_000);

  it('is fast the second time (cache hit) and produces the same decision', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'sentinel-replay-cache-'));
    const scenario = tinyIncidentScenario();

    await runReplayScenario(scenario, {
      archiveRpcUrls: [ETH_URL!, ETH_URL!],
      cacheDir,
      policy: POLICY,
      logger,
    });

    const start = Date.now();
    const second = await runReplayScenario(scenario, {
      archiveRpcUrls: [ETH_URL!, ETH_URL!],
      cacheDir,
      policy: POLICY,
      logger,
    });
    const elapsedMs = Date.now() - start;

    expect(second.decisions[0]!.level).toBe('NORMAL');
    // Generous bound — the point is "no real network round trips," not a tight SLA.
    expect(elapsedMs).toBeLessThan(5000);
  }, 60_000);
});

/**
 * Golden-output regression tests (docs/SPEC.md §9.4: "golden-output tests for each
 * scenario") for the two real named scenario files, run against the real archive RPC
 * through a single block sliced out of each scenario's own range — the full
 * multi-week scenarios (dozens to ~100 samples) are what `sentinel replay` itself
 * runs for real scoring, but re-running them in full on every test invocation would
 * be far too slow/expensive for routine CI; a single real, meaningful block from each
 * scenario's own file is still a genuine regression check tied to real scenario data,
 * not a synthetic fixture.
 */
describeIfNetworked('golden-output regression (real scenario files)', () => {
  it('kelpdao-rseth-exploit-2026-04 does not falsely reach CRITICAL via pre-existing dust bad debt at its point of no return', async () => {
    // This test used to assert CRITICAL via D11_bad_debt here — that was itself the
    // exact confound docs/TUNING_LOG.md's D11 entry documents: the exploit's own
    // collateral was WETH, not USDC, and the "CRITICAL" this single block produced
    // came entirely from pre-existing, unrelated USDC reserve dust (~$1.60) crossing
    // D11's old effectively-zero threshold, not from anything this incident actually
    // did to the watched USDC reserve. After D11's threshold fix, this block
    // honestly reports NORMAL — losing that CRITICAL isn't losing real detection,
    // since it was never real detection of this incident to begin with.
    const scenario = loadScenario('scenarios/kelpdao-rseth-exploit-2026-04.yaml');
    const pointOfNoReturn = scenario.groundTruth.find((e) => e.pointOfNoReturn)!;
    const singleBlockScenario: ReplayScenario = {
      ...scenario,
      blockRange: { from: pointOfNoReturn.blockNumber, to: pointOfNoReturn.blockNumber },
    };
    const cacheDir = mkdtempSync(join(tmpdir(), 'sentinel-replay-cache-'));

    const result = await runReplayScenario(singleBlockScenario, {
      archiveRpcUrls: [ETH_URL!, ETH_URL!],
      cacheDir,
      policy: POLICY,
      logger,
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.level).toBe('NORMAL');
  }, 60_000);

  it('usdc-depeg-2023-03 fails with the documented historical-address error (docs/PROGRESS.md Known Issues)', async () => {
    const scenario = loadScenario('scenarios/usdc-depeg-2023-03.yaml');
    const singleBlockScenario: ReplayScenario = {
      ...scenario,
      blockRange: { from: scenario.blockRange.from, to: scenario.blockRange.from },
    };
    const cacheDir = mkdtempSync(join(tmpdir(), 'sentinel-replay-cache-'));

    await expect(
      runReplayScenario(singleBlockScenario, {
        archiveRpcUrls: [ETH_URL!, ETH_URL!],
        cacheDir,
        policy: POLICY,
        logger,
      }),
    ).rejects.toThrow(/getReserveData/);
    // A regression here is good news (the historical-address gap got fixed) — if this
    // ever starts passing, update this test and docs/PROGRESS.md's Known Issues
    // together rather than just deleting the assertion.
  }, 60_000);
});
