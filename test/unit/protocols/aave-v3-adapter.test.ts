import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';

import { AAVE_WITHDRAW_MAX, poolAbi } from '../../../src/protocols/aave-v3/abi.js';
import { AaveV3Adapter } from '../../../src/protocols/aave-v3/adapter.js';
import type { Address, BlockRef, Position } from '../../../src/core/types.js';
import { encodeTestEventLog } from '../../fixtures/encode-event-log.js';
import { createSequentialMockReader, fail, ok } from '../../fixtures/mock-contract-reader.js';

const POOL = '0x3333333333333333333333333333333333333333' as Address;
const DATA_PROVIDER = '0x4444444444444444444444444444444444444444' as Address;
const ORACLE = '0x5555555555555555555555555555555555555555' as Address;
const OWNER = '0x6666666666666666666666666666666666666666' as Address;
const USDC = '0x1111111111111111111111111111111111111111' as Address;
const WETH = '0x2222222222222222222222222222222222222222' as Address;

const AT: BlockRef = { chainId: 1, number: 100n, hash: '0xblock', timestamp: 1000 };

function makeAdapter(responses: Parameters<typeof createSequentialMockReader>[0]) {
  return new AaveV3Adapter({
    id: 'aave-v3:ethereum:core',
    chainId: 1,
    addresses: { pool: POOL, protocolDataProvider: DATA_PROVIDER, oracle: ORACLE },
    reader: createSequentialMockReader(responses),
  });
}

describe('AaveV3Adapter.discoverPositions', () => {
  it('returns only reserves with a nonzero aToken balance', async () => {
    const adapter = makeAdapter([
      [ok([USDC, WETH])],
      [ok([1000n, 0n, 0n, 0n, 0n, 0n, 0n, 0, true]), ok([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0, true])],
    ]);

    const positions = await adapter.discoverPositions(OWNER, AT);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      marketId: USDC,
      asset: USDC,
      owner: OWNER,
      balance: 1000n,
    });
  });

  it('returns an empty array when the pool has no reserves', async () => {
    const adapter = makeAdapter([[ok([])]]);
    expect(await adapter.discoverPositions(OWNER, AT)).toEqual([]);
  });
});

describe('AaveV3Adapter.snapshotMarkets', () => {
  it('decodes a healthy reserve, computing utilization and availableLiquidity', async () => {
    const adapter = makeAdapter([
      [
        ok([0n, 0n, 1_000_000n, 0n, 400_000n, 5n * 10n ** 25n, 8n * 10n ** 25n, 0n, 0n, 0n, 0n, 0]),
        ok([6n, 8000n, 8250n, 10500n, 1000n, true, true, false, true, false]),
        ok(false),
        fail('getReserveDeficit reverted (pre-3.3 pool)'),
        ok(100_000_000n),
      ],
    ]);

    const [snapshot] = await adapter.snapshotMarkets([USDC], AT);
    expect(snapshot).toMatchObject({
      marketId: USDC,
      totalSupplied: 1_000_000n,
      totalBorrowed: 400_000n,
      availableLiquidity: 600_000n,
      utilization: 0.4,
      supplyRate: 0.05,
      borrowRate: 0.08,
      flags: { paused: false, frozen: false },
    });
    expect(snapshot!.oraclePrices[USDC.toLowerCase()]).toBe(100_000_000n);
    expect(snapshot!.badDebt).toBeUndefined();
  });

  it('sets badDebt when getReserveDeficit succeeds (Aave v3.3+)', async () => {
    const adapter = makeAdapter([
      [
        ok([0n, 0n, 1_000_000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0]),
        ok([6n, 8000n, 8250n, 10500n, 1000n, true, true, false, true, false]),
        ok(false),
        ok(12_345n),
        ok(100_000_000n),
      ],
    ]);
    const [snapshot] = await adapter.snapshotMarkets([USDC], AT);
    expect(snapshot!.badDebt).toBe(12_345n);
  });

  it('reports paused and frozen flags', async () => {
    const adapter = makeAdapter([
      [
        ok([0n, 0n, 1_000_000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0]),
        ok([6n, 8000n, 8250n, 10500n, 1000n, true, true, false, true, true]),
        ok(true),
        fail('no deficit tracking'),
        ok(100_000_000n),
      ],
    ]);
    const [snapshot] = await adapter.snapshotMarkets([USDC], AT);
    expect(snapshot!.flags).toEqual({ paused: true, frozen: true });
  });
});

