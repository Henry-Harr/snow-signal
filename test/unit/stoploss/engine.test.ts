import { describe, expect, it } from 'vitest';

import { evaluateAllPositions, evaluateStopLoss } from '../../../src/stoploss/engine.js';
import type { PriceUpdate, WatchedPosition } from '../../../src/core/types.js';

function position(overrides: Partial<WatchedPosition> = {}): WatchedPosition {
  return {
    label: 'test',
    tokenId: '123',
    negRisk: false,
    shares: 1_000_000n, // 1.0 share in 6-decimal units
    stopPrice: 0.5,
    ...overrides,
  };
}

function price(overrides: Partial<PriceUpdate> = {}): PriceUpdate {
  return { tokenId: '123', bestBid: 0.6, bestAsk: 0.62, at: new Date(), ...overrides };
}

describe('evaluateStopLoss', () => {
  it('does not trigger when the bid is above the stop price', () => {
    expect(evaluateStopLoss(position({ stopPrice: 0.5 }), price({ bestBid: 0.6 }))).toBeUndefined();
  });

  it('triggers when the bid falls to exactly the stop price', () => {
    const trigger = evaluateStopLoss(position({ stopPrice: 0.5 }), price({ bestBid: 0.5 }));
    expect(trigger).toBeDefined();
    expect(trigger?.triggerPrice).toBe(0.5);
  });

  it('triggers when the bid falls below the stop price', () => {
    const trigger = evaluateStopLoss(position({ stopPrice: 0.5 }), price({ bestBid: 0.3 }));
    expect(trigger).toBeDefined();
  });

  it('ignores a price update for a different token', () => {
    expect(
      evaluateStopLoss(position({ tokenId: 'abc' }), price({ tokenId: 'xyz', bestBid: 0.1 })),
    ).toBeUndefined();
  });

  it('sells the full position by default', () => {
    const trigger = evaluateStopLoss(position({ shares: 1_000_000n }), price({ bestBid: 0.1 }));
    expect(trigger?.sellShares).toBe(1_000_000n);
  });

  it('sells only sellFraction of the position when configured', () => {
    const trigger = evaluateStopLoss(
      position({ shares: 1_000_000n, sellFraction: 0.5 }),
      price({ bestBid: 0.1 }),
    );
    expect(trigger?.sellShares).toBe(500_000n);
  });

  it('never triggers a zero-share sell', () => {
    const trigger = evaluateStopLoss(
      position({ shares: 1_000_000n, sellFraction: 0 }),
      price({ bestBid: 0.1 }),
    );
    expect(trigger).toBeUndefined();
  });
});

describe('evaluateAllPositions', () => {
  it('returns a trigger only for the positions whose stop price is crossed', () => {
    const positions = [
      position({ tokenId: 'a', stopPrice: 0.5 }),
      position({ tokenId: 'b', stopPrice: 0.9 }),
    ];
    const triggers = evaluateAllPositions(positions, price({ tokenId: 'a', bestBid: 0.4 }));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.position.tokenId).toBe('a');
  });
});
