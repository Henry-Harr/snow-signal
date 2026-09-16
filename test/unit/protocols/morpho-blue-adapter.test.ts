import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';

import { morphoAbi, morphoEventsAbi } from '../../../src/protocols/morpho-blue/abi.js';
import { MorphoBlueAdapter } from '../../../src/protocols/morpho-blue/adapter.js';
import { computeMorphoMarketId } from '../../../src/protocols/morpho-blue/market-id.js';
import type { Address, BlockRef, Position } from '../../../src/core/types.js';
import { encodeTestEventLog } from '../../fixtures/encode-event-log.js';
import { createSequentialMockReader, ok } from '../../fixtures/mock-contract-reader.js';

const MORPHO = '0x3333333333333333333333333333333333333333' as Address;
const OWNER = '0x6666666666666666666666666666666666666666' as Address;
const USDC = '0x1111111111111111111111111111111111111111' as Address;
const WETH = '0x2222222222222222222222222222222222222222' as Address;
const ORACLE = '0x7777777777777777777777777777777777777777' as Address;
const IRM = '0x8888888888888888888888888888888888888888' as Address;
const LLTV = 860000000000000000n; // 0.86e18

const MARKET_ID = computeMorphoMarketId({
  loanToken: USDC,
  collateralToken: WETH,
  oracle: ORACLE,
  irm: IRM,
  lltv: LLTV,
});

const AT: BlockRef = { chainId: 1, number: 100n, hash: '0xblock', timestamp: 1000 };

function makeAdapter(
  responses: Parameters<typeof createSequentialMockReader>[0],
  watchedMarketIds: `0x${string}`[] = [MARKET_ID],
) {
  return new MorphoBlueAdapter({
    id: 'morpho-blue:ethereum',
    chainId: 1,
    morpho: MORPHO,
    reader: createSequentialMockReader(responses),
    watchedMarketIds,
  });
}

const marketState = {
  totalSupplyAssets: 1_000_000n,
  totalSupplyShares: 1_000_000n * 10n ** 6n,
  totalBorrowAssets: 400_000n,
  totalBorrowShares: 400_000n * 10n ** 6n,
  lastUpdate: 1000n,
  fee: 0n,
};

const marketParams = [USDC, WETH, ORACLE, IRM, LLTV] as const;

describe('computeMorphoMarketId', () => {
  it('is deterministic for the same params and differs for different params', () => {
    const again = computeMorphoMarketId({
      loanToken: USDC,
      collateralToken: WETH,
      oracle: ORACLE,
      irm: IRM,
      lltv: LLTV,
    });
    expect(again).toBe(MARKET_ID);
    const different = computeMorphoMarketId({
      loanToken: WETH,
      collateralToken: USDC,
      oracle: ORACLE,
      irm: IRM,
      lltv: LLTV,
    });
    expect(different).not.toBe(MARKET_ID);
  });
});

describe('MorphoBlueAdapter.discoverPositions', () => {
  it('converts supply shares to assets using the virtual-shares formula and skips zero positions', async () => {
    const adapter = makeAdapter([
      [ok(marketState)], // readMarketState
      [ok(marketParams)], // readMarketParams
      [ok([500_000n * 10n ** 6n, 0n, 0n])], // position(): half the supply shares
    ]);

    const positions = await adapter.discoverPositions(OWNER, AT);
    expect(positions).toHaveLength(1);
    // toAssetsDown(shares, totalAssets, totalShares) = shares*(totalAssets+1)/(totalShares+1e6)
    const expected =
      (500_000n * 10n ** 6n * (marketState.totalSupplyAssets + 1n)) /
      (marketState.totalSupplyShares + 10n ** 6n);
    expect(positions[0]!.balance).toBe(expected);
    expect(positions[0]!.asset).toBe(USDC);
    expect((positions[0]!.raw as { supplyShares: bigint }).supplyShares).toBe(500_000n * 10n ** 6n);
  });

  it('returns an empty array when there are no watched markets', async () => {
    const adapter = makeAdapter([], []);
    expect(await adapter.discoverPositions(OWNER, AT)).toEqual([]);
  });

  it('skips a market where the owner has zero supply shares', async () => {
    const adapter = makeAdapter([[ok(marketState)], [ok(marketParams)], [ok([0n, 0n, 0n])]]);
    expect(await adapter.discoverPositions(OWNER, AT)).toEqual([]);
  });
});

describe('MorphoBlueAdapter.snapshotMarkets', () => {
  it('decodes market state and reads the price from the market-specific oracle', async () => {
    const adapter = makeAdapter([
      [ok(marketState)],
      [ok(marketParams)],
      [ok(2_000_000_000_000_000_000_000_000_000_000_000_000n)], // price(), 1e36 scale
    ]);
    const [snapshot] = await adapter.snapshotMarkets([MARKET_ID], AT);
    expect(snapshot).toMatchObject({
      marketId: MARKET_ID,
      totalSupplied: 1_000_000n,
      totalBorrowed: 400_000n,
      availableLiquidity: 600_000n,
      utilization: 0.4,
    });
    expect(snapshot!.oraclePrices[WETH.toLowerCase()]).toBe(
      2_000_000_000_000_000_000_000_000_000_000_000_000n,
    );
  });
});

