import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ContractReadClient } from '../../../src/chain/client.js';
import { createCachingContractReadClient } from '../../../src/replay/archive-client.js';
import { DiskCache } from '../../../src/replay/cache.js';

function tempCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'sentinel-replay-archive-client-test-'));
}

function makeInnerClient(): { client: ContractReadClient; calls: { multicall: number; getLogs: number; getBlock: number } } {
  const calls = { multicall: 0, getLogs: 0, getBlock: 0 };
  const client: ContractReadClient = {
    getBlockNumber: () => Promise.resolve(999n),
    getBlock: (blockNumber) => {
      calls.getBlock++;
      return Promise.resolve({
        number: blockNumber,
        hash: `0xhash${blockNumber}` as `0x${string}`,
        parentHash: '0xparent',
        timestamp: 1_700_000_000n,
      });
    },
    multicall: (callList, blockNumber) => {
      calls.multicall++;
      return Promise.resolve(
        callList.map(() => ({ status: 'success' as const, result: blockNumber })),
      );
    },
    getLogs: () => {
      calls.getLogs++;
      return Promise.resolve([]);
    },
  };
  return { client, calls };
}

describe('createCachingContractReadClient', () => {
  it('caches multicall results — a repeated call does not hit the inner client', async () => {
    const { client: inner, calls } = makeInnerClient();
    const cache = new DiskCache(tempCacheDir());
    const cached = createCachingContractReadClient(inner, 1, cache);

    const call = [{ address: '0xabc' as `0x${string}`, abi: [], functionName: 'foo' }];
    const first = await cached.multicall(call, 100n);
    const second = await cached.multicall(call, 100n);

    expect(calls.multicall).toBe(1);
    expect(first).toEqual(second);
  });

  it('does not reuse a cached multicall result for a different block number', async () => {
    const { client: inner, calls } = makeInnerClient();
    const cached = createCachingContractReadClient(inner, 1, new DiskCache(tempCacheDir()));

    const call = [{ address: '0xabc' as `0x${string}`, abi: [], functionName: 'foo' }];
    await cached.multicall(call, 100n);
    await cached.multicall(call, 101n);

    expect(calls.multicall).toBe(2);
  });

  it('caches getBlock and round-trips bigint fields correctly', async () => {
    const { client: inner, calls } = makeInnerClient();
    const cached = createCachingContractReadClient(inner, 1, new DiskCache(tempCacheDir()));

    const first = await cached.getBlock(50n);
    const second = await cached.getBlock(50n);

    expect(calls.getBlock).toBe(1);
    expect(second).toEqual(first);
    expect(second.number).toBe(50n);
    expect(second.timestamp).toBe(1_700_000_000n);
  });

  it('caches getLogs results', async () => {
    const { client: inner, calls } = makeInnerClient();
    const cached = createCachingContractReadClient(inner, 1, new DiskCache(tempCacheDir()));

    const query = { address: '0xabc' as `0x${string}`, events: [], fromBlock: 1n, toBlock: 10n };
    await cached.getLogs(query);
    await cached.getLogs(query);

    expect(calls.getLogs).toBe(1);
  });

  it('never caches getBlockNumber', async () => {
    const { client: inner } = makeInnerClient();
    const cached = createCachingContractReadClient(inner, 1, new DiskCache(tempCacheDir()));

    expect(await cached.getBlockNumber()).toBe(999n);
  });

  it('round-trips a failed multicall entry as a real Error', async () => {
    const cache = new DiskCache(tempCacheDir());
    const failingInner: ContractReadClient = {
      getBlockNumber: () => Promise.resolve(1n),
      getBlock: () =>
        Promise.resolve({ number: 1n, hash: '0x0', parentHash: '0x0', timestamp: 0n }),
      multicall: () =>
        Promise.resolve([{ status: 'failure' as const, error: new Error('reverted: boom') }]),
      getLogs: () => Promise.resolve([]),
    };
    const cached = createCachingContractReadClient(failingInner, 1, cache);
    const call = [{ address: '0xabc' as `0x${string}`, abi: [], functionName: 'foo' }];

    const first = await cached.multicall(call, 1n);
    const second = await cached.multicall(call, 1n);

    expect(first[0]?.status).toBe('failure');
    const secondResult = second[0];
    if (secondResult?.status !== 'failure') throw new Error('expected a failure result');
    expect(secondResult.error).toBeInstanceOf(Error);
    expect(secondResult.error.message).toBe('reverted: boom');
  });
});
