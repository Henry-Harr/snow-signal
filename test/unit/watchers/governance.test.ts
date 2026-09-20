import { describe, expect, it } from 'vitest';

import {
  aaveGovernanceTarget,
  fetchGovernanceEvents,
  morphoBlueGovernanceTarget,
  morphoVaultGovernanceTarget,
  resolveAaveConfiguratorAddress,
  type GovernanceWatchTarget,
} from '../../../src/watchers/governance.js';
import { poolConfiguratorAbi } from '../../../src/protocols/aave-v3/abi.js';
import { AaveV3Adapter } from '../../../src/protocols/aave-v3/adapter.js';
import { morphoBlueAbi } from '../../../src/protocols/morpho-blue/abi.js';
import { MorphoBlueAdapter } from '../../../src/protocols/morpho-blue/adapter.js';
import { metaMorphoAbi } from '../../../src/protocols/morpho-vault/abi.js';
import { MorphoVaultAdapter } from '../../../src/protocols/morpho-vault/adapter.js';
import type {
  ContractCall,
  ContractCallResult,
  ContractReadClient,
  DecodedLog,
  LogQuery,
} from '../../../src/chain/client.js';
import { RpcPool, type NamedProvider } from '../../../src/chain/rpc-pool.js';
import { RpcError } from '../../../src/core/errors.js';
import type { BlockRef } from '../../../src/core/types.js';

function addr(seed: string): `0x${string}` {
  return `0x${seed.repeat(40).slice(0, 40)}`;
}

const AT: BlockRef = { chainId: 1, number: 100n, hash: '0xblock', timestamp: 1_700_000_000 };
const POOL = addr('11');
const PROVIDER = addr('22');
const CONFIGURATOR = addr('33');

function mockClient(options: {
  multicall?: (calls: ContractCall[]) => ContractCallResult[];
  getLogs?: (query: LogQuery) => DecodedLog[];
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
    getLogs: (query) => Promise.resolve(options.getLogs ? options.getLogs(query) : []),
  };
}

function poolOf(client: ContractReadClient): RpcPool<ContractReadClient> {
  const providers: NamedProvider<ContractReadClient>[] = [
    { name: 'a', client },
    { name: 'b', client },
  ];
  return new RpcPool(providers, undefined, { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 });
}

describe('fetchGovernanceEvents', () => {
  it("fetches logs per target and decodes them via each target's own decoder", async () => {
    const client = mockClient({
      getLogs: (query) =>
        query.address === CONFIGURATOR
          ? [
              {
                address: CONFIGURATOR,
                blockNumber: 50n,
                transactionHash: '0xabc',
                logIndex: 1,
                eventName: 'ReserveFrozen',
                args: { asset: addr('99'), frozen: true },
              },
            ]
          : [],
    });
    const target: GovernanceWatchTarget = {
      protocol: 'aave-v3',
      address: CONFIGURATOR,
      events: poolConfiguratorAbi.filter((x) => x.type === 'event'),
      decode: (logs) => logs.map((l) => ({ protocol: 'aave-v3', chainId: 1, marketId: 'm', ...l })),
    };

    const events = await fetchGovernanceEvents(poolOf(client), [target], 0n, 100n);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventName).toBe('ReserveFrozen');
  });

  it('skips a target with no events to watch, without calling getLogs', async () => {
    let called = false;
    const client = mockClient({
      getLogs: () => {
        called = true;
        return [];
      },
    });
    const target: GovernanceWatchTarget = {
      protocol: 'empty',
      address: CONFIGURATOR,
      events: [],
      decode: () => [],
    };
    const events = await fetchGovernanceEvents(poolOf(client), [target], 0n, 100n);
    expect(events).toEqual([]);
    expect(called).toBe(false);
  });

  it('flattens results across multiple targets', async () => {
    const client = mockClient({
      getLogs: (query) => [
        {
          address: query.address as `0x${string}`,
          blockNumber: 1n,
          transactionHash: '0xabc',
          logIndex: 0,
          eventName: 'X',
          args: {},
        },
      ],
    });
    const target = (address: `0x${string}`, protocol: string): GovernanceWatchTarget => ({
      protocol,
      address,
      events: poolConfiguratorAbi.filter((x) => x.type === 'event').slice(0, 1),
      decode: (logs) => logs.map((l) => ({ protocol, chainId: 1, marketId: protocol, ...l })),
    });
    const events = await fetchGovernanceEvents(
      poolOf(client),
      [target(addr('1'), 'a'), target(addr('2'), 'b')],
      0n,
      100n,
    );
    expect(events.map((e) => e.protocol)).toEqual(['a', 'b']);
  });
});

