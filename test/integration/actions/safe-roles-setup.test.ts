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
import { afterEach, describe, expect, it } from 'vitest';

import { rolesAbi } from '../../../src/actions/safe-roles/abi.js';
import { deploySafeWithRoles } from '../../../src/actions/safe-roles/setup.js';
import { startAnvilFork, type AnvilFork } from '../../../src/chain/anvil.js';
import type { Address } from '../../../src/core/types.js';
import { poolAbi } from '../../../src/protocols/aave-v3/abi.js';
import { resolveAaveV3Asset, resolveAaveV3Market } from '../../../src/protocols/aave-v3/addresses.js';

/**
 * Fork integration test for the Safe + Zodiac Roles v2 setup script
 * (`src/actions/safe-roles/setup.ts`, docs/SPEC.md §8.4/§11). Deploys a real Safe and
 * a real Roles module on a fork, scopes the bot's role to Aave's `withdraw` with the
 * recipient pinned to the Safe, funds the Safe with a genuine Aave position (same
 * real-whale-impersonation technique as `paper-executor.test.ts`), then proves both
 * halves of spec §11's requirement: the legitimate exit succeeds end to end, and
 * `approve`/a withdrawal to a non-Safe address both revert — enforced by the Roles
 * module itself, independent of any application-level check.
 *
 * `supply()`'s signature (used only to fund the test fixture) is verified against
 * the same official source already cited in `src/protocols/aave-v3/abi.ts`/
 * `docs/SOURCES.md` and reused verbatim from `test/integration/actions/paper-
 * executor.test.ts`'s own doc comment.
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const describeIfNetworked = ETH_URL ? describe : describe.skip;

const WHALE: Address = '0x55FE002aefF02F77364de339a1292923A15844B8';
const OWNER: Address = '0x0000000000000000000000000000000000000011';
const BOT: Address = '0x0000000000000000000000000000000000000022';
const ATTACKER: Address = '0x0000000000000000000000000000000000000033';
const ROLE_KEY = keccak256(toHex('sentinel-withdraw-role'));
const WITHDRAW_SELECTOR = '0x69328dec' as const; // withdraw(address,uint256,address)

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

async function expectRevertAsImpersonated(
  rpcUrl: string,
  from: Address,
  to: Address,
  data: `0x${string}`,
): Promise<void> {
  const transport = http(rpcUrl);
  const testClient = createTestClient({ mode: 'anvil', transport }).extend(publicActions);
  const walletClient = createWalletClient({ transport });
  await testClient.setBalance({ address: from, value: 10n ** 19n });
  await testClient.impersonateAccount({ address: from });
  try {
    let reverted = false;
    try {
      const hash = await walletClient.sendTransaction({ chain: null, account: from, to, data, value: 0n });
      const receipt = await testClient.waitForTransactionReceipt({ hash });
      reverted = receipt.status !== 'success';
    } catch {
      reverted = true;
    }
    expect(reverted).toBe(true);
  } finally {
    await testClient.stopImpersonatingAccount({ address: from });
  }
}

describeIfNetworked('Safe + Zodiac Roles v2 setup (fork integration, real Aave v3 position)', () => {
  let fork: AnvilFork | undefined;

  afterEach(async () => {
    await fork?.stop();
    fork = undefined;
  });

  it('deploys a scoped role that can exit to the Safe but nothing else', async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL! });

    const { pool: poolAddress } = resolveAaveV3Market('ethereum', 'core');
    const usdc = resolveAaveV3Asset('ethereum', 'USDC');

    const { safeAddress, rolesModAddress } = await deploySafeWithRoles({
      rpcUrl: fork.rpcUrl,
      ownerAddress: OWNER,
      botAddress: BOT,
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

    expect(safeAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(rolesModAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);

    // Fund the Safe with a real Aave USDC position (same technique as
    // paper-executor.test.ts): impersonate the real whale, have it supply real USDC
    // on the Safe's behalf.
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

    const publicClient = createPublicClient({ transport: http(fork.rpcUrl) });
    // The Safe holds aUSDC (Aave's interest-bearing receipt token) right now, not
    // USDC itself — it only gets USDC once it actually withdraws. Use a fixed
    // partial amount, comfortably under what was supplied, for the withdraw calls
    // below (this test is about permissions, not exact-amount precision).
    const withdrawAmount = 1_000_000_000n; // 1,000 USDC
    const safeBalanceBefore = await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [safeAddress],
    });
    expect(safeBalanceBefore).toBe(0n);

    // --- Negative tests: the Roles module itself must block these, independent of
    // any in-code check. ---

    // 1. Withdraw to a non-Safe recipient — the scoped `to` parameter condition
    // must reject it.
    await expectRevertAsImpersonated(
      fork.rpcUrl,
      BOT,
      rolesModAddress,
      encodeFunctionData({
        abi: rolesAbi,
        functionName: 'execTransactionWithRole',
        args: [
          poolAddress,
          0n,
          encodeFunctionData({
            abi: poolAbi,
            functionName: 'withdraw',
            args: [usdc, withdrawAmount, ATTACKER],
          }),
          0,
          ROLE_KEY,
          true,
        ],
      }),
    );

    // 2. `approve` on the USDC token directly — not a scoped target/function at all.
    await expectRevertAsImpersonated(
      fork.rpcUrl,
      BOT,
      rolesModAddress,
      encodeFunctionData({
        abi: rolesAbi,
        functionName: 'execTransactionWithRole',
        args: [
          usdc,
          0n,
          encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ATTACKER, withdrawAmount] }),
          0,
          ROLE_KEY,
          true,
        ],
      }),
    );

    // --- Positive test: the legitimate exit succeeds end to end. ---
    await sendAsImpersonated(
      fork.rpcUrl,
      BOT,
      rolesModAddress,
      encodeFunctionData({
        abi: rolesAbi,
        functionName: 'execTransactionWithRole',
        args: [
          poolAddress,
          0n,
          encodeFunctionData({
            abi: poolAbi,
            functionName: 'withdraw',
            args: [usdc, withdrawAmount, safeAddress],
          }),
          0,
          ROLE_KEY,
          true,
        ],
      }),
    );

    const safeBalanceAfter = await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [safeAddress],
    });
    expect(safeBalanceAfter).toBe(withdrawAmount);
  }, 120_000);
});
