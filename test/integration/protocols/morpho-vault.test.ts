import { createPublicClient, erc4626Abi, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';
import { metaMorphoAbi } from '../../../src/protocols/morpho-vault/abi.js';
import { MorphoVaultAdapter } from '../../../src/protocols/morpho-vault/adapter.js';
import {
  createViemContractReadClient,
  type ContractReadClient,
} from '../../../src/chain/client.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import type { BlockRef } from '../../../src/core/types.js';

/**
 * Fork integration test (docs/SPEC.md #9.4, Phase 2 "done when"). Needs a local
 * `anvil` (Foundry) plus `BASE_RPC_ARCHIVE` set (see test/integration/README.md) —
 * skips cleanly otherwise.
 *
 * Uses the user's own watched vault, Gauntlet USDC Prime on Base
 * (config/sentinel.yaml), confirmed **on-chain** (not just via docs) to be a
 * MetaMorpho v1.1 vault: `isMetaMorpho()` on its deploying factory returned `true`,
 * and the same factory's `isVaultV2()` reverted, in this session (2026-09-16).
 */
const forkUrl = process.env['BASE_RPC_ARCHIVE'];
const describeIfForkable = forkUrl ? describe : describe.skip;

const FORK_BLOCK = 34_000_000n;
const VAULT = '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61' as const;

describeIfForkable('MorphoVaultAdapter (fork integration, Gauntlet USDC Prime, Base)', () => {
  let fork: AnvilFork;
  let rpcPool: RpcPool<ContractReadClient>;
  let at: BlockRef;

  beforeAll(async () => {
    fork = await startAnvilFork({ forkUrl: forkUrl!, forkBlockNumber: FORK_BLOCK });
    const client = createViemContractReadClient(fork.rpcUrl, 8453);
    rpcPool = new RpcPool([
      { name: 'fork-a', client },
      { name: 'fork-b', client },
    ]);
    at = { chainId: 8453, number: FORK_BLOCK, hash: '0x0', timestamp: 0 };
  }, 60_000);

  afterAll(async () => {
    await fork?.stop();
  });

  function makeAdapter() {
    return new MorphoVaultAdapter({
      chain: 'base',
      chainId: 8453,
      vaultAddress: VAULT,
      pool: rpcPool,
    });
  }

  it('snapshotMarkets.totalSupplied matches a direct totalAssets() call', async () => {
    const [snapshot] = await makeAdapter().snapshotMarkets([], at);
    expect(snapshot).toBeDefined();

    const directClient = createPublicClient({ transport: http(fork.rpcUrl) });
    const directTotalAssets = await directClient.readContract({
      address: VAULT,
      abi: erc4626Abi,
      functionName: 'totalAssets',
      blockNumber: FORK_BLOCK,
    });

    expect(snapshot!.totalSupplied).toBe(directTotalAssets);
    expect(snapshot!.totalSupplied).toBeGreaterThan(0n);
  }, 30_000);

  it('reads the real supply/withdraw queues and every allocated market matches direct reads', async () => {
    const [snapshot] = await makeAdapter().snapshotMarkets([], at);
    const raw = snapshot!.raw as {
      allocations: { id: `0x${string}`; collateralToken: string; cap: bigint }[];
    };
    expect(raw.allocations.length).toBeGreaterThan(0);

    const directClient = createPublicClient({ transport: http(fork.rpcUrl) });
    const withdrawQueueLength = await directClient.readContract({
      address: VAULT,
      abi: metaMorphoAbi,
      functionName: 'withdrawQueueLength',
      blockNumber: FORK_BLOCK,
    });
    expect(withdrawQueueLength).toBeGreaterThan(0n);

    const firstMarketId = await directClient.readContract({
      address: VAULT,
      abi: metaMorphoAbi,
      functionName: 'withdrawQueue',
      args: [0n],
      blockNumber: FORK_BLOCK,
    });
    const directConfig = await directClient.readContract({
      address: VAULT,
      abi: metaMorphoAbi,
      functionName: 'config',
      args: [firstMarketId],
      blockNumber: FORK_BLOCK,
    });

    const matching = raw.allocations.find((a) => a.id === firstMarketId);
    expect(matching).toBeDefined();
    expect(matching!.cap).toBe(directConfig.cap);
  }, 30_000);

  it('availableLiquidity never exceeds totalSupplied', async () => {
    const [snapshot] = await makeAdapter().snapshotMarkets([], at);
    expect(snapshot!.availableLiquidity).toBeGreaterThan(0n);
    expect(snapshot!.availableLiquidity).toBeLessThanOrEqual(snapshot!.totalSupplied);
  }, 30_000);

  it('collateralExposure shares are each between 0 and 1, summing to at most 1 (idle cash has no exposure)', async () => {
    const exposure = await makeAdapter().collateralExposure(`morpho-vault:base:${VAULT}`, at);
    expect(exposure.length).toBeGreaterThan(0);
    const total = exposure.reduce((sum, e) => sum + e.shareOfCollateralBase, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(1.0001); // small float slack
    for (const e of exposure) {
      expect(e.method).toBe('exact');
      // A market can sit in the withdraw queue with zero current allocation (never
      // funded yet, or fully pulled out) — 0 is a legitimate share, not a bug.
      expect(e.shareOfCollateralBase).toBeGreaterThanOrEqual(0);
      expect(e.shareOfCollateralBase).toBeLessThanOrEqual(1);
    }
  }, 30_000);

  it('discoverPositions finds nothing for an address that never held vault shares', async () => {
    const positions = await makeAdapter().discoverPositions(
      '0x17DD3c5D844556d6AC7c2D8D94761337E2dcAEbA',
      at,
    );
    expect(positions).toEqual([]);
  });
});
