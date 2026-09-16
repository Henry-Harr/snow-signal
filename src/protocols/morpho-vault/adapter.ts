import { encodeFunctionData, erc20Abi, erc4626Abi } from 'viem';
import { z } from 'zod';

import { metaMorphoAbi } from './abi.js';
import { morphoBlueAbi } from '../morpho-blue/abi.js';
import { toAssetsDown } from '../morpho-blue/shares-math.js';
import { bytes32Schema, marketParamsSchema, marketSchema } from '../morpho-blue/types.js';
import type { ContractCall, ContractCallResult, ContractReadClient } from '../../chain/client.js';
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

/** Narrows a multicall slot to its decoded value, throwing `AdapterError` if that
 * specific call reverted (see the identical helper + rationale in
 * src/protocols/aave-v3/adapter.ts). */
function unwrap(result: ContractCallResult | undefined, context: string): unknown {
  if (!result) throw new AdapterError(`${context}: missing multicall result`);
  if (result.status === 'failure') throw new AdapterError(`${context}: ${result.error.message}`);
  return result.result;
}

function addressSchema() {
  return z.string().regex(/^0x[a-fA-F0-9]{40}$/) as unknown as z.ZodType<Address>;
}

const nonNegativeBigint = z.bigint().nonnegative();

const pendingUint192Schema = z.object({ value: nonNegativeBigint, validAt: nonNegativeBigint });
const pendingAddressSchema = z.object({ value: addressSchema(), validAt: nonNegativeBigint });
const marketConfigSchema = z.object({
  cap: nonNegativeBigint,
  enabled: z.boolean(),
  removableAt: nonNegativeBigint,
});

export interface MorphoVaultAdapterOptions {
  chain: string;
  chainId: ChainId;
  vaultAddress: Address;
  pool: RpcPool<ContractReadClient>;
  logger?: Logger;
}

interface MarketAllocation {
  id: `0x${string}`;
  collateralToken: Address;
  cap: bigint;
  enabledInWithdrawQueue: boolean;
  vaultSupplyAssets: bigint;
  marketAvailableLiquidity: bigint;
}

/**
 * Morpho vault (MetaMorpho v1.1) protocol adapter (docs/SPEC.md #6.4). One instance
 * watches one vault. **v1.1 only** — see the header comment in `./abi.ts` for how
 * that was confirmed for the user's watched vault, and what happens if a future one
 * turns out to be Vault V2 instead (misreads; needs its own adapter).
 */
export class MorphoVaultAdapter implements ProtocolAdapter {
  readonly id: string;
  private readonly chain: string;
  private readonly chainId: ChainId;
  private readonly vaultAddress: Address;
  private readonly pool: RpcPool<ContractReadClient>;
  private readonly logger: Logger | undefined;

  constructor(options: MorphoVaultAdapterOptions) {
    this.id = `morpho-vault:${options.chain}:${options.vaultAddress}`;
    this.chain = options.chain;
    this.chainId = options.chainId;
    this.vaultAddress = options.vaultAddress;
    this.pool = options.pool;
    this.logger = options.logger;
  }

