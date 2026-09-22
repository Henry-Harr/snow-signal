import type { PriceUpdate, WatchedPosition } from '../core/types.js';

/**
 * Pure stop-loss trigger logic — no I/O, easy to test exhaustively without a
 * live price feed or a real order client. Polymarket's CLOB has no native
 * stop-loss/conditional order type (verified against the real order-type list —
 * GTC/GTD/FAK/FOK only, `src/polymarket/constants.ts`), so this is the actual
 * stop-loss: continuously compare the live best bid against the configured
 * `stopPrice` and decide when to sell.
 */
export interface StopLossTrigger {
  position: WatchedPosition;
  triggerPrice: number;
  sellShares: bigint;
}

/** Triggers when the position's own token's best bid falls to or below
 * `stopPrice` — using the bid (what you could actually sell into right now),
 * not the ask, since that's the real, achievable exit price for a seller. */
export function evaluateStopLoss(
  position: WatchedPosition,
  price: PriceUpdate,
): StopLossTrigger | undefined {
  if (price.tokenId !== position.tokenId) return undefined;
  if (price.bestBid > position.stopPrice) return undefined;

  const fraction = position.sellFraction ?? 1;
  const sellShares = (position.shares * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
  if (sellShares <= 0n) return undefined;

  return { position, triggerPrice: price.bestBid, sellShares };
}

export function evaluateAllPositions(
  positions: WatchedPosition[],
  price: PriceUpdate,
): StopLossTrigger[] {
  const triggers: StopLossTrigger[] = [];
  for (const position of positions) {
    const trigger = evaluateStopLoss(position, price);
    if (trigger) triggers.push(trigger);
  }
  return triggers;
}
