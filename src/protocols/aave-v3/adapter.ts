import { decodeEventLog, encodeFunctionData } from 'viem';

import { AAVE_RAY, AAVE_WITHDRAW_MAX, oracleAbi, poolAbi, protocolDataProviderAbi } from './abi.js';
import type {
  ContractReader,
  MulticallCall,
  MulticallResult,
} from '../../chain/contract-reader.js';
import type {
  Address,
  BlockRef,
  CollateralExposure,
  MarketSnapshot,
  Position,
  ProtocolAdapter,
  ProtocolEvent,
  RawLog,
  TxRequest,
  WithdrawEstimate,
} from '../../core/types.js';

export interface AaveV3AdapterAddresses {
  pool: Address;
  protocolDataProvider: Address;
  oracle: Address;
}

export interface AaveV3AdapterOptions {
  id: string;
  chainId: number;
  addresses: AaveV3AdapterAddresses;
  reader: ContractReader;
}

function unwrap<T>(result: MulticallResult, context: string): T {
  if (result.status === 'failure') {
    throw new Error(`Aave v3 read failed (${context}): ${result.error.message}`);
  }
  return result.result as T;
}

/** Like `unwrap`, but returns `undefined` on failure instead of throwing — for calls
 * that are expected to revert on some deployments (e.g. `getReserveDeficit` predates
 * Aave v3.3). */
function unwrapOptional<T>(result: MulticallResult): T | undefined {
  return result.status === 'success' ? (result.result as T) : undefined;
}

type ReserveData = readonly [
  unbacked: bigint,
  accruedToTreasuryScaled: bigint,
  totalAToken: bigint,
  totalStableDebt: bigint,
  totalVariableDebt: bigint,
  liquidityRate: bigint,
  variableBorrowRate: bigint,
  stableBorrowRate: bigint,
  averageStableBorrowRate: bigint,
  liquidityIndex: bigint,
  variableBorrowIndex: bigint,
  lastUpdateTimestamp: number,
];

type ReserveConfigurationData = readonly [
  decimals: bigint,
  ltv: bigint,
  liquidationThreshold: bigint,
  liquidationBonus: bigint,
  reserveFactor: bigint,
  usageAsCollateralEnabled: boolean,
  borrowingEnabled: boolean,
  stableBorrowRateEnabled: boolean,
  isActive: boolean,
  isFrozen: boolean,
];

/**
 * Aave v3 protocol adapter (docs/SPEC.md #6.2). One instance is scoped to one pool
 * (e.g. "aave-v3:ethereum:core") — a market's collateral base, per ADR 0001, is a
 * property of the whole pool, not any single reserve, so `collateralExposure` reads
 * every reserve in the pool regardless of which `marketId` (reserve asset) is passed.
 */
export class AaveV3Adapter implements ProtocolAdapter {
  readonly id: string;
  private readonly chainId: number;
  private readonly addresses: AaveV3AdapterAddresses;
  private readonly reader: ContractReader;

  constructor(options: AaveV3AdapterOptions) {
    this.id = options.id;
    this.chainId = options.chainId;
    this.addresses = options.addresses;
    this.reader = options.reader;
  }

  private async getReservesList(at: BlockRef): Promise<Address[]> {
    const [result] = await this.reader.multicall({
      contracts: [{ address: this.addresses.pool, abi: poolAbi, functionName: 'getReservesList' }],
      blockNumber: at.number,
    });
    return unwrap<Address[]>(result!, 'getReservesList');
  }

