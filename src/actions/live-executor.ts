import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startAnvilFork } from '../chain/anvil.js';
import type { Logger } from '../core/logger.js';
import type { Address, ChainId, TxRequest } from '../core/types.js';
import { rolesAbi } from './safe-roles/abi.js';
import { simulateWithdrawal } from './simulator.js';

/**
 * The live executor (docs/SPEC.md §8.4, Phase 8) — the only place in this codebase
 * that ever signs a real transaction with a real key. Two safety-critical gates run
 * before that, in order, and neither is skippable:
 *
 * 1. **In-code allowlist** (safety rule 4): `request.recipient` must equal the
 *    configured Safe address, checked here independent of whatever `request.tx`'s
 *    own calldata happens to encode — this is the "allowlist checked before
 *    signing" half; the on-chain half is the Zodiac Roles scoping itself
 *    (`src/actions/safe-roles/`), which independently blocks a wrong recipient at
 *    the contract level even if this check were somehow bypassed.
 * 2. **Mandatory pre-send simulation** (safety rule 5): a fresh Anvil fork of the
 *    *current* head, driving the exact same `execTransactionWithRole` call this
 *    function is about to send for real (`simulateWithdrawal`'s `viaRoles` mode) —
 *    abort on anything other than "position down, Safe up by the expected amount."
 *
 * Only once both pass does this function sign (with a key read from an env var,
 * never logged) and broadcast. `config.liveRpcUrl` is the only place a real chain
 * enters the picture — everything else, including the bot's own address, comes from
 * the private key itself. Nothing here is ever exercised against a real network by
 * this assistant (CLAUDE.md safety rules 2/3): the accompanying fork test signs for
 * real, but only ever against a local Anvil fork, using a throwaway key generated
 * for that test run.
 */

export interface LiveExecutorConfig {
  chain: string;
  chainId: ChainId;
  /** Where the real signed transaction is actually broadcast — a private-tx RPC on
   * Ethereum (ADR 0004), the configured RPC directly on Base. */
  liveRpcUrl: string;
  /** An archive/full-node RPC to fork from for the mandatory pre-send simulation —
   * typically the same chain's own configured RPC. */
  forkSourceRpcUrl: string;
  safeAddress: Address;
  rolesModAddress: Address;
  roleKey: `0x${string}`;
  /** Name of the env var holding the bot's private key — never the key itself. */
  botPrivateKeyEnvVar: string;
  logger?: Logger;
}

export interface LiveExecutionRequest {
  /** Explicit, separate from `tx` — the allowlist check below never trusts a
   * recipient implied by `tx`'s own calldata, only this field. */
  recipient: Address;
  tx: TxRequest;
  assetAddress: Address;
  expectedAmount: bigint;
}

export type LiveExecutionOutcome =
  | { kind: 'blocked-recipient'; reason: string }
  | { kind: 'simulation-failed'; reason: string }
  | { kind: 'sent'; txHash: `0x${string}` };

export async function runLiveExecution(
  config: LiveExecutorConfig,
  request: LiveExecutionRequest,
): Promise<LiveExecutionOutcome> {
  if (request.recipient !== config.safeAddress) {
    return {
      kind: 'blocked-recipient',
      reason: `recipient ${request.recipient} is not the configured Safe ${config.safeAddress} — refusing to sign (safety rule 4)`,
    };
  }

  const privateKey = process.env[config.botPrivateKeyEnvVar];
  if (!privateKey) {
    throw new Error(
      `${config.botPrivateKeyEnvVar} is not set — refusing to run live execution without a bot key`,
    );
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const fork = await startAnvilFork({ forkUrl: config.forkSourceRpcUrl });
  try {
    const sim = await simulateWithdrawal({
      rpcUrl: fork.rpcUrl,
      chainId: config.chainId,
      safeAddress: config.safeAddress,
      tx: request.tx,
      assetAddress: request.assetAddress,
      expectedAmount: request.expectedAmount,
      viaRoles: {
        rolesModAddress: config.rolesModAddress,
        roleKey: config.roleKey,
        botAddress: account.address,
      },
    });
    if (!sim.passed) {
      return {
        kind: 'simulation-failed',
        reason: sim.failureReason ?? 'simulation did not pass',
      };
    }
  } finally {
    await fork.stop();
  }

  config.logger?.warn(
    { chain: config.chain, recipient: request.recipient, rolesModAddress: config.rolesModAddress },
    'LIVE: signing and broadcasting a real transaction',
  );

  const walletClient = createWalletClient({ account, transport: http(config.liveRpcUrl) });
  const txHash = await walletClient.writeContract({
    chain: null,
    address: config.rolesModAddress,
    abi: rolesAbi,
    functionName: 'execTransactionWithRole',
    args: [request.tx.to, request.tx.value ?? 0n, request.tx.data, 0, config.roleKey, true],
  });
  return { kind: 'sent', txHash };
}
