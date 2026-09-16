import { createPublicClient, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';
import { poolDataProviderAbi } from '../../../src/protocols/aave-v3/abi.js';
import { AAVE_V3_ASSETS, AAVE_V3_MARKETS } from '../../../src/protocols/aave-v3/addresses.js';
import { AaveV3Adapter } from '../../../src/protocols/aave-v3/adapter.js';
import {
  createViemContractReadClient,
  type ContractReadClient,
} from '../../../src/chain/client.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import type { BlockRef, ChainId } from '../../../src/core/types.js';

/**
 * Fork integration tests (docs/SPEC.md #9.4, Phase 2 "done when": "fork integration
 * tests on Ethereum and Base match direct contract reads at pinned blocks"). Needs a
 * local `anvil` (Foundry) plus `ETH_RPC_ARCHIVE`/`BASE_RPC_ARCHIVE` set (see
 * test/integration/README.md) — each chain's suite skips cleanly if its RPC env var
 * isn't set, and `pnpm test` (unit/property) never depends on either.
 */
interface ChainCase {
  chain: 'ethereum' | 'base';
  chainId: ChainId;
  forkUrl: string | undefined;
  /** Must be recent enough that the currently-live `AAVE_PROTOCOL_DATA_PROVIDER`
   * proxy actually has code at this block — an older pinned block found this the hard
   * way, failing with "returned no data" against a real, correctly-address-booked
   * contract that simply didn't exist yet at that height (Aave v3.7 Part 2 went live
   * 2026-05-29, docs/SOURCES.md). Picked as "recent head minus a small safety margin"
   * at write time (2026-09-16); bump forward if it ever predates another
   * data-provider redeployment. */
  forkBlockNumber: bigint;
}

const CHAIN_CASES: ChainCase[] = [
  {
    chain: 'ethereum',
    chainId: 1,
    forkUrl: process.env['ETH_RPC_ARCHIVE'],
    forkBlockNumber: 25_987_000n,
  },
  {
    chain: 'base',
    chainId: 8453,
    forkUrl: process.env['BASE_RPC_ARCHIVE'],
    forkBlockNumber: 51_372_000n,
  },
];

const erc20BalanceOfAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const getReservesListAbi = [
  {
    type: 'function',
    name: 'getReservesList',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }],
  },
] as const;

