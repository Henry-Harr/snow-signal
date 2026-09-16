import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ChainClient } from '../../../src/chain/client.js';
import { LiveBlockSource } from '../../../src/chain/block-source.js';
import { RpcPool } from '../../../src/chain/rpc-pool.js';
import { ReorgDetectedError } from '../../../src/core/errors.js';
import { ChainStateRepository } from '../../../src/storage/chain-state-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';

interface FakeBlock {
  number: bigint;
  hash: `0x${string}`;
  parentHash: `0x${string}`;
  timestamp: bigint;
}

/** A chain of blocks shared by both mock providers, so they always agree (quorum
 * reads need ≥2 providers to return the same value). Mutating `chain` between
 * `poll()` calls simulates new blocks arriving, or a reorg replacing recent ones. */
function makeChainClient(chain: Map<bigint, FakeBlock>): ChainClient {
  return {
    getBlockNumber: () => Promise.resolve([...chain.keys()].reduce((a, b) => (a > b ? a : b))),
    getBlock: (blockNumber: bigint) => {
      const block = chain.get(blockNumber);
      if (!block) return Promise.reject(new Error(`no block ${blockNumber}`));
      return Promise.resolve(block);
    },
  };
}

function genesisChain(upTo: bigint): Map<bigint, FakeBlock> {
  const chain = new Map<bigint, FakeBlock>();
  let parent: `0x${string}` = '0x0';
  for (let i = 0n; i <= upTo; i++) {
    const hash = `0xblock${i}` as `0x${string}`;
    chain.set(i, { number: i, hash, parentHash: parent, timestamp: i });
    parent = hash;
  }
  return chain;
}

describe('LiveBlockSource', () => {
  let repo: ChainStateRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new ChainStateRepository(db);
  });

  it('on first poll with no history, processes only the confirmed tip', async () => {
    const chain = genesisChain(5n);
    const pool = new RpcPool(
      [
        { name: 'a', client: makeChainClient(chain) },
        { name: 'b', client: makeChainClient(chain) },
      ],
      undefined,
      { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    );
    const source = new LiveBlockSource({ chainId: 1, confirmations: 0, pool, chainState: repo });

    const blocks = await source.poll();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.number).toBe(5n);
  });

  it('processes newly arrived blocks incrementally across polls', async () => {
    const chain = genesisChain(5n);
    const pool = new RpcPool(
      [
        { name: 'a', client: makeChainClient(chain) },
        { name: 'b', client: makeChainClient(chain) },
      ],
      undefined,
      { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    );
    const source = new LiveBlockSource({ chainId: 1, confirmations: 0, pool, chainState: repo });

    await source.poll(); // processes block 5
    chain.set(6n, { number: 6n, hash: '0xblock6', parentHash: '0xblock5', timestamp: 6n });

    const blocks = await source.poll();
    expect(blocks.map((b) => b.number)).toEqual([6n]);
  });

  it('respects the configured confirmation depth', async () => {
    const chain = genesisChain(5n);
    const pool = new RpcPool(
      [
        { name: 'a', client: makeChainClient(chain) },
        { name: 'b', client: makeChainClient(chain) },
      ],
      undefined,
      { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    );
    const source = new LiveBlockSource({ chainId: 1, confirmations: 2, pool, chainState: repo });

    const blocks = await source.poll();
    // head=5, confirmations=2 => confirmed tip is block 3
    expect(blocks[0]?.number).toBe(3n);
  });

  /** Grows `chain` one block at a time, polling `source` after each new block —
   * matching how LiveBlockSource is actually driven in production (once per new
   * confirmed block), so every intermediate height actually gets recorded rather
   * than only ever the latest tip at whatever moment poll() happens to run. */
  async function growChainByPolling(
    source: LiveBlockSource,
    chain: Map<bigint, FakeBlock>,
    upTo: bigint,
  ): Promise<void> {
    const start = [...chain.keys()].reduce((a, b) => (a > b ? a : b)) + 1n;
    for (let i = start; i <= upTo; i++) {
      const parent = chain.get(i - 1n)!;
      chain.set(i, { number: i, hash: `0xblock${i}`, parentHash: parent.hash, timestamp: i });
      await source.poll();
    }
  }

  it('detects a reorg, rolls back, and reprocesses the new canonical chain', async () => {
    const chain = genesisChain(0n);
    const pool = new RpcPool(
      [
        { name: 'a', client: makeChainClient(chain) },
        { name: 'b', client: makeChainClient(chain) },
      ],
      undefined,
      { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    );
    const source = new LiveBlockSource({ chainId: 1, confirmations: 0, pool, chainState: repo });

    await source.poll(); // processes genesis (block 0)
    await growChainByPolling(source, chain, 6n); // processes blocks 1..6 one at a time

    // Reorg: replace block 6 and add a new block 7 on top of the replacement.
    chain.set(6n, { number: 6n, hash: '0xblock6b', parentHash: '0xblock5', timestamp: 6n });
    chain.set(7n, { number: 7n, hash: '0xblock7b', parentHash: '0xblock6b', timestamp: 7n });

    const blocks = await source.poll();
    expect(blocks.map((b) => ({ number: b.number, hash: b.hash }))).toEqual([
      { number: 6n, hash: '0xblock6b' },
      { number: 7n, hash: '0xblock7b' },
    ]);
    expect(repo.getLastProcessed(1)).toEqual({ number: 7n, hash: '0xblock7b' });
    // The stale block 5 (unaffected by the reorg) must still be intact.
    expect(repo.getBlockHash(1, 5n)).toBe('0xblock5');
  });

  it('throws ReorgDetectedError when the rollback walks back further than maxReorgDepth', async () => {
    const chain = genesisChain(0n);
    const pool = new RpcPool(
      [
        { name: 'a', client: makeChainClient(chain) },
        { name: 'b', client: makeChainClient(chain) },
      ],
      undefined,
      { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    );
    const source = new LiveBlockSource({
      chainId: 1,
      confirmations: 0,
      pool,
      chainState: repo,
      maxReorgDepth: 1,
    });

    await source.poll(); // processes genesis (block 0)
    await growChainByPolling(source, chain, 3n); // processes blocks 1..3 one at a time

    // Deep reorg: replace blocks 1, 2, 3 entirely (parent chain diverges from block 0),
    // and add a new block 4 so the confirmed tip actually advances past the old one.
    chain.set(1n, { number: 1n, hash: '0xdeep1', parentHash: '0xblock0', timestamp: 1n });
    chain.set(2n, { number: 2n, hash: '0xdeep2', parentHash: '0xdeep1', timestamp: 2n });
    chain.set(3n, { number: 3n, hash: '0xdeep3', parentHash: '0xdeep2', timestamp: 3n });
    chain.set(4n, { number: 4n, hash: '0xdeep4', parentHash: '0xdeep3', timestamp: 4n });

    await expect(source.poll()).rejects.toThrow(ReorgDetectedError);
  });
});
