import {
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  publicActions,
} from 'viem';
import { afterEach, describe, expect, it } from 'vitest';

import { runExitDrill } from '../../../src/actions/exit-drill.js';
import { startAnvilFork, type AnvilFork } from '../../../src/chain/anvil.js';
import type { SentinelConfig } from '../../../src/core/config.js';
import { FixedClock } from '../../../src/core/clock.js';
import type { Address } from '../../../src/core/types.js';
import { resolveAaveV3Asset, resolveAaveV3Market } from '../../../src/protocols/aave-v3/addresses.js';

/**
 * Fork integration test for the daily exit drill (`src/actions/exit-drill.ts`,
 * docs/SPEC.md §8.6). Same real-position technique as `paper-executor.test.ts`: a
 * real, on-chain-verified whale supplies real USDC into Aave's Ethereum Core market
 * on a fork, and `runExitDrill` is pointed at that fork (both configured RPC
 * providers) so its own `getConservativeHead()` quorum read and the paper executor's
 * own fork-of-a-fork both see the position just created.
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const describeIfNetworked = ETH_URL ? describe : describe.skip;

const IMPERSONATED: Address = '0x55FE002aefF02F77364de339a1292923A15844B8';

const supplyAbi = [
  {
    type: 'function',
    name: 'supply',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
] as const;

async function sendAsImpersonated(
  rpcUrl: string,
  from: Address,
  to: Address,
  data: `0x${string}`,
): Promise<void> {
  const transport = http(rpcUrl);
  const testClient = createTestClient({ mode: 'anvil', transport }).extend(publicActions);
  const walletClient = createWalletClient({ transport });

  await testClient.impersonateAccount({ address: from });
  try {
    const hash = await walletClient.sendTransaction({ chain: null, account: from, to, data, value: 0n });
    const receipt = await testClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`setup transaction to ${to} reverted`);
    }
  } finally {
    await testClient.stopImpersonatingAccount({ address: from });
  }
}

function configFor(forkRpcUrl: string): SentinelConfig {
  return {
    safe: { address: IMPERSONATED },
    chains: {
      ethereum: {
        chainId: 1,
        confirmations: 0,
        rpc: [
          { name: 'a', url: forkRpcUrl },
          { name: 'b', url: forkRpcUrl },
        ],
      },
    },
    positions: [{ protocol: 'aave-v3', chain: 'ethereum', market: 'core', asset: 'USDC' }],
    detectors: {},
    policy: {
      watch: { action: 'alert' },
      danger: { action: 'partial_withdraw', fraction: 0.5 },
      critical: { action: 'full_exit' },
      maxShareOfAvailableLiquidity: 1,
    },
    execution: { mode: 'off', maxPriorityFeeGwei: { ethereum: 40 }, liveChains: [], roles: {} },
    notify: {},
    reports: { dailyUtcHour: 0, benchmark: { kind: 'pool_base_rate' } },
  };
}

describeIfNetworked('runExitDrill (fork integration, real Aave v3 position)', () => {
  let fork: AnvilFork | undefined;

  afterEach(async () => {
    await fork?.stop();
    fork = undefined;
  });

  it('reports a passing full-exit drill against a real position created on the fork', async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL! });

    const { pool: poolAddress } = resolveAaveV3Market('ethereum', 'core');
    const usdc = resolveAaveV3Asset('ethereum', 'USDC');
    const supplyAmount = 5_000_000_000n; // 5,000 USDC (6 decimals)

    await sendAsImpersonated(
      fork.rpcUrl,
      IMPERSONATED,
      usdc,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [poolAddress, supplyAmount],
      }),
    );
    await sendAsImpersonated(
      fork.rpcUrl,
      IMPERSONATED,
      poolAddress,
      encodeFunctionData({
        abi: supplyAbi,
        functionName: 'supply',
        args: [usdc, supplyAmount, IMPERSONATED, 0],
      }),
    );

    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const results = await runExitDrill({ config: configFor(fork.rpcUrl), clock });

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result?.positionId).toBe('aave-v3:ethereum:core:USDC');
    expect(result?.passed).toBe(true);
    expect(result?.gasEstimate).toBeGreaterThan(0n);
    expect(result?.estimatedBlocksToExit).toBe(1);
  }, 90_000);

  it('reports no results when the safe holds no configured position', async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL! });

    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const config = configFor(fork.rpcUrl);
    // An arbitrary address, not a claim about any real-world holder — just needs to
    // plausibly hold no Aave position (unlike a well-known burn/vanity address,
    // which occasionally does receive stray tokens by mistake).
    config.safe.address = '0x1234567890123456789012345678901234567890';

    const results = await runExitDrill({ config, clock });
    expect(results).toEqual([]);
  }, 60_000);
});
