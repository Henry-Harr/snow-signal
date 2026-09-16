import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';

import { erc4626Abi, metaMorphoEventsAbi } from '../../../src/protocols/morpho-vaults/abi.js';
import { MorphoVaultAdapter } from '../../../src/protocols/morpho-vaults/adapter.js';
import type { Address, BlockRef, Position } from '../../../src/core/types.js';
import { encodeTestEventLog } from '../../fixtures/encode-event-log.js';
import { createSequentialMockReader, ok } from '../../fixtures/mock-contract-reader.js';

const VAULT = '0x3333333333333333333333333333333333333333' as Address;
const MORPHO = '0x4444444444444444444444444444444444444444' as Address;
const OWNER = '0x6666666666666666666666666666666666666666' as Address;
const USDC = '0x1111111111111111111111111111111111111111' as Address;
const WETH = '0x2222222222222222222222222222222222222222' as Address;
const MARKET_ID = `0x${'ab'.repeat(32)}`;

const AT: BlockRef = { chainId: 1, number: 100n, hash: '0xblock', timestamp: 1000 };

function makeAdapter(responses: Parameters<typeof createSequentialMockReader>[0]) {
  return new MorphoVaultAdapter({
    id: 'morpho-vault:base:0x3333',
    chainId: 8453,
    vault: VAULT,
    morpho: MORPHO,
    reader: createSequentialMockReader(responses),
  });
}

describe('MorphoVaultAdapter.discoverPositions', () => {
  it('converts shares to assets and returns a single position', async () => {
    const adapter = makeAdapter([
      [ok(1000n), ok(USDC)], // balanceOf, asset (one multicall)
      [ok(1050n)], // convertToAssets
    ]);
    const positions = await adapter.discoverPositions(OWNER, AT);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      marketId: VAULT,
      asset: USDC,
      owner: OWNER,
      balance: 1050n,
    });
    expect((positions[0]!.raw as { shares: bigint }).shares).toBe(1000n);
  });

  it('returns an empty array when the owner holds no shares', async () => {
    const adapter = makeAdapter([[ok(0n), ok(USDC)]]);
    expect(await adapter.discoverPositions(OWNER, AT)).toEqual([]);
  });
});

describe('MorphoVaultAdapter.snapshotMarkets', () => {
  it('reports all-idle liquidity when the withdraw queue is empty', async () => {
    const adapter = makeAdapter([
      [ok(500_000n)], // totalAssets (snapshotMarkets' own call)
      [ok(0n)], // withdrawQueueLength
      [ok(500_000n)], // totalAssets (vaultWithdrawableLiquidity's own call)
    ]);
    const [snapshot] = await adapter.snapshotMarkets([VAULT], AT);
    expect(snapshot).toMatchObject({
      marketId: VAULT,
      totalSupplied: 500_000n,
      availableLiquidity: 500_000n,
    });
  });

  it('caps per-market availability at the smaller of vault allocation and market liquidity', async () => {
    const marketState = {
      totalSupplyAssets: 1_000_000n,
      totalSupplyShares: 1_000_000n * 10n ** 6n,
      totalBorrowAssets: 950_000n, // only 50,000 available in this market
      totalBorrowShares: 950_000n * 10n ** 6n,
      lastUpdate: 1n,
      fee: 0n,
    };
    const marketParams = [USDC, WETH, VAULT, VAULT, 0n] as const;
    // Vault holds all 100,000 of the market's supply shares scaled 1e6 -> ~100,000 assets
    const vaultPositionInMarket = [100_000n * 10n ** 6n, 0n, 0n] as const;

    const adapter = makeAdapter([
      [ok(600_000n)], // totalAssets (snapshotMarkets)
      [ok(1n)], // withdrawQueueLength
      [ok(MARKET_ID)], // withdrawQueue(0)
      [ok(marketState)], // market(id)
      [ok(marketParams)], // idToMarketParams(id)
      [ok(vaultPositionInMarket)], // position(id, vault)
      [ok(600_000n)], // totalAssets (vaultWithdrawableLiquidity's own call)
    ]);

    const [snapshot] = await adapter.snapshotMarkets([VAULT], AT);
    // vaultAssets in that market ~= 100,000 (rounding via toAssetsDown), capped at
    // marketAvailableLiquidity = 1,000,000 - 950,000 = 50,000; idle = 600,000 - ~100,000
    expect(snapshot!.availableLiquidity).toBeLessThan(600_000n);
    expect(snapshot!.availableLiquidity).toBeGreaterThan(500_000n);
  });
});

