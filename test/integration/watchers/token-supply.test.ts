import { createPublicClient, erc20Abi, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAnvilFork, type AnvilFork } from '../helpers/anvil.js';
import { fetchMintEvents, fetchTotalSupply } from '../../../src/watchers/token-supply.js';
import { AAVE_V3_ASSETS } from '../../../src/protocols/aave-v3/addresses.js';
import {
  createViemContractReadClient,
  type ContractReadClient,
} from '../../../src/chain/client.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import type { BlockRef } from '../../../src/core/types.js';

/**
 * Fork integration test (docs/SPEC.md #9.4). Needs a local `anvil` (Foundry) plus
 * `ETH_RPC_ARCHIVE` set (see test/integration/README.md). Block range kept to 5
 * blocks — see src/watchers/governance.ts's header comment on the free-tier
 * `eth_getLogs` cap this also applies to.
 */
const forkUrl = process.env['ETH_RPC_ARCHIVE'];
const describeIfForkable = forkUrl ? describe : describe.skip;

const forkBlockNumber = 25_987_000n;
const USDC = AAVE_V3_ASSETS['ethereum']!['USDC']!;

describeIfForkable('token-supply watcher (fork integration, Ethereum USDC)', () => {
  let fork: AnvilFork;
  let rpcPool: RpcPool<ContractReadClient>;
  let at: BlockRef;

  beforeAll(async () => {
    fork = await startAnvilFork({ forkUrl: forkUrl!, forkBlockNumber });
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

  it('fetchTotalSupply matches a direct totalSupply() call', async () => {
    const snapshot = await fetchTotalSupply(rpcPool, USDC, at);
    expect(snapshot.totalSupply).toBeGreaterThan(0n);

    const directClient = createPublicClient({ transport: http(fork.rpcUrl) });
    const direct = await directClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'totalSupply',
      blockNumber: forkBlockNumber,
    });
    expect(snapshot.totalSupply).toBe(direct);
  });

  it('fetchMintEvents runs against real USDC Transfer logs without error', async () => {
    const events = await fetchMintEvents(rpcPool, USDC, 1, forkBlockNumber - 5n, forkBlockNumber);
    expect(Array.isArray(events)).toBe(true);
    for (const event of events) {
      expect(event.eventName).toBe('Mint');
      expect(event.protocol).toBe('erc20');
      expect((event.args['from'] as string).toLowerCase()).toBe(
        '0x0000000000000000000000000000000000000000',
      );
    }
  });
});
