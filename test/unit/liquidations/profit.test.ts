import { describe, expect, it } from 'vitest';

import { estimateLiquidationProfit } from '../../../src/liquidations/profit.js';
import { CLOSE_FACTOR_HF_THRESHOLD } from '../../../src/liquidations/close-factor.js';

const BASE_UNIT = 100_000_000n; // 1e8, oracle base-currency units

describe('estimateLiquidationProfit', () => {
  it('is close-factor limited when collateral is plentiful relative to debt', () => {
    // HF above threshold, large position -> 50% close factor.
    const result = estimateLiquidationProfit({
      healthFactor: CLOSE_FACTOR_HF_THRESHOLD + 1n,
      totalCollateralBase: BASE_UNIT * 10_000n,
      totalDebtBase: BASE_UNIT * 10_000n,
      debtReserveValueBase: BASE_UNIT * 1_000n, // $1,000 debt in this reserve
      collateralReserveValueBase: BASE_UNIT * 10_000n, // plenty of collateral
      liquidationBonus: 0.05,
    });
    // 50% of $1,000 = $500 repaid, seizing $500 * 1.05 = $525.
    expect(result.debtToCoverBase).toBe(BASE_UNIT * 500n);
    expect(result.collateralSeizedBase).toBe(BASE_UNIT * 525n);
    expect(result.grossProfitBase).toBe(BASE_UNIT * 25n);
  });

  it('is collateral limited when the reserve does not hold enough to seize', () => {
    // HF at threshold -> 100% close factor, but collateral in this reserve is thin.
    const result = estimateLiquidationProfit({
      healthFactor: CLOSE_FACTOR_HF_THRESHOLD,
      totalCollateralBase: BASE_UNIT * 10_000n,
      totalDebtBase: BASE_UNIT * 10_000n,
      debtReserveValueBase: BASE_UNIT * 1_000n,
      collateralReserveValueBase: BASE_UNIT * 105n, // only $105 of this collateral
      liquidationBonus: 0.05,
    });
    // debtToCover * 1.05 <= 105 -> debtToCover <= 100.
    expect(result.debtToCoverBase).toBe(BASE_UNIT * 100n);
    expect(result.collateralSeizedBase).toBe(BASE_UNIT * 105n);
    expect(result.grossProfitBase).toBe(BASE_UNIT * 5n);
  });

  it('never seizes more collateral value than exists in the reserve', () => {
    const result = estimateLiquidationProfit({
      healthFactor: CLOSE_FACTOR_HF_THRESHOLD, // 100% close factor
      totalCollateralBase: BASE_UNIT * 100_000n,
      totalDebtBase: BASE_UNIT * 100_000n,
      debtReserveValueBase: BASE_UNIT * 100_000n, // huge debt in this reserve
      collateralReserveValueBase: BASE_UNIT * 1_000n, // small collateral reserve
      liquidationBonus: 0.1,
    });
    expect(result.collateralSeizedBase).toBeLessThanOrEqual(BASE_UNIT * 1_000n);
  });
});
