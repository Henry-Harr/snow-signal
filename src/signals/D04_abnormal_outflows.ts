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
 * Default thresholds (docs/TUNING_LOG.md's 2026-09-19 entry has the full real-data
 * derivation): watch at z ≥ 20, danger at z ≥ 50, critical at z ≥ 400. Originally
 * 4/8/16 through the MAD-floor fix below — raised by roughly an order of magnitude
 * after a real 7-day, dense (300s-resolution, dual-independent-provider) sample of
 * Aave v3 Ethereum Core USDC's actual score distribution showed the *old* thresholds
 * sitting inside ordinary background noise, not past it: the 300s window alone had
 * p90 ≈ 10.4 (already above the old danger=8) and p99 ≈ 260 (16x past the old
 * critical=16) on completely unremarkable flow. Windows default to 300s/3600s/21600s.
 *
 * Known false-positive sources: a market with naturally lumpy flow (e.g. one large,
 * regular depositor rebalancing on a schedule) will have a wide baseline MAD and so
 * rarely trigger even on real outflows — this detector is only as sensitive as the
 * market's own recent history is stable. Conversely a market with a very thin/short
 * history (fewer than 3 baseline observations for a window) can't compute a
 * statistically meaningful MAD and is skipped for that window entirely, per the same
 * "fewer than 3, don't reject/flag" convention `rejectOutliers` uses.
 *
 * The opposite instability, found in production (docs/TUNING_LOG.md's 2026-09-18
 * entry): a market whose baseline flow is nearly flat block-to-block (real for a
 * large, quiet USDC reserve sampled at block granularity) pushes `baselineMad`
 * toward zero — dividing by a near-zero MAD then turns even completely ordinary
 * flow noise into an absurd, meaningless z-score (observed: >25 million once).
 * `minMad` (raw asset units) floors the denominator so immaterial noise below that
 * floor can't blow up the score; defaults to the same $2,000-equivalent materiality
 * bar `D11_bad_debt` established for the same currently-watched 6-decimal
 * stablecoins, for internal consistency rather than an independently-derived number.
 *
 * A second, distinct false-positive source found live the following day
 * (docs/TUNING_LOG.md's 2026-09-19 entry): a single real, recurring, large actor
 * (one address, confirmed via `decodeEventLog` against real `Withdraw` events on 5
 * separate real days) self-withdraws (`user === to`) roughly $180–196M from this
 * same Ethereum Core USDC reserve at almost the same time daily, always recovering
 * by the next day. Its z-score (tens of thousands on the 300s window) dwarfs any
 * threshold sane enough to stay sensitive to genuinely smaller anomalies — and
 * critically, *no amount of additional history retention fixes this*: the baseline
 * MAD is a robust statistic **by design** (so one wild historical spike doesn't
 * distort what counts as normal, see above), so a real pattern that recurs on only
 * ~0.3% of samples (roughly once a day, sampled every few minutes) can never
 * accumulate enough weight to widen the baseline even over `HISTORY_LOOKBACK_BLOCKS`
 * (~28 days, `src/core/pipeline.ts`) of real history. This is therefore an accepted,
 * understood residual: this specific actor's daily self-withdrawal is expected to
 * keep crossing `critical` (it is, honestly, a real ~9%-of-pool single-block outflow
 * event, not nothing — just not a bank run) until a design change (e.g. attributing
 * flow to a specific counterparty, which would require threading real per-transfer
 * event data into this detector and giving up its current I/O-free purity) actually
 * distinguishes "one large actor's own funds, self-directed, self-resolving" from a
 * genuine broad-based drain. Logged, not solved, in docs/PROGRESS.md's Known Issues.
 */
export const D04_ID = 'D04_abnormal_outflows';

export const D04_DEFAULT_THRESHOLDS: AscendingThresholds = {
  watch: 20,
  danger: 50,
  critical: 400,
};

export const D04_DEFAULT_WINDOWS_SECONDS = [300, 3600, 21600];

export const D04_DEFAULT_MIN_MAD = 2_000_000_000;

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
  minMad: number = D04_DEFAULT_MIN_MAD,
): Detector {
  return {
    id: D04_ID,
    family: 'pool_flow',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const market of ctx.markets) {
        const perWindow = evaluateMarket(market, windowsSeconds, minMad);
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

function evaluateMarket(
  market: MarketContext,
  windowsSeconds: number[],
  minMad: number,
): WindowResult[] {
  const points: FlowPoint[] = [...market.history, market.current];
  const results: WindowResult[] = [];
  for (const windowSeconds of windowsSeconds) {
    const baselineFlows = windowedFlows(market.history, windowSeconds);
    if (baselineFlows.length < 3) continue;

    const currentFlows = windowedFlows(points, windowSeconds);
    const currentFlow = currentFlows[currentFlows.length - 1];
    if (currentFlow === undefined) continue;

    const baselineMedian = median(baselineFlows);
    // Floored so a near-flat baseline (small but nonzero MAD) can't turn ordinary
    // flow noise into an absurd score by dividing by a near-zero denominator — see
    // this detector's own doc comment and docs/TUNING_LOG.md's 2026-09-18 entry.
    const baselineMad = Math.max(medianAbsoluteDeviation(baselineFlows), minMad);
    // Negated so a large net *outflow* (currentFlow far below the baseline median)
    // produces a large *positive* score — inflows (currentFlow above median) always
    // score negative and never cross a watch/danger/critical threshold.
    const score = -modifiedZScore(currentFlow, baselineMedian, baselineMad);
    results.push({ windowSeconds, currentFlow, baselineMedian, baselineMad, score });
  }
  return results;
}
