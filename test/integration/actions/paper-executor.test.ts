import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  publicActions,
} from 'viem';
import { afterEach, describe, expect, it } from 'vitest';

import { runPaperExecution } from '../../../src/actions/paper-executor.js';
import { startAnvilFork, type AnvilFork } from '../../../src/chain/anvil.js';
import type { SentinelConfig } from '../../../src/core/config.js';
import { FixedClock } from '../../../src/core/clock.js';
import type { Address, BlockRef } from '../../../src/core/types.js';
import { resolveAaveV3Asset, resolveAaveV3Market } from '../../../src/protocols/aave-v3/addresses.js';
import { openDatabase } from '../../../src/storage/db.js';
import { WithdrawalCampaignRepository } from '../../../src/storage/withdrawal-campaign-repository.js';

/**
 * Fork integration test for the paper executor (`src/actions/paper-executor.ts`),
 * exercising a **real** Aave v3 position end to end rather than a mock/synthetic
 * one: a real, on-chain-verified whale (`0x55FE002aefF02F77364de339a1292923A15844B8`
 * — see `test/integration/actions/simulator.test.ts`'s own doc comment) is
 * impersonated to actually `approve` + `supply` real USDC into Aave's Ethereum Core
 * market on a fork, creating a genuine aUSDC position. `runPaperExecution` is then
 * pointed at *that same fork* as its own `forkUrl` (a fork-of-a-fork — Anvil forks
 * from any JSON-RPC endpoint, including another already-running Anvil instance), so
 * it re-discovers exactly the position just created rather than a stale/nonexistent
 * one on the real chain.
 *
 * `supply()`'s signature is verified against the same official source already cited
 * in `src/protocols/aave-v3/abi.ts`/`docs/SOURCES.md`
 * (raw.githubusercontent.com/aave-dao/aave-v3-origin/main/src/contracts/interfaces/IPool.sol,
 * re-fetched 2026-09-16): `function supply(address asset, uint256 amount, address
 * onBehalfOf, uint16 referralCode) external;` — not otherwise in the codebase since
 * the adapter itself never calls `supply` (only `withdraw`).
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

function minimalConfig(): SentinelConfig {
  return {
    safe: { address: IMPERSONATED },
    chains: {},
    positions: [],
    detectors: {},
    policy: {
      watch: { action: 'alert' },
      danger: { action: 'partial_withdraw', fraction: 0.5 },
      critical: { action: 'full_exit' },
      maxShareOfAvailableLiquidity: 1,
    },
    execution: { mode: 'paper', maxPriorityFeeGwei: { ethereum: 40 } },
    notify: {},
    reports: { dailyUtcHour: 0, benchmark: { kind: 'pool_base_rate' } },
  };
}

describeIfNetworked('runPaperExecution (fork integration, real Aave v3 position)', () => {
  let fork: AnvilFork | undefined;

  afterEach(async () => {
    await fork?.stop();
    fork = undefined;
  });

  it('plans, simulates, and records a full exit against a real position created on the fork', async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL! });

    const { pool: poolAddress } = resolveAaveV3Market('ethereum', 'core');
    const usdc = resolveAaveV3Asset('ethereum', 'USDC');
    const supplyAmount = 10_000_000_000n; // 10,000 USDC (6 decimals)

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

    const publicClient = createPublicClient({ transport: http(fork.rpcUrl) });
    const blockNumber = await publicClient.getBlockNumber();
    const block = await publicClient.getBlock({ blockNumber });
    const at: BlockRef = {
      chainId: 1,
      number: block.number,
      hash: block.hash,
      timestamp: Number(block.timestamp),
    };

    const db = openDatabase(':memory:');
    try {
      const campaigns = new WithdrawalCampaignRepository(db);
      const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));

      const outcome = await runPaperExecution({
        chain: 'ethereum',
        chainId: 1,
        config: minimalConfig(),
        clock,
        campaigns,
        forkUrl: fork.rpcUrl, // fork-of-a-fork: sees the position just created above
        position: {
          positionId: 'aave-v3:ethereum:core:USDC',
          protocol: 'aave-v3',
          marketId: 'aave-v3:ethereum:core:USDC',
          assetSymbol: 'USDC',
        },
        safeAddress: IMPERSONATED,
        action: { kind: 'full_exit' },
        at,
      });

      expect(outcome.kind).toBe('simulated');
      if (outcome.kind !== 'simulated') throw new Error('expected a simulated outcome');
      expect(outcome.result.passed).toBe(true);
      expect(outcome.result.failureReason).toBeUndefined();
      // Aave's scaled-balance aToken accounting rounds down by a couple of wei on
      // deposit (a real, documented Aave quirk, not a bug here — observed 1-2 wei
      // depending on the exact liquidity index at supply time) — the discovered
      // aUSDC balance (and so the full-exit target) can be a hair under `supplyAmount`.
      const stepAmount = outcome.result.plan.stepAmount;
      expect(supplyAmount - stepAmount).toBeGreaterThanOrEqual(0n);
      expect(supplyAmount - stepAmount).toBeLessThanOrEqual(5n);
      expect(outcome.result.plan.wouldComplete).toBe(true);
      expect(outcome.result.gasUsed).toBeGreaterThan(0n);

      const saved = campaigns.get('aave-v3:ethereum:core:USDC');
      expect(saved?.status).toBe('complete');
      expect(saved?.withdrawnSoFar).toBe(stepAmount);
    } finally {
      db.close();
    }
  }, 90_000);
});
