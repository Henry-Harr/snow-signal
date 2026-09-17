import type { Address } from '../../core/types.js';

/**
 * Safe v1.4.1 and Zodiac Roles v2.1.1 deployment addresses, verified this session
 * (docs/SOURCES.md's "Safe" and "Zodiac Roles Modifier" entries) — fetched from each
 * project's own published deployment JSON, then cross-checked on-chain via
 * `cast codesize` against both Ethereum mainnet and Base. All four addresses are
 * identical on both chains (CREATE2-deterministic deployments via a shared factory),
 * so this isn't a per-chain map — safety rule 6 still applies if a new chain is ever
 * added: re-verify on-chain before assuming these carry over.
 *
 * **Important correction made this session**: the first candidate `ModuleProxyFactory`
 * address (the `"factory"` field in the Roles mastercopy's own build JSON) turned out
 * to be the ERC-2470 *singleton* factory — used once, by the Zodiac team, to deploy
 * the mastercopy itself deterministically — not the per-instance factory a caller
 * uses to deploy their own module clone; calling `deployModule` on it reverted
 * immediately (confirmed via `cast call --trace`). The real `ModuleProxyFactory` and
 * the actually-current Roles mastercopy version came from the separate
 * `@gnosis-guild/zodiac` npm package's own `contracts.js` registry, which also
 * flags the *2.1.0* mastercopy as **known faulty** (`FAULTY[ROLES]["2.1.0"]` in that
 * same file) — this file uses **2.1.1** instead, confirmed not in that faulty list
 * and confirmed deployed (real bytecode, `cast codesize`) on both chains.
 */

/** `SafeProxyFactory` v1.4.1 — deploys a new `SafeProxy` pointing at a singleton. */
export const SAFE_PROXY_FACTORY: Address = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';

/** `SafeL2` v1.4.1 singleton — the L2-events variant, used on both chains here (see
 * docs/SOURCES.md for why using it on Ethereum too is harmless for Sentinel's own
 * test/setup Safe). */
export const SAFE_L2_SINGLETON: Address = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';

/** Zodiac's `ModuleProxyFactory` v1.2.0 — deploys a minimal proxy for any Zodiac
 * module mastercopy (Roles included), not Roles-specific itself. */
export const MODULE_PROXY_FACTORY: Address = '0x000000000000aDdB49795b0f9bA5BC298cDda236';

/** Zodiac Roles Modifier mastercopy, contract version **2.1.1** (2.1.0 is flagged
 * faulty by the Zodiac team's own package — see this file's header comment). */
export const ROLES_MASTERCOPY: Address = '0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5';
