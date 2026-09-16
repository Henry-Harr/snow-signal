import { describe, expect, it } from 'vitest';

import {
  aavePoolFlowTarget,
  computeHolderLedger,
  extractAaveMovement,
  extractMorphoBlueMovement,
  extractMorphoVaultMovement,
  fetchAaveBorrowerHealth,
  morphoBluePoolFlowTarget,
  morphoVaultPoolFlowTarget,
  rankHolders,
} from '../../../src/watchers/large-holders.js';
import { AaveV3Adapter } from '../../../src/protocols/aave-v3/adapter.js';
import { MorphoBlueAdapter } from '../../../src/protocols/morpho-blue/adapter.js';
import { MorphoVaultAdapter } from '../../../src/protocols/morpho-vault/adapter.js';
import type {
  ContractCall,
  ContractCallResult,
  ContractReadClient,
} from '../../../src/chain/client.js';
import { RpcPool, type NamedProvider } from '../../../src/chain/rpc-pool.js';
import { AdapterError, QuorumError } from '../../../src/core/errors.js';
import type { BlockRef, ProtocolEvent } from '../../../src/core/types.js';

function addr(seed: string): `0x${string}` {
  return `0x${seed.repeat(40).slice(0, 40)}`;
}

const AT: BlockRef = { chainId: 1, number: 100n, hash: '0xblock', timestamp: 1_700_000_000 };
const ALICE = addr('a1');
const BOB = addr('b2');
const POOL_ADDR = addr('11');

function mockClient(options: {
  multicall?: (calls: ContractCall[]) => ContractCallResult[];
}): ContractReadClient {
  return {
    getBlockNumber: () => Promise.resolve(AT.number),
    getBlock: () =>
      Promise.resolve({
        number: AT.number,
        hash: '0xblock',
        parentHash: '0xparent',
        timestamp: 0n,
      }),
    multicall: (calls) => Promise.resolve(options.multicall ? options.multicall(calls) : []),
    getLogs: () => Promise.resolve([]),
  };
}

function poolOf(client: ContractReadClient): RpcPool<ContractReadClient> {
  const providers: NamedProvider<ContractReadClient>[] = [
    { name: 'a', client },
    { name: 'b', client },
  ];
  return new RpcPool(providers, undefined, { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 });
}

function baseEvent(
  overrides: Partial<ProtocolEvent> & { eventName: string; args: Record<string, unknown> },
): ProtocolEvent {
  return {
    protocol: 'test',
    chainId: 1,
    marketId: 'm',
    blockNumber: 1n,
    transactionHash: '0xabc',
    logIndex: 0,
    ...overrides,
  };
}

describe('extractAaveMovement', () => {
  it('credits onBehalfOf on Supply', () => {
    const e = baseEvent({ eventName: 'Supply', args: { onBehalfOf: ALICE, amount: 100n } });
    expect(extractAaveMovement(e)).toEqual({
      holder: ALICE,
      side: 'supply',
      assetsDelta: 100n,
      blockNumber: 1n,
      transactionHash: '0xabc',
      logIndex: 0,
    });
  });

  it('debits user on Withdraw', () => {
    const e = baseEvent({ eventName: 'Withdraw', args: { user: ALICE, amount: 40n } });
    expect(extractAaveMovement(e)?.assetsDelta).toBe(-40n);
    expect(extractAaveMovement(e)?.side).toBe('supply');
  });

  it('credits onBehalfOf on Borrow and debits user on Repay', () => {
    const borrow = baseEvent({ eventName: 'Borrow', args: { onBehalfOf: BOB, amount: 30n } });
    const repay = baseEvent({ eventName: 'Repay', args: { user: BOB, amount: 10n } });
    expect(extractAaveMovement(borrow)).toMatchObject({
      holder: BOB,
      side: 'borrow',
      assetsDelta: 30n,
    });
    expect(extractAaveMovement(repay)).toMatchObject({
      holder: BOB,
      side: 'borrow',
      assetsDelta: -10n,
    });
  });

  it('returns undefined for an unrelated event', () => {
    expect(
      extractAaveMovement(baseEvent({ eventName: 'ReserveFrozen', args: {} })),
    ).toBeUndefined();
  });

  it('throws AdapterError when a required arg is missing or the wrong type', () => {
    const bad = baseEvent({
      eventName: 'Supply',
      args: { onBehalfOf: ALICE, amount: 'not-a-bigint' },
    });
    expect(() => extractAaveMovement(bad)).toThrow(AdapterError);
  });
});

