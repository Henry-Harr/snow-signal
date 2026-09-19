import type { SentinelDatabase } from './db.js';
import type { LiquidationOpportunity } from '../liquidations/types.js';

export interface LiquidationOpportunityRecord extends LiquidationOpportunity {
  id: number;
}

interface LiquidationOpportunityRow {
  id: number;
  chain: string;
  market: string;
  user_address: string;
  at: string;
  block_number: string;
  health_factor: string;
  debt_asset: string;
  debt_symbol: string;
  debt_to_cover_base: string;
  collateral_asset: string;
  collateral_symbol: string;
  collateral_seized_base: string;
  liquidation_bonus: number;
  gross_profit_base: string;
}

function rowToRecord(row: LiquidationOpportunityRow): LiquidationOpportunityRecord {
  return {
    id: row.id,
    chain: row.chain as LiquidationOpportunity['chain'],
    market: row.market,
    user: row.user_address as LiquidationOpportunity['user'],
    atBlock: BigInt(row.block_number),
    atTimestamp: Math.floor(new Date(row.at).getTime() / 1000),
    healthFactor: BigInt(row.health_factor),
    debtAsset: row.debt_asset as LiquidationOpportunity['debtAsset'],
    debtSymbol: row.debt_symbol,
    debtToCoverBase: BigInt(row.debt_to_cover_base),
    collateralAsset: row.collateral_asset as LiquidationOpportunity['collateralAsset'],
    collateralSymbol: row.collateral_symbol,
    collateralSeizedBase: BigInt(row.collateral_seized_base),
    liquidationBonus: row.liquidation_bonus,
    grossProfitBase: BigInt(row.gross_profit_base),
  };
}

/** Append-only log for the liquidation scanner (docs/adr/0014, migration 13) — every
 * on-chain-confirmed opportunity a scan finds, kept purely as evidence, never
 * consumed by anything that acts on it. */
export class LiquidationOpportunityRepository {
  constructor(private readonly db: SentinelDatabase) {}

  record(opportunity: LiquidationOpportunity): number {
    const result = this.db
      .prepare(
        `INSERT INTO liquidation_opportunities
           (chain, market, user_address, at, block_number, health_factor, debt_asset,
            debt_symbol, debt_to_cover_base, collateral_asset, collateral_symbol,
            collateral_seized_base, liquidation_bonus, gross_profit_base)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opportunity.chain,
        opportunity.market,
        opportunity.user,
        new Date(opportunity.atTimestamp * 1000).toISOString(),
        opportunity.atBlock.toString(),
        opportunity.healthFactor.toString(),
        opportunity.debtAsset,
        opportunity.debtSymbol,
        opportunity.debtToCoverBase.toString(),
        opportunity.collateralAsset,
        opportunity.collateralSymbol,
        opportunity.collateralSeizedBase.toString(),
        opportunity.liquidationBonus,
        opportunity.grossProfitBase.toString(),
      );
    return Number(result.lastInsertRowid);
  }

  findRecent(limit = 50): LiquidationOpportunityRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM liquidation_opportunities ORDER BY at DESC LIMIT ?`)
      .all(limit) as LiquidationOpportunityRow[];
    return rows.map(rowToRecord);
  }
}
