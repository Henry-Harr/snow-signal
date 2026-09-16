import { findTimeBaseline, severityAtLeast, type AscendingThresholds } from './util.js';
import type { Detector, DetectorContext, MarketContext } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D02 — Utilization velocity (docs/SPEC.md #7, pool_flow family).
 *
 * Purpose: catch a market deteriorating *fast* — a bank run in progress — even before
 * D01's absolute-level thresholds are crossed. A market climbing from 60% to 90%
 * utilization in an hour is a materially different situation than one that has sat at
 * 90% for a week, and spec §5.1 explicitly calls out "rate of change counts."
 *
 * Inputs: `MarketSnapshot.utilization` at the current block, plus `MarketContext.history`
 * (oldest → newest) filtered to the lookback window by `block.timestamp`.
 *
 * Formula: `delta = current.utilization - baseline.utilization`, where `baseline` is
 * the *oldest* history entry still within the lookback window (i.e. the point closest
 * to exactly `windowSeconds` ago that we have data for) — not the single oldest point
 * in all of `history`, and not a naive endpoint-to-endpoint slope over whatever
 * history happens to be available. If no history entry is old enough to anchor the
 * window (e.g. the market was only just discovered), the detector emits nothing for
 * that market rather than computing velocity over a shorter, misleadingly-labeled
 * window.
 *
 * Default thresholds (spec gives only "danger if utilization rises 10+ points within
 * 1 hour" — watch/critical are extrapolated placeholders around that one anchor, not
 * independently specified): watch ≥ 5 points/hour, danger ≥ 10 points/hour, critical
 * ≥ 20 points/hour. `windowSeconds` defaults to 3600 (1 hour).
 *
 * Known false-positive sources: a market that just started (little history) or one
 * whose snapshot cadence is coarser than the window (e.g. only hourly snapshots
 * exist) will rarely or never find a valid baseline and stays silent — a silent D02
 * does not mean "no velocity risk," it means "not enough history to measure it
 * yet," which is why this detector never substitutes a shorter window.
 */
export const D02_ID = 'D02_utilization_velocity';

export const D02_DEFAULT_THRESHOLDS: AscendingThresholds = {
  watch: 5,
  danger: 10,
  critical: 20,
};

export const D02_DEFAULT_WINDOW_SECONDS = 3600;

/** Thin, type-narrowed alias of `findTimeBaseline` (`util.ts`) for `MarketSnapshot`
 * history — kept as its own export since it predates the generic and other tests/
 * code already reference this name. */
export function findVelocityBaseline(
  history: MarketContext['history'],
  nowTimestamp: number,
  windowSeconds: number,
) {
  return findTimeBaseline(history, nowTimestamp, windowSeconds);
}

export function createD02Detector(
  thresholds: AscendingThresholds = D02_DEFAULT_THRESHOLDS,
  windowSeconds: number = D02_DEFAULT_WINDOW_SECONDS,
): Detector {
  return {
    id: D02_ID,
    family: 'pool_flow',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const market of ctx.markets) {
        const baseline = findVelocityBaseline(
          market.history,
          market.current.block.timestamp,
          windowSeconds,
        );
        if (!baseline) continue;

        const deltaPoints = (market.current.utilization - baseline.utilization) * 100;
        const severity = severityAtLeast(deltaPoints, thresholds);
        if (!severity) continue;

        signals.push({
          detectorId: D02_ID,
          family: 'pool_flow',
          subject: { kind: 'market', id: market.marketId },
          severity,
          value: deltaPoints,
          threshold: thresholds[severity],
          evidence: {
            windowSeconds,
            currentUtilization: market.current.utilization,
            baselineUtilization: baseline.utilization,
            currentBlock: market.current.block,
            baselineBlock: baseline.block,
          },
        });
      }
      return signals;
    },
  };
}
