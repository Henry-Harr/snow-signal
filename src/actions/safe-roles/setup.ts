import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  publicActions,
  zeroAddress,
  type PublicClient,
  type TestClient,
  type WalletClient,
} from 'viem';
import type { Address } from '../../core/types.js';
import { moduleProxyFactoryAbi, rolesAbi, safeAbi, safeProxyFactoryAbi } from './abi.js';
import { MODULE_PROXY_FACTORY, ROLES_MASTERCOPY, SAFE_L2_SINGLETON, SAFE_PROXY_FACTORY } from './addresses.js';
import { buildArgumentConditions, ExecutionOptions, type ArgCondition } from './conditions.js';

/**
 * Deploys a real Safe + Zodiac Roles v2 module on an already-running Anvil fork and
 * scopes a role to exactly the withdraw/redeem calls Sentinel needs (docs/SPEC.md
 * §8.4). **Local fork only** (safety rules 2/3) — every call here is either a plain
 * factory deployment (no auth) or sent by an impersonated owner, never a real
 * signature. See `docs/adr/0011-hand-built-roles-conditions.md` for the permission-
 * condition encoding this scopes functions with, and `scripts/setup-safe-roles-fork.ts`
 * for a runnable entry point.
 */

export interface ScopedFunction {
  selector: `0x${string}`;
  args: ArgCondition[];
}

export interface ScopedTarget {
  targetAddress: Address;
  functions: ScopedFunction[];
}

export interface DeploySafeWithRolesOptions {
  rpcUrl: string;
  /** The Safe's sole owner (threshold 1) and the Roles module's admin owner — able
   * to reconfigure permissions later, distinct from the bot key. Impersonated
   * throughout, never signed for real; funded via `anvil_setBalance` if it doesn't
   * already hold ETH on the fork. */
  ownerAddress: Address;
  /** The address assigned the scoped role — the bot's own key in a real deployment. */
  botAddress: Address;
  roleKey: `0x${string}`;
  /** A function of the not-yet-known Safe address, since most real scoping (the
   * recipient must be the Safe itself) needs it — called once the Safe is actually
   * deployed, before the Roles module is scoped. */
  scopedTargets: (safeAddress: Address) => ScopedTarget[];
}

export interface DeploySafeWithRolesResult {
  safeAddress: Address;
  rolesModAddress: Address;
}

/** Safe's `checkNSignatures` (`Safe.sol`): `v == 1` means "approved hash," valid
 * whenever `msg.sender` (the `executor`) equals the address encoded in `r` — no real
 * ECDSA signature needed. Since the impersonated owner IS `msg.sender` for every
 * `execTransaction` call this module makes, this is a legitimate, standard Safe
 * signature format, not a workaround — the same impersonate-don't-sign discipline
 * `src/actions/simulator.ts` already uses, applied to a Safe's own signature scheme
 * instead of a plain EOA-direct call. */
function preValidatedSignature(owner: Address): `0x${string}` {
  const r = encodeAbiParameters([{ type: 'address' }], [owner]).slice(2);
  const s = '0'.repeat(64);
  const v = '01';
  return `0x${r}${s}${v}`;
}

async function execSafeTransaction(
  walletClient: WalletClient,
  ownerAddress: Address,
  safeAddress: Address,
  to: Address,
  data: `0x${string}`,
): Promise<`0x${string}`> {
  return walletClient.sendTransaction({
    chain: null,
    account: ownerAddress,
    to: safeAddress,
    data: encodeFunctionData({
      abi: safeAbi,
      functionName: 'execTransaction',
      args: [
        to,
        0n,
        data,
        0, // Enum.Operation.Call
        0n,
        0n,
        0n,
        zeroAddress,
        zeroAddress,
        preValidatedSignature(ownerAddress),
      ],
    }),
  });
}