describe('MorphoVaultAdapter.collateralExposure', () => {
  it('returns look-through exposure weighted by allocation, summing to 1', async () => {
    const marketState = {
      totalSupplyAssets: 100_000n,
      totalSupplyShares: 100_000n * 10n ** 6n,
      totalBorrowAssets: 0n,
      totalBorrowShares: 0n,
      lastUpdate: 1n,
      fee: 0n,
    };
    const marketParams = [USDC, WETH, VAULT, VAULT, 0n] as const;
    const vaultPosition = [100_000n * 10n ** 6n, 0n, 0n] as const;

    const adapter = makeAdapter([
      [ok(1n)], // supplyQueueLength
      [ok(MARKET_ID)], // supplyQueue(0)
      [ok(marketState)], // market(id)
      [ok(marketParams)], // idToMarketParams(id)
      [ok(vaultPosition)], // position(id, vault)
    ]);

    const exposure = await adapter.collateralExposure(VAULT, AT);
    expect(exposure).toEqual([{ marketId: MARKET_ID, asset: WETH, share: 1, method: 'exact' }]);
  });

  it('returns an empty array when the vault has no allocation anywhere', async () => {
    const adapter = makeAdapter([[ok(0n)]]);
    expect(await adapter.collateralExposure(VAULT, AT)).toEqual([]);
  });
});

describe('MorphoVaultAdapter.withdrawable', () => {
  it('caps withdrawableNow at maxWithdraw', async () => {
    const adapter = makeAdapter([[ok(300n)]]);
    const position: Position = {
      id: 'p1',
      adapterId: 'morpho-vault:base:0x3333',
      chainId: 8453,
      marketId: VAULT,
      asset: USDC,
      owner: OWNER,
      balance: 1000n,
      raw: { shares: 950n },
    };
    const estimate = await adapter.withdrawable(position, AT);
    expect(estimate.withdrawableNow).toBe(300n);
    expect(estimate.fullyWithdrawable).toBe(false);
  });
});

describe('MorphoVaultAdapter.buildWithdraw', () => {
  const position: Position = {
    id: 'p1',
    adapterId: 'morpho-vault:base:0x3333',
    chainId: 8453,
    marketId: VAULT,
    asset: USDC,
    owner: OWNER,
    balance: 1000n,
    raw: { shares: 950n },
  };

  it('encodes redeem(shares, recipient, owner) for a max withdraw', () => {
    const adapter = makeAdapter([]);
    const tx = adapter.buildWithdraw(position, 'max', OWNER);
    expect(tx.to).toBe(VAULT);
    const decoded = decodeFunctionData({ abi: erc4626Abi, data: tx.data });
    expect(decoded.functionName).toBe('redeem');
    expect(decoded.args).toEqual([950n, OWNER, OWNER]);
  });

  it('throws for a partial amount (not yet supported)', () => {
    const adapter = makeAdapter([]);
    expect(() => adapter.buildWithdraw(position, 500n, OWNER)).toThrow(
      /only supports amount: 'max'/,
    );
  });

  it('throws if position.raw.shares is missing for a max withdraw', () => {
    const adapter = makeAdapter([]);
    expect(() => adapter.buildWithdraw({ ...position, raw: undefined }, 'max', OWNER)).toThrow(
      /raw\.shares/,
    );
  });
});

describe('MorphoVaultAdapter.decodeEvents', () => {
  it('decodes a SetCurator event', () => {
    const adapter = makeAdapter([]);
    const { data, topics } = encodeTestEventLog(metaMorphoEventsAbi, 'SetCurator', {
      newCurator: OWNER,
    });
    const events = adapter.decodeEvents([
      { address: VAULT, topics, data, blockNumber: 1n, transactionHash: '0xtx', logIndex: 0 },
    ]);
    expect(events[0]).toMatchObject({ kind: 'other', marketId: VAULT });
    expect((events[0]!.data as { eventName: string }).eventName).toBe('SetCurator');
  });
});