describe('extractMorphoBlueMovement', () => {
  it('handles all six flow events, keyed on onBehalf', () => {
    const cases: [string, string, 'supply' | 'borrow' | 'collateral', bigint][] = [
      ['Supply', 'supply', 'supply', 5n],
      ['Withdraw', 'supply', 'supply', -5n],
      ['Borrow', 'borrow', 'borrow', 5n],
      ['Repay', 'borrow', 'borrow', -5n],
      ['SupplyCollateral', 'collateral', 'collateral', 5n],
      ['WithdrawCollateral', 'collateral', 'collateral', -5n],
    ];
    for (const [eventName, , side, delta] of cases) {
      const e = baseEvent({ eventName, args: { onBehalf: ALICE, assets: 5n } });
      expect(extractMorphoBlueMovement(e)).toMatchObject({
        holder: ALICE,
        side,
        assetsDelta: delta,
      });
    }
  });

  it('returns undefined for an unrelated event', () => {
    expect(extractMorphoBlueMovement(baseEvent({ eventName: 'SetFee', args: {} }))).toBeUndefined();
  });
});

describe('extractMorphoVaultMovement', () => {
  it('credits receiver on Deposit and debits owner on Withdraw', () => {
    const deposit = baseEvent({ eventName: 'Deposit', args: { receiver: ALICE, assets: 200n } });
    const withdraw = baseEvent({ eventName: 'Withdraw', args: { owner: ALICE, assets: 50n } });
    expect(extractMorphoVaultMovement(deposit)).toMatchObject({
      holder: ALICE,
      side: 'supply',
      assetsDelta: 200n,
    });
    expect(extractMorphoVaultMovement(withdraw)).toMatchObject({
      holder: ALICE,
      side: 'supply',
      assetsDelta: -50n,
    });
  });
});

describe('computeHolderLedger', () => {
  it('accumulates balances per holder across multiple events', () => {
    const events = [
      baseEvent({
        eventName: 'Supply',
        blockNumber: 1n,
        args: { onBehalfOf: ALICE, amount: 100n },
      }),
      baseEvent({ eventName: 'Supply', blockNumber: 2n, args: { onBehalfOf: BOB, amount: 50n } }),
      baseEvent({ eventName: 'Withdraw', blockNumber: 3n, args: { user: ALICE, amount: 30n } }),
    ];
    const ledger = computeHolderLedger(events, extractAaveMovement);
    expect(ledger.get(ALICE.toLowerCase() as typeof ALICE)).toMatchObject({
      supply: 70n,
      lastMovementBlock: 3n,
    });
    expect(ledger.get(BOB.toLowerCase() as typeof BOB)).toMatchObject({ supply: 50n });
  });

  it('ignores events the extractor does not recognize', () => {
    const ledger = computeHolderLedger(
      [baseEvent({ eventName: 'ReserveFrozen', args: {} })],
      extractAaveMovement,
    );
    expect(ledger.size).toBe(0);
  });
});

describe('rankHolders', () => {
  it('sorts descending by the requested side and excludes non-positive balances', () => {
    const events = [
      baseEvent({
        eventName: 'Supply',
        blockNumber: 1n,
        args: { onBehalfOf: ALICE, amount: 100n },
      }),
      baseEvent({ eventName: 'Supply', blockNumber: 2n, args: { onBehalfOf: BOB, amount: 300n } }),
      baseEvent({
        eventName: 'Supply',
        blockNumber: 3n,
        args: { onBehalfOf: addr('c3'), amount: 10n },
      }),
      baseEvent({
        eventName: 'Withdraw',
        blockNumber: 4n,
        args: { user: addr('c3'), amount: 10n },
      }),
    ];
    const ledger = computeHolderLedger(events, extractAaveMovement);
    const top = rankHolders(ledger, 'supply', 5);
    expect(top.map((h) => h.holder)).toEqual([BOB, ALICE]);
  });

  it('respects the limit n', () => {
    const events = [
      baseEvent({
        eventName: 'Supply',
        blockNumber: 1n,
        args: { onBehalfOf: ALICE, amount: 100n },
      }),
      baseEvent({ eventName: 'Supply', blockNumber: 2n, args: { onBehalfOf: BOB, amount: 300n } }),
    ];
    const ledger = computeHolderLedger(events, extractAaveMovement);
    expect(rankHolders(ledger, 'supply', 1)).toHaveLength(1);
  });
});

