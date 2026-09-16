import type { ActionRecommendation, RiskLevel } from '../risk/types.js';
import type { Address, ChainId, Signal } from '../core/types.js';

/**
 * Notification types (docs/SPEC.md #10.1). An `Alert` is built from a persisted
 * `DecisionRecord` (`src/storage/decision-record-repository.ts`) plus position
 * metadata — it needs the decision's real id (for `/ack <id>`), which a pure
 * `Decision` doesn't have yet (see `src/risk/types.ts`'s doc comment on why).
 */
export interface Alert {
  decisionId: number;
  positionId: string;
  protocol: string;
  chainId: ChainId;
  /** Display label for the position's asset — a symbol when known, the raw address
   * otherwise (the notifier doesn't have a symbol-resolution table of its own; see
   * docs/adr/0007's address/symbol join discussion — same gap, different consumer). */
  asset: string;
  level: RiskLevel;
  previousLevel: RiskLevel;
  rawLevel: RiskLevel;
  signals: Signal[];
  rule: string;
  blockNumber: bigint;
  blockExplorerUrl: string | undefined;
  action: ActionRecommendation;
  standingAlert: boolean;
  at: Date;
}

export interface Notifier {
  id: string;
  send(alert: Alert): Promise<void>;
}

/** Well-known block explorer base URLs, keyed by chain id — used to build the
 * "block explorer links" spec §10.1 asks for. The `/block/<number>` path was checked
 * directly this session (2026-09-16, `curl`): `basescan.org/block/18000000` returns
 * `200`. `etherscan.io/block/18000000` returned `403` even with a browser user
 * agent — consistent with Etherscan's known Cloudflare bot-blocking on scripted
 * requests, not evidence the path is wrong (Basescan is a same-vendor fork of the
 * Etherscan UI and shares its URL scheme) — but that specific URL was not directly
 * confirmed to render. If block-explorer links turn out wrong in practice, re-check
 * this against a real browser rather than assuming the Basescan result generalizes. */
const BLOCK_EXPLORERS: Record<ChainId, string> = {
  1: 'https://etherscan.io',
  8453: 'https://basescan.org',
};

export function blockExplorerUrl(chainId: ChainId, blockNumber: bigint): string | undefined {
  const base = BLOCK_EXPLORERS[chainId];
  return base ? `${base}/block/${blockNumber}` : undefined;
}

export function addressExplorerUrl(chainId: ChainId, address: Address): string | undefined {
  const base = BLOCK_EXPLORERS[chainId];
  return base ? `${base}/address/${address}` : undefined;
}
