import { createPublicClient, http, type Abi, type PublicClient } from 'viem';

import type { Address, RawLog } from '../core/types.js';

export interface MulticallCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type MulticallResult =
  { status: 'success'; result: unknown } | { status: 'failure'; error: Error };

export interface GetLogsParams {
  address: Address;
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * The narrow slice of chain-read functionality protocol adapters need. Adapters
 * depend on this instead of viem's full `PublicClient` so they're unit-testable
 * against hand-built mock responses shaped like real multicall results, without a
 * real RPC connection (docs/PROGRESS.md Phase 2 plan).
 */
export interface ContractReader {
  multicall(params: {
    contracts: MulticallCall[];
    blockNumber: bigint;
  }): Promise<MulticallResult[]>;
  getLogs(params: GetLogsParams): Promise<RawLog[]>;
}

export function createViemContractReader(client: PublicClient): ContractReader {
  return {
    async multicall({ contracts, blockNumber }) {
      const results = await client.multicall({ contracts, blockNumber, allowFailure: true });
      return results.map((r): MulticallResult =>
        r.status === 'success'
          ? { status: 'success', result: r.result }
          : { status: 'failure', error: r.error },
      );
    },
    async getLogs({ address, fromBlock, toBlock }) {
      const logs = await client.getLogs({ address, fromBlock, toBlock });
      return logs.map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        blockNumber: log.blockNumber ?? 0n,
        transactionHash: log.transactionHash ?? '0x0',
        logIndex: log.logIndex ?? 0,
      }));
    },
  };
}

export function createViemPublicClient(url: string, chainId: number): PublicClient {
  return createPublicClient({
    chain: {
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    },
    transport: http(url),
  });
}
