/** The three severities every threshold-based detector can escalate through
 * (excludes `'info'`, which no threshold comparison here produces). */
export type ThresholdSeverity = 'watch' | 'danger' | 'critical';

/**
 * Shared threshold-comparison helpers used by most detectors (docs/SPEC.md #7): every
 * detector's three placeholder thresholds follow one of two shapes — "worse means
 * higher" (utilization, price deviation, …) or "worse means lower" (exit coverage).
 * Kept here instead of duplicated per detector so a rounding/off-by-one fix (e.g.
 * `>=` vs `>`) only needs to happen once.
 */
export interface AscendingThresholds {
  watch: number;
  danger: number;
  critical: number;
}

/** For metrics where a *higher* value is worse (e.g. utilization, price deviation %).
 * Checks critical first so a value past every threshold reports the worst one. */
export function severityAtLeast(
  value: number,
  t: AscendingThresholds,
): ThresholdSeverity | undefined {
  if (value >= t.critical) return 'critical';
  if (value >= t.danger) return 'danger';
  if (value >= t.watch) return 'watch';
  return undefined;
}

/** For metrics where a *lower* value is worse (e.g. exit coverage ratio). `t.watch`
 * is the largest (least bad) threshold, `t.critical` the smallest. */
export function severityAtMost(
  value: number,
  t: AscendingThresholds,
): ThresholdSeverity | undefined {
  if (value <= t.critical) return 'critical';
  if (value <= t.danger) return 'danger';
  if (value <= t.watch) return 'watch';
  return undefined;
}

export interface Timestamped {
  block: { timestamp: number };
}

/** The latest entry in `history` (any oldest → newest series with a `block.timestamp`)
 * that is still at or before `nowTimestamp - windowSeconds` — i.e. the oldest entry
 * that still falls within the lookback window, used to anchor a "how much did this
 * change over the last N seconds" comparison (D02, D08, …). Returns `undefined` when
 * no entry is old enough to anchor the window, which callers should treat as "not
 * enough history yet," not "no change." */
export function findTimeBaseline<T extends Timestamped>(
  history: T[],
  nowTimestamp: number,
  windowSeconds: number,
): T | undefined {
  const cutoff = nowTimestamp - windowSeconds;
  let baseline: T | undefined;
  for (const entry of history) {
    if (entry.block.timestamp <= cutoff) baseline = entry;
  }
  return baseline;
}

/** Robust "modified z-score" (Iglewicz & Hoaglin): `0.6745 * (value - median) / MAD`.
 * The `0.6745` constant scales MAD to be comparable to a standard deviation under a
 * normal distribution, which is what makes a z-of-4/8-style threshold meaningful for
 * MAD instead of only for stdev. Returns 0 when `mad` is 0 and `value === median`
 * (no deviation at all), and `Infinity`/`-Infinity` (signed) when `mad` is 0 but
 * `value !== median` — any nonzero deviation from a perfectly flat baseline is
 * maximally anomalous, not undefined.
 */
export function modifiedZScore(value: number, median: number, mad: number): number {
  if (mad === 0) return value === median ? 0 : Math.sign(value - median) * Infinity;
  return (0.6745 * (value - median)) / mad;
}
