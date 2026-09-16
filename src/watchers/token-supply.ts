import { erc20Abi, type AbiEvent } from 'viem';
import { z } from 'zod';

import type { ContractCallResult, ContractReadClient } from '../chain/client.js';
import type { RpcPool } from '../chain/rpc-pool.js';
import { AdapterError } from '../core/errors.js';
import type { Address, BlockRef, ChainId, ProtocolEvent } from '../core/types.js';

/**
 * Token supply watcher (docs/SPEC.md #6.6): "For every collateral asset in the
 * exposure graph, track `totalSupply` changes and large mints, especially of
 * bridge-minted tokens." This watcher only *records* the raw series (a totalSupply
 * reading, and every mint event) — deciding what counts as "large" or anomalous is a
 * threshold-based detector's job (D08, Phase 4), not the collector's.
 */
export interface TokenSupplySnapshot {
  asset: Address;
  chainId: ChainId;
  totalSupply: bigint;
  blockNumber: bigint;
  fetchedAt: number;
}

function unwrap(result: ContractCallResult | undefined, context: string): unknown {
  if (!result) throw new AdapterError(`${context}: missing multicall result`);
  if (result.status === 'failure') throw new AdapterError(`${context}: ${result.error.message}`);
  return result.result;
}

/** `totalSupply()` is quorum-read: it isn't in spec #6.1's explicit decision-critical
 * list, but it directly feeds D08 (a detector that can trigger de-risking), so it's
 * treated with the same two-provider-agreement discipline as balances/prices. */
export async function fetchTotalSupply(
  pool: RpcPool<ContractReadClient>,
  asset: Address,
  at: BlockRef,
): Promise<TokenSupplySnapshot> {
  const totalSupply = await pool.quorumRead(async (client) => {
    const [result] = await client.multicall(
      [{ address: asset, abi: erc20Abi, functionName: 'totalSupply' }],
      at.number,
    );
    return z
      .bigint()
      .nonnegative()
      .parse(unwrap(result, `totalSupply(${asset})`));
  });
  return {
    asset,
    chainId: at.chainId,
    totalSupply,
    blockNumber: at.number,
    fetchedAt: at.timestamp,
  };
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const transferEvent = (erc20Abi as readonly { type: string; name?: string }[]).find(
  (x): x is AbiEvent => x.type === 'event' && x.name === 'Transfer',
)!;

/** Mint events (`Transfer(from=0x0, to, value)`) over `[fromBlock, toBlock]`, returned
 * as `ProtocolEvent`s (`protocol: 'erc20'`) so they can be stored in the same
 * `protocol_events` table the governance watcher uses, under a `'token-supply'`
 * category — a real event, unlike the totalSupply time series above, which gets its
 * own table (`TokenSupplyRepository`). Best-effort (bulk log scan, not a single
 * decision-critical value) — same treatment as the governance watcher's log reads,
 * and subject to the same provider block-range caps (see
 * src/watchers/governance.ts's header comment). */
export async function fetchMintEvents(
  pool: RpcPool<ContractReadClient>,
  asset: Address,
  chainId: ChainId,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ProtocolEvent[]> {
  const logs = await pool.bestEffortRead((client) =>
    client.getLogs({ address: asset, events: [transferEvent], fromBlock, toBlock }),
  );
  return logs
    .filter((log) => (log.args['from'] as string).toLowerCase() === ZERO_ADDRESS)
    .map((log) => ({
      protocol: 'erc20',
      chainId,
      marketId: `erc20:${chainId}:${asset}`,
      eventName: 'Mint',
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      args: log.args,
    }));
}
