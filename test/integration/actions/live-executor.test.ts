import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  publicActions,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import { runLiveExecution } from '../../../src/actions/live-executor.js';
import { deploySafeWithRoles } from '../../../src/actions/safe-roles/setup.js';
import { startAnvilFork, type AnvilFork } from '../../../src/chain/anvil.js';
import type { Address } from '../../../src/core/types.js';
import { poolAbi } from '../../../src/protocols/aave-v3/abi.js';
import { resolveAaveV3Asset, resolveAaveV3Market } from '../../../src/protocols/aave-v3/addresses.js';

/**
 * Fork integration test for the live executor (`src/actions/live-executor.ts`,
 * docs/SPEC.md §8.4). Unlike every other fork test in this codebase, this one
 * actually *signs for real* — the one code path in the whole system that does — but
 * only ever against a local Anvil fork (safety rules 2/3), using a bot key generated
 * fresh for this test run and never written anywhere (not logged, not committed, not
 * reused across runs). `liveRpcUrl` and `forkSourceRpcUrl` both point at the same
 * fork: "broadcast for real" and "the fork the mandatory pre-send simulation forks
 * from" are the same local chain here, which is exactly the point — nothing in this
 * test ever reaches a real network.
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const describeIfNetworked = ETH_URL ? describe : describe.skip;

const WHALE: Address = '0x55FE002aefF02F77364de339a1292923A15844B8';
const OWNER: Address = '0x0000000000000000000000000000000000000011';
const ROLE_KEY = keccak256(toHex('sentinel-live-withdraw-role'));
const WITHDRAW_SELECTOR = '0x69328dec' as const; // withdraw(address,uint256,address)
const BOT_KEY_ENV_VAR = 'SENTINEL_TEST_LIVE_EXECUTOR_BOT_KEY';

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
    if (receipt.status !== 'success') throw new Error(`setup transaction to ${to} reverted`);
  } finally {
    await testClient.stopImpersonatingAccount({ address: from });
  }
}

describeIfNetworked('runLiveExecution (fork integration, real signing against a local fork only)', () => {
  let fork: AnvilFork | undefined;

  afterEach(async () => {
    delete process.env[BOT_KEY_ENV_VAR];
    await fork?.stop();
    fork = undefined;
  });

  it('signs and sends a real transaction that exits the Safe, via the real Roles-scoped path', async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL! });

    const botPrivateKey = generatePrivateKey();
    const botAddress = privateKeyToAccount(botPrivateKey).address;
    process.env[BOT_KEY_ENV_VAR] = botPrivateKey;

    const { pool: poolAddress } = resolveAaveV3Market('ethereum', 'core');
    const usdc = resolveAaveV3Asset('ethereum', 'USDC');

    const { safeAddress, rolesModAddress } = await deploySafeWithRoles({
      rpcUrl: fork.rpcUrl,
      ownerAddress: OWNER,
      botAddress,
      roleKey: ROLE_KEY,
      scopedTargets: (safe) => [
        {
          targetAddress: poolAddress,
          functions: [
            {
              selector: WITHDRAW_SELECTOR,
              args: [{ kind: 'pass' }, { kind: 'pass' }, { kind: 'equalToAddress', address: safe }],
            },
          ],
        },
      ],
    });

    // The bot needs real ETH to actually pay gas for a real signed transaction.
    const testClient = createTestClient({ mode: 'anvil', transport: http(fork.rpcUrl) }).extend(
      publicActions,
    );
    await testClient.setBalance({ address: botAddress, value: 10n ** 19n });

    // Fund the Safe with a real Aave USDC position.
    const supplyAmount = 5_000_000_000n; // 5,000 USDC
    await sendAsImpersonated(
      fork.rpcUrl,
      WHALE,
      usdc,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [poolAddress, supplyAmount] }),
    );
    await sendAsImpersonated(
      fork.rpcUrl,
      WHALE,
      poolAddress,
      encodeFunctionData({
        abi: supplyAbi,
        functionName: 'supply',
        args: [usdc, supplyAmount, safeAddress, 0],
      }),
    );

    const withdrawAmount = 1_000_000_000n; // 1,000 USDC
    const outcome = await runLiveExecution(
      {
        chain: 'ethereum',
        chainId: 1,
        liveRpcUrl: fork.rpcUrl,
        forkSourceRpcUrl: fork.rpcUrl,
        safeAddress,
        rolesModAddress,
        roleKey: ROLE_KEY,
        botPrivateKeyEnvVar: BOT_KEY_ENV_VAR,
      },
      {
        recipient: safeAddress,
        tx: {
          chainId: 1,
          to: poolAddress,
          data: encodeFunctionData({
            abi: poolAbi,
            functionName: 'withdraw',
            args: [usdc, withdrawAmount, safeAddress],
          }),
          description: 'live withdraw test',
        },
        assetAddress: usdc,
        expectedAmount: withdrawAmount,
      },
    );

    expect(outcome.kind).toBe('sent');
    if (outcome.kind !== 'sent') throw new Error('expected sent');
    expect(outcome.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const publicClient = createPublicClient({ transport: http(fork.rpcUrl) });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: outcome.txHash });
    expect(receipt.status).toBe('success');

    const safeBalance = await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [safeAddress],
    });
    expect(safeBalance).toBe(withdrawAmount);
  }, 120_000);

  it('refuses to send (simulation-failed) when the requested recipient/amount would not actually pass', async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL! });

    const botPrivateKey = generatePrivateKey();
    const botAddress = privateKeyToAccount(botPrivateKey).address;
    process.env[BOT_KEY_ENV_VAR] = botPrivateKey;

    const { pool: poolAddress } = resolveAaveV3Market('ethereum', 'core');
    const usdc = resolveAaveV3Asset('ethereum', 'USDC');

    const { safeAddress, rolesModAddress } = await deploySafeWithRoles({
      rpcUrl: fork.rpcUrl,
      ownerAddress: OWNER,
      botAddress,
      roleKey: ROLE_KEY,
      scopedTargets: (safe) => [
        {
          targetAddress: poolAddress,
          functions: [
            {
              selector: WITHDRAW_SELECTOR,
              args: [{ kind: 'pass' }, { kind: 'pass' }, { kind: 'equalToAddress', address: safe }],
            },
          ],
        },
      ],
    });

    const testClient = createTestClient({ mode: 'anvil', transport: http(fork.rpcUrl) }).extend(
      publicActions,
    );
    await testClient.setBalance({ address: botAddress, value: 10n ** 19n });

    // The Safe holds no position at all here — a withdraw of any nonzero amount
    // must fail simulation (revert), never reach a real send.
    const outcome = await runLiveExecution(
      {
        chain: 'ethereum',
        chainId: 1,
        liveRpcUrl: fork.rpcUrl,
        forkSourceRpcUrl: fork.rpcUrl,
        safeAddress,
        rolesModAddress,
        roleKey: ROLE_KEY,
        botPrivateKeyEnvVar: BOT_KEY_ENV_VAR,
      },
      {
        recipient: safeAddress,
        tx: {
          chainId: 1,
          to: poolAddress,
          data: encodeFunctionData({
            abi: poolAbi,
            functionName: 'withdraw',
            args: [usdc, 1_000_000n, safeAddress],
          }),
          description: 'live withdraw test, no position to withdraw from',
        },
        assetAddress: usdc,
        expectedAmount: 1_000_000n,
      },
    );

    expect(outcome.kind).toBe('simulation-failed');
  }, 60_000);
});
