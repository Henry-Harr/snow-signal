/**
 * Aave v3's liquidation close-factor rule (docs/SOURCES.md's liquidation-scanner
 * entry): how much of a borrower's debt in a given reserve a liquidator may repay in
 * one call. Verified against the official aave-dao/aave-v3-origin repo's
 * `LiquidationLogic.sol` (raw.githubusercontent.com, `main` branch, fetched
 * 2026-09-19) — constants and conditional reproduced from that source, not
 * reimplemented from memory (safety rule 6).
 *
 * Rule: if the borrower's health factor is at or below `CLOSE_FACTOR_HF_THRESHOLD`
 * (0.95), the *entire* debt in that reserve is liquidatable. Otherwise (health
 * factor strictly between the threshold and 1.0 — liquidation is only possible at
 * all below 1.0), liquidation is capped at `DEFAULT_LIQUIDATION_CLOSE_FACTOR` (50%)
 * of that reserve's debt, but only once both the borrower's *total* collateral and
 * *total* debt (in oracle base-currency units) are at or above
 * `MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD` ($2,000 equivalent, 8-decimal oracle base
 * units) — below that, the whole position is small enough that 100% remains
 * liquidatable regardless of health factor, so dust positions don't get stuck
 * un-liquidatable at 50% forever.
 *
 * This is a simplification for a detection-only estimate, not a transaction-ready
 * implementation: the real contract's `MIN_LEFTOVER_BASE` edge case (avoiding a
 * liquidation that would leave a economically-meaningless debt remainder) isn't
 * modeled here. Before any real execution is ever built on this module, the exact
 * on-chain result should be confirmed via fork simulation (this project's own
 * "simulate before trusting a number" standard, safety rule 5) rather than trusted
 * from this approximation.
 */

export const CLOSE_FACTOR_HF_THRESHOLD = 950_000_000_000_000_000n; // 0.95e18
export const MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD = 200_000_000_000n; // 2000e8
const DEFAULT_LIQUIDATION_CLOSE_FACTOR = 0.5;

/** The fraction (0-1) of `debtValueBase` (this specific reserve's debt, in oracle
 * base-currency units) a liquidator may repay in one call, given the borrower's
 * overall health factor and total collateral/debt. */
export function maxLiquidatableFraction(
  healthFactor: bigint,
  totalCollateralBase: bigint,
  totalDebtBase: bigint,
): number {
  if (healthFactor <= CLOSE_FACTOR_HF_THRESHOLD) return 1;
  if (
    totalCollateralBase >= MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD &&
    totalDebtBase >= MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD
  ) {
    return DEFAULT_LIQUIDATION_CLOSE_FACTOR;
  }
  return 1;
}