for (const testCase of CHAIN_CASES) {
  const describeIfForkable = testCase.forkUrl ? describe : describe.skip;
  const USDC = AAVE_V3_ASSETS[testCase.chain]!['USDC']!;
  const { pool: POOL, poolDataProvider: DATA_PROVIDER } = AAVE_V3_MARKETS[testCase.chain]!['core']!;

  describeIfForkable(`AaveV3Adapter (fork integration, ${testCase.chain} core USDC)`, () => {
    let fork: AnvilFork;
    let rpcPool: RpcPool<ContractReadClient>;
    let at: BlockRef;

    beforeAll(async () => {
      fork = await startAnvilFork({
        forkUrl: testCase.forkUrl!,
        forkBlockNumber: testCase.forkBlockNumber,
      });
      const client = createViemContractReadClient(fork.rpcUrl, testCase.chainId);
      // Both "providers" point at the same local fork — this test verifies the
      // adapter's read/decode logic against ground truth, not cross-provider
      // disagreement handling (that's rpc-pool.test.ts's job).
      rpcPool = new RpcPool([
        { name: 'fork-a', client },
        { name: 'fork-b', client },
      ]);
      at = {
        chainId: testCase.chainId,
        number: testCase.forkBlockNumber,
        hash: '0x0',
        timestamp: 0,
      };
    }, 60_000);

    afterAll(async () => {
      await fork?.stop();
    });

    function makeAdapter() {
      return new AaveV3Adapter({
        chain: testCase.chain,
        market: 'core',
        chainId: testCase.chainId,
        watchedAssets: ['USDC'],
        pool: rpcPool,
      });
    }

    it('snapshotMarkets matches a direct getReserveData call at the pinned block', async () => {
      const [snapshot] = await makeAdapter().snapshotMarkets(['USDC'], at);
      expect(snapshot).toBeDefined();

      const directClient = createPublicClient({ transport: http(fork.rpcUrl) });
      const direct = await directClient.readContract({
        address: DATA_PROVIDER,
        abi: poolDataProviderAbi,
        functionName: 'getReserveData',
        args: [USDC],
        blockNumber: testCase.forkBlockNumber,
      });
      const [, , totalAToken, totalStableDebt, totalVariableDebt] = direct;

      expect(snapshot!.totalSupplied).toBe(totalAToken);
      expect(snapshot!.totalBorrowed).toBe(totalStableDebt + totalVariableDebt);
      // Sanity-check it's not an empty/dead reserve — i.e. the fork and the read path
      // are actually hitting real historical state, not silently reading zeros.
      expect(snapshot!.totalSupplied).toBeGreaterThan(0n);
    });

    it('availableLiquidity matches USDC.balanceOf(aToken) directly', async () => {
      const [snapshot] = await makeAdapter().snapshotMarkets(['USDC'], at);

      const directClient = createPublicClient({ transport: http(fork.rpcUrl) });
      const [aTokenAddress] = await directClient.readContract({
        address: DATA_PROVIDER,
        abi: poolDataProviderAbi,
        functionName: 'getReserveTokensAddresses',
        args: [USDC],
        blockNumber: testCase.forkBlockNumber,
      });
      const directBalance = await directClient.readContract({
        address: USDC,
        abi: erc20BalanceOfAbi,
        functionName: 'balanceOf',
        args: [aTokenAddress],
        blockNumber: testCase.forkBlockNumber,
      });

      expect(snapshot!.availableLiquidity).toBe(directBalance);
    });

    // Reads every listed reserve in one multicall batch, cold on a freshly-forked
    // anvil (fetches that many contracts' worth of state lazily from the upstream RPC
    // the first time anything touches them) — measured ~8-10s once warm, comfortably
    // under the 45s timeout below.
    const COLLATERAL_EXPOSURE_TIMEOUT_MS = 45_000;
    it(
      'collateralExposure shares sum to ~1 across every listed reserve',
      async () => {
        const exposure = await makeAdapter().collateralExposure(
          `aave-v3:${testCase.chain}:core`,
          at,
        );
        expect(exposure.length).toBeGreaterThan(5); // both markets list many reserves
        const total = exposure.reduce((sum, e) => sum + e.shareOfCollateralBase, 0);
        expect(total).toBeGreaterThan(0.99);
        expect(total).toBeLessThan(1.01);
        for (const e of exposure) {
          expect(e.method).toBe('approximate');
          expect(e.shareOfCollateralBase).toBeGreaterThanOrEqual(0);
        }
      },
      COLLATERAL_EXPOSURE_TIMEOUT_MS,
    );

    it('discoverPositions finds no USDC position for an address that never held one', async () => {
      // Not the well-known burn address (0x000...dEaD) — that one actually holds real
      // aUSDC on Ethereum mainnet (people send tokens there), which this test found
      // the hard way. A freshly-generated random address has never been sent
      // anything.
      const positions = await makeAdapter().discoverPositions(
        '0x17DD3c5D844556d6AC7c2D8D94761337E2dcAEbA',
        at,
      );
      expect(positions).toEqual([]);
    });

    it('POOL.getReservesList() includes the watched USDC reserve', async () => {
      const directClient = createPublicClient({ transport: http(fork.rpcUrl) });
      const reserves = await directClient.readContract({
        address: POOL,
        abi: getReservesListAbi,
        functionName: 'getReservesList',
        blockNumber: testCase.forkBlockNumber,
      });
      expect(reserves.map((a) => a.toLowerCase())).toContain(USDC.toLowerCase());
    });
  });
}