  /** Reads every underlying market the vault allocates into (union of its supply and
   * withdraw queues — a market can be in one without the other, e.g. mid-removal),
   * each market's Morpho Blue state, and the vault's own supply position in it. This
   * is the core read both `snapshotMarkets` and `collateralExposure` build on. */
  private async readAllocations(at: BlockRef): Promise<{
    morphoBlueAddress: Address;
    asset: Address;
    idleAssets: bigint;
    totalAssets: bigint;
    allocations: MarketAllocation[];
    roles: { owner: Address; curator: Address; guardian: Address };
    fee: bigint;
    feeRecipient: Address;
    timelock: bigint;
    pendingTimelock: { value: bigint; validAt: bigint };
    pendingGuardian: { value: Address; validAt: bigint };
  }> {
    const ctx = this.id;

    const scalarCalls: ContractCall[] = [
      { address: this.vaultAddress, abi: metaMorphoAbi, functionName: 'MORPHO' },
      { address: this.vaultAddress, abi: metaMorphoAbi, functionName: 'owner' },
      { address: this.vaultAddress, abi: metaMorphoAbi, functionName: 'curator' },
      { address: this.vaultAddress, abi: metaMorphoAbi, functionName: 'guardian' },
      { address: this.vaultAddress, abi: metaMorphoAbi, functionName: 'fee' },
      { address: this.vaultAddress, abi: metaMorphoAbi, functionName: 'feeRecipient' },
      { address: this.vaultAddress, abi: metaMorphoAbi, functionName: 'timelock' },
      { address: this.vaultAddress, abi: metaMorphoAbi, functionName: 'pendingTimelock' },
      { address: this.vaultAddress, abi: metaMorphoAbi, functionName: 'pendingGuardian' },
      { address: this.vaultAddress, abi: metaMorphoAbi, functionName: 'supplyQueueLength' },
      { address: this.vaultAddress, abi: metaMorphoAbi, functionName: 'withdrawQueueLength' },
      { address: this.vaultAddress, abi: erc4626Abi, functionName: 'totalAssets' },
      { address: this.vaultAddress, abi: erc4626Abi, functionName: 'asset' },
    ];
    const scalars = await this.pool.quorumRead((client) =>
      client.multicall(scalarCalls, at.number),
    );

    const morphoBlueAddress = unwrap(scalars[0], `${ctx} MORPHO()`) as Address;
    const roles = {
      owner: unwrap(scalars[1], `${ctx} owner()`) as Address,
      curator: unwrap(scalars[2], `${ctx} curator()`) as Address,
      guardian: unwrap(scalars[3], `${ctx} guardian()`) as Address,
    };
    const fee = z
      .bigint()
      .nonnegative()
      .parse(unwrap(scalars[4], `${ctx} fee()`));
    const feeRecipient = unwrap(scalars[5], `${ctx} feeRecipient()`) as Address;
    const timelock = z
      .bigint()
      .nonnegative()
      .parse(unwrap(scalars[6], `${ctx} timelock()`));
    const pendingTimelock = pendingUint192Schema.parse(
      unwrap(scalars[7], `${ctx} pendingTimelock()`),
    );
    const pendingGuardian = pendingAddressSchema.parse(
      unwrap(scalars[8], `${ctx} pendingGuardian()`),
    );
    const supplyQueueLength = z
      .bigint()
      .nonnegative()
      .parse(unwrap(scalars[9], `${ctx} supplyQueueLength()`));
    const withdrawQueueLength = z
      .bigint()
      .nonnegative()
      .parse(unwrap(scalars[10], `${ctx} withdrawQueueLength()`));
    const totalAssets = z
      .bigint()
      .nonnegative()
      .parse(unwrap(scalars[11], `${ctx} totalAssets()`));
    const asset = unwrap(scalars[12], `${ctx} asset()`) as Address;

    const queueCalls: ContractCall[] = [
      ...Array.from({ length: Number(supplyQueueLength) }, (_, i) => ({
        address: this.vaultAddress,
        abi: metaMorphoAbi,
        functionName: 'supplyQueue',
        args: [BigInt(i)],
      })),
      ...Array.from({ length: Number(withdrawQueueLength) }, (_, i) => ({
        address: this.vaultAddress,
        abi: metaMorphoAbi,
        functionName: 'withdrawQueue',
        args: [BigInt(i)],
      })),
    ];
    const queueResults =
      queueCalls.length > 0
        ? await this.pool.bestEffortRead((client) => client.multicall(queueCalls, at.number))
        : [];
    const supplyQueueIds = queueResults
      .slice(0, Number(supplyQueueLength))
      .map((r) => bytes32Schema().parse(unwrap(r, `${ctx} supplyQueue()`)));
    const withdrawQueueIds = queueResults
      .slice(Number(supplyQueueLength))
      .map((r) => bytes32Schema().parse(unwrap(r, `${ctx} withdrawQueue()`)));

    const uniqueIds = [...new Set([...supplyQueueIds, ...withdrawQueueIds])];

    const idleAssets = await this.pool.quorumRead(async (client) => {
      const [result] = await client.multicall(
        [{ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [this.vaultAddress] }],
        at.number,
      );
      return z
        .bigint()
        .nonnegative()
        .parse(unwrap(result, `${ctx} idle balanceOf()`));
    });

    if (uniqueIds.length === 0) {
      return {
        morphoBlueAddress,
        asset,
        idleAssets,
        totalAssets,
        allocations: [],
        roles,
        fee,
        feeRecipient,
        timelock,
        pendingTimelock,
        pendingGuardian,
      };
    }

    // Every market's config + Morpho Blue state + the vault's own position in it, in
    // one batch — these feed availableLiquidity/exposure numbers, so quorum-read.
    const marketCalls: ContractCall[] = uniqueIds.flatMap((marketId) => [
      { address: this.vaultAddress, abi: metaMorphoAbi, functionName: 'config', args: [marketId] },
      { address: morphoBlueAddress, abi: morphoBlueAbi, functionName: 'market', args: [marketId] },
      {
        address: morphoBlueAddress,
        abi: morphoBlueAbi,
        functionName: 'idToMarketParams',
        args: [marketId],
      },
      {
        address: morphoBlueAddress,
        abi: morphoBlueAbi,
        functionName: 'position',
        args: [marketId, this.vaultAddress],
      },
    ]);
    const marketResults = await this.pool.quorumRead((client) =>
      client.multicall(marketCalls, at.number),
    );

    const withdrawQueueSet = new Set(withdrawQueueIds);
    const allocations: MarketAllocation[] = uniqueIds.map((marketId, i) => {
      const base = i * 4;
      const mctx = `${ctx}:${marketId}`;
      const config = marketConfigSchema.parse(unwrap(marketResults[base], `${mctx} config()`));
      const market = marketSchema.parse(unwrap(marketResults[base + 1], `${mctx} market()`));
      const params = marketParamsSchema.parse(
        unwrap(marketResults[base + 2], `${mctx} idToMarketParams()`),
      );
      const [supplyShares] = z
        .tuple([nonNegativeBigint, nonNegativeBigint, nonNegativeBigint])
        .parse(unwrap(marketResults[base + 3], `${mctx} position()`));

      return {
        id: marketId,
        collateralToken: params.collateralToken,
        cap: config.cap,
        enabledInWithdrawQueue: withdrawQueueSet.has(marketId),
        vaultSupplyAssets: toAssetsDown(
          supplyShares,
          market.totalSupplyAssets,
          market.totalSupplyShares,
        ),
        marketAvailableLiquidity: market.totalSupplyAssets - market.totalBorrowAssets,
      };
    });

    return {
      morphoBlueAddress,
      asset,
      idleAssets,
      totalAssets,
      allocations,
      roles,
      fee,
      feeRecipient,
      timelock,
      pendingTimelock,
      pendingGuardian,
    };
  }

