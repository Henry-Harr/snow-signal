import { erc4626Abi, type AbiEvent } from 'viem';

import { poolAbi } from '../protocols/aave-v3/abi.js';
import type { AaveV3Adapter } from '../protocols/aave-v3/adapter.js';
import { morphoBlueAbi } from '../protocols/morpho-blue/abi.js';
import type { MorphoBlueAdapter } from '../protocols/morpho-blue/adapter.js';
import type { MorphoVaultAdapter } from '../protocols/morpho-vault/adapter.js';
import { fetchGovernanceEvents, type GovernanceWatchTarget } from './governance.js';
import type { ContractReadClient } from '../chain/client.js';
import type { RpcPool } from '../chain/rpc-pool.js';
import { AdapterError } from '../core/errors.js';
import type { Address, BlockRef, ProtocolEvent } from '../core/types.js';

/**
 * Large-holder watcher (docs/SPEC.md #6.6): "From event logs, maintain the top
 * suppliers and borrowers of each watched market or vault, their shares, and their
 * recent movements. Track the health of the largest borrowers wherever the protocol
 * makes that computable."
 *
 * Same collector-not-detector split as the token-supply watcher: this module fetches
 * and reduces the raw pool-flow events into a per-holder ledger and a ranking, but
 * deciding what counts as an alertable "large-holder exit" (D05's job, Phase 4)
 * happens elsewhere. Event fetching reuses `fetchGovernanceEvents` from
 * `governance.ts` — that function was already written protocol-agnostically (fetch
 * logs for a target, decode with the adapter's own `decodeEvents`) even though it was
 * introduced for governance events; a "watch target" here is just a different subset
 * of the same protocol's events (Supply/Withdraw/Borrow/Repay instead of config
 * changes), same reuse this watcher's own header comment in `governance.ts`
 * anticipated. Events are stored via `ProtocolEventRepository.recordAll('large-holder',
 * ...)`, the same `protocol_events` table every other watcher uses.
 */

function eventsOf(abi: readonly { type: string; name?: string }[]): AbiEvent[] {
  return abi.filter((x): x is AbiEvent => x.type === 'event');
}

export function aavePoolFlowTarget(
  adapter: AaveV3Adapter,
  poolAddress: Address,
): GovernanceWatchTarget {
  const flowEvents = new Set(['Supply', 'Withdraw', 'Borrow', 'Repay']);
  return {
    protocol: 'aave-v3',
    address: poolAddress,
    events: eventsOf(poolAbi).filter((e) => flowEvents.has(e.name)),
    decode: (logs) => adapter.decodeEvents(logs),
  };
}

export function morphoBluePoolFlowTarget(
  adapter: MorphoBlueAdapter,
  morphoBlueAddress: Address,
): GovernanceWatchTarget {
  const flowEvents = new Set([
    'Supply',
    'Withdraw',
    'Borrow',
    'Repay',
    'SupplyCollateral',
    'WithdrawCollateral',
  ]);
  return {
    protocol: 'morpho-blue',
    address: morphoBlueAddress,
    events: eventsOf(morphoBlueAbi).filter((e) => flowEvents.has(e.name)),
    decode: (logs) => adapter.decodeEvents(logs),
  };
}

/** Only the ERC-4626 `Deposit`/`Withdraw` events (from viem's own maintained
 * `erc4626Abi`, per this protocol's existing convention of not redeclaring standard
 * interfaces — see `morpho-vault/abi.ts`'s header comment), verified against real
 * `Deposit`/`Withdraw` logs on the watched vault this session (docs/SOURCES.md).
 * Deliberately excludes `Transfer` — a vault share transferred on the secondary
 * market (rather than deposited/withdrawn through the vault itself) would move a
 * holder's position without either event firing, which this pass doesn't attempt to
 * track; a known limitation, not an oversight. */
export function morphoVaultPoolFlowTarget(
  adapter: MorphoVaultAdapter,
  vaultAddress: Address,
): GovernanceWatchTarget {
  const flowEvents = new Set(['Deposit', 'Withdraw']);
  return {
    protocol: 'morpho-vault',
    address: vaultAddress,
    events: eventsOf(erc4626Abi).filter((e) => flowEvents.has(e.name)),
    decode: (logs) => adapter.decodeEvents(logs),
  };
}

