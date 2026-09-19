import { maxLiquidatableFraction } from './close-factor.js';

/**
 * Theoretical liquidation profit estimate (docs/adr/0014-liquidation-scanner.md) —
 * gross only, in oracle base-currency units (8 decimals, matching
 * `getUserAccountData`/`getReserveConfigurationData`). Deliberately does not
 * subtract gas or DEX slippage: this detection-only pass has no real routing data
 * for either, and folding in a guessed number would misrepresent an estimate as a
 * measurement — exactly what safety rule 6 exists to prevent. Consumers should treat
 * `grossProfitBase` as an upper bound, not a number to act on directly.
 */
export interface ProfitEstimateInput {
  healthFactor: bigint;
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  /** This specific reserve's debt value, in oracle base-currency units. */
  debtReserveValueBase: bigint;
  /** This specific reserve's collateral value available to seize, in oracle
   * base-currency units — the liquidator can never seize more than the borrower
   * actually holds in that reserve, however large the close factor allows. */
  collateralReserveValueBase: bigint;
  /** e.g. `0.05` for Aave's `liquidationBonus` of 10500 (105.00%, meaning a 5%
   * bonus) — already converted from the raw `getReserveConfigurationData` bps-like
   * unit by the caller. */
  liquidationBonus: number;
}

export interface ProfitEstimate {
  debtToCoverBase: bigint;
  collateralSeizedBase: bigint;
  grossProfitBase: bigint;
}

/** `debtToCover` is capped by both the close-factor rule and by how much collateral
 * value actually exists to seize (the bonus-inflated seizure can't exceed what the
 * borrower holds in that reserve) — whichever binds first. */
export function estimateLiquidationProfit(input: ProfitEstimateInput): ProfitEstimate {
  const fraction = maxLiquidatableFraction(
    input.healthFactor,
    input.totalCollateralBase,
    input.totalDebtBase,
  );

  const closeFactorLimitedDebt = bigintMulFraction(input.debtReserveValueBase, fraction);
  // How much debt could be repaid if the only constraint were "don't seize more
  // collateral than exists": collateralAvailable = debtToCover * (1 + bonus), so
  // debtToCover = collateralAvailable / (1 + bonus).
  const collateralLimitedDebt = bigintDivByOnePlusFraction(
    input.collateralReserveValueBase,
    input.liquidationBonus,
  );

  const debtToCoverBase =
    closeFactorLimitedDebt < collateralLimitedDebt ? closeFactorLimitedDebt : collateralLimitedDebt;
  const collateralSeizedBase = bigintMulFraction(debtToCoverBase, 1 + input.liquidationBonus);

  return {
    debtToCoverBase,
    collateralSeizedBase,
    grossProfitBase: collateralSeizedBase - debtToCoverBase,
  };
}

/** `value * fraction`, rounded down, without floating-point error on the bigint
 * itself — `fraction` (a plain `number`) is scaled to an integer first so the only
 * floating-point step is computing that scale factor, not the (potentially huge)
 * base-currency value. */
function bigintMulFraction(value: bigint, fraction: number): bigint {
  const scaled = BigInt(Math.round(fraction * 1e6));
  return (value * scaled) / 1_000_000n;
}

function bigintDivByOnePlusFraction(value: bigint, bonusFraction: number): bigint {
  const scaled = BigInt(Math.round((1 + bonusFraction) * 1e6));
  return (value * 1_000_000n) / scaled;
}
