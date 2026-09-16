import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';
import {
  aaveGovernanceTarget,
  fetchGovernanceEvents,
  morphoBlueGovernanceTarget,
  morphoVaultGovernanceTarget,
  resolveAaveConfiguratorAddress,
} from '../../../src/watchers/governance.js';
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
 * `ETH_RPC_ARCHIVE`/`BASE_RPC_ARCHIVE` set (see test/integration/README.md).
 *
 * Block ranges here are kept to 5 blocks — at least one configured provider's free
 * tier caps `eth_getLogs` at 10 blocks per call (found directly against Alchemy,
 * 2026-09-16; see src/watchers/governance.ts's header comment). Governance events are
 * rare, so these tests verify the real plumbing works (address resolution succeeds,
 * the call succeeds, the result is a well-formed array) rather than asserting a
 * specific event landed in an arbitrary small window — same philosophy as the CEX
 * live-agreement test.
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const BASE_URL = process.env['BASE_RPC_ARCHIVE'];

const describeIfEthForkable = ETH_URL ? describe : describe.skip;
const describeIfBaseForkable = BASE_URL ? describe : describe.skip;

describeIfEthForkable('governance watcher (fork integration, Ethereum, Aave + Morpho Blue)', () => {
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

  it('resolves the real Aave PoolConfigurator address', async () => {
    const configurator = await resolveAaveConfiguratorAddress(
      rpcPool,
      AAVE_V3_MARKETS['ethereum']!['core']!.pool,
      at,
    );
    expect(configurator.toLowerCase()).toBe('0x64b761d848206f447fe2dd461b0c635ec39ebb27');
  });

  it('fetches governance events for Aave + Morpho Blue over a real small block range', async () => {
    const aaveAdapter = new AaveV3Adapter({
      chain: 'ethereum',
      market: 'core',
      chainId: 1,
      watchedAssets: ['USDC'],
      pool: rpcPool,
    });
    const configurator = await resolveAaveConfiguratorAddress(
      rpcPool,
      AAVE_V3_MARKETS['ethereum']!['core']!.pool,
      at,
    );
    const morphoAdapter = new MorphoBlueAdapter({
      chain: 'ethereum',
      chainId: 1,
      watchedMarketIds: [],
      pool: rpcPool,
    });

    const events = await fetchGovernanceEvents(
      rpcPool,
      [
        aaveGovernanceTarget(aaveAdapter, configurator),
        morphoBlueGovernanceTarget(morphoAdapter, MORPHO_BLUE_ADDRESS['ethereum']!),
      ],
      forkBlockNumber - 5n,
      forkBlockNumber,
    );

    // Real chain, real (tiny) window — asserting the call succeeded and returned a
    // well-formed array is the point; a real governance event landing in this exact
    // 5-block window isn't guaranteed.
    expect(Array.isArray(events)).toBe(true);
    for (const event of events) {
      expect(['aave-v3', 'morpho-blue']).toContain(event.protocol);
      expect(event.blockNumber).toBeGreaterThanOrEqual(forkBlockNumber - 5n);
      expect(event.blockNumber).toBeLessThanOrEqual(forkBlockNumber);
    }
  });
});

describeIfBaseForkable('governance watcher (fork integration, Base, Morpho vault)', () => {
  const forkBlockNumber = 51_370_000n;
  let fork: AnvilFork;
  let rpcPool: RpcPool<ContractReadClient>;
  let at: BlockRef;

  beforeAll(async () => {
    fork = await startAnvilFork({ forkUrl: BASE_URL!, forkBlockNumber });
    const client = createViemContractReadClient(fork.rpcUrl, 8453);
    rpcPool = new RpcPool([
      { name: 'fork-a', client },
      { name: 'fork-b', client },
    ]);
    at = { chainId: 8453, number: forkBlockNumber, hash: '0x0', timestamp: 0 };
  }, 60_000);

  afterAll(async () => {
    await fork?.stop();
  });

  it('fetches governance events for the real watched vault over a real small block range', async () => {
    const vault = '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61' as const;
    const vaultAdapter = new MorphoVaultAdapter({
      chain: 'base',
      chainId: 8453,
      vaultAddress: vault,
      pool: rpcPool,
    });

    const events = await fetchGovernanceEvents(
      rpcPool,
      [morphoVaultGovernanceTarget(vaultAdapter, vault)],
      forkBlockNumber - 5n,
      forkBlockNumber,
    );

    expect(Array.isArray(events)).toBe(true);
    for (const event of events) {
      expect(event.protocol).toBe('morpho-vault');
    }
  });

  it('resolveAaveConfiguratorAddress resolves the real Base PoolConfigurator too', async () => {
    const configurator = await resolveAaveConfiguratorAddress(
      rpcPool,
      AAVE_V3_MARKETS['base']!['core']!.pool,
      at,
    );
    expect(configurator.toLowerCase()).toBe('0x5731a04b1e775f0fdd454bf70f3335886e9a96be');
  });
});