export async function deploySafeWithRoles(
  options: DeploySafeWithRolesOptions,
): Promise<DeploySafeWithRolesResult> {
  const transport = http(options.rpcUrl);
  const publicClient: PublicClient = createPublicClient({ transport });
  const testClient: TestClient = createTestClient({ mode: 'anvil', transport }).extend(publicActions);
  const walletClient: WalletClient = createWalletClient({ transport });

  await testClient.setBalance({ address: options.ownerAddress, value: 10n ** 20n });
  await testClient.impersonateAccount({ address: options.ownerAddress });

  try {
    const saltNonce = BigInt(Date.now());

    // 1. Deploy the Safe: single owner, threshold 1, no fallback handler (nothing
    // here relies on ERC-1271/EIP-165 fallback behavior — every call is either a
    // direct impersonated `execTransaction` or a plain read).
    const safeSetupData = encodeFunctionData({
      abi: safeAbi,
      functionName: 'setup',
      args: [
        [options.ownerAddress],
        1n,
        zeroAddress,
        '0x',
        zeroAddress,
        zeroAddress,
        0n,
        zeroAddress,
      ],
    });
    const { result: safeAddress } = await publicClient.simulateContract({
      address: SAFE_PROXY_FACTORY,
      abi: safeProxyFactoryAbi,
      functionName: 'createProxyWithNonce',
      args: [SAFE_L2_SINGLETON, safeSetupData, saltNonce],
      account: options.ownerAddress,
    });
    const deploySafeHash = await walletClient.sendTransaction({
      chain: null,
      account: options.ownerAddress,
      to: SAFE_PROXY_FACTORY,
      data: encodeFunctionData({
        abi: safeProxyFactoryAbi,
        functionName: 'createProxyWithNonce',
        args: [SAFE_L2_SINGLETON, safeSetupData, saltNonce],
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash: deploySafeHash });

    // 2. Deploy the Roles module: owner = ownerAddress (admin), avatar = target =
    // the just-deployed Safe.
    const rolesInitParams = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
      [options.ownerAddress, safeAddress, safeAddress],
    );
    const rolesSetupData = encodeFunctionData({
      abi: rolesAbi,
      functionName: 'setUp',
      args: [rolesInitParams],
    });
    const { result: rolesModAddress } = await publicClient.simulateContract({
      address: MODULE_PROXY_FACTORY,
      abi: moduleProxyFactoryAbi,
      functionName: 'deployModule',
      args: [ROLES_MASTERCOPY, rolesSetupData, saltNonce],
      account: options.ownerAddress,
    });
    const deployRolesHash = await walletClient.sendTransaction({
      chain: null,
      account: options.ownerAddress,
      to: MODULE_PROXY_FACTORY,
      data: encodeFunctionData({
        abi: moduleProxyFactoryAbi,
        functionName: 'deployModule',
        args: [ROLES_MASTERCOPY, rolesSetupData, saltNonce],
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash: deployRolesHash });

    // 3. Enable the Roles module on the Safe — `enableModule` is `SelfAuthorized`
    // (Safe's own `authorized` modifier: `msg.sender == address(this)`), so it can
    // only be called via the Safe's own `execTransaction`, never directly.
    const enableModuleHash = await execSafeTransaction(
      walletClient,
      options.ownerAddress,
      safeAddress,
      safeAddress,
      encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [rolesModAddress] }),
    );
    await publicClient.waitForTransactionReceipt({ hash: enableModuleHash });

    // 4. Scope the role: exactly the configured targets/functions/conditions, then
    // assign it to the bot address. Every call below is direct on the Roles module
    // (its `owner` is `ownerAddress` from step 2's `setUp`, not gated through the
    // Safe at all).
    for (const target of options.scopedTargets(safeAddress)) {
      const scopeTargetHash = await walletClient.sendTransaction({
        chain: null,
        account: options.ownerAddress,
        to: rolesModAddress,
        data: encodeFunctionData({
          abi: rolesAbi,
          functionName: 'scopeTarget',
          args: [options.roleKey, target.targetAddress],
        }),
      });
      await publicClient.waitForTransactionReceipt({ hash: scopeTargetHash });

      for (const fn of target.functions) {
        const conditions = buildArgumentConditions(fn.args);
        const scopeFunctionHash = await walletClient.sendTransaction({
          chain: null,
          account: options.ownerAddress,
          to: rolesModAddress,
          data: encodeFunctionData({
            abi: rolesAbi,
            functionName: 'scopeFunction',
            args: [options.roleKey, target.targetAddress, fn.selector, conditions, ExecutionOptions.None],
          }),
        });
        await publicClient.waitForTransactionReceipt({ hash: scopeFunctionHash });
      }
    }

    const assignRolesHash = await walletClient.sendTransaction({
      chain: null,
      account: options.ownerAddress,
      to: rolesModAddress,
      data: encodeFunctionData({
        abi: rolesAbi,
        functionName: 'assignRoles',
        args: [options.botAddress, [options.roleKey], [true]],
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash: assignRolesHash });

    return { safeAddress, rolesModAddress };
  } finally {
    await testClient.stopImpersonatingAccount({ address: options.ownerAddress });
  }
}
