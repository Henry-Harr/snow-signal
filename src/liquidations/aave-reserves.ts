import { erc20Abi } from 'viem';

import {
  poolAbi,
  poolDataProviderAbi,
  aaveOracleAbi,
  poolAddressesProviderAbi,
} from '../protocols/aave-v3/abi.js';
import type { ContractCallResult, ContractReadClient } from '../chain/client.js';
import type { RpcPool } from '../chain/rpc-pool.js';
import { AdapterError } from '../core/errors.js';
import type { Address, BlockRef } from '../core/types.js';

/**
 * Market-wide Aave v3 reserve data the liquidation scanner needs (per-reserve
 * config, price, symbol) — fetched once per scan, not once per candidate borrower,
 * since none of it depends on the user. Reuses `getReservesList()` (already
 * verified, `poolAbi`) for the *complete* reserve set, rather than this project's
 * existing `AAVE_V3_ASSETS` registry, which is deliberately scoped to only the
 * assets Sentinel's core watchdog cares about (USDC) — a liquidation scanner needs
 * every reserve a borrower could hold collateral or debt in, most of which aren't
 * in that registry.
 */
export interface ReserveInfo {
  asset: Address;
  symbol: string;
  decimals: number;
  liquidationBonus: number; // fraction, e.g. 0.05 for Aave's raw 10500 (105.00%)
  usageAsCollateralEnabled: boolean;
  priceBase: bigint; // oracle base-currency units (1e8 for the watched markets)
}

function unwrap(result: ContractCallResult | undefined, context: string): unknown {
  if (!result) throw new AdapterError(`${context}: missing multicall result`);
  if (result.status === 'failure') throw new AdapterError(`${context}: ${result.error.message}`);
  return result.result;
}

export async function fetchMarketReserves(
  pool: RpcPool<ContractReadClient>,
  poolAddress: Address,
  poolDataProviderAddress: Address,
  at: BlockRef,
): Promise<ReserveInfo[]> {
  // Oracle *address* resolution and the reserve list are structural, not
  // price-critical (same reasoning `AaveV3Adapter.resolveOracle` already uses) —
  // only the prices/config actually feeding the profit estimate below go through
  // `quorumRead`.
  const providerAddress = await pool.bestEffortRead(async (client) => {
    const [result] = await client.multicall(
      [{ address: poolAddress, abi: poolAbi, functionName: 'ADDRESSES_PROVIDER' }],
      at.number,
    );
    return unwrap(result, 'fetchMarketReserves: ADDRESSES_PROVIDER') as Address;
  });
  const oracleAddress = await pool.bestEffortRead(async (client) => {
    const [result] = await client.multicall(
      [{ address: providerAddress, abi: poolAddressesProviderAbi, functionName: 'getPriceOracle' }],
      at.number,
    );
    return unwrap(result, 'fetchMarketReserves: getPriceOracle') as Address;
  });
  const reservesList = await pool.bestEffortRead(async (client) => {
    const [result] = await client.multicall(
      [{ address: poolAddress, abi: poolAbi, functionName: 'getReservesList' }],
      at.number,
    );
    return unwrap(result, 'fetchMarketReserves: getReservesList') as Address[];
  });

  return pool.quorumRead(async (client) => {
    const pricesResult = await client.multicall(
      [{ address: oracleAddress, abi: aaveOracleAbi, functionName: 'getAssetsPrices', args: [reservesList] }],
      at.number,
    );
    const prices = unwrap(pricesResult[0], 'fetchMarketReserves: getAssetsPrices') as bigint[];

    const configResults = await client.multicall(
      reservesList.map((asset) => ({
        address: poolDataProviderAddress,
        abi: poolDataProviderAbi,
        functionName: 'getReserveConfigurationData',
        args: [asset],
      })),
      at.number,
    );
    const symbolResults = await client.multicall(
      reservesList.map((asset) => ({ address: asset, abi: erc20Abi, functionName: 'symbol', args: [] })),
      at.number,
    );

    return reservesList.map((asset, i) => {
      const config = unwrap(configResults[i], `fetchMarketReserves:${asset}`) as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
      ];
      const [decimals, , , liquidationBonus, , usageAsCollateralEnabled] = config;
      const symbolResult = symbolResults[i];
      const symbol =
        symbolResult && symbolResult.status === 'success' ? (symbolResult.result as string) : asset;

      return {
        asset,
        symbol,
        decimals: Number(decimals),
        // Aave's raw liquidationBonus is a percentage scaled by 1e4 where 100.00%
        // (10000) means "no bonus" — e.g. 10500 = 105.00% = a 5% bonus. Converted
        // here so callers work with a plain fraction (0.05), not the raw offset
        // encoding.
        liquidationBonus: Number(liquidationBonus) / 10_000 - 1,
        usageAsCollateralEnabled,
        priceBase: prices[i] ?? 0n,
      };
    });
  });
}

export interface UserReserveRaw {
  asset: Address;
  currentATokenBalance: bigint;
  currentVariableDebt: bigint;
  currentStableDebt: bigint;
  usageAsCollateralEnabled: boolean;
}

/** Per-reserve collateral/debt balances for one borrower, across every reserve in
 * the market — `getUserAccountData` only gives account-wide totals (docs/SPEC.md's
 * D15 note), so finding *which* reserve to repay/seize needs this. */
export async function fetchUserReserves(
  pool: RpcPool<ContractReadClient>,
  poolDataProviderAddress: Address,
  reserves: ReserveInfo[],
  user: Address,
  at: BlockRef,
): Promise<UserReserveRaw[]> {
  return pool.quorumRead(async (client) => {
    const results = await client.multicall(
      reserves.map((r) => ({
        address: poolDataProviderAddress,
        abi: poolDataProviderAbi,
        functionName: 'getUserReserveData',
        args: [r.asset, user],
      })),
      at.number,
    );
    return reserves.map((r, i) => {
      const raw = unwrap(results[i], `fetchUserReserves:${user}:${r.asset}`) as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        number,
        boolean,
      ];
      const [currentATokenBalance, currentStableDebt, currentVariableDebt, , , , , , usageAsCollateralEnabled] =
        raw;
      return {
        asset: r.asset,
        currentATokenBalance,
        currentVariableDebt,
        currentStableDebt,
        usageAsCollateralEnabled,
      };
    });
  });
}