  async discoverPositions(owner: Address, at: BlockRef): Promise<Position[]> {
    const reserves = await this.getReservesList(at);
    if (reserves.length === 0) return [];

    const calls: MulticallCall[] = reserves.map((asset) => ({
      address: this.addresses.protocolDataProvider,
      abi: protocolDataProviderAbi,
      functionName: 'getUserReserveData',
      args: [asset, owner],
    }));
    const results = await this.reader.multicall({ contracts: calls, blockNumber: at.number });

    const positions: Position[] = [];
    reserves.forEach((asset, index) => {
      type UserReserveData = readonly [
        currentATokenBalance: bigint,
        currentStableDebt: bigint,
        currentVariableDebt: bigint,
        principalStableDebt: bigint,
        scaledVariableDebt: bigint,
        stableBorrowRate: bigint,
        liquidityRate: bigint,
        stableRateLastUpdated: number,
        usageAsCollateralEnabled: boolean,
      ];
      const data = unwrap<UserReserveData>(results[index]!, `getUserReserveData(${asset})`);
      const balance = data[0];
      if (balance > 0n) {
        positions.push({
          id: `${this.id}:${asset}:${owner}`,
          adapterId: this.id,
          chainId: this.chainId,
          marketId: asset,
          asset,
          owner,
          balance,
        });
      }
    });
    return positions;
  }

  async snapshotMarkets(marketIds: string[], at: BlockRef): Promise<MarketSnapshot[]> {
    const assets = marketIds as Address[];
    const calls: MulticallCall[] = assets.flatMap((asset) => [
      {
        address: this.addresses.protocolDataProvider,
        abi: protocolDataProviderAbi,
        functionName: 'getReserveData',
        args: [asset],
      },
      {
        address: this.addresses.protocolDataProvider,
        abi: protocolDataProviderAbi,
        functionName: 'getReserveConfigurationData',
        args: [asset],
      },
      {
        address: this.addresses.protocolDataProvider,
        abi: protocolDataProviderAbi,
        functionName: 'getPaused',
        args: [asset],
      },
      {
        address: this.addresses.protocolDataProvider,
        abi: protocolDataProviderAbi,
        functionName: 'getReserveDeficit',
        args: [asset],
      },
      {
        address: this.addresses.oracle,
        abi: oracleAbi,
        functionName: 'getAssetPrice',
        args: [asset],
      },
    ]);
    const results = await this.reader.multicall({ contracts: calls, blockNumber: at.number });

    const CALLS_PER_ASSET = 5;
    return assets.map((asset, i): MarketSnapshot => {
      const base = i * CALLS_PER_ASSET;
      const reserveData = unwrap<ReserveData>(results[base]!, `getReserveData(${asset})`);
      const config = unwrap<ReserveConfigurationData>(
        results[base + 1]!,
        `getReserveConfigurationData(${asset})`,
      );
      const paused = unwrap<boolean>(results[base + 2]!, `getPaused(${asset})`);
      const deficit = unwrapOptional<bigint>(results[base + 3]!);
      const price = unwrap<bigint>(results[base + 4]!, `getAssetPrice(${asset})`);

      const totalAToken = reserveData[2];
      const totalStableDebt = reserveData[3];
      const totalVariableDebt = reserveData[4];
      const totalBorrowed = totalStableDebt + totalVariableDebt;
      const availableLiquidity = totalAToken > totalBorrowed ? totalAToken - totalBorrowed : 0n;
      const isFrozen = config[9];

      return {
        marketId: asset,
        block: at,
        totalSupplied: totalAToken,
        totalBorrowed,
        availableLiquidity,
        utilization: totalAToken > 0n ? Number(totalBorrowed) / Number(totalAToken) : 0,
        supplyRate: Number(reserveData[5]) / Number(AAVE_RAY),
        borrowRate: Number(reserveData[6]) / Number(AAVE_RAY),
        flags: { paused, frozen: isFrozen },
        oraclePrices: { [asset.toLowerCase()]: price },
        ...(deficit !== undefined ? { badDebt: deficit } : {}),
        raw: { reserveData, config },
      };
    });
  }