describe('AaveV3Adapter.collateralExposure', () => {
  it('weights each collateral-enabled reserve by oracle-priced value, shares summing to 1', async () => {
    const adapter = makeAdapter([
      [ok([USDC, WETH])],
      [
        // USDC: 6 decimals, 1,000,000 raw = 1 token, price $1 (1e8)
        ok([6n, 8000n, 8250n, 10500n, 1000n, true, true, false, true, false]),
        ok([0n, 0n, 1_000_000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0]),
        ok(100_000_000n),
        // WETH: 18 decimals, 1e18 raw = 1 token, price $3000 (3e11)
        ok([18n, 8000n, 8250n, 10500n, 1000n, true, true, false, true, false]),
        ok([0n, 0n, 10n ** 18n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0]),
        ok(300_000_000_000n),
      ],
    ]);

    const exposure = await adapter.collateralExposure(USDC, AT);
    expect(exposure).toHaveLength(2);
    const totalShare = exposure.reduce((sum, e) => sum + e.share, 0);
    expect(totalShare).toBeCloseTo(1, 10);
    const weth = exposure.find((e) => e.asset === WETH);
    expect(weth!.share).toBeGreaterThan(0.99); // WETH dominates by USD value
    expect(exposure.every((e) => e.method === 'approximate')).toBe(true);
  });

  it('excludes reserves not enabled as collateral', async () => {
    const adapter = makeAdapter([
      [ok([USDC, WETH])],
      [
        ok([6n, 8000n, 8250n, 10500n, 1000n, false, true, false, true, false]), // not collateral-enabled
        ok([0n, 0n, 1_000_000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0]),
        ok(100_000_000n),
        ok([18n, 8000n, 8250n, 10500n, 1000n, true, true, false, true, false]),
        ok([0n, 0n, 10n ** 18n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0]),
        ok(300_000_000_000n),
      ],
    ]);
    const exposure = await adapter.collateralExposure(USDC, AT);
    expect(exposure).toHaveLength(1);
    expect(exposure[0]!.asset).toBe(WETH);
    expect(exposure[0]!.share).toBe(1);
  });
});

describe('AaveV3Adapter.withdrawable', () => {
  it('caps withdrawableNow at available liquidity', async () => {
    const adapter = makeAdapter([
      [ok([0n, 0n, 1_000_000n, 0n, 900_000n, 0n, 0n, 0n, 0n, 0n, 0n, 0])],
    ]);
    const position: Position = {
      id: 'p1',
      adapterId: 'aave-v3:ethereum:core',
      chainId: 1,
      marketId: USDC,
      asset: USDC,
      owner: OWNER,
      balance: 500_000n,
    };
    const estimate = await adapter.withdrawable(position, AT);
    expect(estimate.withdrawableNow).toBe(100_000n);
    expect(estimate.fullyWithdrawable).toBe(false);
  });

  it('is fully withdrawable when liquidity covers the whole balance', async () => {
    const adapter = makeAdapter([[ok([0n, 0n, 1_000_000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0])]]);
    const position: Position = {
      id: 'p1',
      adapterId: 'aave-v3:ethereum:core',
      chainId: 1,
      marketId: USDC,
      asset: USDC,
      owner: OWNER,
      balance: 500_000n,
    };
    const estimate = await adapter.withdrawable(position, AT);
    expect(estimate.withdrawableNow).toBe(500_000n);
    expect(estimate.fullyWithdrawable).toBe(true);
  });
});

describe('AaveV3Adapter.buildWithdraw', () => {
  const position: Position = {
    id: 'p1',
    adapterId: 'aave-v3:ethereum:core',
    chainId: 1,
    marketId: USDC,
    asset: USDC,
    owner: OWNER,
    balance: 500_000n,
  };

  it('encodes a partial withdraw with the given amount', () => {
    const adapter = makeAdapter([]);
    const tx = adapter.buildWithdraw(position, 100_000n, OWNER);
    expect(tx.to).toBe(POOL);
    expect(tx.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: poolAbi, data: tx.data });
    expect(decoded.functionName).toBe('withdraw');
    expect(decoded.args).toEqual([USDC, 100_000n, OWNER]);
  });

  it('encodes a max withdraw using the uint256 max sentinel', () => {
    const adapter = makeAdapter([]);
    const tx = adapter.buildWithdraw(position, 'max', OWNER);
    const decoded = decodeFunctionData({ abi: poolAbi, data: tx.data });
    expect(decoded.args).toEqual([USDC, AAVE_WITHDRAW_MAX, OWNER]);
  });
});

describe('AaveV3Adapter.decodeEvents', () => {
  it('decodes a Supply event', () => {
    const adapter = makeAdapter([]);
    const { data, topics } = encodeTestEventLog(poolAbi, 'Supply', {
      reserve: USDC,
      user: OWNER,
      onBehalfOf: OWNER,
      amount: 1000n,
      referralCode: 0,
    });
    const events = adapter.decodeEvents([
      { address: POOL, topics, data, blockNumber: 100n, transactionHash: '0xtx', logIndex: 0 },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'supply', marketId: USDC });
  });

  it('decodes a LiquidationCall event with marketId set to the collateral asset', () => {
    const adapter = makeAdapter([]);
    const { data, topics } = encodeTestEventLog(poolAbi, 'LiquidationCall', {
      collateralAsset: WETH,
      debtAsset: USDC,
      user: OWNER,
      debtToCover: 100n,
      liquidatedCollateralAmount: 1n,
      liquidator: OWNER,
      receiveAToken: false,
    });
    const events = adapter.decodeEvents([
      { address: POOL, topics, data, blockNumber: 100n, transactionHash: '0xtx', logIndex: 0 },
    ]);
    expect(events[0]).toMatchObject({ kind: 'liquidation', marketId: WETH });
  });

  it('silently skips logs that do not decode against this ABI', () => {
    const adapter = makeAdapter([]);
    const events = adapter.decodeEvents([
      {
        address: POOL,
        topics: ['0xdeadbeef'],
        data: '0x',
        blockNumber: 1n,
        transactionHash: '0xtx',
        logIndex: 0,
      },
    ]);
    expect(events).toEqual([]);
  });
});
