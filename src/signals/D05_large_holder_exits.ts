import type { Detector, DetectorContext, HolderSnapshot } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D05 — Large-holder exits (docs/SPEC.md #7, pool_flow family).
 *
 * Purpose: a whale quietly exiting is an early warning long before it shows up as a
 * pool-wide utilization or outflow anomaly (D01/D04) — the whole point of watching
 * concentration, not just aggregates.
 *
 * Inputs: `MarketContext.holdersHistory` (the supply-side ledger at the start of the
 * lookback window) and `MarketContext.holders` (the current ledger) — see
 * `src/watchers/large-holders.ts` for how the ledger itself is built from pool-flow
 * events.
 *
 * Formula: rank `holdersHistory` by `supply` descending, take the top N (default 10).
 * For each, find its *current* supply balance (0 if the holder no longer appears in
 * `holders` at all — a full exit) and compute `withdrawnFraction = (historyBalance -
 * currentBalance) / historyBalance`. Emit one signal per holder whose
 * `withdrawnFraction` crosses a threshold — deliberately one signal per holder rather
 * than one aggregate signal per market, since the risk engine and a human reading
 * alerts both want to know *which* whale moved, not just that "someone" did.
 *
 * Default thresholds (spec gives only "watch if a top-10 supplier withdraws ≥ 25%
 * within 1 hour" — danger/critical are extrapolated placeholders around that one
 * anchor): watch ≥ 25%, danger ≥ 50%, critical ≥ 90% (a near-total exit). `topN`
 * defaults to 10.
 *
 * Known false-positive sources: a holder rotating funds between two of their own
 * addresses (e.g. moving from a hot wallet into a smart-contract wallet, both
 * supplying the same market) looks identical to a real exit from this detector's
 * point of view — it has no cross-address identity information. A protocol-level
 * rebalance where a large holder is known to cycle on a schedule (e.g. a vault's own
 * periodic reallocation counted as a "holder" of the underlying market) is the other
 * common false-positive shape; distinguishing "my own vault's rebalance" from "an
 * external whale leaving" needs config-level allowlisting, which is a risk-engine/
 * config concern (Phase 5), not something this detector can determine from the ledger
 * alone.
 */
export const D05_ID = 'D05_large_holder_exits';

export interface D05Thresholds {
  watch: number;
  danger: number;
  critical: number;
}

export const D05_DEFAULT_THRESHOLDS: D05Thresholds = { watch: 0.25, danger: 0.5, critical: 0.9 };

export const D05_DEFAULT_TOP_N = 10;

function severityFor(fraction: number, t: D05Thresholds) {
  if (fraction >= t.critical) return 'critical' as const;
  if (fraction >= t.danger) return 'danger' as const;
  if (fraction >= t.watch) return 'watch' as const;
  return undefined;
}

function topSuppliers(holders: HolderSnapshot[], topN: number): HolderSnapshot[] {
  return [...holders]
    .filter((h) => h.supply > 0n)
    .sort((a, b) => (b.supply > a.supply ? 1 : b.supply < a.supply ? -1 : 0))
    .slice(0, topN);
}

export function createD05Detector(
  thresholds: D05Thresholds = D05_DEFAULT_THRESHOLDS,
  topN: number = D05_DEFAULT_TOP_N,
): Detector {
  return {
    id: D05_ID,
    family: 'pool_flow',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const market of ctx.markets) {
        const currentByHolder = new Map(market.holders.map((h) => [h.holder.toLowerCase(), h]));
        for (const historical of topSuppliers(market.holdersHistory, topN)) {
          const current = currentByHolder.get(historical.holder.toLowerCase());
          const currentSupply = current?.supply ?? 0n;
          if (currentSupply >= historical.supply) continue; // no withdrawal at all

          const withdrawn = historical.supply - currentSupply;
          const withdrawnFraction = Number(withdrawn) / Number(historical.supply);
          const severity = severityFor(withdrawnFraction, thresholds);
          if (!severity) continue;

          signals.push({
            detectorId: D05_ID,
            family: 'pool_flow',
            subject: { kind: 'market', id: market.marketId },
            severity,
            value: withdrawnFraction,
            threshold: thresholds[severity],
            evidence: {
              holder: historical.holder,
              historyBalance: historical.supply,
              currentBalance: currentSupply,
              block: market.current.block,
            },
          });
        }
      }
      return signals;
    },
  };
}
