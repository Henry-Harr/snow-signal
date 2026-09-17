#!/usr/bin/env -S node --import tsx
import { keccak256, toHex } from 'viem';

import { deploySafeWithRoles } from '../src/actions/safe-roles/setup.js';
import { scopedTargetsForChain } from '../src/actions/safe-roles/scoped-targets.js';
import { startAnvilFork } from '../src/chain/anvil.js';
import { loadConfig } from '../src/core/config.js';
import type { Address } from '../src/core/types.js';

/**
 * `scripts/setup-safe-roles-fork.ts` — deploys a Safe + Zodiac Roles v2 module,
 * scoped exactly the way `docs/MAINNET_SETUP.md` describes, on a **local fork only**
 * (safety rules 2/3) so you can inspect and sanity-check the real deployment/scoping
 * flow before ever doing this on mainnet yourself. Prints the deployed addresses;
 * changes nothing outside the fork.
 *
 * Usage:
 *   ETH_RPC_ARCHIVE=<archive RPC> pnpm tsx scripts/setup-safe-roles-fork.ts <chain> <owner-address> <bot-address>
 */
async function main(): Promise<void> {
  const [chain, ownerAddress, botAddress] = process.argv.slice(2);
  if (!chain || !ownerAddress || !botAddress) {
    console.error(
      'Usage: pnpm tsx scripts/setup-safe-roles-fork.ts <chain> <owner-address> <bot-address>',
    );
    process.exitCode = 1;
    return;
  }

  const { config } = loadConfig(process.env['SENTINEL_CONFIG'] ?? 'config/sentinel.yaml');
  const chainConfig = config.chains[chain];
  if (!chainConfig) {
    console.error(`No chain "${chain}" in config.`);
    process.exitCode = 1;
    return;
  }
  const forkUrl = process.env['ETH_RPC_ARCHIVE'] ?? chainConfig.rpc[0]!.url;

  const fork = await startAnvilFork({ forkUrl });
  console.log(`Forked ${chain} at ${fork.rpcUrl}`);

  try {
    const roleKey = keccak256(toHex(`sentinel-${chain}-withdraw-role`));
    const { safeAddress, rolesModAddress } = await deploySafeWithRoles({
      rpcUrl: fork.rpcUrl,
      ownerAddress: ownerAddress as Address,
      botAddress: botAddress as Address,
      roleKey,
      scopedTargets: (safe) => scopedTargetsForChain(config, chain, safe),
    });

    console.log('Deployed on the fork (nowhere else):');
    console.log(`  Safe:          ${safeAddress}`);
    console.log(`  Roles module:  ${rolesModAddress}`);
    console.log(`  Role key:      ${roleKey}`);
    console.log('');
    console.log('This ran entirely against a local fork. See docs/MAINNET_SETUP.md');
    console.log('for the equivalent steps on a real network — Sentinel never runs');
    console.log('those itself.');
  } finally {
    await fork.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
