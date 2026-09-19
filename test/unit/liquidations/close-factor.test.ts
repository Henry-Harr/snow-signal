import { describe, expect, it } from 'vitest';

import {
  CLOSE_FACTOR_HF_THRESHOLD,
  MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD,
  maxLiquidatableFraction,
} from '../../../src/liquidations/close-factor.js';

const LARGE_POSITION = MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD * 10n;

describe('maxLiquidatableFraction', () => {
  it('allows 100% at or below the 0.95 health-factor threshold, for a large position', () => {
    expect(maxLiquidatableFraction(CLOSE_FACTOR_HF_THRESHOLD, LARGE_POSITION, LARGE_POSITION)).toBe(
      1,
    );
    expect(
      maxLiquidatableFraction(CLOSE_FACTOR_HF_THRESHOLD - 1n, LARGE_POSITION, LARGE_POSITION),
    ).toBe(1);
  });

  it('caps at 50% above the threshold when both collateral and debt clear the $2,000 bar', () => {
    expect(
      maxLiquidatableFraction(CLOSE_FACTOR_HF_THRESHOLD + 1n, LARGE_POSITION, LARGE_POSITION),
    ).toBe(0.5);
  });

  it('allows 100% above the threshold when the position is below the $2,000 bar (dust guard)', () => {
    const dust = MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD - 1n;
    expect(maxLiquidatableFraction(CLOSE_FACTOR_HF_THRESHOLD + 1n, dust, dust)).toBe(1);
  });

  it("requires both collateral AND debt to clear the bar, not just one", () => {
    expect(
      maxLiquidatableFraction(
        CLOSE_FACTOR_HF_THRESHOLD + 1n,
        LARGE_POSITION,
        MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD - 1n,
      ),
    ).toBe(1);
  });
});