  /** Ignores `marketIds` — a vault adapter instance watches exactly one vault, so
   * there is exactly one snapshot to give (unlike Aave/Morpho Blue, where one adapter
   * instance covers several reserves/markets by id). */
  async snapshotMarkets(_marketIds: string[], at: BlockRef): Promise<MarketSnapshot[]> {
    const data = await this.readAllocations(at);

    // "Vault withdrawable liquidity" (docs/SPEC.md #6.4): idle assets, plus for each
    // market in the withdraw queue, the smaller of the vault's supply there and that
    // market's available liquidity.
    const availableLiquidity = data.allocations
      .filter((a) => a.enabledInWithdrawQueue)
      .reduce(
        (sum, a) =>
          sum +
          (a.vaultSupplyAssets < a.marketAvailableLiquidity
            ? a.vaultSupplyAssets
            : a.marketAvailableLiquidity),
        data.idleAssets,
      );

    // Reinterpreted for a vault: "utilization" here means the share of vault assets
    // that is *not* immediately withdrawable (locked in underlying market illiquidity)
    // rather than Aave-style borrow/supply utilization, which doesn't apply to a
    // vault directly — a vault doesn't itself borrow (docs/SPEC.md #6.4 has no
    // vault-level utilization concept; this is the closest meaningful analogue).
    const utilization =
      data.totalAssets === 0n ? 0 : 1 - Number(availableLiquidity) / Number(data.totalAssets);

    return [
      {
        marketId: this.id,
        block: at,
        totalSupplied: data.totalAssets,
        totalBorrowed: 0n, // vaults don't borrow; risk lives in the underlying markets (see collateralExposure)
        availableLiquidity,
        utilization,
        // Vault yield isn't computed here — an accurate figure needs every allocated
        // market's IRM rate weighted by allocation and netted against both the
        // underlying market's and this vault's own fee; deferred rather than
        // fabricated. `lastTotalAssets` (in `raw`) plus a later reading's
        // `totalAssets` gives a *realized* yield measurement over time, which Phase 3
        // can compute without needing this per-block estimate at all.
        supplyRate: 0,
        borrowRate: 0,
        flags: { paused: false, frozen: false }, // no vault-level pause/freeze concept in MetaMorpho v1.1
        oraclePrices: {}, // no single vault-level oracle; see collateralExposure for per-asset look-through
        raw: {
          idleAssets: data.idleAssets,
          roles: data.roles,
          fee: data.fee,
          feeRecipient: data.feeRecipient,
          timelock: data.timelock,
          pendingTimelock: data.pendingTimelock,
          pendingGuardian: data.pendingGuardian,
          allocations: data.allocations,
        },
      },
    ];
  }