describe('MorphoBlueAdapter.collateralExposure', () => {
  it('always returns exactly one entry at share 1 for the market collateral asset', async () => {
    const adapter = makeAdapter([[ok(marketParams)]]);
    const exposure = await adapter.collateralExposure(MARKET_ID, AT);
    expect(exposure).toEqual([{ marketId: MARKET_ID, asset: WETH, share: 1, method: 'exact' }]);
  });
});

describe('MorphoBlueAdapter.withdrawable', () => {
  it('caps withdrawableNow at the market available liquidity', async () => {
    const adapter = makeAdapter([[ok(marketState)]]);
    const position: Position = {
      id: 'p1',
      adapterId: 'morpho-blue:ethereum',
      chainId: 1,
      marketId: MARKET_ID,
      asset: USDC,
      owner: OWNER,
      balance: 900_000n,
      raw: { supplyShares: 900_000n * 10n ** 6n, marketParams },
    };
    const estimate = await adapter.withdrawable(position, AT);
    expect(estimate.withdrawableNow).toBe(600_000n); // availableLiquidity = 1,000,000 - 400,000
    expect(estimate.fullyWithdrawable).toBe(false);
  });
});

describe('MorphoBlueAdapter.buildWithdraw', () => {
  const position: Position = {
    id: 'p1',
    adapterId: 'morpho-blue:ethereum',
    chainId: 1,
    marketId: MARKET_ID,
    asset: USDC,
    owner: OWNER,
    balance: 500_000n,
    raw: { supplyShares: 500_000n * 10n ** 6n, marketParams },
  };

  it('encodes a partial withdraw by assets, with shares zeroed', () => {
    const adapter = makeAdapter([]);
    const tx = adapter.buildWithdraw(position, 100_000n, OWNER);
    expect(tx.to).toBe(MORPHO);
    const decoded = decodeFunctionData({ abi: morphoAbi, data: tx.data });
    expect(decoded.functionName).toBe('withdraw');
    const args = decoded.args as unknown as [unknown, bigint, bigint, Address, Address];
    expect(args[1]).toBe(100_000n); // assets
    expect(args[2]).toBe(0n); // shares
    expect(args[3]).toBe(OWNER); // onBehalf
    expect(args[4]).toBe(OWNER); // receiver
  });

  it('encodes a max withdraw by the full share balance, with assets zeroed', () => {
    const adapter = makeAdapter([]);
    const tx = adapter.buildWithdraw(position, 'max', OWNER);
    const decoded = decodeFunctionData({ abi: morphoAbi, data: tx.data });
    const args = decoded.args as unknown as [unknown, bigint, bigint, Address, Address];
    expect(args[1]).toBe(0n); // assets
    expect(args[2]).toBe(500_000n * 10n ** 6n); // shares
  });

  it('throws if position.raw.marketParams is missing', () => {
    const adapter = makeAdapter([]);
    const bare: Position = { ...position, raw: undefined };
    expect(() => adapter.buildWithdraw(bare, 'max', OWNER)).toThrow(/marketParams/);
  });
});

describe('MorphoBlueAdapter.decodeEvents', () => {
  it('decodes a Supply event', () => {
    const adapter = makeAdapter([]);
    const { data, topics } = encodeTestEventLog(morphoEventsAbi, 'Supply', {
      id: MARKET_ID,
      caller: OWNER,
      onBehalf: OWNER,
      assets: 1000n,
      shares: 1000n * 10n ** 6n,
    });
    const events = adapter.decodeEvents([
      { address: MORPHO, topics, data, blockNumber: 100n, transactionHash: '0xtx', logIndex: 0 },
    ]);
    expect(events[0]).toMatchObject({ kind: 'supply', marketId: MARKET_ID });
  });

  it('decodes a Liquidate event', () => {
    const adapter = makeAdapter([]);
    const { data, topics } = encodeTestEventLog(morphoEventsAbi, 'Liquidate', {
      id: MARKET_ID,
      caller: OWNER,
      borrower: OWNER,
      repaidAssets: 1n,
      repaidShares: 1n,
      seizedAssets: 1n,
      badDebtAssets: 0n,
      badDebtShares: 0n,
    });
    const events = adapter.decodeEvents([
      { address: MORPHO, topics, data, blockNumber: 100n, transactionHash: '0xtx', logIndex: 0 },
    ]);
    expect(events[0]).toMatchObject({ kind: 'liquidation', marketId: MARKET_ID });
  });
});
