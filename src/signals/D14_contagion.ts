import type { Detector, DetectorContext } from './types.js';
import type { Signal, SignalSeverity } from '../core/types.js';

/**
 * D14 — Contagion (docs/SPEC.md #7, collateral family).
 *
 * Purpose: an asset flagged as risky in one market is the same asset everywhere else
 * it's used as collateral — a WETH depeg or a frozen WETH oracle discovered via one
 * market's D06/D07 reading is just as real in every other market (and every vault
 * that allocates into one) holding WETH as collateral, whether or not that other
 * market's own snapshot looks fine yet.
 *
 * Inputs: `DetectorContext.priorSignals` (this evaluation's own asset-level signals
 * from every other detector — see ADR 0007's two-pass registry design, the mechanism
 * this detector exists to use) and `DetectorContext.assetExposure` (which markets/
 * vaults are exposed to each asset symbol, and how much — see that field's doc
 * comment in `types.ts` for how vault look-through is resolved upstream).
 *
 * Formula: for every prior signal whose `subject.kind === 'asset'`, look up
 * `assetExposure[subject.id]` and emit one contagion signal per exposed market.
 * Severity is the source severity demoted one level (`critical → danger → watch →
 * info`) *unless* that market's `shareOfCollateralBase` meets or exceeds
 * `fullContagionShare`, in which case the market inherits the *same* severity as the
 * source — spec's own wording ("inherits the source severity minus one level, unless
 * exposure exceeds a configured share").
 *
 * Default threshold: `fullContagionShare` = 0.5 (a market where the flagged asset is
 * at least half the collateral base gets no demotion).
 *
 * Known false-positive sources: this detector inherits every false-positive source
 * of whatever raised the original signal — it adds no new judgment of its own, by
 * design (spreading risk, not re-deriving it). A market with only trivial exposure
 * to a flagged asset (well under `fullContagionShare`) still gets a demoted signal
 * even if that exposure is economically immaterial to it — deliberately conservative,
 * since "immaterial" is a magnitude judgment the risk engine's severity handling is
 * better positioned to make than a fixed cutoff here.
 */
export const D14_ID = 'D14_contagion';

export const D14_DEFAULT_FULL_CONTAGION_SHARE = 0.5;

const DEMOTION: Record<SignalSeverity, SignalSeverity> = {
  critical: 'danger',
  danger: 'watch',
  watch: 'info',
  info: 'info',
};

export function createD14Detector(
  fullContagionShare: number = D14_DEFAULT_FULL_CONTAGION_SHARE,
): Detector {
  return {
    id: D14_ID,
    family: 'collateral',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const source of ctx.priorSignals) {
        if (source.subject.kind !== 'asset') continue;

        const exposedMarkets = ctx.assetExposure[source.subject.id] ?? [];
        for (const exposure of exposedMarkets) {
          const fullContagion = exposure.shareOfCollateralBase >= fullContagionShare;
          const severity = fullContagion ? source.severity : DEMOTION[source.severity];

          signals.push({
            detectorId: D14_ID,
            family: 'collateral',
            subject: { kind: 'market', id: exposure.marketId },
            severity,
            value: exposure.shareOfCollateralBase,
            threshold: fullContagionShare,
            evidence: {
              sourceDetectorId: source.detectorId,
              sourceAsset: source.subject.id,
              sourceSeverity: source.severity,
              shareOfCollateralBase: exposure.shareOfCollateralBase,
              fullContagion,
            },
          });
        }
      }
      return signals;
    },
  };
}
