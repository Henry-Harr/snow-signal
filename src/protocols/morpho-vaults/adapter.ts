import { decodeEventLog, encodeFunctionData } from 'viem';

import { erc4626Abi, metaMorphoAbi, metaMorphoEventsAbi } from './abi.js';
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
import { morphoAbi } from '../morpho-blue/abi.js';

function unwrap<T>(result: MulticallResult, context: string): T {
  if (result.status === 'failure') {
    throw new Error(`Morpho vault read failed (${context}): ${result.error.message}`);
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

const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;

function sharesToAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
}

export interface MorphoVaultAllocationEntry {
  marketId: `0x${string}`;
  collateralToken: Address;
  /** The vault's current allocation to this market, in the vault's underlying asset
   * units. */
  vaultAssets: bigint;
  /** The market's own available liquidity (total supplied minus total borrowed). */
  marketAvailableLiquidity: bigint;
}

export interface MorphoVaultAdapterOptions {
  id: string;
  chainId: number;
  vault: Address;
  /** Morpho Blue contract this vault allocates into — vaults sit on top of Morpho
   * Blue, so look-through exposure and withdrawable-liquidity reads go through it. */
  morpho: Address;
  reader: ContractReader;
}

/**
 * Morpho vault (MetaMorpho v1.1) protocol adapter (docs/SPEC.md #6.4). One instance
 * is scoped to one vault, matching how positions are configured (spec §14:
 * `{protocol: morpho-vault, chain, vault: address}` — no separate market id, the
 * vault itself is the unit of configuration).
 */
export class MorphoVaultAdapter implements ProtocolAdapter {
  readonly id: string;
  private readonly chainId: number;
  private readonly vault: Address;
  private readonly morpho: Address;
  private readonly reader: ContractReader;

  constructor(options: MorphoVaultAdapterOptions) {
    this.id = options.id;
    this.chainId = options.chainId;
    this.vault = options.vault;
    this.morpho = options.morpho;
    this.reader = options.reader;
  }

  private async readQueue(
    queue: 'supplyQueue' | 'withdrawQueue',
    lengthFn: 'supplyQueueLength' | 'withdrawQueueLength',
    at: BlockRef,
  ): Promise<`0x${string}`[]> {
    const [lengthResult] = await this.reader.multicall({
      contracts: [{ address: this.vault, abi: metaMorphoAbi, functionName: lengthFn }],
      blockNumber: at.number,
    });
    const length = unwrap<bigint>(lengthResult!, lengthFn);
    if (length === 0n) return [];

    const calls: MulticallCall[] = Array.from({ length: Number(length) }, (_, i) => ({
      address: this.vault,
      abi: metaMorphoAbi,
      functionName: queue,
      args: [BigInt(i)],
    }));
    const results = await this.reader.multicall({ contracts: calls, blockNumber: at.number });
    return results.map((r, i) => unwrap<`0x${string}`>(r, `${queue}(${i})`));
  }

  /** Idle assets plus, for each market in the withdraw queue, the smaller of the
   * vault's supply there and that market's available liquidity (docs/SPEC.md #6.4) —
   * an independent, inspectable breakdown of what ERC-4626's `maxWithdraw` computes
   * on-chain, useful for reports/detectors that want to see *why* liquidity is or
   * isn't there, not just the final number. */
  async vaultWithdrawableLiquidity(
    at: BlockRef,
  ): Promise<{ idle: bigint; perMarket: MorphoVaultAllocationEntry[] }> {
    const withdrawQueue = await this.readQueue('withdrawQueue', 'withdrawQueueLength', at);
    const allocation = await this.readAllocation(withdrawQueue, at);

    const [totalAssetsResult] = await this.reader.multicall({
      contracts: [{ address: this.vault, abi: erc4626Abi, functionName: 'totalAssets' }],
      blockNumber: at.number,
    });
    const totalAssets = unwrap<bigint>(totalAssetsResult!, 'totalAssets');
    const allocatedTotal = allocation.reduce((sum, entry) => sum + entry.vaultAssets, 0n);
    const idle = totalAssets > allocatedTotal ? totalAssets - allocatedTotal : 0n;

    return { idle, perMarket: allocation };
  }

  private async readAllocation(
    marketIds: `0x${string}`[],
    at: BlockRef,
  ): Promise<MorphoVaultAllocationEntry[]> {
    if (marketIds.length === 0) return [];

    const stateCalls: MulticallCall[] = marketIds.map((id) => ({
      address: this.morpho,
      abi: morphoAbi,
      functionName: 'market',
      args: [id],
    }));
    const paramsCalls: MulticallCall[] = marketIds.map((id) => ({
      address: this.morpho,
      abi: morphoAbi,
      functionName: 'idToMarketParams',
      args: [id],
    }));
    const vaultPositionCalls: MulticallCall[] = marketIds.map((id) => ({
      address: this.morpho,
      abi: morphoAbi,
      functionName: 'position',
      args: [id, this.vault],
    }));

    const [stateResults, paramsResults, positionResults] = await Promise.all([
      this.reader.multicall({ contracts: stateCalls, blockNumber: at.number }),
      this.reader.multicall({ contracts: paramsCalls, blockNumber: at.number }),
      this.reader.multicall({ contracts: vaultPositionCalls, blockNumber: at.number }),
    ]);

    return marketIds.map((marketId, i): MorphoVaultAllocationEntry => {
      const state = unwrap<MarketState>(stateResults[i]!, `market(${marketId})`);
      const params = unwrap<MarketParamsResult>(paramsResults[i]!, `idToMarketParams(${marketId})`);
      const position = unwrap<PositionResult>(positionResults[i]!, `position(${marketId}, vault)`);
      const vaultAssets = sharesToAssetsDown(
        position[0],
        state.totalSupplyAssets,
        state.totalSupplyShares,
      );
      const marketAvailableLiquidity =
        state.totalSupplyAssets > state.totalBorrowAssets
          ? state.totalSupplyAssets - state.totalBorrowAssets
          : 0n;
      return { marketId, collateralToken: params[1], vaultAssets, marketAvailableLiquidity };
    });
  }

  async discoverPositions(owner: Address, at: BlockRef): Promise<Position[]> {
    const [balanceResult, assetResult] = await this.reader.multicall({
      contracts: [
        { address: this.vault, abi: erc4626Abi, functionName: 'balanceOf', args: [owner] },
        { address: this.vault, abi: erc4626Abi, functionName: 'asset' },
      ],
      blockNumber: at.number,
    });
    const shares = unwrap<bigint>(balanceResult!, 'balanceOf');
    if (shares <= 0n) return [];
    const asset = unwrap<Address>(assetResult!, 'asset');

    const [assetsResult] = await this.reader.multicall({
      contracts: [
        { address: this.vault, abi: erc4626Abi, functionName: 'convertToAssets', args: [shares] },
      ],
      blockNumber: at.number,
    });
    const balance = unwrap<bigint>(assetsResult!, 'convertToAssets');

    return [
      {
        id: `${this.id}:${this.vault}:${owner}`,
        adapterId: this.id,
        chainId: this.chainId,
        marketId: this.vault,
        asset,
        owner,
        balance,
        raw: { shares },
      },
    ];
  }

  async snapshotMarkets(_marketIds: string[], at: BlockRef): Promise<MarketSnapshot[]> {
    const [totalAssetsResult] = await this.reader.multicall({
      contracts: [{ address: this.vault, abi: erc4626Abi, functionName: 'totalAssets' }],
      blockNumber: at.number,
    });
    const totalAssets = unwrap<bigint>(totalAssetsResult!, 'totalAssets');
    const { idle, perMarket } = await this.vaultWithdrawableLiquidity(at);
    const availableLiquidity =
      idle +
      perMarket.reduce(
        (sum, e) =>
          sum +
          (e.vaultAssets < e.marketAvailableLiquidity ? e.vaultAssets : e.marketAvailableLiquidity),
        0n,
      );

    return [
      {
        marketId: this.vault,
        block: at,
        totalSupplied: totalAssets,
        totalBorrowed: 0n,
        availableLiquidity,
        utilization: 0,
        supplyRate: 0,
        borrowRate: 0,
        flags: { paused: false, frozen: false },
        oraclePrices: {},
        raw: { perMarket },
      },
    ];
  }

  /** Look-through exposure (docs/SPEC.md #6.4): my share of the vault's assets in
   * each underlying market, expressed as exposure to that market's collateral
   * asset. Exact, not approximate (docs/adr/0001) — every market shares the same
   * denomination (the vault's own underlying asset), so shares here are precise
   * allocation ratios, not a cross-asset value estimate. */
  async collateralExposure(_marketId: string, at: BlockRef): Promise<CollateralExposure[]> {
    const supplyQueue = await this.readQueue('supplyQueue', 'supplyQueueLength', at);
    const allocation = await this.readAllocation(supplyQueue, at);
    const total = allocation.reduce((sum, e) => sum + e.vaultAssets, 0n);
    if (total <= 0n) return [];

    return allocation
      .filter((e) => e.vaultAssets > 0n)
      .map((e): CollateralExposure => ({
        marketId: e.marketId,
        asset: e.collateralToken,
        share: Number(e.vaultAssets) / Number(total),
        method: 'exact',
      }));
  }

  async withdrawable(position: Position, at: BlockRef): Promise<WithdrawEstimate> {
    const [maxWithdrawResult] = await this.reader.multicall({
      contracts: [
        {
          address: this.vault,
          abi: erc4626Abi,
          functionName: 'maxWithdraw',
          args: [position.owner],
        },
      ],
      blockNumber: at.number,
    });
    const maxWithdraw = unwrap<bigint>(maxWithdrawResult!, 'maxWithdraw');
    const withdrawableNow = position.balance < maxWithdraw ? position.balance : maxWithdraw;
    return {
      position,
      withdrawableNow,
      fullyWithdrawable: withdrawableNow >= position.balance,
    };
  }

  buildWithdraw(position: Position, amount: bigint | 'max', recipient: Address): TxRequest {
    const raw = position.raw as { shares?: bigint } | undefined;
    if (amount === 'max' && raw?.shares === undefined) {
      throw new Error(
        'buildWithdraw("max") requires position.raw.shares (set by discoverPositions) to redeem the exact full position',
      );
    }
    // 'max' redeems by shares (redeem), a specific amount withdraws by assets
    // (withdraw isn't in this adapter's ABI subset — redeem covers both cases since
    // any target asset amount can be converted to shares by the caller if needed;
    // for Phase 2's read-only scope, only the 'max' full-exit path is wired up).
    if (amount !== 'max') {
      throw new Error(
        "MorphoVaultAdapter.buildWithdraw only supports amount: 'max' for now — partial vault withdrawals " +
          'are a Phase 7 (withdrawal planner) concern once ERC-4626 withdraw() is added to the ABI subset',
      );
    }
    const data = encodeFunctionData({
      abi: erc4626Abi,
      functionName: 'redeem',
      args: [raw!.shares!, recipient, position.owner],
    });
    return { chainId: this.chainId, to: this.vault, data, value: 0n };
  }

  decodeEvents(logs: RawLog[]): ProtocolEvent[] {
    const events: ProtocolEvent[] = [];
    for (const log of logs) {
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: metaMorphoEventsAbi,
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

      events.push({
        ...base,
        marketId: this.vault,
        kind: 'other',
        data: { eventName: decoded.eventName, ...decoded.args },
      });
    }
    return events;
  }
}
