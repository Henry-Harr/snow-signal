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
