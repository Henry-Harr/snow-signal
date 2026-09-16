import { describe, expect, it } from 'vitest';

import {
  createD15Detector,
  D15_HEALTH_FACTOR_SCALE,
  D15_ID,
} from '../../../src/signals/D15_debt_near_liquidation.js';
import { addr, borrowerHealth, detectorContext, marketContext } from './helpers.js';

const HEALTHY = 2n * D15_HEALTH_FACTOR_SCALE; // 2.0
const UNHEALTHY = (104n * D15_HEALTH_FACTOR_SCALE) / 100n; // 1.04, below the 1.05 threshold

describe('D15 debt near liquidation', () => {
  const detector = createD15Detector();

  it('emits no signal when no borrowers are tracked', () => {
    const ctx = detectorContext({ markets: [marketContext({ borrowerHealth: [] })] });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits no signal when every tracked borrower is healthy', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          borrowerHealth: [
            borrowerHealth({ holder: addr('01'), totalDebtBase: 100n, healthFactor: HEALTHY }),
            borrowerHealth({ holder: addr('02'), totalDebtBase: 100n, healthFactor: HEALTHY }),
          ],
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits watch at the borderline 20% share', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          marketId: 'm1',
          borrowerHealth: [
            borrowerHealth({ holder: addr('01'), totalDebtBase: 20n, healthFactor: UNHEALTHY }),
            borrowerHealth({ holder: addr('02'), totalDebtBase: 80n, healthFactor: HEALTHY }),
          ],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({
      detectorId: D15_ID,
      family: 'collateral',
      subject: { kind: 'market', id: 'm1' },
      severity: 'watch',
      value: 0.2,
    });
  });

  it('emits critical when most tracked debt is unhealthy', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          borrowerHealth: [
            borrowerHealth({ holder: addr('01'), totalDebtBase: 70n, healthFactor: UNHEALTHY }),
            borrowerHealth({ holder: addr('02'), totalDebtBase: 30n, healthFactor: HEALTHY }),
          ],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.severity).toBe('critical');
  });

  it('treats a health factor exactly at the threshold as healthy (strict less-than)', () => {
    const exactlyAtThreshold = (105n * D15_HEALTH_FACTOR_SCALE) / 100n;
    const ctx = detectorContext({
      markets: [
        marketContext({
          borrowerHealth: [
            borrowerHealth({
              holder: addr('01'),
              totalDebtBase: 100n,
              healthFactor: exactlyAtThreshold,
            }),
          ],
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('does not let a zero-debt entry skew the share either way (false-positive guard)', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          borrowerHealth: [
            // A tracked address with no actual debt (Aave's "no debt" sentinel
            // health factor, max uint256) contributes 0 to both sides of the ratio.
            borrowerHealth({
              holder: addr('01'),
              totalDebtBase: 0n,
              healthFactor: 2n ** 256n - 1n,
            }),
            borrowerHealth({ holder: addr('02'), totalDebtBase: 100n, healthFactor: UNHEALTHY }),
          ],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.value).toBe(1); // 100/100 — the zero-debt entry doesn't dilute the share
  });
});
