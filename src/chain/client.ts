import { createPublicClient, defineChain, http, type Abi, type AbiEvent } from 'viem';

/** The minimal surface Sentinel needs from a chain RPC client. Kept narrow and
 * hand-rolled (rather than passing a full viem `PublicClient` around everywhere) so
 * the RPC pool and block source are testable against plain mock objects without
 * constructing real viem clients in unit tests. */
export interface ChainClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(blockNumber: bigint): Promise<{
    number: bigint;
    hash: `0x${string}`;
    parentHash: `0x${string}`;
    timestamp: bigint;
  }>;
}

/** Multicall3 is deployed at this same address via the same CREATE2 factory on
 * essentially every EVM chain, including every chain Sentinel watches — confirmed by
 * reading it straight out of viem's own maintained `viem/chains` definitions for
 * `mainnet` and `base` (2026-09-16), rather than typing the well-known literal from
 * memory (safety rule 6). Needed here because `defineChain` below builds a bespoke
 * chain object (so this file works against arbitrary RPC URLs, not just viem's
 * bundled chain list) that otherwise has no `contracts.multicall3` entry, and viem's
 * `multicall()` action requires one. */
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

function makeChain(url: string, chainId: number) {
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
  });
}

export function createViemChainClient(url: string, chainId: number): ChainClient {
  const client = createPublicClient({ chain: makeChain(url, chainId), transport: http(url) });

  return {
    getBlockNumber: () => client.getBlockNumber(),
    getBlock: async (blockNumber: bigint) => {
      const block = await client.getBlock({ blockNumber });
      return {
        number: block.number,
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: block.timestamp,
      };
    },
  };
}

export interface ContractCall {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type ContractCallResult =
  { status: 'success'; result: unknown } | { status: 'failure'; error: Error };

export interface LogQuery {
  address: `0x${string}` | `0x${string}`[];
  event: AbiEvent;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface DecodedLog {
  address: `0x${string}`;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
  eventName: string;
  args: Record<string, unknown>;
}

/**
 * `ChainClient` plus the read operations protocol adapters need (docs/SPEC.md #6.1:
 * "use multicall to keep call volume down"). Kept as a separate, wider interface
 * rather than folding these methods into the base `ChainClient` so the block source
 * and RPC pool's own unit tests keep constructing plain `{ getBlockNumber, getBlock }`
 * mocks without also having to stub multicall/getLogs they never call.
 */
export interface ContractReadClient extends ChainClient {
  /** One batched call per RPC round-trip, all pinned to `blockNumber`. Uses
   * `allowFailure: true` — a single reverting call (e.g. a market that doesn't exist)
   * surfaces as a `{status:'failure'}` entry rather than failing the whole batch. */
  multicall(calls: ContractCall[], blockNumber: bigint): Promise<ContractCallResult[]>;
  getLogs(query: LogQuery): Promise<DecodedLog[]>;
}

export function createViemContractReadClient(url: string, chainId: number): ContractReadClient {
  const client = createPublicClient({ chain: makeChain(url, chainId), transport: http(url) });

  return {
    getBlockNumber: () => client.getBlockNumber(),
    getBlock: async (blockNumber: bigint) => {
      const block = await client.getBlock({ blockNumber });
      return {
        number: block.number,
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: block.timestamp,
      };
    },
    multicall: async (calls, blockNumber) => {
      const results = await client.multicall({
        contracts: calls.map((call) => ({
          address: call.address,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args as unknown[] | undefined,
        })),
        blockNumber,
        allowFailure: true,
      });
      return results.map((r) =>
        r.status === 'success'
          ? { status: 'success', result: r.result }
          : {
              status: 'failure',
              error: r.error instanceof Error ? r.error : new Error(String(r.error)),
            },
      );
    },
    getLogs: async (query) => {
      const logs = await client.getLogs({
        address: query.address,
        event: query.event,
        fromBlock: query.fromBlock,
        toBlock: query.toBlock,
      });
      return logs.map((log) => ({
        address: log.address,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        eventName: query.event.name,
        args: (log as unknown as { args: Record<string, unknown> }).args,
      }));
    },
  };
}
