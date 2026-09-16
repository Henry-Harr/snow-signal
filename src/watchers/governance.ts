import type { AbiEvent } from 'viem';

import {
  poolAbi,
  poolAddressesProviderAbi,
  poolConfiguratorAbi,
} from '../protocols/aave-v3/abi.js';
import type { AaveV3Adapter } from '../protocols/aave-v3/adapter.js';
import { morphoBlueAbi } from '../protocols/morpho-blue/abi.js';
import type { MorphoBlueAdapter } from '../protocols/morpho-blue/adapter.js';
import { metaMorphoAbi } from '../protocols/morpho-vault/abi.js';
import type { MorphoVaultAdapter } from '../protocols/morpho-vault/adapter.js';
import type { ContractReadClient } from '../chain/client.js';
import type { RpcPool } from '../chain/rpc-pool.js';
import { AdapterError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { Address, BlockRef, Log, ProtocolEvent } from '../core/types.js';

function eventsOf(abi: readonly { type: string; name?: string }[]): AbiEvent[] {
  return abi.filter((x): x is AbiEvent => x.type === 'event');
}

/**
 * Governance/config watcher (docs/SPEC.md #6.6): "Aave configurator changes and
 * executed governance payloads affecting watched markets; Morpho vault timelocked
 * submissions/role changes; new collateral listings; oracle changes; pauses/freezes."
 *
 * Deliberately thin: every protocol adapter already decodes its own events
 * (`ProtocolAdapter.decodeEvents`, Phase 2) — a "governance watch target" is just
 * *which* contract address and *which subset* of that protocol's events count as
 * governance (as opposed to pool-flow events like Supply/Withdraw, which the
 * large-holder watcher cares about instead), reusing the same decode function either
 * way. This is what makes `fetchGovernanceEvents` itself protocol-agnostic.
 *
 * Operational note: at least one configured RPC provider's free tier caps
 * `eth_getLogs` at a 10-block range per call (found directly against Alchemy's free
 * tier, 2026-09-16) — callers must pass a `fromBlock`/`toBlock` window within
 * whatever the configured providers actually allow (fine for polling new blocks as
 * they confirm, since that's usually a handful of blocks per tick; a problem for a
 * naive full historical backfill, which needs chunking this function doesn't do
 * itself).
 */
export interface GovernanceWatchTarget {
  protocol: string;
  address: Address;
  events: AbiEvent[];
  decode: (logs: Log[]) => ProtocolEvent[];
}

export async function fetchGovernanceEvents(
  pool: RpcPool<ContractReadClient>,
  targets: GovernanceWatchTarget[],
  fromBlock: bigint,
  toBlock: bigint,
  logger?: Logger,
): Promise<ProtocolEvent[]> {
  const results = await Promise.all(
    targets
      .filter((target) => target.events.length > 0)
      .map(async (target) => {
        const logs = await pool.bestEffortRead((client) =>
          client.getLogs({ address: target.address, events: target.events, fromBlock, toBlock }),
        );
        logger?.debug(
          { protocol: target.protocol, address: target.address, count: logs.length },
          'governance logs fetched',
        );
        return target.decode(logs);
      }),
  );
  return results.flat();
}

/** Aave's `PoolConfigurator` isn't a static address (unlike `Pool`/`PoolDataProvider`)
 * — resolved the same two-hop way `AaveV3Adapter` resolves its oracle:
 * `Pool.ADDRESSES_PROVIDER()` → `PoolAddressesProvider.getPoolConfigurator()`. */
export async function resolveAaveConfiguratorAddress(
  pool: RpcPool<ContractReadClient>,
  poolAddress: Address,
  at: BlockRef,
): Promise<Address> {
  const providerAddress = await pool.bestEffortRead(async (client) => {
    const [result] = await client.multicall(
      [{ address: poolAddress, abi: poolAbi, functionName: 'ADDRESSES_PROVIDER' }],
      at.number,
    );
    if (result?.status !== 'success') {
      throw new AdapterError(`resolveAaveConfiguratorAddress: failed to read ADDRESSES_PROVIDER`);
    }
    return result.result as Address;
  });

  return pool.bestEffortRead(async (client) => {
    const [result] = await client.multicall(
      [
        {
          address: providerAddress,
          abi: poolAddressesProviderAbi,
          functionName: 'getPoolConfigurator',
        },
      ],
      at.number,
    );
    if (result?.status !== 'success') {
      throw new AdapterError(`resolveAaveConfiguratorAddress: failed to read getPoolConfigurator`);
    }
    return result.result as Address;
  });
}

export function aaveGovernanceTarget(
  adapter: AaveV3Adapter,
  configuratorAddress: Address,
): GovernanceWatchTarget {
  return {
    protocol: 'aave-v3',
    address: configuratorAddress,
    events: eventsOf(poolConfiguratorAbi),
    decode: (logs) => adapter.decodeEvents(logs),
  };
}

const MORPHO_BLUE_GOVERNANCE_EVENTS = new Set([
  'SetOwner',
  'SetFee',
  'SetFeeRecipient',
  'EnableIrm',
  'EnableLltv',
  'CreateMarket',
]);

export function morphoBlueGovernanceTarget(
  adapter: MorphoBlueAdapter,
  morphoBlueAddress: Address,
): GovernanceWatchTarget {
  return {
    protocol: 'morpho-blue',
    address: morphoBlueAddress,
    events: eventsOf(morphoBlueAbi).filter((e) => MORPHO_BLUE_GOVERNANCE_EVENTS.has(e.name)),
    decode: (logs) => adapter.decodeEvents(logs),
  };
}

export function morphoVaultGovernanceTarget(
  adapter: MorphoVaultAdapter,
  vaultAddress: Address,
): GovernanceWatchTarget {
  return {
    protocol: 'morpho-vault',
    address: vaultAddress,
    events: eventsOf(metaMorphoAbi),
    decode: (logs) => adapter.decodeEvents(logs),
  };
}
