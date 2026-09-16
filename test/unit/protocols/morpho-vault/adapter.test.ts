import { encodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';

import { metaMorphoAbi } from '../../../../src/protocols/morpho-vault/abi.js';
import { MorphoVaultAdapter } from '../../../../src/protocols/morpho-vault/adapter.js';
import { toAssetsDown } from '../../../../src/protocols/morpho-blue/shares-math.js';
import type {
  ContractCall,
  ContractCallResult,
  ContractReadClient,
} from '../../../../src/chain/client.js';
import { RpcPool, type NamedProvider } from '../../../../src/chain/rpc-pool.js';
import type { BlockRef, Position } from '../../../../src/core/types.js';

function addr(seed: string): `0x${string}` {
  return `0x${seed.repeat(40).slice(0, 40)}`;
}

function id32(seed: string): `0x${string}` {
  return `0x${seed.repeat(64).slice(0, 64)}`;
}

const VAULT = addr('e1');
const MORPHO_BLUE = addr('bb');
const UNDERLYING = addr('a5');
const OWNER_ROLE = addr('01');
const CURATOR = addr('02');
const GUARDIAN = addr('03');
const FEE_RECIPIENT = addr('04');
const HOLDER = addr('55');
const RECIPIENT = addr('66');

const MARKET_A = id32('a1');
const COLLATERAL_A = addr('c1');
const MARKET_B = id32('b2');
const COLLATERAL_B = addr('c2');

const AT: BlockRef = {
  chainId: 8453,
  number: 34_000_000n,
  hash: '0xblock',
  timestamp: 1_700_000_000,
};

interface MarketFixture {
  id: `0x${string}`;
  collateralToken: `0x${string}`;
  cap: bigint;
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  vaultSupplyShares: bigint;
}

interface Scenario {
  totalAssets: bigint;
  idleAssets: bigint;
  supplyQueue: `0x${string}`[];
  withdrawQueue: `0x${string}`[];
  markets: MarketFixture[];
  shareBalance: bigint;
  convertedAssets: bigint;
  maxWithdraw: bigint;
}

const marketA: MarketFixture = {
  id: MARKET_A,
  collateralToken: COLLATERAL_A,
  cap: 5_000_000n,
  totalSupplyAssets: 2_000_000n,
  totalSupplyShares: 2_000_000_000_000n,
  totalBorrowAssets: 1_500_000n, // marketAvailableLiquidity = 500,000
  vaultSupplyShares: 900_000_000_000n,
};

const marketB: MarketFixture = {
  id: MARKET_B,
  collateralToken: COLLATERAL_B,
  cap: 1_000_000n,
  totalSupplyAssets: 800_000n,
  totalSupplyShares: 800_000_000_000n,
  totalBorrowAssets: 100_000n, // marketAvailableLiquidity = 700,000
  vaultSupplyShares: 300_000_000_000n,
};

const defaultScenario: Scenario = {
  totalAssets: 1_000_000n,
  idleAssets: 100_000n,
  supplyQueue: [MARKET_A, MARKET_B],
  withdrawQueue: [MARKET_A, MARKET_B],
  markets: [marketA, marketB],
  shareBalance: 500_000_000n,
  convertedAssets: 480_000n,
  maxWithdraw: 480_000n,
};

function vaultAssetsOf(market: MarketFixture): bigint {
  return toAssetsDown(market.vaultSupplyShares, market.totalSupplyAssets, market.totalSupplyShares);
}

function mockContractReadClient(scenario: Scenario): ContractReadClient {
  const marketsById = new Map(scenario.markets.map((m) => [m.id, m]));

  const answer = (call: ContractCall): ContractCallResult => {
    if (call.address === VAULT) {
      switch (call.functionName) {
        case 'MORPHO':
          return { status: 'success', result: MORPHO_BLUE };
        case 'owner':
          return { status: 'success', result: OWNER_ROLE };
        case 'curator':
          return { status: 'success', result: CURATOR };
        case 'guardian':
          return { status: 'success', result: GUARDIAN };
        case 'fee':
          return { status: 'success', result: 100_000_000_000_000_000n }; // 10%
        case 'feeRecipient':
          return { status: 'success', result: FEE_RECIPIENT };
        case 'timelock':
          return { status: 'success', result: 86_400n };
        case 'pendingTimelock':
          return { status: 'success', result: { value: 0n, validAt: 0n } };
        case 'pendingGuardian':
          return {
            status: 'success',
            result: { value: '0x0000000000000000000000000000000000000000', validAt: 0n },
          };
        case 'supplyQueueLength':
          return { status: 'success', result: BigInt(scenario.supplyQueue.length) };
        case 'withdrawQueueLength':
          return { status: 'success', result: BigInt(scenario.withdrawQueue.length) };
        case 'totalAssets':
          return { status: 'success', result: scenario.totalAssets };
        case 'asset':
          return { status: 'success', result: UNDERLYING };
        case 'supplyQueue': {
          const [index] = call.args as [bigint];
          return { status: 'success', result: scenario.supplyQueue[Number(index)]! };
        }
        case 'withdrawQueue': {
          const [index] = call.args as [bigint];
          return { status: 'success', result: scenario.withdrawQueue[Number(index)]! };
        }
        case 'config': {
          const [marketId] = call.args as [`0x${string}`];
          const market = marketsById.get(marketId)!;
          return { status: 'success', result: { cap: market.cap, enabled: true, removableAt: 0n } };
        }
        case 'balanceOf': {
          return { status: 'success', result: scenario.shareBalance };
        }
        case 'convertToAssets':
          return { status: 'success', result: scenario.convertedAssets };
        case 'maxWithdraw':
          return { status: 'success', result: scenario.maxWithdraw };
        default:
          return {
            status: 'failure',
            error: new Error(`unmocked vault call: ${call.functionName}`),
          };
      }
    }

    if (call.address === MORPHO_BLUE) {
      const [marketId] = call.args as [`0x${string}`];
      const market = marketsById.get(marketId)!;
      switch (call.functionName) {
        case 'market':
          return {
            status: 'success',
            result: {
              totalSupplyAssets: market.totalSupplyAssets,
              totalSupplyShares: market.totalSupplyShares,
              totalBorrowAssets: market.totalBorrowAssets,
              totalBorrowShares: market.totalBorrowAssets, // not exercised by this adapter
              lastUpdate: 1_700_000_000n,
              fee: 0n,
            },
          };
        case 'idToMarketParams':
          return {
            status: 'success',
            result: {
              loanToken: UNDERLYING,
              collateralToken: market.collateralToken,
              oracle: addr('fa'),
              irm: addr('fb'),
              lltv: 860_000_000_000_000_000n,
            },
          };
        case 'position':
          return { status: 'success', result: [market.vaultSupplyShares, 0n, 0n] };
        default:
          return {
            status: 'failure',
            error: new Error(`unmocked blue call: ${call.functionName}`),
          };
      }
    }

    if (call.address === UNDERLYING && call.functionName === 'balanceOf') {
      return { status: 'success', result: scenario.idleAssets };
    }

    return {
      status: 'failure',
      error: new Error(`unmocked call: ${call.functionName} @ ${call.address}`),
    };
  };

  return {
    getBlockNumber: () => Promise.resolve(AT.number),
    getBlock: () =>
      Promise.resolve({
        number: AT.number,
        hash: '0xblock',
        parentHash: '0xparent',
        timestamp: 0n,
      }),
    multicall: (calls) => Promise.resolve(calls.map(answer)),
    getLogs: () => Promise.resolve([]),
  };
}

function poolOf(scenario: Scenario = defaultScenario): RpcPool<ContractReadClient> {
  const providers: NamedProvider<ContractReadClient>[] = [
    { name: 'a', client: mockContractReadClient(scenario) },
    { name: 'b', client: mockContractReadClient(scenario) },
  ];
  return new RpcPool(providers, undefined, { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 });
}

function makeAdapter(scenario: Scenario = defaultScenario) {
  return new MorphoVaultAdapter({
    chain: 'base',
    chainId: 8453,
    vaultAddress: VAULT,
    pool: poolOf(scenario),
  });
}

describe('MorphoVaultAdapter', () => {
  it('has the spec-shaped id', () => {
    expect(makeAdapter().id).toBe(`morpho-vault:base:${VAULT}`);
  });

  describe('snapshotMarkets', () => {
    it('computes vault withdrawable liquidity as idle + min(vaultSupply, marketLiquidity) per withdraw-queue market', async () => {
      const [snapshot] = await makeAdapter().snapshotMarkets([], AT);
      const aVaultAssets = vaultAssetsOf(marketA);
      const bVaultAssets = vaultAssetsOf(marketB);
      const aLiquidity = marketA.totalSupplyAssets - marketA.totalBorrowAssets; // 500,000
      const bLiquidity = marketB.totalSupplyAssets - marketB.totalBorrowAssets; // 700,000
      const expectedAvailable =
        defaultScenario.idleAssets +
        (aVaultAssets < aLiquidity ? aVaultAssets : aLiquidity) +
        (bVaultAssets < bLiquidity ? bVaultAssets : bLiquidity);

      expect(snapshot!.marketId).toBe(`morpho-vault:base:${VAULT}`);
      expect(snapshot!.totalSupplied).toBe(defaultScenario.totalAssets);
      expect(snapshot!.totalBorrowed).toBe(0n);
      expect(snapshot!.availableLiquidity).toBe(expectedAvailable);
      expect(snapshot!.flags).toEqual({ paused: false, frozen: false });
      expect(snapshot!.oraclePrices).toEqual({});
    });

    it('excludes a market from the liquidity sum when it is not in the withdraw queue', async () => {
      const scenario: Scenario = {
        ...defaultScenario,
        withdrawQueue: [MARKET_A], // B removed from withdraw queue, still in supply queue
      };
      const [snapshot] = await makeAdapter(scenario).snapshotMarkets([], AT);
      const aVaultAssets = vaultAssetsOf(marketA);
      const aLiquidity = marketA.totalSupplyAssets - marketA.totalBorrowAssets;
      const expectedAvailable =
        scenario.idleAssets + (aVaultAssets < aLiquidity ? aVaultAssets : aLiquidity);
      expect(snapshot!.availableLiquidity).toBe(expectedAvailable);
    });

    it('utilization is the share of assets not immediately withdrawable', async () => {
      const [snapshot] = await makeAdapter().snapshotMarkets([], AT);
      const expected =
        1 - Number(snapshot!.availableLiquidity) / Number(defaultScenario.totalAssets);
      expect(snapshot!.utilization).toBeCloseTo(expected, 10);
    });

    it('treats zero totalAssets as zero utilization, not a division by zero', async () => {
      const scenario: Scenario = { ...defaultScenario, totalAssets: 0n };
      const [snapshot] = await makeAdapter(scenario).snapshotMarkets([], AT);
      expect(snapshot!.utilization).toBe(0);
    });

    it('carries roles, timelock, and per-market allocation in raw', async () => {
      const [snapshot] = await makeAdapter().snapshotMarkets([], AT);
      const raw = snapshot!.raw as {
        roles: { owner: string; curator: string; guardian: string };
        timelock: bigint;
        allocations: { id: string; cap: bigint }[];
      };
      expect(raw.roles).toEqual({ owner: OWNER_ROLE, curator: CURATOR, guardian: GUARDIAN });
      expect(raw.timelock).toBe(86_400n);
      expect(raw.allocations).toHaveLength(2);
    });
  });

  describe('collateralExposure', () => {
    it('groups look-through exposure by each underlying market collateral asset', async () => {
      const exposure = await makeAdapter().collateralExposure(`morpho-vault:base:${VAULT}`, AT);
      const aVaultAssets = vaultAssetsOf(marketA);
      const bVaultAssets = vaultAssetsOf(marketB);
      expect(exposure).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            asset: COLLATERAL_A,
            shareOfCollateralBase: Number(aVaultAssets) / Number(defaultScenario.totalAssets),
            method: 'exact',
          }),
          expect.objectContaining({
            asset: COLLATERAL_B,
            shareOfCollateralBase: Number(bVaultAssets) / Number(defaultScenario.totalAssets),
            method: 'exact',
          }),
        ]),
      );
    });

    it('returns nothing when the vault has zero assets', async () => {
      const scenario: Scenario = { ...defaultScenario, totalAssets: 0n };
      const exposure = await makeAdapter(scenario).collateralExposure(
        `morpho-vault:base:${VAULT}`,
        AT,
      );
      expect(exposure).toEqual([]);
    });
  });

  describe('discoverPositions', () => {
    it('converts vault shares to assets via convertToAssets when the holder has shares', async () => {
      const positions = await makeAdapter().discoverPositions(HOLDER, AT);
      expect(positions).toEqual([
        {
          id: `morpho-vault:base:${VAULT}:${HOLDER}`,
          protocol: 'morpho-vault',
          chainId: 8453,
          marketId: `morpho-vault:base:${VAULT}`,
          owner: HOLDER,
          asset: UNDERLYING,
          balance: defaultScenario.convertedAssets,
        },
      ]);
    });

    it('returns no positions when the holder has zero shares', async () => {
      const scenario: Scenario = { ...defaultScenario, shareBalance: 0n };
      const positions = await makeAdapter(scenario).discoverPositions(HOLDER, AT);
      expect(positions).toEqual([]);
    });
  });

  describe('withdrawable', () => {
    const position: Position = {
      id: `morpho-vault:base:${VAULT}:${HOLDER}`,
      protocol: 'morpho-vault',
      chainId: 8453,
      marketId: `morpho-vault:base:${VAULT}`,
      owner: HOLDER,
      asset: UNDERLYING,
      balance: 480_000n,
    };

    it('caps availableNow at maxWithdraw when it is below the position balance', async () => {
      const scenario: Scenario = { ...defaultScenario, maxWithdraw: 200_000n };
      const estimate = await makeAdapter(scenario).withdrawable(position, AT);
      expect(estimate).toEqual({
        positionId: position.id,
        availableNow: 200_000n,
        totalPosition: 480_000n,
      });
    });

    it('never exceeds the position balance even if maxWithdraw reports more', async () => {
      const scenario: Scenario = { ...defaultScenario, maxWithdraw: 999_999n };
      const estimate = await makeAdapter(scenario).withdrawable(position, AT);
      expect(estimate.availableNow).toBe(480_000n);
    });
  });

  describe('buildWithdraw', () => {
    const position: Position = {
      id: `morpho-vault:base:${VAULT}:${HOLDER}`,
      protocol: 'morpho-vault',
      chainId: 8453,
      marketId: `morpho-vault:base:${VAULT}`,
      owner: HOLDER,
      asset: UNDERLYING,
      balance: 480_000n,
    };

    it('encodes an exact-amount withdraw', () => {
      const tx = makeAdapter().buildWithdraw(position, 100_000n, RECIPIENT);
      expect(tx.to).toBe(VAULT);
      expect(tx.chainId).toBe(8453);
      expect(tx.data).toBe(
        encodeFunctionData({
          abi: metaMorphoAbi,
          functionName: 'withdraw',
          args: [100_000n, RECIPIENT, HOLDER],
        }),
      );
    });

    it("encodes 'max' using the position's known balance", () => {
      const tx = makeAdapter().buildWithdraw(position, 'max', RECIPIENT);
      expect(tx.data).toBe(
        encodeFunctionData({
          abi: metaMorphoAbi,
          functionName: 'withdraw',
          args: [480_000n, RECIPIENT, HOLDER],
        }),
      );
    });
  });

  describe('decodeEvents', () => {
    it('normalizes a decoded log into a ProtocolEvent', () => {
      const events = makeAdapter().decodeEvents([
        {
          address: VAULT,
          blockNumber: 34_000_000n,
          transactionHash: '0xabc',
          logIndex: 1,
          eventName: 'SetCap',
          args: { id: MARKET_A, cap: 5_000_000n },
        },
      ]);
      expect(events).toEqual([
        {
          protocol: 'morpho-vault',
          chainId: 8453,
          marketId: `morpho-vault:base:${VAULT}`,
          eventName: 'SetCap',
          blockNumber: 34_000_000n,
          transactionHash: '0xabc',
          logIndex: 1,
          args: { id: MARKET_A, cap: 5_000_000n },
        },
      ]);
    });
  });
});
