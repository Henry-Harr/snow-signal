import { createTestClient, http } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';

import { LiveBlockSource } from '../../../src/chain/block-source.js';
import { createViemContractReadClient, type ContractReadClient } from '../../../src/chain/client.js';
import { startAnvilFork, type AnvilFork } from '../../../src/chain/anvil.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import { createLogger } from '../../../src/core/logger.js';
import { openDatabase } from '../../../src/storage/db.js';
import { ChainStateRepository } from '../../../src/storage/chain-state-repository.js';

/**
 * Chaos test (docs/SPEC.md §9 Phase 9): a **real** reorg, not a mocked one.
 * `test/unit/chain/block-source.test.ts` already proves `LiveBlockSource`'s rollback
 * logic against hand-built mock providers; this proves the same logic against real
 * Anvil-produced block hashes and timestamps, using `evm_snapshot`/`evm_revert` to
 * genuinely replace one block with a different one at the same height (confirmed by
 * checking the two blocks' hashes actually differ) — the closest a local fork can get
 * to a real network reorg.
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const describeIfForkable = ETH_URL ? describe : describe.skip;

describeIfForkable('LiveBlockSource (chaos: a real reorg on a fork)', () => {
  let fork: AnvilFork | undefined;

  afterEach(async () => {
    await fork?.stop();
    fork = undefined;
  });

  it('detects a real reorg, rolls back, and reprocesses the new canonical chain', async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL! });

    const db = openDatabase(':memory:');
    const chainState = new ChainStateRepository(db);
    // A fresh pool (fresh viem clients) per poll — viem's public client caches
    // `eth_blockNumber` for a few seconds by default, which would otherwise make a
    // poll() called immediately after mining see a stale head. Production `sentinel
    // watch` never hits this in practice (its poll interval is far longer than
    // viem's cache window); this chaos test deliberately mines and polls back to
    // back, so it needs the cache out of the way.
    function freshBlockSource(): LiveBlockSource {
      const providers = [0, 1].map((i) => ({
        name: `p${i}`,
        client: createViemContractReadClient(fork!.rpcUrl, 1),
      }));
      const pool = new RpcPool<ContractReadClient>(providers, createLogger({ level: 'silent' }));
      return new LiveBlockSource({
        chainId: 1,
        confirmations: 0,
        pool,
        chainState,
        logger: createLogger({ level: 'silent' }),
      });
    }

    const testClient = createTestClient({ mode: 'anvil', transport: http(fork.rpcUrl) });

    // Establish a starting point: process block N.
    const firstPoll = await freshBlockSource().poll();
    expect(firstPoll).toHaveLength(1);
    const blockN = firstPoll[0]!;

    // Snapshot right at N, before any alternate history exists.
    const snapshotAtN = await testClient.snapshot();

    // Mine block A on top of N, process it.
    await testClient.mine({ blocks: 1 });
    const secondPoll = await freshBlockSource().poll();
    expect(secondPoll).toHaveLength(1);
    const blockA = secondPoll[0]!;
    expect(blockA.number).toBe(blockN.number + 1n);

    // Revert to right after N, then mine a *different* block B at the same height —
    // a real reorg: same parent, different block. A large time jump guarantees a
    // different hash even though nothing else about fork state changed.
    await testClient.revert({ id: snapshotAtN });
    await testClient.increaseTime({ seconds: 3600 });
    await testClient.mine({ blocks: 1 });

    // Mine one more block (C) on top of B — LiveBlockSource only notices a reorg
    // when it fetches a block whose parentHash no longer matches what it has stored,
    // which requires something new past the point of divergence.
    await testClient.mine({ blocks: 1 });

    const thirdPoll = await freshBlockSource().poll();

    // Recovered: both B (replacing A) and C are now processed, and B's hash is
    // genuinely different from A's — this really was a different block, not the
    // same one re-emitted.
    expect(thirdPoll).toHaveLength(2);
    const [blockB, blockC] = thirdPoll;
    expect(blockB!.number).toBe(blockA.number);
    expect(blockB!.hash).not.toBe(blockA.hash);
    expect(blockC!.number).toBe(blockA.number + 1n);

    const stored = chainState.getLastProcessed(1);
    expect(stored?.number).toBe(blockC!.number);
    expect(stored?.hash).toBe(blockC!.hash);

    db.close();
  }, 60_000);
});
