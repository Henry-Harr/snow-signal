import type {
  ContractCall,
  ContractCallResult,
  ContractReadClient,
  DecodedLog,
  LogQuery,
} from '../chain/client.js';
import type { DiskCache } from './cache.js';
import { cacheKey } from './cache.js';

/**
 * Wraps a real `ContractReadClient` (an archive-capable RPC) with the disk cache
 * (docs/SPEC.md §9.1). Every method that reads state pinned to (or bounded by) a
 * block number is cached; `getBlockNumber()` (the current head) is never cached —
 * there's no stable key for "now," and nothing in replay calls it anyway (the replay
 * block source drives block numbers from the scenario's own range, never by asking
 * "what's the current head").
 *
 * The cache key for `multicall` hashes each call's `address`/`functionName`/`args`
 * and block number, deliberately **excluding** `abi` — a given `functionName` at a
 * given `address` is always called with the same ABI fragment throughout this
 * codebase (each adapter's own file defines it once), so including the full ABI array
 * in every key would only bloat the hash input, not add real key uniqueness.
 */
export function createCachingContractReadClient(
  inner: ContractReadClient,
  chainId: number,
  cache: DiskCache,
): ContractReadClient {
  return {
    getBlockNumber: () => inner.getBlockNumber(),

    getBlock: async (blockNumber) => {
      const key = cacheKey(chainId, 'getBlock', { blockNumber });
      const cached = await cache.get<{
        number: string;
        hash: `0x${string}`;
        parentHash: `0x${string}`;
        timestamp: string;
      }>(key);
      if (cached) {
        return {
          number: BigInt(cached.number),
          hash: cached.hash,
          parentHash: cached.parentHash,
          timestamp: BigInt(cached.timestamp),
        };
      }
      const result = await inner.getBlock(blockNumber);
      await cache.set(key, {
        number: result.number.toString(),
        hash: result.hash,
        parentHash: result.parentHash,
        timestamp: result.timestamp.toString(),
      });
      return result;
    },

    multicall: async (calls: ContractCall[], blockNumber: bigint) => {
      const key = cacheKey(chainId, 'multicall', {
        blockNumber,
        calls: calls.map((c) => ({
          address: c.address,
          functionName: c.functionName,
          args: c.args ?? [],
        })),
      });
      const cached =
        await cache.get<
          ({ status: 'success'; result: unknown } | { status: 'failure'; message: string })[]
        >(key);
      if (cached) {
        return cached.map((r): ContractCallResult =>
          r.status === 'success' ? r : { status: 'failure', error: new Error(r.message) },
        );
      }
      const results = await inner.multicall(calls, blockNumber);
      await cache.set(
        key,
        results.map((r) =>
          r.status === 'success' ? r : { status: 'failure' as const, message: r.error.message },
        ),
      );
      return results;
    },

    getLogs: async (query: LogQuery) => {
      const key = cacheKey(chainId, 'getLogs', {
        address: query.address,
        eventNames: query.events.map((e) => e.name),
        fromBlock: query.fromBlock,
        toBlock: query.toBlock,
      });
      const cached = await cache.get<DecodedLog[]>(key);
      if (cached) return cached;
      const results = await inner.getLogs(query);
      await cache.set(key, results);
      return results;
    },
  };
}