export { fetchGovernanceEvents as fetchPoolFlowEvents };

export type HolderSide = 'supply' | 'borrow' | 'collateral';

export interface HolderMovement {
  holder: Address;
  side: HolderSide;
  assetsDelta: bigint;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
}

function asAddress(value: unknown, context: string): Address {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new AdapterError(`${context}: expected an address, got ${JSON.stringify(value)}`);
  }
  return value as Address;
}

function asBigInt(value: unknown, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new AdapterError(`${context}: expected a bigint, got ${JSON.stringify(value)}`);
  }
  return value;
}

function movement(
  event: ProtocolEvent,
  holder: Address,
  side: HolderSide,
  assetsDelta: bigint,
): HolderMovement {
  return {
    holder,
    side,
    assetsDelta,
    blockNumber: event.blockNumber,
    transactionHash: event.transactionHash,
    logIndex: event.logIndex,
  };
}

/** Extracts the holder-balance-changing movement from one Aave v3 pool-flow event, if
 * it is one. `Supply`/`Borrow` credit `onBehalfOf` (the position owner, not
 * necessarily the caller); `Withdraw`/`Repay` debit `user` (Aave's own naming for the
 * position owner in those two events — verified against the event ABI in
 * `aave-v3/abi.ts`, itself sourced from the official repo). */
export function extractAaveMovement(event: ProtocolEvent): HolderMovement | undefined {
  const ctx = `extractAaveMovement:${event.eventName}`;
  switch (event.eventName) {
    case 'Supply':
      return movement(
        event,
        asAddress(event.args['onBehalfOf'], ctx),
        'supply',
        asBigInt(event.args['amount'], ctx),
      );
    case 'Withdraw':
      return movement(
        event,
        asAddress(event.args['user'], ctx),
        'supply',
        -asBigInt(event.args['amount'], ctx),
      );
    case 'Borrow':
      return movement(
        event,
        asAddress(event.args['onBehalfOf'], ctx),
        'borrow',
        asBigInt(event.args['amount'], ctx),
      );
    case 'Repay':
      return movement(
        event,
        asAddress(event.args['user'], ctx),
        'borrow',
        -asBigInt(event.args['amount'], ctx),
      );
    default:
      return undefined;
  }
}

/** Extracts the holder-balance-changing movement from one Morpho Blue pool-flow
 * event. All six flow events key on `onBehalf` (the position owner) per
 * `morpho-blue/abi.ts`'s event ABI. */
export function extractMorphoBlueMovement(event: ProtocolEvent): HolderMovement | undefined {
  const ctx = `extractMorphoBlueMovement:${event.eventName}`;
  const holder = () => asAddress(event.args['onBehalf'], ctx);
  const assets = () => asBigInt(event.args['assets'], ctx);
  switch (event.eventName) {
    case 'Supply':
      return movement(event, holder(), 'supply', assets());
    case 'Withdraw':
      return movement(event, holder(), 'supply', -assets());
    case 'Borrow':
      return movement(event, holder(), 'borrow', assets());
    case 'Repay':
      return movement(event, holder(), 'borrow', -assets());
    case 'SupplyCollateral':
      return movement(event, holder(), 'collateral', assets());
    case 'WithdrawCollateral':
      return movement(event, holder(), 'collateral', -assets());
    default:
      return undefined;
  }
}

/** Extracts the holder-balance-changing movement from one MetaMorpho vault
 * `Deposit`/`Withdraw` event. Keys on `owner` (viem's `erc4626Abi` names it
 * `receiver` on `Deposit` and `owner` on `Withdraw`, matching the ERC-4626 standard's
 * own inconsistent naming — both are the position owner in EIP-4626's definition). */
export function extractMorphoVaultMovement(event: ProtocolEvent): HolderMovement | undefined {
  const ctx = `extractMorphoVaultMovement:${event.eventName}`;
  const assets = () => asBigInt(event.args['assets'], ctx);
  switch (event.eventName) {
    case 'Deposit':
      return movement(event, asAddress(event.args['receiver'], ctx), 'supply', assets());
    case 'Withdraw':
      return movement(event, asAddress(event.args['owner'], ctx), 'supply', -assets());
    default:
      return undefined;
  }
}

