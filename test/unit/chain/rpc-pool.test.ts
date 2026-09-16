import { describe, expect, it } from 'vitest';

import type { ChainClient } from '../../../src/chain/client.js';
import { RpcPool, type NamedProvider } from '../../../src/chain/rpc-pool.js';
import { QuorumError, RpcError } from '../../../src/core/errors.js';

function mockClient(overrides: Partial<ChainClient> = {}): ChainClient {
  return {
    getBlockNumber: () => Promise.resolve(100n),
    getBlock: () =>
      Promise.resolve({
        number: 100n,
        hash: '0xhash',
        parentHash: '0xparent',
        timestamp: 1000n,
      }),
    ...overrides,
  };
}

function provider(name: string, client: ChainClient): NamedProvider {
  return { name, client };
}

const noRetryDelay = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

describe('RpcPool', () => {
  it('requires at least two providers', () => {
    expect(() => new RpcPool([provider('a', mockClient())])).toThrow(RpcError);
  });

  describe('quorumRead', () => {
    it('returns the value when providers agree', async () => {
      const pool = new RpcPool(
        [provider('a', mockClient()), provider('b', mockClient())],
        undefined,
        noRetryDelay,
      );
      const result = await pool.quorumRead((client) => client.getBlockNumber());
      expect(result).toBe(100n);
    });

    it('throws QuorumError when providers disagree', async () => {
      const pool = new RpcPool(
        [
          provider('a', mockClient({ getBlockNumber: () => Promise.resolve(100n) })),
          provider('b', mockClient({ getBlockNumber: () => Promise.resolve(101n) })),
        ],
        undefined,
        noRetryDelay,
      );
      await expect(pool.quorumRead((client) => client.getBlockNumber())).rejects.toThrow(
        QuorumError,
      );
    });

    it('throws QuorumError when fewer than two providers succeed', async () => {
      const pool = new RpcPool(
        [
          provider('a', mockClient({ getBlockNumber: () => Promise.reject(new Error('down')) })),
          provider('b', mockClient({ getBlockNumber: () => Promise.resolve(100n) })),
        ],
        undefined,
        noRetryDelay,
      );
      await expect(pool.quorumRead((client) => client.getBlockNumber())).rejects.toThrow(
        QuorumError,
      );
    });
  });

  describe('bestEffortRead', () => {
    it('fails over to the next provider when the first fails', async () => {
      const pool = new RpcPool(
        [
          provider('a', mockClient({ getBlockNumber: () => Promise.reject(new Error('down')) })),
          provider('b', mockClient({ getBlockNumber: () => Promise.resolve(100n) })),
        ],
        undefined,
        noRetryDelay,
      );
      const result = await pool.bestEffortRead((client) => client.getBlockNumber());
      expect(result).toBe(100n);
    });

    it('throws when every provider fails', async () => {
      const pool = new RpcPool(
        [
          provider('a', mockClient({ getBlockNumber: () => Promise.reject(new Error('down')) })),
          provider('b', mockClient({ getBlockNumber: () => Promise.reject(new Error('down')) })),
        ],
        undefined,
        noRetryDelay,
      );
      await expect(pool.bestEffortRead((client) => client.getBlockNumber())).rejects.toThrow(
        RpcError,
      );
    });
  });

  describe('getConservativeHead', () => {
    it('returns the minimum head across providers', async () => {
      const pool = new RpcPool(
        [
          provider('a', mockClient({ getBlockNumber: () => Promise.resolve(105n) })),
          provider('b', mockClient({ getBlockNumber: () => Promise.resolve(100n) })),
        ],
        undefined,
        noRetryDelay,
      );
      const head = await pool.getConservativeHead();
      expect(head).toBe(100n);
    });

    it('requires at least two successful providers', async () => {
      const pool = new RpcPool(
        [
          provider('a', mockClient({ getBlockNumber: () => Promise.reject(new Error('down')) })),
          provider('b', mockClient({ getBlockNumber: () => Promise.resolve(100n) })),
        ],
        undefined,
        noRetryDelay,
      );
      await expect(pool.getConservativeHead()).rejects.toThrow(QuorumError);
    });
  });
});
