import { fetchAaveBorrowerHealth, HEALTH_FACTOR_SCALE } from '../watchers/large-holders.js';
import type { ContractReadClient } from '../chain/client.js';
import type { RpcPool } from '../chain/rpc-pool.js';
import type { Address, BlockRef } from '../core/types.js';
import { fetchMarketReserves, fetchUserReserves, type ReserveInfo } from './aave-reserves.js';
import { estimateLiquidationProfit } from './profit.js';
import { fetchLiquidationCandidates, type SubgraphConfig } from './subgraph.js';
import type { LiquidationOpportunity } from './types.js';

/**
 * Liquidation scanner orchestration (docs/adr/0014-liquidation-scanner.md):
 * subgraph for cheap candidate discovery, then real on-chain reads for everything
 * that actually matters — same two-tier discipline the rest of this project uses
 * (a signal source that isn't independently verified never drives a real number).
 * Detection only: returns opportunities to log, never touches a private key or
 * sends a transaction.
 */

export interface ScanMarketOptions {
  chain: 'ethereum' | 'base';
  market: string;
  poolAddress: Address;
  poolDataProviderAddress: Address;
  subgraph: SubgraphConfig;
  at: BlockRef;
  /** Borrowers per `getUserAccountData` multicall batch — kept well under typical
   * RPC/gas response-size limits rather than one giant call for every candidate. */
  healthCheckBatchSize?: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function largestReserve<T extends { valueBase: bigint }>(candidates: T[]): T | undefined {
  return candidates.reduce<T | undefined>(
    (best, r) => (best === undefined || r.valueBase > best.valueBase ? r : best),
    undefined,
  );
}

async function buildOpportunity(
  pool: RpcPool<ContractReadClient>,
  options: ScanMarketOptions,
  reserves: ReserveInfo[],
  user: Address,
  healthFactor: bigint,
  totalCollateralBase: bigint,
  totalDebtBase: bigint,
): Promise<LiquidationOpportunity | undefined> {
  const userReserves = await fetchUserReserves(
    pool,
    options.poolDataProviderAddress,
    reserves,
    user,
    options.at,
  );

  const debtCandidates = userReserves
    .map((ur, i) => {
      const reserve = reserves[i]!;
      const debtAmount = ur.currentVariableDebt + ur.currentStableDebt;
      if (debtAmount === 0n) return undefined;
      const valueBase = (debtAmount * reserve.priceBase) / 10n ** BigInt(reserve.decimals);
      return { reserve, debtAmount, valueBase };
    })
    .filter((c): c is NonNullable<typeof c> => c !== undefined);

  const collateralCandidates = userReserves
    .map((ur, i) => {
      const reserve = reserves[i]!;
      if (!ur.usageAsCollateralEnabled || ur.currentATokenBalance === 0n) return undefined;
      const valueBase = (ur.currentATokenBalance * reserve.priceBase) / 10n ** BigInt(reserve.decimals);
      return { reserve, aTokenBalance: ur.currentATokenBalance, valueBase };
    })
    .filter((c): c is NonNullable<typeof c> => c !== undefined);

  const largestDebt = largestReserve(debtCandidates);
  const largestCollateral = largestReserve(collateralCandidates);
  if (!largestDebt || !largestCollateral) return undefined; // stale subgraph data, or fully closed since

  const profit = estimateLiquidationProfit({
    healthFactor,
    totalCollateralBase,
    totalDebtBase,
    debtReserveValueBase: largestDebt.valueBase,
    collateralReserveValueBase: largestCollateral.valueBase,
    liquidationBonus: largestCollateral.reserve.liquidationBonus,
  });

  return {
    chain: options.chain,
    market: options.market,
    user,
    atBlock: options.at.number,
    atTimestamp: options.at.timestamp,
    healthFactor,
    debtAsset: largestDebt.reserve.asset,
    debtSymbol: largestDebt.reserve.symbol,
    debtToCoverBase: profit.debtToCoverBase,
    collateralAsset: largestCollateral.reserve.asset,
    collateralSymbol: largestCollateral.reserve.symbol,
    collateralSeizedBase: profit.collateralSeizedBase,
    liquidationBonus: largestCollateral.reserve.liquidationBonus,
    grossProfitBase: profit.grossProfitBase,
  };
}

export async function scanMarketForLiquidations(
  pool: RpcPool<ContractReadClient>,
  options: ScanMarketOptions,
): Promise<LiquidationOpportunity[]> {
  const candidates = await fetchLiquidationCandidates(options.subgraph);
  if (candidates.length === 0) return [];

  const reserves = await fetchMarketReserves(
    pool,
    options.poolAddress,
    options.poolDataProviderAddress,
    options.at,
  );

  const batchSize = options.healthCheckBatchSize ?? 200;
  const liquidatable: { user: Address; healthFactor: bigint; totalCollateralBase: bigint; totalDebtBase: bigint }[] =
    [];
  for (const batch of chunk(candidates.map((c) => c.user), batchSize)) {
    const health = await fetchAaveBorrowerHealth(pool, options.poolAddress, batch, options.at);
    for (const h of health) {
      // healthFactor < 1.0 (HEALTH_FACTOR_SCALE) is Aave's own liquidation-eligible
      // condition; the `type(uint256).max` "no debt" sentinel (verified
      // 2026-09-16, large-holders.ts) is always far above scale, so it's already
      // excluded by this comparison without a separate check.
      if (h.healthFactor < HEALTH_FACTOR_SCALE) {
        liquidatable.push({
          user: h.holder,
          healthFactor: h.healthFactor,
          totalCollateralBase: h.totalCollateralBase,
          totalDebtBase: h.totalDebtBase,
        });
      }
    }
  }

  const opportunities: LiquidationOpportunity[] = [];
  for (const b of liquidatable) {
    const opportunity = await buildOpportunity(
      pool,
      options,
      reserves,
      b.user,
      b.healthFactor,
      b.totalCollateralBase,
      b.totalDebtBase,
    );
    if (opportunity) opportunities.push(opportunity);
  }
  return opportunities;
}
