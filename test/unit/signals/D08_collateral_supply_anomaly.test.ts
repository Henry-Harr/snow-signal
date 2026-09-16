import { describe, expect, it } from 'vitest';

import { createD08Detector, D08_ID } from '../../../src/signals/D08_collateral_supply_anomaly.js';
import {
  assetContext,
  block,
  detectorContext,
  marketContext,
  marketSnapshot,
  tokenSupplySnapshot,
} from './helpers.js';

const NOW = 1_700_010_000;
const HOUR = 3600;

function supplyHistory(baselineSupply: bigint, currentSupply: bigint) {
  return [
    tokenSupplySnapshot({ totalSupply: baselineSupply, block: block({ timestamp: NOW - HOUR }) }),
    tokenSupplySnapshot({ totalSupply: currentSupply, block: block({ timestamp: NOW }) }),
  ];
}

describe('D08 collateral supply anomaly', () => {
  const detector = createD08Detector();

  it('emits no signal for normal supply growth', () => {
    const ctx = detectorContext({
      assets: [assetContext({ supplyHistory: supplyHistory(1_000_000n, 1_005_000n) })],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits watch for a moderate rise', () => {
    const ctx = detectorContext({
      assets: [
        assetContext({ symbol: 'rsETH', supplyHistory: supplyHistory(1_000_000n, 1_030_000n) }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({
      detectorId: D08_ID,
      family: 'collateral',
      subject: { kind: 'asset', id: 'rsETH' },
      severity: 'watch',
    });
  });

  it('emits danger for a 5%+ rise with no matching borrow growth', () => {
    const ctx = detectorContext({
      assets: [assetContext({ supplyHistory: supplyHistory(1_000_000n, 1_100_000n) })],
      markets: [
        marketContext({
          current: marketSnapshot({ totalBorrowed: 500_000n, block: block({ timestamp: NOW }) }),
          history: [
            marketSnapshot({ totalBorrowed: 500_000n, block: block({ timestamp: NOW - HOUR }) }),
          ],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.severity).toBe('danger');
  });

  it('escalates to critical when the rise is paired with concurrent borrowing (the rsETH pattern)', () => {
    const ctx = detectorContext({
      assets: [assetContext({ supplyHistory: supplyHistory(1_000_000n, 1_100_000n) })],
      markets: [
        marketContext({
          current: marketSnapshot({ totalBorrowed: 600_000n, block: block({ timestamp: NOW }) }),
          history: [
            marketSnapshot({ totalBorrowed: 500_000n, block: block({ timestamp: NOW - HOUR }) }),
          ],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.severity).toBe('critical');
  });

  it('stays at danger (does not escalate) when borrowing did not grow (false-positive guard for the critical path)', () => {
    const ctx = detectorContext({
      assets: [assetContext({ supplyHistory: supplyHistory(1_000_000n, 1_100_000n) })],
      markets: [
        marketContext({
          current: marketSnapshot({ totalBorrowed: 400_000n, block: block({ timestamp: NOW }) }), // borrowing fell
          history: [
            marketSnapshot({ totalBorrowed: 500_000n, block: block({ timestamp: NOW - HOUR }) }),
          ],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.severity).toBe('danger');
  });

  it('does not fire without a baseline old enough to anchor the window (false-positive guard: thin history)', () => {
    const ctx = detectorContext({
      assets: [
        assetContext({
          supplyHistory: [
            tokenSupplySnapshot({ totalSupply: 1_000_000n, block: block({ timestamp: NOW - 60 }) }),
            tokenSupplySnapshot({ totalSupply: 2_000_000n, block: block({ timestamp: NOW }) }),
          ],
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });
});
