import { severityAtMost, type AscendingThresholds } from './util.js';
import type { Detector, DetectorContext, MarketContext } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D03 — Exit coverage (docs/SPEC.md #7, pool_flow family).
 *
 * Purpose: the single most decision-relevant pool_flow number — not "is this market
 * risky in the abstract" (D01) but "could *I* actually get my money out right now."
 *
 * Inputs: `MarketContext.current.availableLiquidity`, `MarketContext.position.balance`,
 * and `MarketContext.history` (oldest → newest) for the blocks-to-exit estimate.
 * Markets with no `position` (I don't hold anything there) are skipped — coverage is
 * undefined, not infinite or zero, when there's nothing to cover.
 *
 * Formula: `coverage = availableLiquidity / myPosition` (unitless multiple — "how many
 * times over could this market pay me out right now"). When `coverage < 1` (the pool
 * can't fully pay me today), also estimates blocks-to-exit from the *average* per-block
 * change in `availableLiquidity` across `history`: if that average is positive, blocks
 * = `ceil(shortfall / averagePerBlockInflow)`; if it's zero or negative (liquidity
 * isn't recovering, or is still draining), blocks-to-exit is `Infinity` — organic
 * recovery isn't happening, which is itself part of the evidence, not an error.
 *
 * Default thresholds (spec placeholders): watch < 20×, danger < 5×, critical < 1.5×.
 *
 * Known false-positive sources: a brand-new position with `balance` still effectively
 * 0 immediately after depositing would show enormous (non-alarming) coverage — not a
 * false *positive* exactly, but a reminder this detector is about *my* exposure, so a
 * tiny position always looks safe here even in a market other detectors are flagging
 * hard. A market with volatile but mean-reverting liquidity (e.g. one large depositor
 * cycling funds) can also swing `coverage` across thresholds within one block without
 * real risk — D02-style rate-of-change smoothing isn't applied here deliberately,
 * since exit coverage is meant to answer "right now," not "on average recently."
 */
export const D03_ID = 'D03_exit_coverage';

export const D03_DEFAULT_THRESHOLDS: AscendingThresholds = {
  watch: 20,
  danger: 5,
  critical: 1.5,
};

/** Average per-block change in `availableLiquidity` across `history` (oldest →
 * newest), using the first and last entries — `undefined` if there are fewer than 2
 * points (no rate is computable from a single reading). Exported for direct testing.
 */
export function averageLiquidityInflowPerBlock(
  history: MarketContext['history'],
): number | undefined {
  if (history.length < 2) return undefined;
  const first = history[0]!;
  const last = history[history.length - 1]!;
  const blockSpan = last.block.number - first.block.number;
  if (blockSpan <= 0n) return undefined;
  const liquiditySpan = Number(last.availableLiquidity - first.availableLiquidity);
  return liquiditySpan / Number(blockSpan);
}

export function estimateBlocksToExit(shortfall: bigint, history: MarketContext['history']): number {
  if (shortfall <= 0n) return 0;
  const rate = averageLiquidityInflowPerBlock(history);
  if (rate === undefined || rate <= 0) return Infinity;
  return Math.ceil(Number(shortfall) / rate);
}

export function createD03Detector(
  thresholds: AscendingThresholds = D03_DEFAULT_THRESHOLDS,
): Detector {
  return {
    id: D03_ID,
    family: 'pool_flow',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const market of ctx.markets) {
        const position = market.position;
        if (!position || position.balance <= 0n) continue;

        const coverage = Number(market.current.availableLiquidity) / Number(position.balance);
        const severity = severityAtMost(coverage, thresholds);
        if (!severity) continue;

        const shortfall = position.balance - market.current.availableLiquidity;
        const blocksToExit = estimateBlocksToExit(shortfall, market.history);

        signals.push({
          detectorId: D03_ID,
          family: 'pool_flow',
          subject: { kind: 'position', id: position.id },
          severity,
          value: coverage,
          threshold: thresholds[severity],
          evidence: {
            availableLiquidity: market.current.availableLiquidity,
            positionBalance: position.balance,
            blocksToExit,
            block: market.current.block,
          },
        });
      }
      return signals;
    },
  };
}
