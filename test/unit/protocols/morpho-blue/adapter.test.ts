import { encodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';

import { morphoBlueAbi } from '../../../../src/protocols/morpho-blue/abi.js';
import { MorphoBlueAdapter } from '../../../../src/protocols/morpho-blue/adapter.js';
import type {
  ContractCall,
  ContractCallResult,
  ContractReadClient,
} from '../../../../src/chain/client.js';
import { RpcPool, type NamedProvider } from '../../../../src/chain/rpc-pool.js';
import { AdapterError } from '../../../../src/core/errors.js';
import type { BlockRef, Position } from '../../../../src/core/types.js';

function addr(seed: string): `0x${string}` {
  return `0x${seed.repeat(40).slice(0, 40)}`;
}

function id32(seed: string): `0x${string}` {
  return `0x${seed.repeat(64).slice(0, 64)}`;
}

const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const MARKET_ID = id32('a1');
const LOAN_TOKEN = addr('11');
const COLLATERAL_TOKEN = addr('22');
const ORACLE = addr('33');
const IRM = addr('44');
const OWNER = addr('55');
const RECIPIENT = addr('66');

const AT: BlockRef = {
  chainId: 8453,
  number: 34_000_000n,
  hash: '0xblock',
  timestamp: 1_700_000_000,
};
const WAD = 10n ** 18n;

interface Scenario {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  fee: bigint;
  price: bigint;
  borrowRatePerSecond: bigint;
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
}

const defaultScenario: Scenario = {
  totalSupplyAssets: 1_000_000_000n, // 1000 USDC (6 decimals)
  totalSupplyShares: 1_000_000_000_000_000n, // arbitrary share count
  totalBorrowAssets: 800_000_000n,
  totalBorrowShares: 800_000_000_000_000n,
  fee: 0n,
  price: 3_000n * 10n ** 36n, // 1 collateral = 3000 loan-token units, 1e36-scaled
  borrowRatePerSecond: WAD / 1_000_000_000n, // a small, plausible per-second rate
  supplyShares: 0n,
  borrowShares: 0n,
  collateral: 0n,
};

function mockContractReadClient(scenario: Scenario): ContractReadClient {
  const answer = (call: ContractCall): ContractCallResult => {
    switch (call.functionName) {
      case 'market':
        return {
          status: 'success',
          result: {
            totalSupplyAssets: scenario.totalSupplyAssets,
            totalSupplyShares: scenario.totalSupplyShares,
            totalBorrowAssets: scenario.totalBorrowAssets,
            totalBorrowShares: scenario.totalBorrowShares,
            lastUpdate: 1_700_000_000n,
            fee: scenario.fee,
          },
        };
      case 'idToMarketParams':
        return {
          status: 'success',
          result: {
            loanToken: LOAN_TOKEN,
            collateralToken: COLLATERAL_TOKEN,
            oracle: ORACLE,
            irm: IRM,
            lltv: (86n * WAD) / 100n,
          },
        };
      case 'position':
        return {
          status: 'success',
          result: [scenario.supplyShares, scenario.borrowShares, scenario.collateral],
        };
      case 'price':
        return { status: 'success', result: scenario.price };
      case 'borrowRateView':
        return { status: 'success', result: scenario.borrowRatePerSecond };
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
  return new MorphoBlueAdapter({
    chain: 'base',
    chainId: 8453,
    watchedMarketIds: [MARKET_ID],
    pool: poolOf(scenario),
  });
}

describe('MorphoBlueAdapter', () => {
  it('has the spec-shaped id', () => {
    expect(makeAdapter().id).toBe('morpho-blue:base');
  });

  describe('snapshotMarkets', () => {
    it('reads market state and computes utilization/liquidity/oracle price', async () => {
      const [snapshot] = await makeAdapter().snapshotMarkets([MARKET_ID], AT);
      expect(snapshot).toMatchObject({
        marketId: `morpho-blue:base:${MARKET_ID}`,
        totalSupplied: 1_000_000_000n,
        totalBorrowed: 800_000_000n,
        availableLiquidity: 200_000_000n,
        utilization: 0.8,
        flags: { paused: false, frozen: false },
        oraclePrices: { [COLLATERAL_TOKEN]: 3_000n * 10n ** 36n },
      });
    });

    it('annualizes the per-second borrow rate and derives supply rate from utilization/fee', async () => {
      const [snapshot] = await makeAdapter({
        ...defaultScenario,
        borrowRatePerSecond: WAD / 10_000_000n, // ~3.15/year in WAD terms before /1e18
        fee: WAD / 10n, // 10% fee
      }).snapshotMarkets([MARKET_ID], AT);
      const expectedBorrowRate = (1 / 10_000_000) * (365 * 24 * 60 * 60);
      expect(snapshot!.borrowRate).toBeCloseTo(expectedBorrowRate, 6);
      expect(snapshot!.supplyRate).toBeCloseTo(expectedBorrowRate * 0.8 * 0.9, 6);
    });

    it('treats zero supply as zero utilization, not a division by zero', async () => {
      const [snapshot] = await makeAdapter({
        ...defaultScenario,
        totalSupplyAssets: 0n,
        totalBorrowAssets: 0n,
      }).snapshotMarkets([MARKET_ID], AT);
      expect(snapshot!.utilization).toBe(0);
    });

    it('throws AdapterError for a market that does not exist (zero loanToken)', async () => {
      const scenario = { ...defaultScenario };
      const client = mockContractReadClient(scenario);
      const nonexistent: ContractReadClient = {
        ...client,
        multicall: async (calls) => {
          const results = await client.multicall(calls, AT.number);
          return results.map((r, i) =>
            calls[i]!.functionName === 'idToMarketParams'
              ? ({
                  status: 'success',
                  result: {
                    loanToken: '0x0000000000000000000000000000000000000000',
                    collateralToken: COLLATERAL_TOKEN,
                    oracle: ORACLE,
                    irm: IRM,
                    lltv: 0n,
                  },
                } satisfies ContractCallResult)
              : r,
          );
        },
      };
      const pool = new RpcPool(
        [
          { name: 'a', client: nonexistent },
          { name: 'b', client: nonexistent },
        ],
        undefined,
        { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      );
      const adapter = new MorphoBlueAdapter({
        chain: 'base',
        chainId: 8453,
        watchedMarketIds: [MARKET_ID],
        pool,
      });
      await expect(adapter.snapshotMarkets([MARKET_ID], AT)).rejects.toThrow(AdapterError);
    });
  });

  describe('collateralExposure', () => {
    it('is 100% (exact) when the market has outstanding borrows', async () => {
      const exposure = await makeAdapter().collateralExposure(`morpho-blue:base:${MARKET_ID}`, AT);
      expect(exposure).toEqual([
        {
          marketId: `morpho-blue:base:${MARKET_ID}`,
          asset: COLLATERAL_TOKEN,
          shareOfCollateralBase: 1,
          method: 'exact',
          raw: { totalBorrowAssets: 800_000_000n },
        },
      ]);
    });

    it('is 0% when the market has no outstanding borrows', async () => {
      const exposure = await makeAdapter({
        ...defaultScenario,
        totalBorrowAssets: 0n,
      }).collateralExposure(`morpho-blue:base:${MARKET_ID}`, AT);
      expect(exposure[0]!.shareOfCollateralBase).toBe(0);
    });
  });

  describe('discoverPositions', () => {
    it('converts supplyShares to assets via the virtual-shares formula', async () => {
      // toAssetsDown(shares, totalAssets, totalShares) =
      //   shares * (totalAssets + 1) / (totalShares + 1e6), floored.
      const scenario: Scenario = {
        ...defaultScenario,
        supplyShares: 500_000_000_000_000n,
      };
      const positions = await makeAdapter(scenario).discoverPositions(OWNER, AT);
      const expectedBalance =
        (scenario.supplyShares * (scenario.totalSupplyAssets + 1n)) /
        (scenario.totalSupplyShares + 1_000_000n);
      expect(positions).toEqual([
        {
          id: `morpho-blue:base:${MARKET_ID}:${OWNER}`,
          protocol: 'morpho-blue',
          chainId: 8453,
          marketId: `morpho-blue:base:${MARKET_ID}`,
          owner: OWNER,
          asset: LOAN_TOKEN,
          balance: expectedBalance,
        },
      ]);
      expect(expectedBalance).toBeGreaterThan(0n);
    });

    it('returns no positions when supplyShares is zero', async () => {
      const positions = await makeAdapter().discoverPositions(OWNER, AT);
      expect(positions).toEqual([]);
    });
  });

  describe('withdrawable', () => {
    const position: Position = {
      id: `morpho-blue:base:${MARKET_ID}:${OWNER}`,
      protocol: 'morpho-blue',
      chainId: 8453,
      marketId: `morpho-blue:base:${MARKET_ID}`,
      owner: OWNER,
      asset: LOAN_TOKEN,
      balance: 500_000_000n,
    };

    it('caps availableNow at market liquidity when liquidity is short', async () => {
      const estimate = await makeAdapter({
        ...defaultScenario,
        totalSupplyAssets: 900_000_000n,
        totalBorrowAssets: 850_000_000n, // only 50M available
      }).withdrawable(position, AT);
      expect(estimate).toEqual({
        positionId: position.id,
        availableNow: 50_000_000n,
        totalPosition: 500_000_000n,
      });
    });

    it('returns the full position when liquidity exceeds it', async () => {
      const estimate = await makeAdapter({
        ...defaultScenario,
        totalSupplyAssets: 900_000_000n,
        totalBorrowAssets: 100_000_000n, // 800M available, well above the 500M position
      }).withdrawable(position, AT);
      expect(estimate).toEqual({
        positionId: position.id,
        availableNow: 500_000_000n,
        totalPosition: 500_000_000n,
      });
    });
  });

  describe('buildWithdraw', () => {
    const position: Position = {
      id: `morpho-blue:base:${MARKET_ID}:${OWNER}`,
      protocol: 'morpho-blue',
      chainId: 8453,
      marketId: `morpho-blue:base:${MARKET_ID}`,
      owner: OWNER,
      asset: LOAN_TOKEN,
      balance: 500_000_000n,
    };

    it('throws AdapterError if no market has been read yet (cache empty)', () => {
      const adapter = makeAdapter();
      expect(() => adapter.buildWithdraw(position, 1_000n, RECIPIENT)).toThrow(AdapterError);
    });

    it('encodes an exact-amount withdraw (assets set, shares zero) after a snapshot warms the cache', async () => {
      const adapter = makeAdapter();
      await adapter.snapshotMarkets([MARKET_ID], AT);
      const tx = adapter.buildWithdraw(position, 1_000n, RECIPIENT);
      expect(tx.to).toBe(MORPHO);
      expect(tx.chainId).toBe(8453);
      expect(tx.data).toBe(
        encodeFunctionData({
          abi: morphoBlueAbi,
          functionName: 'withdraw',
          args: [
            {
              loanToken: LOAN_TOKEN,
              collateralToken: COLLATERAL_TOKEN,
              oracle: ORACLE,
              irm: IRM,
              lltv: (86n * WAD) / 100n,
            },
            1_000n,
            0n,
            OWNER,
            RECIPIENT,
          ],
        }),
      );
    });

    it("encodes 'max' as assets=0 with shares estimated via toSharesUp", async () => {
      const adapter = makeAdapter();
      await adapter.snapshotMarkets([MARKET_ID], AT);
      const tx = adapter.buildWithdraw(position, 'max', RECIPIENT);
      const expectedShares =
        (position.balance * (defaultScenario.totalSupplyShares + 1_000_000n) +
          (defaultScenario.totalSupplyAssets + 1n) -
          1n) /
        (defaultScenario.totalSupplyAssets + 1n);
      expect(tx.data).toBe(
        encodeFunctionData({
          abi: morphoBlueAbi,
          functionName: 'withdraw',
          args: [
            {
              loanToken: LOAN_TOKEN,
              collateralToken: COLLATERAL_TOKEN,
              oracle: ORACLE,
              irm: IRM,
              lltv: (86n * WAD) / 100n,
            },
            0n,
            expectedShares,
            OWNER,
            RECIPIENT,
          ],
        }),
      );
    });
  });

  describe('decodeEvents', () => {
    it('normalizes a decoded log into a ProtocolEvent', () => {
      const events = makeAdapter().decodeEvents([
        {
          address: MORPHO,
          blockNumber: 34_000_000n,
          transactionHash: '0xabc',
          logIndex: 2,
          eventName: 'Liquidate',
          args: { id: MARKET_ID, borrower: OWNER, badDebtAssets: 5n },
        },
      ]);
      expect(events).toEqual([
        {
          protocol: 'morpho-blue',
          chainId: 8453,
          marketId: 'morpho-blue:base',
          eventName: 'Liquidate',
          blockNumber: 34_000_000n,
          transactionHash: '0xabc',
          logIndex: 2,
          args: { id: MARKET_ID, borrower: OWNER, badDebtAssets: 5n },
        },
      ]);
    });
  });
});
