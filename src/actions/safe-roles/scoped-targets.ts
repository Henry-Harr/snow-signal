import type { SentinelConfig } from '../../core/config.js';
import type { Address } from '../../core/types.js';
import { resolveAaveV3Market } from '../../protocols/aave-v3/addresses.js';
import type { ScopedTarget } from './setup.js';

/**
 * Builds the `ScopedTarget[]` a Roles role needs for every configured position on
 * one chain (docs/SPEC.md §8.4: "scoped to the specific pool and vault contracts, to
 * withdraw and redeem functions only, and to parameter conditions requiring the
 * recipient (and owner, where relevant) to be the Safe itself") — used by both
 * `scripts/setup-safe-roles-fork.ts` and, eventually, whatever wires the live
 * executor's own deployment (see `docs/adr/0012-live-executor-not-wired-into-
 * pipeline.md` for why that wiring isn't built yet).
 *
 * Selectors verified via `cast sig`, not memory: Aave's `withdraw(address,uint256,
 * address)` is `0x69328dec` (already used throughout `src/protocols/aave-v3/`); a
 * MetaMorpho vault's ERC-4626 `withdraw(uint256,address,address)` is `0xb460af94`.
 */
const AAVE_WITHDRAW_SELECTOR = '0x69328dec' as const;
const VAULT_WITHDRAW_SELECTOR = '0xb460af94' as const;

export function scopedTargetsForChain(
  config: SentinelConfig,
  chain: string,
  safeAddress: Address,
): ScopedTarget[] {
  const targets: ScopedTarget[] = [];

  for (const position of config.positions) {
    if (position.chain !== chain) continue;

    if (position.protocol === 'aave-v3') {
      const { pool } = resolveAaveV3Market(position.chain, position.market);
      targets.push({
        targetAddress: pool,
        functions: [
          {
            selector: AAVE_WITHDRAW_SELECTOR,
            // withdraw(address asset, uint256 amount, address to) — only `to` is
            // pinned; `asset`/`amount` are left unconstrained per position, since
            // one Aave pool is shared across every reserve Sentinel might hold.
            args: [{ kind: 'pass' }, { kind: 'pass' }, { kind: 'equalToAddress', address: safeAddress }],
          },
        ],
      });
    } else if (position.protocol === 'morpho-vault') {
      targets.push({
        targetAddress: position.vault as Address,
        functions: [
          {
            selector: VAULT_WITHDRAW_SELECTOR,
            // withdraw(uint256 assets, address receiver, address owner) — both
            // receiver and owner must be the Safe (spec: "recipient and owner,
            // where relevant").
            args: [
              { kind: 'pass' },
              { kind: 'equalToAddress', address: safeAddress },
              { kind: 'equalToAddress', address: safeAddress },
            ],
          },
        ],
      });
    }
    // A direct morpho-blue position would be added here the same way, once one is
    // actually configured — same scope note as src/core/pipeline.ts.
  }

  return targets;
}
