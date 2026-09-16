import { medianAbsoluteDeviation, median } from '../prices/aggregate.js';
import { modifiedZScore, severityAtLeast, type AscendingThresholds } from './util.js';
import type { Detector, DetectorContext, MarketContext } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D04 — Abnormal net outflows (docs/SPEC.md #7, pool_flow family).
 *
 * Purpose: catch a bank run in its early stages, before D01's absolute-utilization
 * thresholds are reached — a market whose *net flow* (change in `totalSupplied`) over
 * a short window is far outside its own recent normal range, even if the absolute
 * utilization level still looks unremarkable.
 *
 * Inputs: `MarketContext.current`/`history` (oldest → newest), across three windows
 * (5 minutes, 1 hour, 6 hours).
 *
 * Formula: for each window, build a *baseline distribution* of "windowed flows" by
 * sliding the window across `history` (each `history[i]` paired with the latest
 * earlier point at least `windowSeconds` before it), then compute
 * `flow = totalSupplied[t] - totalSupplied[t - window]` for `current` the same way.
 * The anomaly score is the *robust modified z-score* (median/MAD of the baseline
 * distribution — median and MAD instead of mean/stdev because a single wild historical
 * spike shouldn't distort what counts as "normal," matching `src/prices/aggregate.ts`'s
 * outlier-rejection philosophy) of `-flow` (so a large net *outflow* gives a large
 * *positive* score — inflows never trigger this detector, only outflows). The overall
 * signal takes the worst (maximum) anomaly score across the three windows; evidence
 * carries all three so a corroborating human can see whether it's a 5-minute flash or
 * a sustained 6-hour drain.
 *
 * Default thresholds (spec placeholders — only watch/danger given; critical is an
 * extrapolated placeholder): watch at z ≥ 4, danger at z ≥ 8, critical at z ≥ 16.
 * Windows default to 300s/3600s/21600s.
 *
 * Known false-positive sources: a market with naturally lumpy flow (e.g. one large,
 * regular depositor rebalancing on a schedule) will have a wide baseline MAD and so
 * rarely trigger even on real outflows — this detector is only as sensitive as the
 * market's own recent history is stable. Conversely a market with a very thin/short
 * history (fewer than 3 baseline observations for a window) can't compute a
 * statistically meaningful MAD and is skipped for that window entirely, per the same
 * "fewer than 3, don't reject/flag" convention `rejectOutliers` uses.
 */
export const D04_ID = 'D04_abnormal_outflows';

export const D04_DEFAULT_THRESHOLDS: AscendingThresholds = { watch: 4, danger: 8, critical: 16 };

export const D04_DEFAULT_WINDOWS_SECONDS = [300, 3600, 21600];

interface FlowPoint {
  block: { timestamp: number };
  totalSupplied: bigint;
}

/** Every "windowed flow" observation obtainable from `points` (oldest → newest) for
 * `windowSeconds`: for each point, pair it with the latest earlier point at least
 * `windowSeconds` before it, if one exists. Exported for direct unit testing. */
export function windowedFlows(points: FlowPoint[], windowSeconds: number): number[] {
  const flows: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const cutoff = points[i]!.block.timestamp - windowSeconds;
    let baseline: FlowPoint | undefined;
    for (let j = 0; j < i; j++) {
      if (points[j]!.block.timestamp <= cutoff) baseline = points[j]!;
    }
    if (baseline) {
      flows.push(Number(points[i]!.totalSupplied - baseline.totalSupplied));
    }
  }
  return flows;
}

export function createD04Detector(
  thresholds: AscendingThresholds = D04_DEFAULT_THRESHOLDS,
  windowsSeconds: number[] = D04_DEFAULT_WINDOWS_SECONDS,
): Detector {
  return {
    id: D04_ID,
    family: 'pool_flow',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const market of ctx.markets) {
        const perWindow = evaluateMarket(market, windowsSeconds);
        if (perWindow.length === 0) continue;

        const worst = perWindow.reduce((a, b) => (b.score > a.score ? b : a));
        const severity = severityAtLeast(worst.score, thresholds);
        if (!severity) continue;

        signals.push({
          detectorId: D04_ID,
          family: 'pool_flow',
          subject: { kind: 'market', id: market.marketId },
          severity,
          value: worst.score,
          threshold: thresholds[severity],
          evidence: {
            windows: perWindow,
            block: market.current.block,
          },
        });
      }
      return signals;
    },
  };
}

interface WindowResult {
  windowSeconds: number;
  currentFlow: number;
  baselineMedian: number;
  baselineMad: number;
  score: number;
}

function evaluateMarket(market: MarketContext, windowsSeconds: number[]): WindowResult[] {
  const points: FlowPoint[] = [...market.history, market.current];
  const results: WindowResult[] = [];
  for (const windowSeconds of windowsSeconds) {
    const baselineFlows = windowedFlows(market.history, windowSeconds);
    if (baselineFlows.length < 3) continue;

    const currentFlows = windowedFlows(points, windowSeconds);
    const currentFlow = currentFlows[currentFlows.length - 1];
    if (currentFlow === undefined) continue;

    const baselineMedian = median(baselineFlows);
    const baselineMad = medianAbsoluteDeviation(baselineFlows);
    // Negated so a large net *outflow* (currentFlow far below the baseline median)
    // produces a large *positive* score — inflows (currentFlow above median) always
    // score negative and never cross a watch/danger/critical threshold.
    const score = -modifiedZScore(currentFlow, baselineMedian, baselineMad);
    results.push({ windowSeconds, currentFlow, baselineMedian, baselineMad, score });
  }
  return results;
}