export interface HolderBalance {
  holder: Address;
  supply: bigint;
  borrow: bigint;
  collateral: bigint;
  lastMovementBlock: bigint;
}

/** Reduces a stream of `ProtocolEvent`s into a per-holder balance ledger. Pure —
 * matches the purity discipline `src/prices/aggregate.ts` follows, for the same
 * reason: easy to unit-test on synthetic event sequences without a chain client.
 * Order-independent for the final balances (summation), but `lastMovementBlock` only
 * makes sense if `events` is fed in block/logIndex order — callers get that for free
 * from `ProtocolEventRepository.findByMarket`, which already orders that way. */
export function computeHolderLedger(
  events: ProtocolEvent[],
  extract: (event: ProtocolEvent) => HolderMovement | undefined,
): Map<Address, HolderBalance> {
  const ledger = new Map<Address, HolderBalance>();
  for (const event of events) {
    const move = extract(event);
    if (!move) continue;
    const key = move.holder.toLowerCase() as Address;
    const existing = ledger.get(key) ?? {
      holder: move.holder,
      supply: 0n,
      borrow: 0n,
      collateral: 0n,
      lastMovementBlock: move.blockNumber,
    };
    existing[move.side] += move.assetsDelta;
    existing.lastMovementBlock =
      move.blockNumber > existing.lastMovementBlock ? move.blockNumber : existing.lastMovementBlock;
    ledger.set(key, existing);
  }
  return ledger;
}

/** Top `n` holders by `side`'s balance, descending. Holders whose net balance on that
 * side has fallen to zero or below (fully withdrawn/repaid, or an artifact of only
 * having partial event history) are excluded — a zero balance isn't a "holder". */
export function rankHolders(
  ledger: Map<Address, HolderBalance>,
  side: HolderSide,
  n: number,
): HolderBalance[] {
  return [...ledger.values()]
    .filter((h) => h[side] > 0n)
    .sort((a, b) => (b[side] > a[side] ? 1 : b[side] < a[side] ? -1 : 0))
    .slice(0, n);
}

export interface BorrowerHealth {
  holder: Address;
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  healthFactor: bigint;
}

/** Aave scales `healthFactor` by 1e18 (documented convention, matches the raw values
 * read directly via `cast call` this session) — export it so callers don't
 * re-hardcode the scale when comparing against a threshold. */
export const HEALTH_FACTOR_SCALE = 10n ** 18n;

/** Aave v3's `getUserAccountData` gives `healthFactor` directly (Aave's own risk
 * computation, not reimplemented here) — `type(uint256).max` for an account with no
 * debt (verified directly on-chain, 2026-09-16, against a synthetic zero-position
 * address; see docs/SOURCES.md). Quorum-read: this drives the same "large-holder
 * health" signal safety rule 7's two-provider-confirmation discipline applies to for
 * anything that could inform a de-risking decision. Morpho Blue's equivalent
 * (collateral value vs. `lltv`) isn't computed here — deferred to D15 (Phase 4), which
 * needs the same per-position health math across every borrower in a market anyway,
 * so building it once there avoids duplicating it early. */
export async function fetchAaveBorrowerHealth(
  pool: RpcPool<ContractReadClient>,
  poolAddress: Address,
  borrowers: Address[],
  at: BlockRef,
): Promise<BorrowerHealth[]> {
  if (borrowers.length === 0) return [];
  // Unwrapping happens inside the quorumRead callback (not after it resolves) so a
  // per-call revert counts as that provider's attempt failing — same pattern as
  // chainlink.ts/token-supply.ts — rather than surfacing as a bare AdapterError that
  // bypasses quorumRead's two-provider-agreement discipline entirely.
  return pool.quorumRead(async (client) => {
    const results = await client.multicall(
      borrowers.map((user) => ({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'getUserAccountData',
        args: [user],
      })),
      at.number,
    );
    return borrowers.map((holder, i) => {
      const result = results[i];
      if (!result || result.status === 'failure') {
        throw new AdapterError(
          `fetchAaveBorrowerHealth:${holder}: ${result?.status === 'failure' ? result.error.message : 'missing result'}`,
        );
      }
      const [totalCollateralBase, totalDebtBase, , , , healthFactor] = result.result as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      return { holder, totalCollateralBase, totalDebtBase, healthFactor };
    });
  });
}
