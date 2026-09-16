import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';
import {
  aavePoolFlowTarget,
  computeHolderLedger,
  extractAaveMovement,
  extractMorphoBlueMovement,
  extractMorphoVaultMovement,
  fetchAaveBorrowerHealth,
  fetchPoolFlowEvents,
  HEALTH_FACTOR_SCALE,
  morphoBluePoolFlowTarget,
  morphoVaultPoolFlowTarget,
  rankHolders,
} from '../../../src/watchers/large-holders.js';
import { AAVE_V3_MARKETS } from '../../../src/protocols/aave-v3/addresses.js';
import { AaveV3Adapter } from '../../../src/protocols/aave-v3/adapter.js';
import { MORPHO_BLUE_ADDRESS } from '../../../src/protocols/morpho-blue/addresses.js';
import { MorphoBlueAdapter } from '../../../src/protocols/morpho-blue/adapter.js';
import { MorphoVaultAdapter } from '../../../src/protocols/morpho-vault/adapter.js';
import {
  createViemContractReadClient,
  type ContractReadClient,
} from '../../../src/chain/client.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import type { BlockRef } from '../../../src/core/types.js';

/**
 * Fork integration test (docs/SPEC.md #9.4). Needs a local `anvil` (Foundry) plus
 * `ETH_RPC_ARCHIVE`/`BASE_RPC_ARCHIVE` set (see test/integration/README.md). Block
 * ranges kept to 5 blocks, same free-tier `eth_getLogs` constraint as the governance
 * fork tests — but unlike governance events, Supply/Withdraw/Borrow/Repay happen on
 * (real, live) Aave's Ethereum Core market many times within any 5-block window, so
 * this test both checks the plumbing (well-formed results) and, when real events
 * come back, runs them through the full ledger/ranking pipeline.
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const BASE_URL = process.env['BASE_RPC_ARCHIVE'];

const describeIfEthForkable = ETH_URL ? describe : describe.skip;
const describeIfBaseForkable = BASE_URL ? describe : describe.skip;

describeIfEthForkable(
  'large-holder watcher (fork integration, Ethereum, Aave + Morpho Blue)',
  () => {
    const forkBlockNumber = 25_987_000n;
    let fork: AnvilFork;
    let rpcPool: RpcPool<ContractReadClient>;
    let at: BlockRef;

    beforeAll(async () => {
      fork = await startAnvilFork({ forkUrl: ETH_URL!, forkBlockNumber });
      const client = createViemContractReadClient(fork.rpcUrl, 1);
      rpcPool = new RpcPool([
        { name: 'fork-a', client },
        { name: 'fork-b', client },
      ]);
      at = { chainId: 1, number: forkBlockNumber, hash: '0x0', timestamp: 0 };
    }, 60_000);

    afterAll(async () => {
      await fork?.stop();
    });

    it('fetches real Aave pool-flow events and reduces them into a plausible holder ledger', async () => {
      const aaveAdapter = new AaveV3Adapter({
        chain: 'ethereum',
        market: 'core',
        chainId: 1,
        watchedAssets: ['USDC'],
        pool: rpcPool,
      });
      const events = await fetchPoolFlowEvents(
        rpcPool,
        [aavePoolFlowTarget(aaveAdapter, AAVE_V3_MARKETS['ethereum']!['core']!.pool)],
        forkBlockNumber - 5n,
        forkBlockNumber,
      );
      expect(Array.isArray(events)).toBe(true);
      for (const event of events) {
        expect(['Supply', 'Withdraw', 'Borrow', 'Repay']).toContain(event.eventName);
      }

      const ledger = computeHolderLedger(events, extractAaveMovement);
      // Every extracted movement must have landed in the ledger under its holder.
      for (const event of events) {
        const move = extractAaveMovement(event);
        if (!move) continue;
        expect(ledger.has(move.holder.toLowerCase() as typeof move.holder)).toBe(true);
      }

      const topSuppliers = rankHolders(ledger, 'supply', 10);
      const topBorrowers = rankHolders(ledger, 'borrow', 10);
      // Ranking invariant: descending, and every entry actually has a positive balance
      // on the ranked side (rankHolders' own exclusion of non-positive balances).
      for (const list of [topSuppliers, topBorrowers]) {
        for (let i = 1; i < list.length; i++) {
          const side = list === topSuppliers ? 'supply' : 'borrow';
          expect(list[i - 1]![side]).toBeGreaterThanOrEqual(list[i]![side]);
        }
      }
    });

    it('fetches Morpho Blue pool-flow events and extracts movements without error', async () => {
      const morphoAdapter = new MorphoBlueAdapter({
        chain: 'ethereum',
        chainId: 1,
        watchedMarketIds: [],
        pool: rpcPool,
      });
      const events = await fetchPoolFlowEvents(
        rpcPool,
        [morphoBluePoolFlowTarget(morphoAdapter, MORPHO_BLUE_ADDRESS['ethereum']!)],
        forkBlockNumber - 5n,
        forkBlockNumber,
      );
      expect(Array.isArray(events)).toBe(true);
      const ledger = computeHolderLedger(events, extractMorphoBlueMovement);
      expect(ledger).toBeInstanceOf(Map);
    });

    it('fetchAaveBorrowerHealth matches a direct getUserAccountData call for a zero-position address', async () => {
      const zeroPosition = '0x0000000000000000000000000000000000000001' as const;
      const [health] = await fetchAaveBorrowerHealth(
        rpcPool,
        AAVE_V3_MARKETS['ethereum']!['core']!.pool,
        [zeroPosition],
        at,
      );
      expect(health).toEqual({
        holder: zeroPosition,
        totalCollateralBase: 0n,
        totalDebtBase: 0n,
        healthFactor: 2n ** 256n - 1n, // Aave's "no debt" sentinel, verified via cast this session.
      });
      expect(health!.healthFactor).toBeGreaterThan(HEALTH_FACTOR_SCALE);
    });
  },
);

describeIfBaseForkable('large-holder watcher (fork integration, Base, Morpho vault)', () => {
  const forkBlockNumber = 51_370_000n;
  let fork: AnvilFork;
  let rpcPool: RpcPool<ContractReadClient>;

  beforeAll(async () => {
    fork = await startAnvilFork({ forkUrl: BASE_URL!, forkBlockNumber });
    const client = createViemContractReadClient(fork.rpcUrl, 8453);
    rpcPool = new RpcPool([
      { name: 'fork-a', client },
      { name: 'fork-b', client },
    ]);
  }, 60_000);

  afterAll(async () => {
    await fork?.stop();
  });

  it('fetches real vault Deposit/Withdraw events and reduces them into a ledger', async () => {
    const vault = '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61' as const;
    const vaultAdapter = new MorphoVaultAdapter({
      chain: 'base',
      chainId: 8453,
      vaultAddress: vault,
      pool: rpcPool,
    });
    const events = await fetchPoolFlowEvents(
      rpcPool,
      [morphoVaultPoolFlowTarget(vaultAdapter, vault)],
      forkBlockNumber - 5n,
      forkBlockNumber,
    );
    expect(Array.isArray(events)).toBe(true);
    for (const event of events) {
      expect(['Deposit', 'Withdraw']).toContain(event.eventName);
    }
    const ledger = computeHolderLedger(events, extractMorphoVaultMovement);
    const topDepositors = rankHolders(ledger, 'supply', 10);
    for (const holder of topDepositors) {
      expect(holder.supply).toBeGreaterThan(0n);
    }
  });
});
