import { describe, expect, it } from 'vitest';

import { fetchMintEvents, fetchTotalSupply } from '../../../src/watchers/token-supply.js';
import type {
  ContractCall,
  ContractCallResult,
  ContractReadClient,
  DecodedLog,
  LogQuery,
} from '../../../src/chain/client.js';
import { RpcPool, type NamedProvider } from '../../../src/chain/rpc-pool.js';
import { QuorumError } from '../../../src/core/errors.js';
import type { BlockRef } from '../../../src/core/types.js';

function addr(seed: string): `0x${string}` {
  return `0x${seed.repeat(40).slice(0, 40)}`;
}

const AT: BlockRef = { chainId: 1, number: 100n, hash: '0xblock', timestamp: 1_700_000_000 };
const USDC = addr('a5');
const ZERO = '0x0000000000000000000000000000000000000000';
const MINTER = addr('01');
const HOLDER = addr('02');

function mockClient(options: {
  multicall?: (calls: ContractCall[]) => ContractCallResult[];
  getLogs?: (query: LogQuery) => DecodedLog[];
}): ContractReadClient {
  return {
    getBlockNumber: () => Promise.resolve(AT.number),
    getBlock: () =>
      Promise.resolve({
        number: AT.number,
        hash: '0xblock',
        parentHash: '0xparent',
        timestamp: 0n,
      }),
    multicall: (calls) => Promise.resolve(options.multicall ? options.multicall(calls) : []),
    getLogs: (query) => Promise.resolve(options.getLogs ? options.getLogs(query) : []),
  };
}

function poolOf(client: ContractReadClient): RpcPool<ContractReadClient> {
  const providers: NamedProvider<ContractReadClient>[] = [
    { name: 'a', client },
    { name: 'b', client },
  ];
  return new RpcPool(providers, undefined, { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 });
}

describe('fetchTotalSupply', () => {
  it('reads and returns a snapshot pinned to the given block', async () => {
    const client = mockClient({
      multicall: (calls) =>
        calls.map((): ContractCallResult => ({ status: 'success', result: 123_456_789n })),
    });
    const snapshot = await fetchTotalSupply(poolOf(client), USDC, AT);
    expect(snapshot).toEqual({
      asset: USDC,
      chainId: 1,
      totalSupply: 123_456_789n,
      blockNumber: 100n,
      fetchedAt: 1_700_000_000,
    });
  });

  it('throws (via quorumRead having no successful providers) when the call fails everywhere', async () => {
    const client = mockClient({
      multicall: (calls) =>
        calls.map((): ContractCallResult => ({ status: 'failure', error: new Error('boom') })),
    });
    // quorumRead needs 2 successful providers; the AdapterError thrown inside the
    // callback for each failed provider never surfaces directly — quorumRead reports
    // the aggregate failure as QuorumError instead (same behavior as every other
    // quorumRead call site, e.g. the adapters' own reads).
    await expect(fetchTotalSupply(poolOf(client), USDC, AT)).rejects.toThrow(QuorumError);
  });
});

describe('fetchMintEvents', () => {
  it('keeps only Transfer events from the zero address', async () => {
    const client = mockClient({
      getLogs: () => [
        {
          address: USDC,
          blockNumber: 50n,
          transactionHash: '0xabc',
          logIndex: 1,
          eventName: 'Transfer',
          args: { from: ZERO, to: MINTER, value: 1_000_000n },
        },
        {
          address: USDC,
          blockNumber: 51n,
          transactionHash: '0xdef',
          logIndex: 2,
          eventName: 'Transfer',
          args: { from: MINTER, to: HOLDER, value: 500n }, // a regular transfer, not a mint
        },
      ],
    });
    const events = await fetchMintEvents(poolOf(client), USDC, 1, 0n, 100n);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      protocol: 'erc20',
      chainId: 1,
      marketId: `erc20:1:${USDC}`,
      eventName: 'Mint',
      blockNumber: 50n,
      transactionHash: '0xabc',
      logIndex: 1,
      args: { from: ZERO, to: MINTER, value: 1_000_000n },
    });
  });

  it('returns an empty array when there are no mints in range', async () => {
    const client = mockClient({
      getLogs: () => [
        {
          address: USDC,
          blockNumber: 50n,
          transactionHash: '0xabc',
          logIndex: 1,
          eventName: 'Transfer',
          args: { from: MINTER, to: HOLDER, value: 500n },
        },
      ],
    });
    const events = await fetchMintEvents(poolOf(client), USDC, 1, 0n, 100n);
    expect(events).toEqual([]);
  });
});
