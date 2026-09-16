import { findTimeBaseline, type AscendingThresholds } from './util.js';
import type { Detector, DetectorContext } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D08 — Collateral supply anomaly (docs/SPEC.md #7, collateral family; "the rsETH
 * pattern").
 *
 * Purpose: catch a sudden, large increase in a collateral asset's total supply — the
 * shape of an exploited or malfunctioning bridge/mint path flooding a market with
 * bad collateral, which is only dangerous to me if someone then borrows against it.
 *
 * Inputs: `AssetContext.supplyHistory` (oldest → newest, current last).
 *
 * Formula: `riseFraction = (current.totalSupply - baseline.totalSupply) /
 * baseline.totalSupply`, where `baseline` is found the same way D02 finds its
 * velocity baseline (`findTimeBaseline`, `util.ts`) — the latest supply reading still
 * at least `windowSeconds` old. If `riseFraction` crosses the danger threshold *and*
 * the asset's own market (`AssetContext.marketId`, matched against
 * `DetectorContext.markets`) also shows its `totalBorrowed` rising materially over
 * the same window, the severity escalates to critical — new collateral sitting idle
 * is a warning; new collateral immediately borrowed against is the rsETH pattern
 * itself. This detector cannot determine whether a supply rise is a "known flow" (a
 * legitimate large bridge deposit) — spec's "without matching known flows" clause
 * would need cross-chain event correlation this collector doesn't have, so every
 * qualifying rise is flagged and a human decides whether it's explained.
 *
 * Default thresholds (spec placeholders — "danger if supply rises 5%+ within 1 hour";
 * watch/critical-without-borrowing are extrapolated): watch ≥ 2%, danger ≥ 5%.
 * `windowSeconds` defaults to 3600. `borrowGrowthForCritical` (the concurrent-borrow
 * threshold that escalates danger to critical) defaults to 0.02 (2%).
 *
 * Known false-positive sources: a legitimate large single deposit (a whale bridging
 * in, or a known market-maker top-up) looks identical to a malicious mint from this
 * detector's point of view — see the "known flows" limitation above. A market with
 * naturally low total supply can also show a large *percentage* rise from a small
 * absolute mint; `riseFraction` alone doesn't distinguish "5% of $2M" from "5% of
 * $2B," which is a reason to keep this detector's output advisory rather than
 * standalone-critical.
 */
export const D08_ID = 'D08_collateral_supply_anomaly';

export const D08_DEFAULT_THRESHOLDS: Pick<AscendingThresholds, 'watch' | 'danger'> = {
  watch: 0.02,
  danger: 0.05,
};

export const D08_DEFAULT_WINDOW_SECONDS = 3600;
export const D08_DEFAULT_BORROW_GROWTH_FOR_CRITICAL = 0.02;

export function createD08Detector(
  thresholds: Pick<AscendingThresholds, 'watch' | 'danger'> = D08_DEFAULT_THRESHOLDS,
  windowSeconds: number = D08_DEFAULT_WINDOW_SECONDS,
  borrowGrowthForCritical: number = D08_DEFAULT_BORROW_GROWTH_FOR_CRITICAL,
): Detector {
  return {
    id: D08_ID,
    family: 'collateral',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const asset of ctx.assets) {
        const current = asset.supplyHistory[asset.supplyHistory.length - 1];
        if (!current) continue;
        const baseline = findTimeBaseline(
          asset.supplyHistory.slice(0, -1),
          current.block.timestamp,
          windowSeconds,
        );
        if (!baseline || baseline.totalSupply <= 0n) continue;

        const riseFraction =
          Number(current.totalSupply - baseline.totalSupply) / Number(baseline.totalSupply);

        let severity: 'watch' | 'danger' | 'critical';
        if (riseFraction >= thresholds.danger) severity = 'danger';
        else if (riseFraction >= thresholds.watch) severity = 'watch';
        else continue;

        if (severity === 'danger') {
          const market = ctx.markets.find((m) => m.marketId === asset.marketId);
          const marketBaseline =
            market &&
            findTimeBaseline(market.history, market.current.block.timestamp, windowSeconds);
          if (market && marketBaseline && marketBaseline.totalBorrowed > 0n) {
            const borrowGrowth =
              Number(market.current.totalBorrowed - marketBaseline.totalBorrowed) /
              Number(marketBaseline.totalBorrowed);
            if (borrowGrowth >= borrowGrowthForCritical) severity = 'critical';
          }
        }

        signals.push({
          detectorId: D08_ID,
          family: 'collateral',
          subject: { kind: 'asset', id: asset.symbol },
          severity,
          value: riseFraction,
          threshold: severity === 'watch' ? thresholds.watch : thresholds.danger,
          evidence: {
            windowSeconds,
            currentSupply: current.totalSupply,
            baselineSupply: baseline.totalSupply,
            marketId: asset.marketId,
            block: current.block,
          },
        });
      }
      return signals;
    },
  };
}