  /**
   * Look-through exposure (docs/SPEC.md #6.4): the vault's own share of assets in
   * each underlying market, grouped by that market's collateral asset. `method:
   * 'exact'` — unlike Aave's pool-wide approximation (docs/adr/0001), this reads the
   * vault's *actual* on-chain position in every market it allocates into, not an
   * aggregate proxy.
   */
  async collateralExposure(_marketId: string, at: BlockRef): Promise<CollateralExposure[]> {
    const data = await this.readAllocations(at);
    if (data.totalAssets === 0n) return [];

    const byAsset = new Map<Address, bigint>();
    for (const allocation of data.allocations) {
      byAsset.set(
        allocation.collateralToken,
        (byAsset.get(allocation.collateralToken) ?? 0n) + allocation.vaultSupplyAssets,
      );
    }

    return [...byAsset.entries()].map(([asset, exposedAssets]) => ({
      marketId: this.id,
      asset,
      shareOfCollateralBase: Number(exposedAssets) / Number(data.totalAssets),
      method: 'exact' as const,
      raw: { exposedAssets },
    }));
  }

  async discoverPositions(owner: Address, at: BlockRef): Promise<Position[]> {
    const shares = await this.pool.quorumRead(async (client) => {
      const [result] = await client.multicall(
        [{ address: this.vaultAddress, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }],
        at.number,
      );
      return z
        .bigint()
        .nonnegative()
        .parse(unwrap(result, `${this.id} share balanceOf()`));
    });

    if (shares === 0n) return [];

    const balance = await this.pool.quorumRead(async (client) => {
      const [result] = await client.multicall(
        [
          {
            address: this.vaultAddress,
            abi: erc4626Abi,
            functionName: 'convertToAssets',
            args: [shares],
          },
        ],
        at.number,
      );
      return z
        .bigint()
        .nonnegative()
        .parse(unwrap(result, `${this.id} convertToAssets()`));
    });

    const asset = await this.pool.bestEffortRead(async (client) => {
      const [result] = await client.multicall(
        [{ address: this.vaultAddress, abi: erc4626Abi, functionName: 'asset' }],
        at.number,
      );
      return unwrap(result, `${this.id} asset()`) as Address;
    });

    return [
      {
        id: `${this.id}:${owner}`,
        protocol: 'morpho-vault',
        chainId: this.chainId,
        marketId: this.id,
        owner,
        asset,
        balance,
      },
    ];
  }

  async withdrawable(position: Position, at: BlockRef): Promise<WithdrawEstimate> {
    const maxWithdraw = await this.pool.quorumRead(async (client) => {
      const [result] = await client.multicall(
        [
          {
            address: this.vaultAddress,
            abi: erc4626Abi,
            functionName: 'maxWithdraw',
            args: [position.owner],
          },
        ],
        at.number,
      );
      return z
        .bigint()
        .nonnegative()
        .parse(unwrap(result, `${this.id} maxWithdraw()`));
    });
    const availableNow = maxWithdraw < position.balance ? maxWithdraw : position.balance;
    return { positionId: position.id, availableNow, totalPosition: position.balance };
  }

  buildWithdraw(position: Position, amount: bigint | 'max', recipient: Address): TxRequest {
    const assets = amount === 'max' ? position.balance : amount;
    return {
      chainId: this.chainId,
      to: this.vaultAddress,
      data: encodeFunctionData({
        abi: metaMorphoAbi,
        functionName: 'withdraw',
        args: [assets, recipient, position.owner],
      }),
      description: `Morpho vault (${this.chain}:${this.vaultAddress}) withdraw ${
        amount === 'max' ? `~max (${assets})` : assets.toString()
      } of ${position.asset} to ${recipient}`,
    };
  }

  decodeEvents(logs: Log[]): ProtocolEvent[] {
    return logs.map((log) => ({
      protocol: 'morpho-vault',
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
