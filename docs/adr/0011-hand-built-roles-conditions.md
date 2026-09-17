# 0011: Hand-build Zodiac Roles condition trees instead of using `zodiac-roles-sdk`

## Context

Spec §8.4 requires the bot's Safe-module role to be "scoped to the specific pool and
vault contracts, to withdraw and redeem functions only, and to parameter conditions
requiring the recipient (and owner, where relevant) to be the Safe itself... verify
the right condition operators in the Roles v2 docs." Roles v2's on-chain permission
scoping (`scopeFunction`) takes a `ConditionFlat[]` — a flattened permission-condition
tree — as raw calldata; building one by hand means getting `ParameterType`/`Operator`
enum ordinals and the `{parent, paramType, operator, compValue}` tuple layout exactly
right.

The obvious way to avoid hand-rolling this is the official `zodiac-roles-sdk` (npm,
v4.1.3 as of this session), which the Roles team maintains for exactly this purpose.
Its documented workflow (`docs.roles.gnosisguild.org/sdk/getting-started`) is: build a
`permissions` array from a curated `allow.<chain>.<contract>.<function>(...)` preset
database, then call `.push()`, which "sends the desired state to the Zodiac API,
which diffs against the current on-chain configuration and applies the necessary
calls." Two properties of that workflow are disqualifying here:

1. **It depends on a hosted API** (the Zodiac API) to compute and apply the diff.
   Safety rules 2/3 require every signing/state-changing code path to run only
   against a local Anvil fork — a setup script that must round-trip through Gnosis
   Guild's own hosted service to configure permissions doesn't satisfy that, fork or
   no fork.
2. **Its `allow.<chain>.<contract>` presets are curated per contract**, evidently
   covering well-known DeFi integrations (the docs example is Curve's 3pool). There's
   no evidence it has a preset for this specific Aave v3 Core pool's `withdraw` or
   this specific MetaMorpho vault's `withdraw` — both fairly narrow, less-traveled
   targets for a permissions SDK's curated list.

## Decision

Hand-build the `ConditionFlat[]` array directly, grounded in the actual Solidity
source rather than a paraphrase or a half-remembered structure: the Roles v2.1.0
mastercopy's own `compilerInput` (fetched from `zodiac-modifier-roles/packages/evm/
mastercopies.json`, the repo's own deploy artifact) includes the full source of
`contracts/Types.sol`, giving the exact `ParameterType`, `Operator`, and
`ExecutionOptions` enum ordinals and the `ConditionFlat` struct layout — see
`docs/SOURCES.md`'s Zodiac Roles entry for the specifics. `src/actions/safe-roles/
conditions.ts` builds the tree from these values directly: a root node
(`paramType: Calldata`, `operator: Matches`) whose children describe each function
argument in order, `Pass` (unconstrained) for arguments Sentinel doesn't care about,
`EqualTo` with a 32-byte `compValue` for arguments that must equal the Safe's own
address.

**This encoding is verified empirically, not just by source-reading.** Phase 8's own
required end-to-end and negative-permission fork tests (spec §11) are the actual
proof: deploy the real Roles mastercopy via the real `ModuleProxyFactory`, scope a
function with this exact encoding, then confirm on a fork that (a) a legitimate call
(recipient = Safe) succeeds, and (b) `transfer`/`approve`/a withdrawal to a non-Safe
address all revert. Getting an enum ordinal wrong would fail one of those two checks
outright — a good design should make its own mistakes loud, and this one does.

## Consequence

No new runtime dependency for something this safety-critical (`zodiac-roles-sdk`
pulls in `ethers` and CoW Protocol SDK packages this codebase otherwise has no use
for, on top of the hosted-API incompatibility above). The tradeoff is that a Roles
contract upgrade past 2.1.x that changes `Types.sol`'s enum ordinals or the
`ConditionFlat` layout would silently break `conditions.ts` without a type error —
mitigated by pinning the exact verified mastercopy address (`docs/SOURCES.md`) rather
than resolving "latest," and by the fork tests failing loudly if it ever drifts.