describe('resolveAaveConfiguratorAddress', () => {
  it('resolves via Pool.ADDRESSES_PROVIDER() then PoolAddressesProvider.getPoolConfigurator()', async () => {
    const client = mockClient({
      multicall: (calls) =>
        calls.map((call): ContractCallResult => {
          if (call.functionName === 'ADDRESSES_PROVIDER')
            return { status: 'success', result: PROVIDER };
          if (call.functionName === 'getPoolConfigurator') {
            return { status: 'success', result: CONFIGURATOR };
          }
          return { status: 'failure', error: new Error('unexpected call') };
        }),
    });
    const resolved = await resolveAaveConfiguratorAddress(poolOf(client), POOL, AT);
    expect(resolved).toBe(CONFIGURATOR);
  });

  it('throws (via bestEffortRead exhausting providers) if ADDRESSES_PROVIDER() fails', async () => {
    const client = mockClient({
      multicall: (calls) =>
        calls.map((): ContractCallResult => ({ status: 'failure', error: new Error('boom') })),
    });
    // bestEffortRead wraps the underlying AdapterError as RpcError once every
    // provider has failed (same behavior every other bestEffortRead call in the
    // adapters relies on) — the original AdapterError is still attached as `.cause`.
    await expect(resolveAaveConfiguratorAddress(poolOf(client), POOL, AT)).rejects.toThrow(
      RpcError,
    );
  });
});

describe('governance target factories', () => {
  it('aaveGovernanceTarget watches every PoolConfigurator event and delegates decoding to the adapter', () => {
    const adapter = new AaveV3Adapter({
      chain: 'ethereum',
      market: 'core',
      chainId: 1,
      watchedAssets: ['USDC'],
      pool: poolOf(mockClient({})),
    });
    const target = aaveGovernanceTarget(adapter, CONFIGURATOR);
    expect(target.protocol).toBe('aave-v3');
    expect(target.address).toBe(CONFIGURATOR);
    expect(target.events).toHaveLength(
      poolConfiguratorAbi.filter((x) => x.type === 'event').length,
    );
    // asset must be the real, registered USDC address — decodeEvents now drops any
    // log about a reserve outside the adapter's watchedAssets (found live,
    // 2026-09-20: unfiltered cross-reserve governance events falsely attributed
    // to the watched USDC position, see src/protocols/aave-v3/adapter.ts).
    const decoded = target.decode([
      {
        address: CONFIGURATOR,
        blockNumber: 1n,
        transactionHash: '0xabc',
        logIndex: 0,
        eventName: 'ReserveFrozen',
        args: { asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', frozen: true },
      },
    ]);
    expect(decoded[0]!.protocol).toBe('aave-v3');
    expect(decoded[0]!.marketId).toBe('aave-v3:ethereum:core:USDC');
  });

  it('morphoBlueGovernanceTarget watches only the governance subset, not pool-flow events', () => {
    const adapter = new MorphoBlueAdapter({
      chain: 'base',
      chainId: 8453,
      watchedMarketIds: [],
      pool: poolOf(mockClient({})),
    });
    const target = morphoBlueGovernanceTarget(adapter, addr('bb'));
    const names = target.events.map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'SetOwner',
        'SetFee',
        'SetFeeRecipient',
        'EnableIrm',
        'EnableLltv',
        'CreateMarket',
      ]),
    );
    expect(names).not.toContain('Supply');
    expect(names).not.toContain('Liquidate');
    const totalMorphoBlueEvents = morphoBlueAbi.filter((x) => x.type === 'event').length;
    expect(target.events.length).toBeLessThan(totalMorphoBlueEvents);
  });

  it('morphoVaultGovernanceTarget watches every MetaMorpho event', () => {
    const adapter = new MorphoVaultAdapter({
      chain: 'base',
      chainId: 8453,
      vaultAddress: addr('e1'),
      pool: poolOf(mockClient({})),
    });
    const target = morphoVaultGovernanceTarget(adapter, addr('e1'));
    expect(target.events).toHaveLength(metaMorphoAbi.filter((x) => x.type === 'event').length);
  });
});
