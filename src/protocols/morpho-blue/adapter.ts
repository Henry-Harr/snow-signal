import { encodeFunctionData } from 'viem';
import { z } from 'zod';

import { morphoBlueAbi, morphoIrmAbi, morphoOracleAbi } from './abi.js';
import { resolveMorphoBlueAddress } from './addresses.js';
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

function bytes32Schema() {
  return z.string().regex(/^0x[a-fA-F0-9]{64}$/) as unknown as z.ZodType<`0x${string}`>;
}

const nonNegativeBigint = z.bigint().nonnegative();

/** `Market` struct field order (src/interfaces/IMorpho.sol, verified 2026-09-16). */
const marketSchema = z.object({
  totalSupplyAssets: nonNegativeBigint,
  totalSupplyShares: nonNegativeBigint,
  totalBorrowAssets: nonNegativeBigint,
  totalBorrowShares: nonNegativeBigint,
  lastUpdate: nonNegativeBigint,
  fee: nonNegativeBigint,
});
type MarketData = z.infer<typeof marketSchema>;

/** `MarketParams` struct field order, same source. */
const marketParamsSchema = z.object({
  loanToken: addressSchema(),
  collateralToken: addressSchema(),
  oracle: addressSchema(),
  irm: addressSchema(),
  lltv: nonNegativeBigint,
});
type MarketParamsData = z.infer<typeof marketParamsSchema>;

// Unlike `market`/`idToMarketParams` (each a single named struct return, which viem
// decodes to a plain object), `position` is declared in the ABI as three separate
// top-level named outputs (matching the multi-output pattern in
// src/protocols/aave-v3/abi.ts) — viem decodes that shape as a positional tuple, not
// an object, confirmed directly against a real fork call (2026-09-16). Same
// ABI-encoded bytes either way (all fields are static-size), just a different
// decoded JS shape depending on how the ABI groups the outputs.
const positionSchema = z.tuple([nonNegativeBigint, nonNegativeBigint, nonNegativeBigint]);

/** Morpho's virtual-shares offset (`SharesMathLib.sol`, verified 2026-09-16) — added
 * to both sides of every shares<->assets conversion to make an empty market's first
 * deposit share-inflation-attack-resistant. `VIRTUAL_SHARES = 1e6`,
 * `VIRTUAL_ASSETS = 1`. */
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;

/** `shares.mulDivDown(totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES)` —
 * BigInt division already floors for non-negative operands, matching `mulDivDown`. */
function toAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
}

/** `assets.mulDivUp(totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS)` —
 * ceiling division via the standard `(a + b - 1) / b` BigInt trick. Used only to
 * estimate a "withdraw everything" share count for `buildWithdraw` (see its comment)
 * — rounding up here means the estimate very slightly over-, never under-, requests,
 * which `withdraw()` will simply clamp to the caller's actual share balance. */
function toSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  const numerator = assets * (totalShares + VIRTUAL_SHARES);
  const denominator = totalAssets + VIRTUAL_ASSETS;
  return (numerator + denominator - 1n) / denominator;
}

const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
const WAD = 10n ** 18n;

export interface MorphoBlueAdapterOptions {
  chain: string;
  chainId: ChainId;
  /** Market IDs (32-byte hex, e.g. `"0xa066f3...cb7f1f0"`) this adapter watches —
   * Morpho Blue markets are isolated and permissionless to create, so unlike Aave
   * there's no bounded "list every reserve" enumeration; the caller must say which
   * markets matter (matches config `positions[].marketId`). */
  watchedMarketIds: `0x${string}`[];
  pool: RpcPool<ContractReadClient>;
  logger?: Logger;
}

/** Morpho Blue protocol adapter (docs/SPEC.md #6.3). One instance watches every
 * market in `watchedMarketIds` on one chain. */
export class MorphoBlueAdapter implements ProtocolAdapter {
  readonly id: string;
  private readonly chain: string;
  private readonly chainId: ChainId;
  private readonly watchedMarketIds: `0x${string}`[];
  private readonly pool: RpcPool<ContractReadClient>;
  private readonly logger: Logger | undefined;
  private readonly morphoAddress: Address;

  /** Populated by every `readMarketAndParams` call, keyed by raw market id.
   * `buildWithdraw` is synchronous (per `ProtocolAdapter`) but Morpho's `withdraw()`
   * needs the full `MarketParams` struct, not just the id its keccak256 hashes to —
   * this cache is what lets it stay synchronous. In the real pipeline, something
   * always reads the market (a snapshot, a withdrawable() check) before a withdrawal
   * is ever planned, so the cache is populated by the time `buildWithdraw` runs. */
  private readonly marketCache = new Map<
    string,
    { market: MarketData; params: MarketParamsData }
  >();

