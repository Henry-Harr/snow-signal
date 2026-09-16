/**
 * Core shared types, per docs/SPEC.md #5.3. These are load-bearing sketches shared
 * across every later phase; protocol adapters (Phase 2), detectors (Phase 4), and the
 * risk engine (Phase 5) all build on these rather than defining their own shapes.
 */

export type ChainId = number;
export type Address = `0x${string}`;

export interface BlockRef {
  chainId: ChainId;
  number: bigint;
  hash: `0x${string}`;
  timestamp: number;
}

/** A user's supply position in one market, as discovered on-chain — not a config
 * entry (see `SentinelConfig['positions']` in src/core/config.ts for the config
 * shape that tells an adapter *what* to look for). */
export interface Position {
  /** Stable identifier: `${adapterId}:${marketId}:${owner}`. */
  id: string;
  adapterId: string;
  chainId: ChainId;
  /** Adapter-specific market identifier — an underlying asset address for Aave v3
   * (one reserve per asset within a pool), a Morpho Blue market `Id`, or a vault
   * address for Morpho vaults. */
  marketId: string;
  asset: Address;
  owner: Address;
  /** Current balance in underlying-asset units (not shares/aTokens). */
  balance: bigint;
  /** Protocol-specific extra state an adapter needs later without re-fetching it —
   * e.g. Morpho's raw share count, needed by `buildWithdraw` to redeem the exact
   * full position via shares rather than an asset-amount estimate that could leave
   * dust behind from rounding. */
  raw?: unknown;
}

export interface MarketSnapshot {
  marketId: string;
  block: BlockRef;
  totalSupplied: bigint;
  totalBorrowed: bigint;
  availableLiquidity: bigint;
  /** 0-1. */
  utilization: number;
  /** Annualized, as a fraction (e.g. 0.05 = 5%), not a raw on-chain fixed-point value —
   * adapters convert from whatever ray/WAD convention their protocol uses. */
  supplyRate: number;
  borrowRate: number;
  flags: { paused: boolean; frozen: boolean };
  /** Oracle price per unit of each asset (address, lowercase hex, as the key),
   * denominated in whatever base currency/scale the protocol's own oracle uses —
   * consumers that need an absolute value must also read that oracle's base
   * currency unit; consumers that only need a *ratio* between assets in the same
   * snapshot can use these directly since the base currency cancels out. */
  oraclePrices: Record<string, bigint>;
  badDebt?: bigint;
  raw: unknown;
}

export interface CollateralExposure {
  marketId: string;
  asset: Address;
  /** Approximate share of the market's collateral base this asset represents, in
   * [0, 1]. Across every `CollateralExposure` returned for one market, shares sum to
   * 1 (see docs/adr/0001 for the approximation method behind this for Aave; Morpho
   * Blue markets are exact by construction — a single-collateral market always
   * returns one entry at share 1). */
  share: number;
  method: 'exact' | 'approximate';
}

export interface WithdrawEstimate {
  position: Position;
  /** How much of `position.balance` could be withdrawn right now, given current
   * on-chain liquidity — may be less than the full balance if the pool can't pay it
   * all out immediately (docs/SPEC.md #8.3). */
  withdrawableNow: bigint;
  fullyWithdrawable: boolean;
}

export interface TxRequest {
  chainId: ChainId;
  to: Address;
  data: `0x${string}`;
  value: bigint;
}

/** Minimal shape of an on-chain log, independent of which chain-client library reads
 * it — adapters decode these without depending on viem's own `Log` type directly, so
 * `decodeEvents` stays testable with hand-built fixtures. */
export interface RawLog {
  address: Address;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
}

export interface ProtocolEvent {
  chainId: ChainId;
  marketId: string;
  kind: 'supply' | 'withdraw' | 'borrow' | 'repay' | 'liquidation' | 'other';
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
  data: Record<string, unknown>;
}

export interface ProtocolAdapter {
  /** e.g. "aave-v3:ethereum:core". */
  id: string;
  discoverPositions(owner: Address, at: BlockRef): Promise<Position[]>;
  snapshotMarkets(marketIds: string[], at: BlockRef): Promise<MarketSnapshot[]>;
  collateralExposure(marketId: string, at: BlockRef): Promise<CollateralExposure[]>;
  withdrawable(position: Position, at: BlockRef): Promise<WithdrawEstimate>;
  buildWithdraw(position: Position, amount: bigint | 'max', recipient: Address): TxRequest;
  decodeEvents(logs: RawLog[]): ProtocolEvent[];
}

export type SignalFamily = 'pool_flow' | 'collateral' | 'peg' | 'governance' | 'infra';

export type SignalSeverity = 'info' | 'watch' | 'danger' | 'critical';

export interface Signal {
  detectorId: string;
  family: SignalFamily;
  subject: { kind: 'market' | 'asset' | 'vault' | 'position' | 'infra'; id: string };
  severity: SignalSeverity;
  /** May trigger a full exit without corroboration from another family (docs/SPEC.md
   * #8.1) — only set by detectors explicitly allowed to (D06 at critical, D11, or
   * others justified by an ADR). */
  standaloneCritical?: boolean;
  value: number;
  threshold: number;
  evidence: Record<string, unknown>;
}
