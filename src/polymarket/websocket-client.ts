import WebSocket from 'ws';

import { CLOB_WS_MARKET_URL } from './constants.js';
import type { PriceUpdate } from '../core/types.js';

/**
 * Real-time price feed — endpoint, subscription frame shape, heartbeat
 * requirement, and price-update message shape verified against
 * docs.polymarket.com/developers/CLOB/websocket/market-channel
 * (`src/polymarket/constants.ts` has the full citation).
 */
interface PriceChangeMessage {
  event_type: 'price_change';
  market: string;
  price_changes: {
    asset_id: string;
    price: string;
    size: string;
    side: 'BUY' | 'SELL';
    best_bid?: string;
    best_ask?: string;
  }[];
  timestamp: string;
}

function isPriceChangeMessage(value: unknown): value is PriceChangeMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { event_type?: unknown }).event_type === 'price_change'
  );
}

export interface MarketPriceFeedOptions {
  tokenIds: string[];
  onPrice: (update: PriceUpdate) => void;
  onError?: (err: Error) => void;
  url?: string;
}

/** Subscribes to `tokenIds` on the market-data channel and calls `onPrice` for
 * every price change carrying both `best_bid` and `best_ask` (the fields the
 * stop-loss engine needs — a change event without them isn't actionable here
 * and is silently skipped). Sends the required `PING` heartbeat every 10s per
 * the docs' own stated requirement; the connection is expected to be kept open
 * for the life of the process (the caller decides when to `close()`). */
export function startMarketPriceFeed(options: MarketPriceFeedOptions): { close: () => void } {
  const url = options.url ?? CLOB_WS_MARKET_URL;
  const ws = new WebSocket(url);
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  ws.on('open', () => {
    ws.send(JSON.stringify({ assets_ids: options.tokenIds, type: 'market' }));
    heartbeat = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send('PING');
    }, 10_000);
  });

  ws.on('message', (raw) => {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf-8')
      : Buffer.isBuffer(raw)
        ? raw.toString('utf-8')
        : Buffer.from(raw).toString('utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // e.g. a bare "PONG" text frame, not JSON — not an error
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const msg of messages) {
      if (!isPriceChangeMessage(msg)) continue;
      for (const change of msg.price_changes) {
        if (change.best_bid === undefined || change.best_ask === undefined) continue;
        options.onPrice({
          tokenId: change.asset_id,
          bestBid: Number(change.best_bid),
          bestAsk: Number(change.best_ask),
          at: new Date(Number(msg.timestamp)),
        });
      }
    }
  });

  ws.on('error', (err) => options.onError?.(err instanceof Error ? err : new Error(String(err))));

  return {
    close: () => {
      if (heartbeat) clearInterval(heartbeat);
      ws.close();
    },
  };
}
