import type { ContractReader, MulticallResult } from '../../src/chain/contract-reader.js';
import type { RawLog } from '../../src/core/types.js';

/**
 * A `ContractReader` that replays a fixed sequence of responses, one array per
 * `multicall()` call, in the order the adapter under test is expected to make them.
 * Throws if the adapter makes more or fewer calls than the test set up, which is
 * exactly the failure mode you want when an adapter's call sequence changes
 * unexpectedly.
 */
export function createSequentialMockReader(responses: MulticallResult[][]): ContractReader {
  const queue = [...responses];
  return {
    multicall: ({ contracts }) => {
      const next = queue.shift();
      if (!next) {
        throw new Error(
          `mock reader: no more responses queued, but multicall was called again with ${contracts.length} contract(s)`,
        );
      }
      if (next.length !== contracts.length) {
        throw new Error(
          `mock reader: expected ${next.length} contract call(s) but adapter requested ${contracts.length}`,
        );
      }
      return Promise.resolve(next);
    },
    getLogs: () => Promise.resolve([] as RawLog[]),
  };
}

export function ok(result: unknown): MulticallResult {
  return { status: 'success', result };
}

export function fail(message: string): MulticallResult {
  return { status: 'failure', error: new Error(message) };
}