  constructor(options: MorphoBlueAdapterOptions) {
    this.id = `morpho-blue:${options.chain}`;
    this.chain = options.chain;
    this.chainId = options.chainId;
    this.watchedMarketIds = options.watchedMarketIds;
    this.pool = options.pool;
    this.logger = options.logger;
    this.morphoAddress = resolveMorphoBlueAddress(options.chain);
  }

  private marketId(rawId: `0x${string}`): string {
    return `${this.id}:${rawId}`;
  }

  private async readMarketAndParams(
    rawId: `0x${string}`,
    at: BlockRef,
  ): Promise<{ market: MarketData; params: MarketParamsData }> {
    const calls: ContractCall[] = [
      { address: this.morphoAddress, abi: morphoBlueAbi, functionName: 'market', args: [rawId] },
      {
        address: this.morphoAddress,
        abi: morphoBlueAbi,
        functionName: 'idToMarketParams',
        args: [rawId],
      },
    ];
    const ctx = `${this.id}:${rawId}`;
    const results = await this.pool.quorumRead((client) => client.multicall(calls, at.number));
    const market = marketSchema.parse(unwrap(results[0], `${ctx} market()`));
    const params = marketParamsSchema.parse(unwrap(results[1], `${ctx} idToMarketParams()`));
    if (params.loanToken === '0x0000000000000000000000000000000000000000') {
      throw new AdapterError(`${ctx}: market does not exist (loanToken is zero address)`);
    }
    const entry = { market, params };
    this.marketCache.set(rawId, entry);
    return entry;
  }

  async snapshotMarkets(marketIds: string[], at: BlockRef): Promise<MarketSnapshot[]> {
    return Promise.all(marketIds.map((rawId) => this.snapshotOne(rawId as `0x${string}`, at)));
  }

  private async snapshotOne(rawId: `0x${string}`, at: BlockRef): Promise<MarketSnapshot> {
    const ctx = `${this.id}:${rawId}`;
    const { market, params } = await this.readMarketAndParams(rawId, at);

    // Oracle price is decision-critical (docs/SPEC.md #6.1) — quorum-read.
    const price = await this.pool.quorumRead(async (client) => {
      const [result] = await client.multicall(
        [{ address: params.oracle, abi: morphoOracleAbi, functionName: 'price' }],
        at.number,
      );
      return z
        .bigint()
        .nonnegative()
        .parse(unwrap(result, `${ctx} oracle.price()`));
    });

    // Borrow rate isn't decision-critical (not in spec #6.1's list) — best-effort.
    const borrowRatePerSecond = await this.pool.bestEffortRead(async (client) => {
      const [result] = await client.multicall(
        [
          {
            address: params.irm,
            abi: morphoIrmAbi,
            functionName: 'borrowRateView',
            args: [
              {
                loanToken: params.loanToken,
                collateralToken: params.collateralToken,
                oracle: params.oracle,
                irm: params.irm,
                lltv: params.lltv,
              },
              market,
            ],
          },
        ],
        at.number,
      );
      return z
        .bigint()
        .nonnegative()
        .parse(unwrap(result, `${ctx} irm.borrowRateView()`));
    });

    const availableLiquidity = market.totalSupplyAssets - market.totalBorrowAssets;
    const utilization =
      market.totalSupplyAssets === 0n
        ? 0
        : Number(market.totalBorrowAssets) / Number(market.totalSupplyAssets);
    const borrowRate = (Number(borrowRatePerSecond) / Number(WAD)) * Number(SECONDS_PER_YEAR);
    // Supply rate isn't exposed on-chain directly; it's the standard derivation from
    // the borrow rate, utilization, and protocol fee (interest borrowers pay, minus
    // the fee cut, spread across suppliers) — algebra from already-verified
    // primitives, not a separate protocol fact needing its own citation.
    const feeFraction = Number(market.fee) / Number(WAD);
    const supplyRate = borrowRate * utilization * (1 - feeFraction);

    return {
      marketId: this.marketId(rawId),
      block: at,
      totalSupplied: market.totalSupplyAssets,
      totalBorrowed: market.totalBorrowAssets,
      availableLiquidity,
      utilization,
      supplyRate,
      borrowRate,
      flags: { paused: false, frozen: false }, // Morpho Blue markets have no pause/freeze concept
      oraclePrices: { [params.collateralToken]: price },
      raw: { market, params, borrowRatePerSecond },
    };
  }

