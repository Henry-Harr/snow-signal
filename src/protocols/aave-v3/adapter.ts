import { encodeFunctionData, erc20Abi } from 'viem';
import { z } from 'zod';

import { aaveOracleAbi, poolAbi, poolAddressesProviderAbi, poolDataProviderAbi } from './abi.js';
import {
  resolveAaveV3Asset,
  resolveAaveV3Market,
  type AaveV3MarketAddresses,
} from './addresses.js';
import type { ContractCall, ContractReadClient } from '../../chain/client.js';
import type { RpcPool } from '../../chain/rpc-pool.js';
import { AdapterError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type {
  Address,
  BlockRef,
  ChainId,
  CollateralExposure,
  Log,
  MarketSnapshot,
  Position,
  ProtocolAdapter,
  ProtocolEvent,
  TxRequest,
  WithdrawEstimate,
} from '../../core/types.js';
import type { ContractCallResult } from '../../chain/client.js';

/** Narrows a multicall slot to its decoded value, throwing `AdapterError` if that
 * specific call reverted — every read site uses this instead of an inline
 * `status === 'failure'` check so TS can actually narrow `.result`'s type (a bare
 * `if (r.status === 'failure') throw` inside a loop over the whole array doesn't
 * narrow the other elements TS still sees as the union). */
function unwrap(result: ContractCallResult | undefined, context: string): unknown {
  if (!result) throw new AdapterError(`${context}: missing multicall result`);
  if (result.status === 'failure') throw new AdapterError(`${context}: ${result.error.message}`);
  return result.result;
}

/** `withdraw(asset, amount, to)`'s documented "withdraw everything" sentinel
 * (docs.aave.com / IPool.sol doc comment, verified 2026-09-16). */
export const WITHDRAW_MAX = 2n ** 256n - 1n;

export interface AaveV3AdapterOptions {
  chain: string;
  market: string;
  chainId: ChainId;
  /** Asset symbols (matching config `positions[].asset`, e.g. `"USDC"`) this adapter
   * instance watches within the pool. Aave v3 is one shared pool across every listed
   * reserve, not isolated per-asset markets, so the adapter needs to be told which
   * reserves the user actually holds a position in rather than discovering it. */
  watchedAssets: string[];
  pool: RpcPool<ContractReadClient>;
  logger?: Logger;
}

/** Raw per-reserve read, sanity-checked with zod before it's trusted (docs/SPEC.md
 * #6: "nothing external ... is trusted without a schema" applies to RPC responses,
 * not just config). Every field is a plain non-negative bigint/number — Aave never
 * returns a signed or negative reserve figure — so this mostly guards against a
 * misbehaving or malicious RPC provider returning a wrong *type*, not just a wrong
 * value (wrong values are what `RpcPool.quorumRead`'s two-provider agreement guards
 * against). */
const nonNegativeBigint = z.bigint().nonnegative();
const reserveDataSchema = z.tuple([
  nonNegativeBigint, // unbacked
  nonNegativeBigint, // accruedToTreasuryScaled
  nonNegativeBigint, // totalAToken
  nonNegativeBigint, // totalStableDebt
  nonNegativeBigint, // totalVariableDebt
  nonNegativeBigint, // liquidityRate (ray, 1e27)
  nonNegativeBigint, // variableBorrowRate (ray)
  nonNegativeBigint, // stableBorrowRate (ray)
  nonNegativeBigint, // averageStableBorrowRate (ray)
  nonNegativeBigint, // liquidityIndex (ray)
  nonNegativeBigint, // variableBorrowIndex (ray)
  z.number().int().nonnegative(), // lastUpdateTimestamp
]);

const reserveConfigSchema = z.tuple([
  nonNegativeBigint, // decimals
  nonNegativeBigint, // ltv (bps)
  nonNegativeBigint, // liquidationThreshold (bps)
  nonNegativeBigint, // liquidationBonus (bps)
  nonNegativeBigint, // reserveFactor (bps)
  z.boolean(), // usageAsCollateralEnabled
  z.boolean(), // borrowingEnabled
  z.boolean(), // stableBorrowRateEnabled
  z.boolean(), // isActive
  z.boolean(), // isFrozen
]);

const reserveCapsSchema = z.tuple([nonNegativeBigint, nonNegativeBigint]);
const reserveTokensSchema = z.tuple([addressSchema(), addressSchema(), addressSchema()]);

function addressSchema() {
  return z.string().regex(/^0x[a-fA-F0-9]{40}$/) as unknown as z.ZodType<Address>;
}

/** RAY, Aave's fixed-point unit for interest rates (1e27) — every rate field above is
 * in ray. Confirmed by the field-naming convention in `IPoolDataProvider.sol`
 * (`liquidityRate` etc. match the protocol-wide `WadRayMath` ray convention used
 * throughout `aave-v3-origin`); annualized APR = `rayValue / 1e27`. */
const RAY = 10n ** 27n;
const rayToNumber = (ray: bigint): number => Number(ray) / Number(RAY);

/** Aave v3 protocol adapter (docs/SPEC.md #6.2). One instance watches one pool
 * (`chain` + `market`, e.g. `ethereum` + `core`) across whichever reserves
 * `watchedAssets` names. */
export class AaveV3Adapter implements ProtocolAdapter {
  readonly id: string;
  private readonly chain: string;
  private readonly market: string;
  private readonly chainId: ChainId;
  private readonly watchedAssets: string[];
  private readonly pool: RpcPool<ContractReadClient>;
  private readonly logger: Logger | undefined;
  private readonly addresses: AaveV3MarketAddresses;
  private oracleCache: { blockNumber: bigint; address: Address } | undefined;

  constructor(options: AaveV3AdapterOptions) {
    this.id = `aave-v3:${options.chain}:${options.market}`;
    this.chain = options.chain;
    this.market = options.market;
    this.chainId = options.chainId;
    this.watchedAssets = options.watchedAssets;
    this.pool = options.pool;
    this.logger = options.logger;
    this.addresses = resolveAaveV3Market(options.chain, options.market);
  }

  private marketId(assetSymbol: string): string {
    return `${this.id}:${assetSymbol}`;
  }

  /** Resolves the market's price oracle on-chain (`Pool.ADDRESSES_PROVIDER()` →
   * `PoolAddressesProvider.getPriceOracle()`) instead of a hardcoded address, since
   * only `POOL`/`AAVE_PROTOCOL_DATA_PROVIDER` were independently re-verified this
   * session (docs/SOURCES.md). Cached per block number — the oracle address itself is
   * not decision-critical (only the *prices it returns* are, and those go through
   * `quorumRead` separately), so this is a best-effort read. */
  private async resolveOracle(at: BlockRef): Promise<Address> {
    if (this.oracleCache?.blockNumber === at.number) return this.oracleCache.address;

    const providerAddress = await this.pool.bestEffortRead(async (client) => {
      const [result] = await client.multicall(
        [{ address: this.addresses.pool, abi: poolAbi, functionName: 'ADDRESSES_PROVIDER' }],
        at.number,
      );
      return unwrap(result, `${this.id}: ADDRESSES_PROVIDER`) as Address;
    });

    const oracleAddress = await this.pool.bestEffortRead(async (client) => {
      const [result] = await client.multicall(
        [
          {
            address: providerAddress,
            abi: poolAddressesProviderAbi,
            functionName: 'getPriceOracle',
          },
        ],
        at.number,
      );
      return unwrap(result, `${this.id}: getPriceOracle`) as Address;
    });

    this.oracleCache = { blockNumber: at.number, address: oracleAddress };
    return oracleAddress;
  }

  async snapshotMarkets(marketIds: string[], at: BlockRef): Promise<MarketSnapshot[]> {
    const oracle = await this.resolveOracle(at);
    return Promise.all(marketIds.map((assetSymbol) => this.snapshotOne(assetSymbol, oracle, at)));
  }

  private async snapshotOne(
    assetSymbol: string,
    oracle: Address,
    at: BlockRef,
  ): Promise<MarketSnapshot> {
    const assetAddress = resolveAaveV3Asset(this.chain, assetSymbol);
    const dataProvider = this.addresses.poolDataProvider;

    const calls: ContractCall[] = [
      {
        address: dataProvider,
        abi: poolDataProviderAbi,
        functionName: 'getReserveData',
        args: [assetAddress],
      },
      {
        address: dataProvider,
        abi: poolDataProviderAbi,
        functionName: 'getReserveConfigurationData',
        args: [assetAddress],
      },
      {
        address: dataProvider,
        abi: poolDataProviderAbi,
        functionName: 'getReserveTokensAddresses',
        args: [assetAddress],
      },
      { address: oracle, abi: aaveOracleAbi, functionName: 'getAssetPrice', args: [assetAddress] },
      {
        address: dataProvider,
        abi: poolDataProviderAbi,
        functionName: 'getReserveCaps',
        args: [assetAddress],
      },
      {
        // Introduced in Aave v3.3 (docs/SOURCES.md); both watched markets run v3.7,
        // which carries it forward, so this is always expected to succeed for them.
        address: dataProvider,
        abi: poolDataProviderAbi,
        functionName: 'getReserveDeficit',
        args: [assetAddress],
      },
    ];

    // All five values are decision-critical (liquidity/supply/borrow figures, frozen
    // flag, oracle price — docs/SPEC.md #6.1) — quorum-read the whole batch together
    // rather than trusting one provider's multicall response.
    const results = await this.pool.quorumRead((client) => client.multicall(calls, at.number));
    const ctx = `${this.id}:${assetSymbol}`;

    const reserveData = reserveDataSchema.parse(unwrap(results[0], `${ctx} getReserveData`));
    const config = reserveConfigSchema.parse(
      unwrap(results[1], `${ctx} getReserveConfigurationData`),
    );
    const tokens = reserveTokensSchema.parse(
      unwrap(results[2], `${ctx} getReserveTokensAddresses`),
    );
    const price = z
      .bigint()
      .nonnegative()
      .parse(unwrap(results[3], `${ctx} getAssetPrice`));
    const caps = reserveCapsSchema.parse(unwrap(results[4], `${ctx} getReserveCaps`));
    const deficit = z
      .bigint()
      .nonnegative()
      .parse(unwrap(results[5], `${ctx} getReserveDeficit`));

    const [, , totalAToken, totalStableDebt, totalVariableDebt, liquidityRate, variableBorrowRate] =
      reserveData;
    const [, , , , , , , , isActive, isFrozen] = config;
    const [aTokenAddress] = tokens;

    // Ground-truth withdrawable buffer: the underlying tokens the aToken contract
    // actually holds, not the `totalAToken - totalDebt` accounting identity (docs/
    // SPEC.md #6.2 "available liquidity"; same call reused by `withdrawable()` below).
    const availableLiquidity = await this.readAvailableLiquidity(assetAddress, aTokenAddress, at);

    const totalBorrowed = totalStableDebt + totalVariableDebt;
    const utilization = totalAToken === 0n ? 0 : Number(totalBorrowed) / Number(totalAToken);

    return {
      marketId: this.marketId(assetSymbol),
      block: at,
      totalSupplied: totalAToken,
      totalBorrowed,
      availableLiquidity,
      utilization,
      supplyRate: rayToNumber(liquidityRate),
      borrowRate: rayToNumber(variableBorrowRate),
      flags: { paused: !isActive, frozen: isFrozen },
      oraclePrices: { [assetSymbol]: price },
      badDebt: deficit,
      raw: { reserveData, config, tokens, caps: { borrowCap: caps[0], supplyCap: caps[1] } },
    };
  }

  private async readAvailableLiquidity(
    assetAddress: Address,
    aTokenAddress: Address,
    at: BlockRef,
  ): Promise<bigint> {
    return this.pool.quorumRead(async (client) => {
      const [result] = await client.multicall(
        [
          {
            address: assetAddress,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [aTokenAddress],
          },
        ],
        at.number,
      );
      return unwrap(result, `${this.id}: underlying balanceOf(aToken)`) as bigint;
    });
  }

  /**
   * Coarse, protocol-level approximation per docs/adr/0001: every listed reserve's
   * share of total supplied (`totalAToken`) across the whole pool, as a proxy for its
   * share of the collateral base. Enumerates every reserve via `getReservesList()`
   * (best-effort — this is already an approximation, not a decision-critical exact
   * value, so it isn't worth doubling the RPC cost with a quorum read; the specific
   * watched reserve's own numbers from `snapshotMarkets` are quorum-read separately).
   */
  async collateralExposure(_marketId: string, at: BlockRef): Promise<CollateralExposure[]> {
    const reserves = await this.pool.bestEffortRead(async (client) => {
      const [result] = await client.multicall(
        [{ address: this.addresses.pool, abi: poolAbi, functionName: 'getReservesList' }],
        at.number,
      );
      return z.array(addressSchema()).parse(unwrap(result, `${this.id}: getReservesList`));
    });

    if (reserves.length === 0) return [];

    const supplied = await this.pool.bestEffortRead(async (client) => {
      const results = await client.multicall(
        reserves.map((asset) => ({
          address: this.addresses.poolDataProvider,
          abi: poolDataProviderAbi,
          functionName: 'getReserveData',
          args: [asset],
        })),
        at.number,
      );
      return results.map((r, i) =>
        r.status === 'success'
          ? { asset: reserves[i]!, totalAToken: reserveDataSchema.parse(r.result)[2] }
          : { asset: reserves[i]!, totalAToken: 0n },
      );
    });

    const total = supplied.reduce((sum, r) => sum + r.totalAToken, 0n);
    if (total === 0n) {
      return supplied.map((r) => ({
        marketId: this.id,
        asset: r.asset,
        shareOfCollateralBase: 0,
        method: 'approximate' as const,
        raw: { totalAToken: r.totalAToken },
      }));
    }

    return supplied.map((r) => ({
      marketId: this.id,
      asset: r.asset,
      shareOfCollateralBase: Number(r.totalAToken) / Number(total),
      method: 'approximate' as const,
      raw: { totalAToken: r.totalAToken },
    }));
  }

  async discoverPositions(owner: Address, at: BlockRef): Promise<Position[]> {
    const positions: Position[] = [];
    for (const assetSymbol of this.watchedAssets) {
      const assetAddress = resolveAaveV3Asset(this.chain, assetSymbol);
      const tokens = await this.pool.bestEffortRead(async (client) => {
        const [result] = await client.multicall(
          [
            {
              address: this.addresses.poolDataProvider,
              abi: poolDataProviderAbi,
              functionName: 'getReserveTokensAddresses',
              args: [assetAddress],
            },
          ],
          at.number,
        );
        return reserveTokensSchema.parse(
          unwrap(result, `${this.id}:${assetSymbol} getReserveTokensAddresses`),
        );
      });
      const [aTokenAddress] = tokens;

      const balance = await this.pool.quorumRead(async (client) => {
        const [result] = await client.multicall(
          [{ address: aTokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }],
          at.number,
        );
        return unwrap(result, `${this.id}:${assetSymbol} aToken balanceOf`) as bigint;
      });

      if (balance > 0n) {
        positions.push({
          id: `${this.marketId(assetSymbol)}:${owner}`,
          protocol: 'aave-v3',
          chainId: this.chainId,
          marketId: this.marketId(assetSymbol),
          owner,
          asset: assetAddress,
          balance,
        });
      }
    }
    return positions;
  }

  async withdrawable(position: Position, at: BlockRef): Promise<WithdrawEstimate> {
    const tokens = await this.pool.bestEffortRead(async (client) => {
      const [result] = await client.multicall(
        [
          {
            address: this.addresses.poolDataProvider,
            abi: poolDataProviderAbi,
            functionName: 'getReserveTokensAddresses',
            args: [position.asset],
          },
        ],
        at.number,
      );
      return reserveTokensSchema.parse(unwrap(result, `${this.id} withdrawable() reserve tokens`));
    });
    const [aTokenAddress] = tokens;

    const availableLiquidity = await this.readAvailableLiquidity(position.asset, aTokenAddress, at);
    const availableNow =
      availableLiquidity < position.balance ? availableLiquidity : position.balance;

    return {
      positionId: position.id,
      availableNow,
      totalPosition: position.balance,
    };
  }

  buildWithdraw(position: Position, amount: bigint | 'max', recipient: Address): TxRequest {
    const withdrawAmount = amount === 'max' ? WITHDRAW_MAX : amount;
    return {
      chainId: this.chainId,
      to: this.addresses.pool,
      data: encodeFunctionData({
        abi: poolAbi,
        functionName: 'withdraw',
        args: [position.asset, withdrawAmount, recipient],
      }),
      description: `Aave v3 (${this.chain}:${this.market}) withdraw ${
        amount === 'max' ? 'max' : withdrawAmount.toString()
      } of ${position.asset} to ${recipient}`,
    };
  }

  decodeEvents(logs: Log[]): ProtocolEvent[] {
    return logs.map((log) => ({
      protocol: 'aave-v3',
      chainId: this.chainId,
      marketId: this.id,
      eventName: log.eventName,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      args: log.args,
    }));
  }
}
