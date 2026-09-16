import { encodeFunctionData } from 'viem';
import { describe, expect, it, afterEach } from 'vitest';

import { simulateWithdrawal } from '../../../src/actions/simulator.js';
import type { Address } from '../../../src/core/types.js';
import { startAnvilFork, type AnvilFork } from '../../../src/chain/anvil.js';

/**
 * Fork integration test for the withdrawal simulator (`src/actions/simulator.ts`),
 * against a real Anvil fork with real impersonation — no mocked chain client, since
 * the whole point of this module is exercising Anvil's own `eth_sendTransaction`-for-
 * an-impersonated-account behavior (safety rule 2).
 *
 * Uses WETH's `deposit()` (wrap ETH into WETH) as the "withdrawal" under test rather
 * than a real Aave position: `deposit()` is the simplest possible real on-chain
 * mechanism that increases the caller's ERC-20 balance by exactly a known amount (the
 * same "position down [ETH], Safe up [WETH] by the expected amount" shape a real
 * pool withdrawal has) without needing to locate or fabricate a real lending
 * position — `src/actions/paper-executor.test.ts`'s own fork test exercises a real
 * Aave withdrawal end to end instead. The impersonated account
 * (`0x55FE002aefF02F77364de339a1292923A15844B8`) is a real, well-funded address
 * (verified live via `cast balance`/`cast call` this session, ~66.5M USDC and ~247
 * real ETH at the time) — not a fabricated fixture address.
 */
const ETH_URL = process.env['ETH_RPC_ARCHIVE'];
const describeIfNetworked = ETH_URL ? describe : describe.skip;

const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const IMPERSONATED: Address = '0x55FE002aefF02F77364de339a1292923A15844B8';

const wethAbi = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const;

describeIfNetworked('simulateWithdrawal (fork integration)', () => {
  let fork: AnvilFork | undefined;

  afterEach(async () => {
    await fork?.stop();
    fork = undefined;
  });

  it('passes for a real transaction that increases the impersonated account\'s tracked balance by exactly the expected amount', async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL! });
    const depositAmount = 1_000_000_000_000_000_000n; // 1 ETH -> 1 WETH

    const outcome = await simulateWithdrawal({
      rpcUrl: fork.rpcUrl,
      chainId: 1,
      safeAddress: IMPERSONATED,
      tx: {
        chainId: 1,
        to: WETH,
        data: encodeFunctionData({ abi: wethAbi, functionName: 'deposit' }),
        value: depositAmount,
        description: 'wrap 1 ETH into WETH',
      },
      assetAddress: WETH,
      expectedAmount: depositAmount,
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.gasUsed).toBeGreaterThan(0n);
    expect(outcome.safeAssetBalanceAfter - outcome.safeAssetBalanceBefore).toBe(depositAmount);
    expect(outcome.failureReason).toBeUndefined();
  }, 60_000);

  it('fails (does not throw) when the transaction reverts', async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL! });
    const impossibleAmount = 2n ** 200n; // far more WETH than the account holds

    const outcome = await simulateWithdrawal({
      rpcUrl: fork.rpcUrl,
      chainId: 1,
      safeAddress: IMPERSONATED,
      tx: {
        chainId: 1,
        to: WETH,
        data: encodeFunctionData({ abi: wethAbi, functionName: 'withdraw', args: [impossibleAmount] }),
        description: 'withdraw way more WETH than the account holds',
      },
      assetAddress: WETH,
      expectedAmount: impossibleAmount,
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failureReason).toBeDefined();
  }, 60_000);

  it('fails when the balance increases by a different amount than expected', async () => {
    fork = await startAnvilFork({ forkUrl: ETH_URL! });
    const depositAmount = 1_000_000_000_000_000_000n;
    const wrongExpectation = 2_000_000_000_000_000_000n;

    const outcome = await simulateWithdrawal({
      rpcUrl: fork.rpcUrl,
      chainId: 1,
      safeAddress: IMPERSONATED,
      tx: {
        chainId: 1,
        to: WETH,
        data: encodeFunctionData({ abi: wethAbi, functionName: 'deposit' }),
        value: depositAmount,
        description: 'wrap 1 ETH into WETH',
      },
      assetAddress: WETH,
      expectedAmount: wrongExpectation,
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failureReason).toContain('expected exactly');
  }, 60_000);
});