  /**
   * Exact by construction (docs/adr/0001): an isolated Morpho Blue market has exactly
   * one collateral asset, so it's either 100% of the market's collateral base or the
   * market currently has none. Per the ADR, "knowable from `totalBorrowAssets`" —
   * outstanding debt implies posted collateral backing it; a market with zero
   * borrowing is treated as having no meaningful collateral exposure yet, even if
   * someone deposited unused collateral (a real but practically negligible edge case,
   * noted here rather than hidden).
   */
  async collateralExposure(marketId: string, at: BlockRef): Promise<CollateralExposure[]> {
    const rawId = this.extractRawId(marketId);
    const { market, params } = await this.readMarketAndParams(rawId, at);
    return [
      {
        marketId,
        asset: params.collateralToken,
        shareOfCollateralBase: market.totalBorrowAssets > 0n ? 1 : 0,
        method: 'exact',
        raw: { totalBorrowAssets: market.totalBorrowAssets },
      },
    ];
  }

  private extractRawId(marketId: string): `0x${string}` {
    const prefix = `${this.id}:`;
    const rawId = marketId.startsWith(prefix) ? marketId.slice(prefix.length) : marketId;
    return bytes32Schema().parse(rawId);
  }

  async discoverPositions(owner: Address, at: BlockRef): Promise<Position[]> {
    const positions: Position[] = [];
    for (const rawId of this.watchedMarketIds) {
      const ctx = `${this.id}:${rawId}`;
      const { market, params } = await this.readMarketAndParams(rawId, at);

      const [supplyShares] = await this.pool.quorumRead(async (client) => {
        const [result] = await client.multicall(
          [
            {
              address: this.morphoAddress,
              abi: morphoBlueAbi,
              functionName: 'position',
              args: [rawId, owner],
            },
          ],
          at.number,
        );
        return positionSchema.parse(unwrap(result, `${ctx} position()`));
      });

      if (supplyShares > 0n) {
        const balance = toAssetsDown(
          supplyShares,
          market.totalSupplyAssets,
          market.totalSupplyShares,
        );
        positions.push({
          id: `${this.marketId(rawId)}:${owner}`,
          protocol: 'morpho-blue',
          chainId: this.chainId,
          marketId: this.marketId(rawId),
          owner,
          asset: params.loanToken,
          balance,
        });
      }
    }
    return positions;
  }

  async withdrawable(position: Position, at: BlockRef): Promise<WithdrawEstimate> {
    const rawId = this.extractRawId(position.marketId);
    const { market } = await this.readMarketAndParams(rawId, at);
    const availableLiquidity = market.totalSupplyAssets - market.totalBorrowAssets;
    const availableNow =
      availableLiquidity < position.balance ? availableLiquidity : position.balance;
    return { positionId: position.id, availableNow, totalPosition: position.balance };
  }

  /** Encodes `Morpho.withdraw(marketParams, assets, shares, onBehalf, receiver)`.
   * Needs `MarketParams`, not just the market id its hash commits to — pulled from
   * `marketCache` (see its doc comment), populated by whatever earlier snapshot or
   * `withdrawable()` call led to this withdrawal being planned in the first place.
   *
   * `'max'` is a best-effort estimate: Morpho requires "either `assets` or `shares`
   * should be zero", and a true full withdrawal needs the *exact* on-chain share
   * count (which `Position.balance`, already converted to assets, doesn't carry).
   * This estimates shares from the cached market state via `toSharesUp` — safety
   * rule 5 (simulate before sending) is what actually has to catch any drift between
   * this estimate and the live on-chain share balance by the time this is ever sent
   * for real (Phase 7+), not this function.
   */
  buildWithdraw(position: Position, amount: bigint | 'max', recipient: Address): TxRequest {
    const rawId = this.extractRawId(position.marketId);
    const cached = this.marketCache.get(rawId);
    if (!cached) {
      throw new AdapterError(
        `${this.id}:${rawId}: buildWithdraw needs a prior snapshotMarkets()/` +
          `withdrawable() call for this market so MarketParams is cached`,
      );
    }
    const { market, params } = cached;

    const assets = amount === 'max' ? 0n : amount;
    const shares =
      amount === 'max'
        ? toSharesUp(position.balance, market.totalSupplyAssets, market.totalSupplyShares)
        : 0n;

    return {
      chainId: this.chainId,
      to: this.morphoAddress,
      data: encodeFunctionData({
        abi: morphoBlueAbi,
        functionName: 'withdraw',
        args: [params, assets, shares, position.owner, recipient],
      }),
      description: `Morpho Blue (${this.chain}) withdraw ${
        amount === 'max' ? `~max (${shares} shares)` : assets.toString()
      } of ${position.asset} to ${recipient}`,
    };
  }

  decodeEvents(logs: Log[]): ProtocolEvent[] {
    return logs.map((log) => ({
      protocol: 'morpho-blue',
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
