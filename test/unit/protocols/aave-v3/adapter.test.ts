import { encodeFunctionData, getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import { poolAbi } from '../../../../src/protocols/aave-v3/abi.js';
import { AaveV3Adapter, WITHDRAW_MAX } from '../../../../src/protocols/aave-v3/adapter.js';
import type {
  ContractCall,
  ContractCallResult,
  ContractReadClient,
} from '../../../../src/chain/client.js';
import { RpcPool, type NamedProvider } from '../../../../src/chain/rpc-pool.js';
import { AdapterError } from '../../../../src/core/errors.js';
import type { Address, BlockRef, Position } from '../../../../src/core/types.js';

/** A syntactically valid, correctly-checksummed 20-byte address for test fixtures —
 * `seed` is repeated/truncated to exactly 40 hex chars first (a hand-typed hex string
 * one digit short of 40 is invalid input everywhere from viem's ABI encoder to our
 * own `addressSchema` regex, and easy to get wrong by eye). */
function addr(seed: string): Address {
  const hex = seed.repeat(40).slice(0, 40);
  return getAddress(`0x${hex}`);
}

const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' as Address;
const ADDRESSES_PROVIDER = addr('1a');
const ORACLE = addr('2b');
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const ATOKEN = addr('3c');
const STABLE_DEBT = addr('4d');
const VARIABLE_DEBT = addr('5e');
const OWNER = addr('6f');
const RAY = 10n ** 27n;

const AT: BlockRef = { chainId: 1, number: 21_500_000n, hash: '0xblock', timestamp: 1_700_000_000 };

interface Scenario {
  totalAToken: bigint;
  totalStableDebt: bigint;
  totalVariableDebt: bigint;
  liquidityRate: bigint;
  variableBorrowRate: bigint;
  isActive: boolean;
  isFrozen: boolean;
  price: bigint;
  borrowCap: bigint;
  supplyCap: bigint;
  deficit: bigint;
  underlyingBalanceOfAToken: bigint;
  aTokenBalanceOfOwner: bigint;
  reservesList: Address[];
}

const defaultScenario: Scenario = {
  totalAToken: 1_000_000n,
  totalStableDebt: 0n,
  totalVariableDebt: 800_000n,
  liquidityRate: RAY / 20n, // 5%
  variableBorrowRate: RAY / 10n, // 10%
  isActive: true,
  isFrozen: false,
  price: 100_000_000n, // $1.00 at 8 decimals
  borrowCap: 0n,
  supplyCap: 0n,
  deficit: 0n,
  underlyingBalanceOfAToken: 200_000n,
  aTokenBalanceOfOwner: 5_000n,
  reservesList: [USDC],
};

/** A minimal fake `ContractReadClient` that answers every multicall entry the adapter
 * can issue, driven by one `Scenario`. Both mock providers in a pool share the same
 * scenario object so `quorumRead` sees agreeing values (a real two-provider RPC pool
 * would compare two independent nodes; here we're testing the adapter's own read/
 * decode logic, not cross-provider disagreement, which `rpc-pool.test.ts` already
 * covers). */
function mockContractReadClient(scenario: Scenario): ContractReadClient {
  const answer = (call: ContractCall): ContractCallResult => {
    switch (call.functionName) {
      case 'ADDRESSES_PROVIDER':
        return { status: 'success', result: ADDRESSES_PROVIDER };
      case 'getPriceOracle':
        return { status: 'success', result: ORACLE };
      case 'getReserveData':
        return {
          status: 'success',
          result: [
            0n,
            0n,
            scenario.totalAToken,
            scenario.totalStableDebt,
            scenario.totalVariableDebt,
            scenario.liquidityRate,
            scenario.variableBorrowRate,
            0n,
            0n,
            RAY,
            RAY,
            1_700_000_000,
          ],
        };
      case 'getReserveConfigurationData':
        return {
          status: 'success',
          result: [
            6n,
            8000n,
            8500n,
            10500n,
            1000n,
            true,
            true,
            false,
            scenario.isActive,
            scenario.isFrozen,
          ],
        };
      case 'getReserveTokensAddresses':
        return { status: 'success', result: [ATOKEN, STABLE_DEBT, VARIABLE_DEBT] };
      case 'getAssetPrice':
        return { status: 'success', result: scenario.price };
      case 'getReserveCaps':
        return { status: 'success', result: [scenario.borrowCap, scenario.supplyCap] };
      case 'getReserveDeficit':
        return { status: 'success', result: scenario.deficit };
      case 'getReservesList':
        return { status: 'success', result: scenario.reservesList };
      case 'balanceOf': {
        const [who] = call.args as [Address];
        if (who === ATOKEN)
          return { status: 'success', result: scenario.underlyingBalanceOfAToken };
        if (who === OWNER) return { status: 'success', result: scenario.aTokenBalanceOfOwner };
        return { status: 'success', result: 0n };
      }
      default:
        return { status: 'failure', error: new Error(`unmocked call: ${call.functionName}`) };
    }
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
  return new AaveV3Adapter({
    chain: 'ethereum',
    market: 'core',
    chainId: 1,
    watchedAssets: ['USDC'],
    pool: poolOf(scenario),
  });
}

describe('AaveV3Adapter', () => {
  it('has the spec-shaped id', () => {
    expect(makeAdapter().id).toBe('aave-v3:ethereum:core');
  });

  describe('snapshotMarkets', () => {
    it('reads reserve state and computes utilization/rates from ray-scaled values', async () => {
      const [snapshot] = await makeAdapter().snapshotMarkets(['USDC'], AT);
      expect(snapshot).toMatchObject({
        marketId: 'aave-v3:ethereum:core:USDC',
        totalSupplied: 1_000_000n,
        totalBorrowed: 800_000n,
        availableLiquidity: 200_000n,
        utilization: 0.8,
        supplyRate: 0.05,
        borrowRate: 0.1,
        flags: { paused: false, frozen: false },
        oraclePrices: { USDC: 100_000_000n },
        badDebt: 0n,
      });
    });

    it('flags a paused reserve (isActive=false) and a frozen one', async () => {
      const [snapshot] = await makeAdapter({
        ...defaultScenario,
        isActive: false,
        isFrozen: true,
      }).snapshotMarkets(['USDC'], AT);
      expect(snapshot!.flags).toEqual({ paused: true, frozen: true });
    });

    it('reports non-zero deficit as badDebt', async () => {
      const [snapshot] = await makeAdapter({ ...defaultScenario, deficit: 42n }).snapshotMarkets(
        ['USDC'],
        AT,
      );
      expect(snapshot!.badDebt).toBe(42n);
    });

    it('treats an empty reserve (zero supply) as zero utilization, not NaN/Infinity', async () => {
      const [snapshot] = await makeAdapter({
        ...defaultScenario,
        totalAToken: 0n,
        totalStableDebt: 0n,
        totalVariableDebt: 0n,
      }).snapshotMarkets(['USDC'], AT);
      expect(snapshot!.utilization).toBe(0);
    });

    it('throws AdapterError when a reserve read reverts', async () => {
      const scenario = { ...defaultScenario };
      const client = mockContractReadClient(scenario);
      const failing: ContractReadClient = {
        ...client,
        multicall: async (calls) => {
          const results = await client.multicall(calls, AT.number);
          return results.map((r, i) =>
            calls[i]!.functionName === 'getReserveData'
              ? ({ status: 'failure', error: new Error('reverted') } satisfies ContractCallResult)
              : r,
          );
        },
      };
      const pool = new RpcPool(
        [
          { name: 'a', client: failing },
          { name: 'b', client: failing },
        ],
        undefined,
        { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      );
      const adapter = new AaveV3Adapter({
        chain: 'ethereum',
        market: 'core',
        chainId: 1,
        watchedAssets: ['USDC'],
        pool,
      });
      await expect(adapter.snapshotMarkets(['USDC'], AT)).rejects.toThrow(AdapterError);
    });
  });

  describe('discoverPositions', () => {
    it('returns a position when the owner holds aTokens', async () => {
      const positions = await makeAdapter().discoverPositions(OWNER, AT);
      expect(positions).toEqual([
        {
          id: 'aave-v3:ethereum:core:USDC:' + OWNER,
          protocol: 'aave-v3',
          chainId: 1,
          marketId: 'aave-v3:ethereum:core:USDC',
          owner: OWNER,
          asset: USDC,
          balance: 5_000n,
        },
      ]);
    });

    it('returns no positions when the owner holds nothing', async () => {
      const positions = await makeAdapter({
        ...defaultScenario,
        aTokenBalanceOfOwner: 0n,
      }).discoverPositions(OWNER, AT);
      expect(positions).toEqual([]);
    });
  });

  describe('withdrawable', () => {
    const position: Position = {
      id: 'aave-v3:ethereum:core:USDC:' + OWNER,
      protocol: 'aave-v3',
      chainId: 1,
      marketId: 'aave-v3:ethereum:core:USDC',
      owner: OWNER,
      asset: USDC,
      balance: 5_000n,
    };

    it('caps availableNow at the pool liquidity when liquidity is short', async () => {
      const estimate = await makeAdapter({
        ...defaultScenario,
        underlyingBalanceOfAToken: 1_000n,
      }).withdrawable(position, AT);
      expect(estimate).toEqual({
        positionId: position.id,
        availableNow: 1_000n,
        totalPosition: 5_000n,
      });
    });

    it('returns the full position when liquidity exceeds it', async () => {
      const estimate = await makeAdapter().withdrawable(position, AT);
      expect(estimate).toEqual({
        positionId: position.id,
        availableNow: 5_000n,
        totalPosition: 5_000n,
      });
    });
  });

  describe('collateralExposure', () => {
    it('splits share of collateral base proportional to each reserve totalAToken', async () => {
      const WETH = addr('7a');
      const scenario: Scenario = { ...defaultScenario, reservesList: [USDC, WETH] };
      const client = mockContractReadClient(scenario);
      const syncClient: ContractReadClient = {
        ...client,
        multicall: (calls) =>
          Promise.resolve(
            calls.map((c): ContractCallResult => {
              if (c.functionName === 'getReserveData' && c.args?.[0] === WETH) {
                return {
                  status: 'success',
                  result: [0n, 0n, 3_000_000n, 0n, 0n, 0n, 0n, 0n, 0n, RAY, RAY, 0],
                };
              }
              if (c.functionName === 'getReserveData' && c.args?.[0] === USDC) {
                return {
                  status: 'success',
                  result: [
                    0n,
                    0n,
                    scenario.totalAToken,
                    scenario.totalStableDebt,
                    scenario.totalVariableDebt,
                    scenario.liquidityRate,
                    scenario.variableBorrowRate,
                    0n,
                    0n,
                    RAY,
                    RAY,
                    0,
                  ],
                };
              }
              if (c.functionName === 'getReservesList') {
                return { status: 'success', result: scenario.reservesList };
              }
              return { status: 'failure', error: new Error(`unmocked: ${c.functionName}`) };
            }),
          ),
      };

      const pool = new RpcPool(
        [
          { name: 'a', client: syncClient },
          { name: 'b', client: syncClient },
        ],
        undefined,
        { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      );
      const adapter = new AaveV3Adapter({
        chain: 'ethereum',
        market: 'core',
        chainId: 1,
        watchedAssets: ['USDC'],
        pool,
      });

      const exposure = await adapter.collateralExposure('aave-v3:ethereum:core', AT);
      const total = 1_000_000n + 3_000_000n;
      expect(exposure).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            asset: USDC,
            shareOfCollateralBase: Number(1_000_000n) / Number(total),
            method: 'approximate',
          }),
          expect.objectContaining({
            asset: WETH,
            shareOfCollateralBase: Number(3_000_000n) / Number(total),
            method: 'approximate',
          }),
        ]),
      );
    });

    it('returns zero shares when the whole pool has zero supply, without dividing by zero', async () => {
      const exposure = await makeAdapter({
        ...defaultScenario,
        totalAToken: 0n,
        reservesList: [USDC],
      }).collateralExposure('aave-v3:ethereum:core', AT);
      expect(exposure).toEqual([
        expect.objectContaining({ asset: USDC, shareOfCollateralBase: 0, method: 'approximate' }),
      ]);
    });
  });

  describe('buildWithdraw', () => {
    const position: Position = {
      id: 'aave-v3:ethereum:core:USDC:' + OWNER,
      protocol: 'aave-v3',
      chainId: 1,
      marketId: 'aave-v3:ethereum:core:USDC',
      owner: OWNER,
      asset: USDC,
      balance: 5_000n,
    };

    it('encodes withdraw() with the given amount', () => {
      const tx = makeAdapter().buildWithdraw(position, 1_000n, OWNER);
      expect(tx.to).toBe(POOL);
      expect(tx.chainId).toBe(1);
      expect(tx.data).toBe(
        encodeFunctionData({
          abi: poolAbi,
          functionName: 'withdraw',
          args: [USDC, 1_000n, OWNER],
        }),
      );
    });

    it("encodes 'max' as type(uint256).max, not the position balance", () => {
      const tx = makeAdapter().buildWithdraw(position, 'max', OWNER);
      expect(tx.data).toBe(
        encodeFunctionData({
          abi: poolAbi,
          functionName: 'withdraw',
          args: [USDC, WITHDRAW_MAX, OWNER],
        }),
      );
      expect(WITHDRAW_MAX).toBe(2n ** 256n - 1n);
    });
  });

  describe('decodeEvents', () => {
    // A second, real reserve on the same shared Pool/PoolConfigurator contract but
    // NOT in this adapter's watchedAssets (['USDC'] only) — the whole point of
    // these tests (found live, 2026-09-20: a large governance cleanup touching
    // dozens of unrelated reserves produced a false DANGER escalation for the
    // watched USDC position, because every reserve's events were previously
    // stamped with the same un-asset-scoped marketId regardless of which reserve
    // they were actually about).
    const WETH = addr('7e');

    it('normalizes a decoded log about the watched reserve into a ProtocolEvent, asset-scoped marketId', () => {
      const events = makeAdapter().decodeEvents([
        {
          address: POOL,
          blockNumber: 21_500_000n,
          transactionHash: '0xabc',
          logIndex: 3,
          eventName: 'Supply',
          args: { reserve: USDC, onBehalfOf: OWNER, amount: 1_000n },
        },
      ]);
      expect(events).toEqual([
        {
          protocol: 'aave-v3',
          chainId: 1,
          marketId: 'aave-v3:ethereum:core:USDC', // matches position.marketId's format elsewhere
          eventName: 'Supply',
          blockNumber: 21_500_000n,
          transactionHash: '0xabc',
          logIndex: 3,
          args: { reserve: USDC, onBehalfOf: OWNER, amount: 1_000n },
        },
      ]);
    });

    it('drops a pool-flow log about a reserve outside watchedAssets', () => {
      const events = makeAdapter().decodeEvents([
        {
          address: POOL,
          blockNumber: 21_500_000n,
          transactionHash: '0xabc',
          logIndex: 3,
          eventName: 'Supply',
          args: { reserve: WETH, onBehalfOf: OWNER, amount: 1_000n },
        },
      ]);
      expect(events).toEqual([]);
    });

    it('drops a governance (asset-keyed) log about a reserve outside watchedAssets', () => {
      const events = makeAdapter().decodeEvents([
        {
          address: addr('cc'),
          blockNumber: 21_500_000n,
          transactionHash: '0xdef',
          logIndex: 0,
          eventName: 'ReserveFrozen',
          args: { asset: WETH, frozen: true },
        },
      ]);
      expect(events).toEqual([]);
    });

    it('keeps a governance log about the watched reserve, asset-scoped marketId', () => {
      const events = makeAdapter().decodeEvents([
        {
          address: addr('cc'),
          blockNumber: 21_500_000n,
          transactionHash: '0xdef',
          logIndex: 0,
          eventName: 'SupplyCapChanged',
          args: { asset: USDC, oldSupplyCap: 100n, newSupplyCap: 1n },
        },
      ]);
      expect(events).toMatchObject([{ marketId: 'aave-v3:ethereum:core:USDC' }]);
    });

    it('keeps a LiquidationCall where only the debtAsset (not collateralAsset) is watched', () => {
      const events = makeAdapter().decodeEvents([
        {
          address: POOL,
          blockNumber: 21_500_000n,
          transactionHash: '0xghi',
          logIndex: 0,
          eventName: 'LiquidationCall',
          args: { collateralAsset: WETH, debtAsset: USDC, user: OWNER, debtToCover: 1n },
        },
      ]);
      expect(events).toMatchObject([{ marketId: 'aave-v3:ethereum:core:USDC' }]);
    });
  });
});
