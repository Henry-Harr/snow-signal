import { decodeEventLog, encodeFunctionData } from 'viem';

import { morphoAbi, morphoEventsAbi, morphoOracleAbi } from './abi.js';
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

// Source: https://github.com/morpho-org/morpho-blue/blob/main/src/libraries/SharesMathLib.sol
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;

function sharesToAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
}

function unwrap<T>(result: MulticallResult, context: string): T {
  if (result.status === 'failure') {
    throw new Error(`Morpho Blue read failed (${context}): ${result.error.message}`);
  }
  return result.result as T;
}

type MarketState = {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
};

type MarketParamsResult = readonly [
  loanToken: Address,
  collateralToken: Address,
  oracle: Address,
  irm: Address,
  lltv: bigint,
];

type PositionResult = readonly [supplyShares: bigint, borrowShares: bigint, collateral: bigint];

export interface MorphoBlueAdapterOptions {
  id: string;
  chainId: number;
  morpho: Address;
  reader: ContractReader;
  /** Morpho Blue has no on-chain way to enumerate "every market a user has a
   * position in" — markets are only known from configuration (spec's `positions`
   * list already names an exact `marketId`) or from indexing `CreateMarket` events
   * over history (a Phase 3 watcher concern). `discoverPositions` checks the user's
   * position in exactly these configured markets. */
  watchedMarketIds: `0x${string}`[];
}

export class MorphoBlueAdapter implements ProtocolAdapter {
  readonly id: string;
  private readonly chainId: number;
  private readonly morpho: Address;
  private readonly reader: ContractReader;
  private readonly watchedMarketIds: `0x${string}`[];

  constructor(options: MorphoBlueAdapterOptions) {
    this.id = options.id;
    this.chainId = options.chainId;
    this.morpho = options.morpho;
    this.reader = options.reader;
    this.watchedMarketIds = options.watchedMarketIds;
  }

  private async readMarketState(marketIds: `0x${string}`[], at: BlockRef): Promise<MarketState[]> {
    const calls: MulticallCall[] = marketIds.map((id) => ({
      address: this.morpho,
      abi: morphoAbi,
      functionName: 'market',
      args: [id],
    }));
    const results = await this.reader.multicall({ contracts: calls, blockNumber: at.number });
    return marketIds.map((id, i) => {
      const raw = unwrap<{
        totalSupplyAssets: bigint;
        totalSupplyShares: bigint;
        totalBorrowAssets: bigint;
        totalBorrowShares: bigint;
        lastUpdate: bigint;
        fee: bigint;
      }>(results[i]!, `market(${id})`);
      return raw;
    });
  }

  private async readMarketParams(
    marketIds: `0x${string}`[],
    at: BlockRef,
  ): Promise<MarketParamsResult[]> {
    const calls: MulticallCall[] = marketIds.map((id) => ({
      address: this.morpho,
      abi: morphoAbi,
      functionName: 'idToMarketParams',
      args: [id],
    }));
    const results = await this.reader.multicall({ contracts: calls, blockNumber: at.number });
    return marketIds.map((id, i) =>
      unwrap<MarketParamsResult>(results[i]!, `idToMarketParams(${id})`),
    );
  }

  async discoverPositions(owner: Address, at: BlockRef): Promise<Position[]> {
    if (this.watchedMarketIds.length === 0) return [];

    const [states, params] = await Promise.all([
      this.readMarketState(this.watchedMarketIds, at),
      this.readMarketParams(this.watchedMarketIds, at),
    ]);

    const calls: MulticallCall[] = this.watchedMarketIds.map((id) => ({
      address: this.morpho,
      abi: morphoAbi,
      functionName: 'position',
      args: [id, owner],
    }));
    const results = await this.reader.multicall({ contracts: calls, blockNumber: at.number });

    const positions: Position[] = [];
    this.watchedMarketIds.forEach((marketId, i) => {
      const positionResult = unwrap<PositionResult>(results[i]!, `position(${marketId})`);
      const supplyShares = positionResult[0];
      if (supplyShares <= 0n) return;

      const state = states[i]!;
      const assets = sharesToAssetsDown(
        supplyShares,
        state.totalSupplyAssets,
        state.totalSupplyShares,
      );
      positions.push({
        id: `${this.id}:${marketId}:${owner}`,
        adapterId: this.id,
        chainId: this.chainId,
        marketId,
        asset: params[i]![0],
        owner,
        balance: assets,
        raw: { supplyShares, marketParams: params[i]! },
      });
    });
    return positions;
  }