describe('pool-flow target factories', () => {
  it('aavePoolFlowTarget watches exactly Supply/Withdraw/Borrow/Repay', () => {
    const adapter = new AaveV3Adapter({
      chain: 'ethereum',
      market: 'core',
      chainId: 1,
      watchedAssets: ['USDC'],
      pool: poolOf(mockClient({})),
    });
    const target = aavePoolFlowTarget(adapter, POOL_ADDR);
    expect(target.address).toBe(POOL_ADDR);
    expect(new Set(target.events.map((e) => e.name))).toEqual(
      new Set(['Supply', 'Withdraw', 'Borrow', 'Repay']),
    );
  });

  it('morphoBluePoolFlowTarget watches exactly the six flow events', () => {
    const adapter = new MorphoBlueAdapter({
      chain: 'base',
      chainId: 8453,
      watchedMarketIds: [],
      pool: poolOf(mockClient({})),
    });
    const target = morphoBluePoolFlowTarget(adapter, addr('bb'));
    expect(new Set(target.events.map((e) => e.name))).toEqual(
      new Set(['Supply', 'Withdraw', 'Borrow', 'Repay', 'SupplyCollateral', 'WithdrawCollateral']),
    );
  });

  it('morphoVaultPoolFlowTarget watches exactly Deposit/Withdraw, excluding Transfer', () => {
    const adapter = new MorphoVaultAdapter({
      chain: 'base',
      chainId: 8453,
      vaultAddress: addr('e1'),
      pool: poolOf(mockClient({})),
    });
    const target = morphoVaultPoolFlowTarget(adapter, addr('e1'));
    expect(new Set(target.events.map((e) => e.name))).toEqual(new Set(['Deposit', 'Withdraw']));
  });
});

describe('fetchAaveBorrowerHealth', () => {
  it('reads getUserAccountData for each borrower', async () => {
    const client = mockClient({
      multicall: (calls) =>
        calls.map((): ContractCallResult => ({
          status: 'success',
          result: [500n, 200n, 100n, 8000n, 7500n, 1_200_000_000_000_000_000n],
        })),
    });
    const health = await fetchAaveBorrowerHealth(poolOf(client), POOL_ADDR, [ALICE, BOB], AT);
    expect(health).toEqual([
      {
        holder: ALICE,
        totalCollateralBase: 500n,
        totalDebtBase: 200n,
        healthFactor: 1_200_000_000_000_000_000n,
      },
      {
        holder: BOB,
        totalCollateralBase: 500n,
        totalDebtBase: 200n,
        healthFactor: 1_200_000_000_000_000_000n,
      },
    ]);
  });

  it('returns an empty array without calling the chain when given no borrowers', async () => {
    let called = false;
    const client = mockClient({
      multicall: () => {
        called = true;
        return [];
      },
    });
    expect(await fetchAaveBorrowerHealth(poolOf(client), POOL_ADDR, [], AT)).toEqual([]);
    expect(called).toBe(false);
  });

  it('throws when the call fails everywhere (via quorumRead having no successful providers)', async () => {
    const client = mockClient({
      multicall: (calls) =>
        calls.map((): ContractCallResult => ({ status: 'failure', error: new Error('boom') })),
    });
    await expect(fetchAaveBorrowerHealth(poolOf(client), POOL_ADDR, [ALICE], AT)).rejects.toThrow(
      QuorumError,
    );
  });
});
