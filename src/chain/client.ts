import { createPublicClient, defineChain, http } from 'viem';

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

export function createViemChainClient(url: string, chainId: number): ChainClient {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const client = createPublicClient({ chain, transport: http(url) });

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
