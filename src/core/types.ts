export type OrderSide = 'BUY' | 'SELL';

/** A configured position this bot protects with a stop-loss — you acquire the
 * underlying YES/NO shares yourself (manually, or elsewhere); this bot only
 * manages the downside exit. */
export interface WatchedPosition {
  /** A human label, for logs/alerts only. */
  label: string;
  /** The CTF ERC1155 token id (as a decimal string — it's a uint256) for the
   * specific outcome share you hold, e.g. the "YES" token of a market. */
  tokenId: string;
  /** Whether this market settles through the standard CTF Exchange or the
   * Neg Risk CTF Exchange — determines which contract address orders are signed
   * against (`src/polymarket/constants.ts`). Multi-outcome ("neg risk") markets
   * use the Neg Risk exchange; simple binary markets use the standard one. */
  negRisk: boolean;
  /** Number of shares you hold, in the CLOB's 6-decimal integer units. */
  shares: bigint;
  /** Sell when the best bid price falls to or below this fraction (0-1). */
  stopPrice: number;
  /** Fraction of `shares` to sell when triggered (1 = full exit). Defaults to 1
   * if omitted. */
  sellFraction?: number;
}

export interface PriceUpdate {
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  at: Date;
}

export type ExecutionMode = 'paper' | 'live';
