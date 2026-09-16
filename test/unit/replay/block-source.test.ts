import { describe, expect, it } from 'vitest';

import type { ContractReadClient } from '../../../src/chain/client.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import { ReplayBlockSource } from '../../../src/replay/block-source.js';

function makeClient(): ContractReadClient {
  return {
    getBlockNumber: () => Promise.resolve(0n),
    getBlock: (blockNumber) =>
      Promise.resolve({
        number: blockNumber,
        hash: `0xhash${blockNumber}` as `0x${string}`,
        parentHash: '0xparent',
        timestamp: 1_700_000_000n + blockNumber,
      }),
    multicall: () => Promise.resolve([]),
    getLogs: () => Promise.resolve([]),
  };
}

function pool(): RpcPool<ContractReadClient> {
  return new RpcPool<ContractReadClient>(
    [
      { name: 'a', client: makeClient() },
      { name: 'b', client: makeClient() },
    ],
    undefined,
    { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  );
}

describe('ReplayBlockSource', () => {
  it('emits one sampled block per poll, at the configured stride', async () => {
    const source = new ReplayBlockSource({
      chainId: 1,
      pool: pool(),
      fromBlock: 100n,
      toBlock: 140n,
      sampleIntervalBlocks: 20n,
    });

    const numbers: bigint[] = [];
    for (;;) {
      const blocks = await source.poll();
      if (blocks.length === 0) break;
      numbers.push(...blocks.map((b) => b.number));
    }

    expect(numbers).toEqual([100n, 120n, 140n]);
  });

  it('reports real block hash/timestamp for every sampled block, not synthesized data', async () => {
    const source = new ReplayBlockSource({
      chainId: 1,
      pool: pool(),
      fromBlock: 5n,
      toBlock: 5n,
      sampleIntervalBlocks: 1n,
    });

    const [block] = await source.poll();
    expect(block).toEqual({
      chainId: 1,
      number: 5n,
      hash: '0xhash5',
      timestamp: Number(1_700_000_005n),
    });
  });

  it('returns an empty array once the range is exhausted, and exposes `done`', async () => {
    const source = new ReplayBlockSource({
      chainId: 1,
      pool: pool(),
      fromBlock: 10n,
      toBlock: 10n,
      sampleIntervalBlocks: 1n,
    });

    expect(source.done).toBe(false);
    await source.poll();
    expect(source.done).toBe(true);
    expect(await source.poll()).toEqual([]);
  });

  it('handles a range narrower than one stride (a single sample)', async () => {
    const source = new ReplayBlockSource({
      chainId: 1,
      pool: pool(),
      fromBlock: 100n,
      toBlock: 105n,
      sampleIntervalBlocks: 20n,
    });

    const first = await source.poll();
    expect(first.map((b) => b.number)).toEqual([100n]);
    expect(await source.poll()).toEqual([]);
  });
});
