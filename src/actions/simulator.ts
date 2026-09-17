import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, erc20Abi, http, publicActions } from 'viem';

import type { Address, TxRequest } from '../core/types.js';
import { rolesAbi } from './safe-roles/abi.js';

/**
 * The fork simulator (docs/SPEC.md §8.4, safety rule 5: "simulate every transaction
 * before sending; abort on revert or on any result other than 'position down, Safe up
 * by the expected amount'"). Runs a `TxRequest` against an already-forked Anvil
 * instance (`src/chain/anvil.ts`) by impersonating the Safe — the standard
 * simulate-only technique: Anvil accepts `eth_sendTransaction` for an impersonated
 * address with no private key at all, so nothing here ever signs anything (safety
 * rule 2). The caller owns spawning/stopping the fork; this module only drives one
 * transaction through an already-running one.
 *
 * Verifies the *generic* half of "position down, Safe up": the Safe's underlying
 * ERC-20 balance increased by the expected amount. The protocol-specific "position
 * down" half (aToken burned, vault shares redeemed, Morpho Blue supply reduced) is
 * the caller's job (`src/actions/paper-executor.ts`), since it already holds the
 * protocol adapter and can re-read the position after simulating.
 */

export interface SimulateWithdrawalOptions {
  rpcUrl: string;
  chainId: number;
  safeAddress: Address;
  tx: TxRequest;
  /** The underlying ERC-20 the Safe should receive — checked via a plain
   * `balanceOf` read before and after, not assumed from the tx's own calldata. */
  assetAddress: Address;
  expectedAmount: bigint;
  /** Phase 8 live-executor mode: when present, `tx` is not sent directly — it's
   * wrapped in `Roles.execTransactionWithRole(...)` and sent by the impersonated
   * *bot* address instead of the Safe, the same path a real live send takes
   * (`src/actions/live-executor.ts`). The underlying protocol call still executes
   * with the Safe as `msg.sender` (Roles calls `Safe.execTransactionFromModule`
   * internally), so the balance check below is unchanged — still the Safe's own
   * balance, not the bot's. */
  viaRoles?: {
    rolesModAddress: Address;
    roleKey: `0x${string}`;
    botAddress: Address;
  };
}

export interface SimulationOutcome {
  passed: boolean;
  gasUsed: bigint | undefined;
  safeAssetBalanceBefore: bigint;
  safeAssetBalanceAfter: bigint;
  failureReason: string | undefined;
}

export async function simulateWithdrawal(
  options: SimulateWithdrawalOptions,
): Promise<SimulationOutcome> {
  const transport = http(options.rpcUrl);
  const publicClient = createPublicClient({ transport });
  const testClient = createTestClient({ mode: 'anvil', transport }).extend(publicActions);
  const walletClient = createWalletClient({ transport });

  const safeAssetBalanceBefore = await publicClient.readContract({
    address: options.assetAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [options.safeAddress],
  });

  // Without `viaRoles`: impersonate the Safe and send `tx` directly (paper mode,
  // and the drill). With `viaRoles`: impersonate the *bot* and send `tx` wrapped in
  // `execTransactionWithRole`, to the Roles module — the actual path a real live
  // send takes.
  const sender = options.viaRoles?.botAddress ?? options.safeAddress;
  const callTarget = options.viaRoles?.rolesModAddress ?? options.tx.to;
  const callData = options.viaRoles
    ? encodeFunctionData({
        abi: rolesAbi,
        functionName: 'execTransactionWithRole',
        args: [
          options.tx.to,
          options.tx.value ?? 0n,
          options.tx.data,
          0, // Enum.Operation.Call
          options.viaRoles.roleKey,
          true, // shouldRevert — surface the underlying call's own revert, don't swallow it
        ],
      })
    : options.tx.data;
  const callValue = options.viaRoles ? 0n : (options.tx.value ?? 0n);

  await testClient.impersonateAccount({ address: sender });
  try {
    let gas: bigint;
    try {
      // `eth_estimateGas` at the current (pre-tx) state, with a 20% buffer.
      // Withdrawal calls can take a materially more expensive branch than a naive
      // estimate suggests — e.g. Aave's `withdraw()` costs extra gas on a *full*
      // exit (it also clears the reserve's "used as collateral" bit), so an
      // unbuffered estimate risks an avoidable out-of-gas revert here that a real
      // wallet (which always pads its own estimate) would never hit.
      const estimated = await publicClient.estimateGas({
        account: sender,
        to: callTarget,
        data: callData,
        value: callValue,
      });
      gas = (estimated * 6n) / 5n;
    } catch (error) {
      return {
        passed: false,
        gasUsed: undefined,
        safeAssetBalanceBefore,
        safeAssetBalanceAfter: safeAssetBalanceBefore,
        failureReason: `gas estimation reverted: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let txHash: `0x${string}`;
    try {
      txHash = await walletClient.sendTransaction({
        chain: null,
        account: sender,
        to: callTarget,
        data: callData,
        value: callValue,
        gas,
      });
    } catch (error) {
      return {
        passed: false,
        gasUsed: undefined,
        safeAssetBalanceBefore,
        safeAssetBalanceAfter: safeAssetBalanceBefore,
        failureReason: error instanceof Error ? error.message : String(error),
      };
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const safeAssetBalanceAfter = await publicClient.readContract({
      address: options.assetAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [options.safeAddress],
    });

    if (receipt.status !== 'success') {
      // Replay the exact call as an `eth_call` at the pre-tx block to recover a
      // human-readable revert reason — a plain "transaction reverted" is close to
      // useless for a paper-mode audit trail (the whole point of `paper` mode is
      // "record what would have happened").
      let reason = 'unknown (replay did not revert)';
      try {
        await publicClient.call({
          account: sender,
          to: callTarget,
          data: callData,
          value: callValue,
          gas,
          blockNumber: receipt.blockNumber - 1n,
        });
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      return {
        passed: false,
        gasUsed: receipt.gasUsed,
        safeAssetBalanceBefore,
        safeAssetBalanceAfter,
        failureReason: `transaction reverted: ${reason}`,
      };
    }

    const actualIncrease = safeAssetBalanceAfter - safeAssetBalanceBefore;
    if (actualIncrease !== options.expectedAmount) {
      return {
        passed: false,
        gasUsed: receipt.gasUsed,
        safeAssetBalanceBefore,
        safeAssetBalanceAfter,
        failureReason: `Safe balance increased by ${actualIncrease} wei, expected exactly ${options.expectedAmount}`,
      };
    }

    return {
      passed: true,
      gasUsed: receipt.gasUsed,
      safeAssetBalanceBefore,
      safeAssetBalanceAfter,
      failureReason: undefined,
    };
  } finally {
    await testClient.stopImpersonatingAccount({ address: sender });
  }
}
