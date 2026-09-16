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

/**
 * Phase 2 protocol adapter types (docs/SPEC.md #5.3, #6). A "position" is one row of
 * the user's configured `positions` list — a specific (protocol, chain, market-or-
 * vault, asset) the user holds directly (docs/adr/0002). `id` for both `Position` and
 * `ProtocolAdapter` follows the `protocol:chain:market:asset` convention shown in
 * spec #5.3's sketch, e.g. `"aave-v3:ethereum:core"`.
 */
export interface Position {
  id: string;
  protocol: string;
  chainId: ChainId;
  marketId: string;
  owner: Address;
  asset: Address;
  /** Raw underlying-asset units (e.g. aToken balance already converted to underlying
   * via the liquidity index, or a vault's `convertToAssets(shares)`). */
  balance: bigint;
}

export interface MarketSnapshot {
  marketId: string;
  block: BlockRef;
  totalSupplied: bigint;
  totalBorrowed: bigint;
  availableLiquidity: bigint;
  utilization: number;
  supplyRate: number;
  borrowRate: number;
  flags: { paused: boolean; frozen: boolean };
  oraclePrices: Record<string /* asset */, bigint>;
  badDebt?: bigint;
  /** Protocol-specific extras, validated with zod by the adapter before being placed
   * here (docs/SPEC.md #5.3) — never trust an RPC response's shape without a schema. */
  raw: unknown;
}

/** Pool-wide exposure to one collateral asset (docs/SPEC.md #6.2, docs/adr/0001) —
 * "the real risk for a stablecoin supplier is the pool's whole collateral base." */
export interface CollateralExposure {
  marketId: string;
  asset: Address;
  /** This asset's approximate share of the market's collateral base, 0–1. See
   * docs/adr/0001 for exactly how each protocol computes this (exact for Morpho Blue,
   * approximated for Aave v3). */
  shareOfCollateralBase: number;
  method: 'exact' | 'approximate';
  raw: unknown;
}

export interface WithdrawEstimate {
  positionId: string;
  /** What could actually be withdrawn right now, given current on-chain liquidity —
   * never more than `totalPosition`. */
  availableNow: bigint;
  totalPosition: bigint;
}

/** An unsigned transaction request. Building one is pure/harmless (no signing, no
 * broadcast) — Phase 2 adapters implement `buildWithdraw` so the withdrawal planner
 * (Phase 7) doesn't need protocol-specific calldata knowledge, but nothing calls it
 * for real until execution mode is no longer `off` (safety rules 2–3). */
export interface TxRequest {
  chainId: ChainId;
  to: Address;
  data: `0x${string}`;
  value?: bigint;
  description: string;
}

export interface ProtocolEvent {
  protocol: string;
  chainId: ChainId;
  marketId: string;
  eventName: string;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
  args: Record<string, unknown>;
}

/**
 * One already-ABI-decoded log, as produced by `ContractReadClient.getLogs`
 * (src/chain/client.ts). Spec #5.3 sketches `decodeEvents(logs: Log[])` as decoding
 * raw logs; here the ABI decoding already happened at the RPC-read layer (viem decodes
 * against the `event` passed to `getLogs`), so `decodeEvents` is instead the
 * normalization step: turning a protocol's own decoded log shape into the
 * cross-protocol `ProtocolEvent` shape every downstream consumer (storage, watchers)
 * reads.
 */
export interface Log {
  address: Address;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
  eventName: string;
  args: Record<string, unknown>;
}

export interface ProtocolAdapter {
  id: string;
  discoverPositions(owner: Address, at: BlockRef): Promise<Position[]>;
  snapshotMarkets(marketIds: string[], at: BlockRef): Promise<MarketSnapshot[]>;
  collateralExposure(marketId: string, at: BlockRef): Promise<CollateralExposure[]>;
  withdrawable(position: Position, at: BlockRef): Promise<WithdrawEstimate>;
  buildWithdraw(position: Position, amount: bigint | 'max', recipient: Address): TxRequest;
  decodeEvents(logs: Log[]): ProtocolEvent[];
}
