import type { Address } from '../core/types.js';

/**
 * Liquidation scanner types (docs/adr/0014-liquidation-scanner.md). Detection-only:
 * this module never submits a transaction — it logs theoretical opportunities so
 * their real frequency/profitability can be evidenced before any execution logic is
 * built, the same paper-before-live discipline the rest of this project follows.
 */

/** A borrower with an active debt position on a watched Aave v3 market, discovered
 * via the official subgraph (`src/liquidations/subgraph.ts`) — a *candidate* only,
 * not yet confirmed against real on-chain state. */
export interface LiquidationCandidate {
  user: Address;
}

/** The single largest debt reserve and single largest collateral reserve for a
 * borrower — the simplification real liquidation bots use (repay the reserve with
 * the most value, seize the reserve with the most value) rather than optimizing
 * across every reserve combination, which real profit rarely rewards once gas and
 * DEX slippage are accounted for. */
export interface BorrowerReservePosition {
  user: Address;
  healthFactor: bigint; // Aave HEALTH_FACTOR_SCALE (1e18)
  totalCollateralBase: bigint; // oracle base-currency units (1e8, see abi.ts)
  totalDebtBase: bigint;
  largestDebtReserve: {
    asset: Address;
    symbol: string;
    debtAmount: bigint; // raw asset units
    debtValueBase: bigint;
  };
  largestCollateralReserve: {
    asset: Address;
    symbol: string;
    aTokenBalance: bigint; // raw asset units
    collateralValueBase: bigint;
    liquidationBonus: number; // fraction, e.g. 0.05 for a 5% bonus
  };
}

export interface LiquidationOpportunity {
  chain: 'ethereum' | 'base';
  market: string; // e.g. 'core'
  user: Address;
  atBlock: bigint;
  atTimestamp: number;
  healthFactor: bigint;
  debtAsset: Address;
  debtSymbol: string;
  debtToCoverBase: bigint; // what a liquidator would actually repay, base currency
  collateralAsset: Address;
  collateralSymbol: string;
  collateralSeizedBase: bigint; // value of collateral received, base currency
  liquidationBonus: number;
  /** `collateralSeizedBase - debtToCoverBase` — the gross profit before gas and any
   * DEX slippage converting seized collateral back to the debt asset. Deliberately
   * not netted further here (see this module's ADR): gas/slippage estimation needs
   * real routing data this detection-only pass doesn't collect. */
  grossProfitBase: bigint;
}