  async collateralExposure(_marketId: string, at: BlockRef): Promise<CollateralExposure[]> {
    const reserves = await this.getReservesList(at);
    if (reserves.length === 0) return [];

    const calls: MulticallCall[] = reserves.flatMap((asset) => [
      {
        address: this.addresses.protocolDataProvider,
        abi: protocolDataProviderAbi,
        functionName: 'getReserveConfigurationData',
        args: [asset],
      },
      {
        address: this.addresses.protocolDataProvider,
        abi: protocolDataProviderAbi,
        functionName: 'getReserveData',
        args: [asset],
      },
      {
        address: this.addresses.oracle,
        abi: oracleAbi,
        functionName: 'getAssetPrice',
        args: [asset],
      },
    ]);
    const results = await this.reader.multicall({ contracts: calls, blockNumber: at.number });

    const CALLS_PER_ASSET = 3;
    const values = reserves.map((asset, i) => {
      const base = i * CALLS_PER_ASSET;
      const config = unwrap<ReserveConfigurationData>(
        results[base]!,
        `getReserveConfigurationData(${asset})`,
      );
      const reserveData = unwrap<ReserveData>(results[base + 1]!, `getReserveData(${asset})`);
      const price = unwrap<bigint>(results[base + 2]!, `getAssetPrice(${asset})`);
      const decimals = Number(config[0]);
      const usageAsCollateralEnabled = config[5];
      const totalAToken = reserveData[2];
      // Ratio-only value (docs/adr/0001): the oracle's base-currency unit cancels out
      // when taking a share, so it's never read or assumed here.
      const value = usageAsCollateralEnabled
        ? (Number(totalAToken) / 10 ** decimals) * Number(price)
        : 0;
      return { asset, value };
    });

    const total = values.reduce((sum, v) => sum + v.value, 0);
    if (total <= 0) return [];

    return values
      .filter((v) => v.value > 0)
      .map((v): CollateralExposure => ({
        marketId: this.id,
        asset: v.asset,
        share: v.value / total,
        method: 'approximate',
      }));
  }

  async withdrawable(position: Position, at: BlockRef): Promise<WithdrawEstimate> {
    const [result] = await this.reader.multicall({
      contracts: [
        {
          address: this.addresses.protocolDataProvider,
          abi: protocolDataProviderAbi,
          functionName: 'getReserveData',
          args: [position.asset],
        },
      ],
      blockNumber: at.number,
    });
    const reserveData = unwrap<ReserveData>(result!, `getReserveData(${position.asset})`);
    const totalAToken = reserveData[2];
    const totalBorrowed = reserveData[3] + reserveData[4];
    const availableLiquidity = totalAToken > totalBorrowed ? totalAToken - totalBorrowed : 0n;
    const withdrawableNow =
      position.balance < availableLiquidity ? position.balance : availableLiquidity;
    return {
      position,
      withdrawableNow,
      fullyWithdrawable: withdrawableNow >= position.balance,
    };
  }

  buildWithdraw(position: Position, amount: bigint | 'max', recipient: Address): TxRequest {
    const data = encodeFunctionData({
      abi: poolAbi,
      functionName: 'withdraw',
      args: [position.asset, amount === 'max' ? AAVE_WITHDRAW_MAX : amount, recipient],
    });
    return { chainId: this.chainId, to: this.addresses.pool, data, value: 0n };
  }

  decodeEvents(logs: RawLog[]): ProtocolEvent[] {
    const events: ProtocolEvent[] = [];
    for (const log of logs) {
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: poolAbi,
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });
      } catch {
        continue;
      }

      const base = {
        chainId: this.chainId,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      };

      switch (decoded.eventName) {
        case 'Supply':
        case 'Withdraw':
        case 'Borrow':
        case 'Repay': {
          const kind = decoded.eventName.toLowerCase() as
            'supply' | 'withdraw' | 'borrow' | 'repay';
          events.push({ ...base, marketId: decoded.args.reserve, kind, data: { ...decoded.args } });
          break;
        }
        case 'LiquidationCall':
          events.push({
            ...base,
            marketId: decoded.args.collateralAsset,
            kind: 'liquidation',
            data: { ...decoded.args },
          });
          break;
        default:
          break;
      }
    }
    return events;
  }
}
