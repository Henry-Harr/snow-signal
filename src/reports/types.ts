import type { DecisionLabel } from '../storage/decision-label-repository.js';
import type { DecisionRecord } from '../storage/decision-record-repository.js';
import type { Address, ChainId } from '../core/types.js';

/**
 * Daily report types (docs/SPEC.md #10.2). `DailyReportInput` is the bundle the
 * pipeline (`src/core/pipeline.ts`) assembles from storage each day; the generator
 * itself (`daily-report.ts`) is a pure function of that bundle, so it's testable
 * without touching SQLite at all.
 */
export interface PositionSummary {
  positionId: string;
  protocol: string;
  chainId: ChainId;
  asset: Address;
  assetSymbol: string;
  /** Raw balance in the asset's smallest unit, at report time. */
  balance: bigint;
  balanceDecimals: number;
  /** Current supply rate this position is earning (fraction, e.g. 0.045 = 4.5% APR)
   * — from the position's own market snapshot. */
  supplyRateApr: number;
  /** The configured benchmark to compare against (docs/SPEC.md #10.2, spec's own
   * example: "the pool's base supply rate or a benchmark vault") — `undefined` when
   * no comparable benchmark reading was available this run. */
  benchmarkAprLabel: string;
  benchmarkApr: number | undefined;
}

export interface DataQualitySummary {
  chainId: ChainId;
  /** Fraction of polls this chain's RPC pool successfully reached quorum on,
   * 0–1 — `undefined` when uptime wasn't tracked for this run (Phase 5's minimal
   * wiring doesn't yet persist a running uptime counter; see docs/PROGRESS.md). */
  providerUptime: number | undefined;
  averageHeadLagBlocks: number;
  disagreementCount: number;
  staleSourceCount: number;
}

/** One position's result from the daily exit drill (docs/SPEC.md §8.6,
 * `src/actions/exit-drill.ts`) — a real fork-simulated full exit, not a placeholder.
 * `gasEstimate`/`estimatedBlocksToExit` are `undefined` when `passed` is `false`
 * (the mechanism is broken — an estimate built on top of a broken withdrawal would
 * be misleading) or when the drill couldn't even start (zero liquidity right now). */
export interface ExitDrillResult {
  positionId: string;
  passed: boolean;
  gasEstimate: bigint | undefined;
  estimatedBlocksToExit: number | undefined;
}

export interface DailyReportInput {
  /** UTC calendar date this report covers, `YYYY-MM-DD`. */
  date: string;
  generatedAt: Date;
  positions: PositionSummary[];
  /** Every decision recorded during the report's date window, any position. */
  decisions: DecisionRecord[];
  labels: Map<number, DecisionLabel>;
  dataQuality: DataQualitySummary[];
  exitDrillResults: ExitDrillResult[];
  /** Total gas spent on real/paper actions this window — always `0n` while
   * execution mode is `off` (the only mode Phase 5 itself drives). */
  gasSpentWei: bigint;
}

export interface DailyReport {
  markdown: string;
  /** JSON-serializable — bigints are stringified (see `daily-report.ts`). */
  json: Record<string, unknown>;
}