  async snapshotMarkets(marketIds: string[], at: BlockRef): Promise<MarketSnapshot[]> {
    const ids = marketIds as `0x${string}`[];
    const [states, params] = await Promise.all([
      this.readMarketState(ids, at),
      this.readMarketParams(ids, at),
    ]);

    const priceCalls: MulticallCall[] = params.map((p) => ({
      address: p[2],
      abi: morphoOracleAbi,
      functionName: 'price',
    }));
    const priceResults = await this.reader.multicall({
      contracts: priceCalls,
      blockNumber: at.number,
    });

    return ids.map((id, i): MarketSnapshot => {
      const state = states[i]!;
      const marketParams = params[i]!;
      const price = unwrap<bigint>(priceResults[i]!, `price() for market ${id}`);
      const totalSupplied = state.totalSupplyAssets;
      const totalBorrowed = state.totalBorrowAssets;
      const availableLiquidity = totalSupplied > totalBorrowed ? totalSupplied - totalBorrowed : 0n;

      return {
        marketId: id,
        block: at,
        totalSupplied,
        totalBorrowed,
        availableLiquidity,
        utilization: totalSupplied > 0n ? Number(totalBorrowed) / Number(totalSupplied) : 0,
        // Morpho Blue markets don't expose a pre-computed APR the way Aave's data
        // provider does — the IRM's rate is only readable via a simulation call
        // (borrowRateView), which is out of scope for this read-only snapshot pass.
        // Left at 0 here; revisit once a detector actually needs it (Phase 4).
        supplyRate: 0,
        borrowRate: 0,
        flags: { paused: false, frozen: false },
        oraclePrices: { [marketParams[1].toLowerCase()]: price },
        raw: { state, marketParams },
      };
    });
  }

  async collateralExposure(marketId: string, at: BlockRef): Promise<CollateralExposure[]> {
    const [params] = await this.readMarketParams([marketId as `0x${string}`], at);
    // Exact by construction (docs/adr/0001): an isolated Morpho Blue market has
    // exactly one possible collateral asset, so it's always 100% of this market's
    // collateral exposure, independent of how much is currently posted.
    return [{ marketId, asset: params![1], share: 1, method: 'exact' }];
  }

  async withdrawable(position: Position, at: BlockRef): Promise<WithdrawEstimate> {
    const [state] = await this.readMarketState([position.marketId as `0x${string}`], at);
    const totalSupplied = state!.totalSupplyAssets;
    const totalBorrowed = state!.totalBorrowAssets;
    const availableLiquidity = totalSupplied > totalBorrowed ? totalSupplied - totalBorrowed : 0n;
    const withdrawableNow =
      position.balance < availableLiquidity ? position.balance : availableLiquidity;
    return {
      position,
      withdrawableNow,
      fullyWithdrawable: withdrawableNow >= position.balance,
    };
  }

  buildWithdraw(position: Position, amount: bigint | 'max', recipient: Address): TxRequest {
    const raw = position.raw as
      { supplyShares: bigint; marketParams: MarketParamsResult } | undefined;
    if (!raw?.marketParams) {
      throw new Error(
        "buildWithdraw requires position.raw.marketParams (set by discoverPositions) — Morpho's " +
          'withdraw() takes the full MarketParams struct, not just the market id',
      );
    }

    const [loanToken, collateralToken, oracle, irm, lltv] = raw.marketParams;
    // Either `assets` or `shares` must be zero (docs/SOURCES.md); for 'max', redeem
    // by shares so the full position is withdrawn exactly, with no dust left behind
    // from converting shares to an assets estimate first.
    const assets = amount === 'max' ? 0n : amount;
    const shares = amount === 'max' ? raw.supplyShares : 0n;

    const data = encodeFunctionData({
      abi: morphoAbi,
      functionName: 'withdraw',
      args: [
        { loanToken, collateralToken, oracle, irm, lltv },
        assets,
        shares,
        position.owner,
        recipient,
      ],
    });
    return { chainId: this.chainId, to: this.morpho, data, value: 0n };
  }

  decodeEvents(logs: RawLog[]): ProtocolEvent[] {
    const events: ProtocolEvent[] = [];
    for (const log of logs) {
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: morphoEventsAbi,
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
          events.push({ ...base, marketId: decoded.args.id, kind, data: { ...decoded.args } });
          break;
        }
        case 'Liquidate':
          events.push({
            ...base,
            marketId: decoded.args.id,
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
