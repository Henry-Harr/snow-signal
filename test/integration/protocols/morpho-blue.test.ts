import { createPublicClient, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';
import { morphoBlueAbi } from '../../../src/protocols/morpho-blue/abi.js';
import { MORPHO_BLUE_ADDRESS } from '../../../src/protocols/morpho-blue/addresses.js';
import { MorphoBlueAdapter } from '../../../src/protocols/morpho-blue/adapter.js';
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
 * Uses a real, currently-active Base market (USDC loan / wstETH collateral) that the
 * user's own watched Morpho vault (Gauntlet USDC Prime, config/sentinel.yaml)
 * allocates into — found via a live query against Morpho's own GraphQL API
 * (`api.morpho.org/graphql`, `vaultByAddress.state.allocation`, 2026-09-16), not
 * guessed. The same vault address happens to hold a real position in this market at
 * the pinned block, which doubles as a real `discoverPositions` fixture.
 */
const forkUrl = process.env['BASE_RPC_ARCHIVE'];
const describeIfForkable = forkUrl ? describe : describe.skip;

const FORK_BLOCK = 34_000_000n;
const MORPHO_BLUE = MORPHO_BLUE_ADDRESS['base']!;
const MARKET_ID = '0x13c42741a359ac4a8aa8287d2be109dcf28344484f91185f9a79bd5a805a55ae' as const;
// Gauntlet USDC Prime — confirmed via the same GraphQL query to hold a real supply
// position in this exact market.
const VAULT_WITH_POSITION = '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61' as const;

describeIfForkable('MorphoBlueAdapter (fork integration, Base)', () => {
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
    return new MorphoBlueAdapter({
      chain: 'base',
      chainId: 8453,
      watchedMarketIds: [MARKET_ID],
      pool: rpcPool,
    });
  }

  it('snapshotMarkets matches a direct market() call at the pinned block', async () => {
    const [snapshot] = await makeAdapter().snapshotMarkets([MARKET_ID], at);
    expect(snapshot).toBeDefined();

    const directClient = createPublicClient({ transport: http(fork.rpcUrl) });
    const direct = await directClient.readContract({
      address: MORPHO_BLUE,
      abi: morphoBlueAbi,
      functionName: 'market',
      args: [MARKET_ID],
      blockNumber: FORK_BLOCK,
    });

    expect(snapshot!.totalSupplied).toBe(direct.totalSupplyAssets);
    expect(snapshot!.totalBorrowed).toBe(direct.totalBorrowAssets);
    expect(snapshot!.availableLiquidity).toBe(direct.totalSupplyAssets - direct.totalBorrowAssets);
    // Sanity-check it's a real, active market, not an empty one.
    expect(snapshot!.totalSupplied).toBeGreaterThan(0n);
    expect(snapshot!.totalBorrowed).toBeGreaterThan(0n);
  });

  it('idToMarketParams matches a direct call, and oraclePrices is keyed by the collateral token', async () => {
    const [snapshot] = await makeAdapter().snapshotMarkets([MARKET_ID], at);

    const directClient = createPublicClient({ transport: http(fork.rpcUrl) });
    const params = await directClient.readContract({
      address: MORPHO_BLUE,
      abi: morphoBlueAbi,
      functionName: 'idToMarketParams',
      args: [MARKET_ID],
      blockNumber: FORK_BLOCK,
    });

    expect(Object.keys(snapshot!.oraclePrices)).toEqual([params.collateralToken]);
    expect(snapshot!.oraclePrices[params.collateralToken]).toBeGreaterThan(0n);
  });

  it('collateralExposure is 100% (exact) for this actively-borrowed market', async () => {
    const exposure = await makeAdapter().collateralExposure(`morpho-blue:base:${MARKET_ID}`, at);
    expect(exposure).toHaveLength(1);
    expect(exposure[0]!.shareOfCollateralBase).toBe(1);
    expect(exposure[0]!.method).toBe('exact');
  });

  it('discoverPositions finds the real Gauntlet USDC Prime position in this market', async () => {
    const positions = await makeAdapter().discoverPositions(VAULT_WITH_POSITION, at);
    expect(positions).toHaveLength(1);
    expect(positions[0]!.owner).toBe(VAULT_WITH_POSITION);
    expect(positions[0]!.marketId).toBe(`morpho-blue:base:${MARKET_ID}`);
    expect(positions[0]!.balance).toBeGreaterThan(0n);
  });

  it('discoverPositions finds nothing for an address that never held a position', async () => {
    const positions = await makeAdapter().discoverPositions(
      '0x17DD3c5D844556d6AC7c2D8D94761337E2dcAEbA',
      at,
    );
    expect(positions).toEqual([]);
  });

  it('withdrawable never exceeds the real position balance', async () => {
    const [position] = await makeAdapter().discoverPositions(VAULT_WITH_POSITION, at);
    expect(position).toBeDefined();
    const estimate = await makeAdapter().withdrawable(position!, at);
    expect(estimate.availableNow).toBeLessThanOrEqual(estimate.totalPosition);
    expect(estimate.availableNow).toBeGreaterThan(0n);
  });
});
