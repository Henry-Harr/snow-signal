import { severityAtLeast, type AscendingThresholds } from './util.js';
import type { Detector, DetectorContext } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D15 — Share of debt held by borrowers close to liquidation (docs/SPEC.md #7,
 * collateral family).
 *
 * Purpose: a market can look perfectly healthy in aggregate (moderate utilization, no
 * bad debt yet) while a large share of its borrowers sit just above their
 * liquidation threshold — a sharp price move or a stale oracle tick (D06/D07) can
 * then trigger a wave of liquidations all at once, which is exactly the kind of
 * correlated, sudden stress a single aggregate utilization number doesn't show.
 *
 * Inputs: `MarketContext.borrowerHealth` (`BorrowerHealthSnapshot[]`, Aave-only for
 * now — see `src/watchers/large-holders.ts`'s doc comment on why Morpho Blue
 * borrower health isn't collected the same way).
 *
 * Formula and a real limitation worth stating plainly: Aave's `healthFactor` (via
 * `getUserAccountData`) is an **account-wide** figure — a borrower's health across
 * *every* reserve they've borrowed, denominated in Aave's base currency — not a
 * per-reserve debt amount in this specific market's asset. There is no clean way to
 * turn that into "this reserve's total debt held by unhealthy accounts" without also
 * reading each borrower's per-reserve variable-debt-token balance, which isn't
 * collected (Phase 3 scope was the top-N ledger, not per-reserve borrower debt
 * breakdowns). So this detector computes `shareNearLiquidation = sum(totalDebtBase
 * for borrowers with healthFactor < healthFactorThreshold) / sum(totalDebtBase for
 * every tracked borrower)` — a share of the *tracked* borrower population's
 * account-wide debt, not literally "this market's pool debt" as spec's wording
 * states. It's the closest honest approximation available from account-level health
 * data, and is internally consistent (same units on both sides), but is **not** the
 * same measurement spec describes.
 *
 * Default thresholds (spec gives only "watch if ≥20% of debt has a health factor
 * below 1.05" — danger/critical are extrapolated placeholders): watch ≥ 20%, danger ≥
 * 40%, critical ≥ 60%. `healthFactorThreshold` defaults to `1.05 * 1e18` (Aave's
 * `HEALTH_FACTOR_SCALE`, matching `src/watchers/large-holders.ts`).
 *
 * Known false-positive sources: `borrowerHealth` only covers whichever borrowers the
 * large-holder watcher tracked (a ranked top-N, not every borrower in the market) —
 * a market with many small, healthy borrowers outside that tracked set would show an
 * inflated share here purely because the untracked healthy debt isn't in the
 * denominator. This detector is only as representative as the tracked set is of the
 * market's real borrower population.
 */
export const D15_ID = 'D15_debt_near_liquidation';

export const D15_DEFAULT_THRESHOLDS: AscendingThresholds = {
  watch: 0.2,
  danger: 0.4,
  critical: 0.6,
};

export const D15_HEALTH_FACTOR_SCALE = 10n ** 18n;
export const D15_DEFAULT_HEALTH_FACTOR_THRESHOLD = (105n * D15_HEALTH_FACTOR_SCALE) / 100n; // 1.05

export function createD15Detector(
  thresholds: AscendingThresholds = D15_DEFAULT_THRESHOLDS,
  healthFactorThreshold: bigint = D15_DEFAULT_HEALTH_FACTOR_THRESHOLD,
): Detector {
  return {
    id: D15_ID,
    family: 'collateral',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const market of ctx.markets) {
        if (market.borrowerHealth.length === 0) continue;

        let totalDebt = 0n;
        let unhealthyDebt = 0n;
        for (const borrower of market.borrowerHealth) {
          totalDebt += borrower.totalDebtBase;
          if (borrower.healthFactor < healthFactorThreshold)
            unhealthyDebt += borrower.totalDebtBase;
        }
        if (totalDebt <= 0n) continue;

        const shareNearLiquidation = Number(unhealthyDebt) / Number(totalDebt);
        const severity = severityAtLeast(shareNearLiquidation, thresholds);
        if (!severity) continue;

        signals.push({
          detectorId: D15_ID,
          family: 'collateral',
          subject: { kind: 'market', id: market.marketId },
          severity,
          value: shareNearLiquidation,
          threshold: thresholds[severity],
          evidence: {
            totalDebt,
            unhealthyDebt,
            healthFactorThreshold,
            trackedBorrowers: market.borrowerHealth.length,
            block: market.current.block,
          },
        });
      }
      return signals;
    },
  };
}
