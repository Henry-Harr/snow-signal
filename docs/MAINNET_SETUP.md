# Mainnet Safe + Zodiac Roles setup

**This guide is for you to run yourself, by hand, using your own wallet and your own
judgement at every step.** Sentinel never executes any of this against a real
network — every command below either runs in your own wallet UI, or is a read-only
check you run to confirm what you just did. `scripts/setup-safe-roles-fork.ts`
(same deployment logic, addresses, and scoping this guide describes) only ever runs
against a local Anvil fork; use it beforehand to see exactly what the real steps
below will produce, with no risk.

Read `docs/SPEC.md` §8.4 and `docs/THREAT_MODEL.md` before doing any of this. The
short version: Sentinel's bot key never holds your funds and never has a blanket
approval — it holds a narrow, on-chain-enforced permission to call `withdraw` on
specific pool/vault contracts, with the recipient locked to your own Safe. Getting
that scoping wrong is the one mistake in this whole setup that actually matters;
everything below exists to make that hard to get wrong, and to let you verify it
before trusting it.

## What you're building

- A **Safe** (multisig) that holds your actual funds. You keep full control — your
  own signer(s), your own threshold. Sentinel's bot key is never an owner.
- A **Zodiac Roles Modifier v2** module enabled on that Safe, with one role assigned
  to Sentinel's bot key, scoped to exactly:
  - the specific pool/vault contracts you've configured Sentinel to watch
    (`config/sentinel.yaml`'s `positions:` list),
  - their `withdraw` function only (never `transfer`, `approve`, or anything else),
  - a parameter condition requiring the recipient (and owner, for a vault) to be
    your Safe, checked on-chain by the Roles module itself — not just trusted from
    Sentinel's own code.

## Verified addresses (docs/SOURCES.md has the full sourcing detail)

Same on Ethereum mainnet and Base — confirmed deployed (real bytecode) on both via
`cast codesize` this session:

| Contract | Address |
|---|---|
| `SafeProxyFactory` v1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |
| `SafeL2` v1.4.1 singleton | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
| Zodiac `ModuleProxyFactory` v1.2.0 | `0x000000000000aDdB49795b0f9bA5BC298cDda236` |
| Zodiac Roles Modifier mastercopy **v2.1.1** | `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5` |

**Do not use Roles v2.1.0** (`0x9646fDAD06d3e24444381f44362a3B0eB343D337`) — the
Zodiac team's own tooling flags that specific mastercopy as known-faulty
(`docs/SOURCES.md`'s Zodiac Roles entry has the detail). Re-verify these addresses
yourself before using them for anything real — `docs/adr/0011-hand-built-roles-
conditions.md` and the SOURCES.md entry explain exactly how they were confirmed, so
you can redo the same check.

## 1. Deploy the Safe

Use the [Safe web app](https://app.safe.global) — pick "Create new Safe," choose the
network, and add your own signer(s) and threshold. **Do not add the bot key as an
owner.** The bot key is added later, as a Roles Modifier *role member*, which is a
fundamentally different (and much narrower) kind of access than Safe ownership.

Fund the Safe with the assets you actually want Sentinel watching — the same asset(s)
your `config/sentinel.yaml` `positions:` list names.

## 2. Enable the Roles Modifier

Use the [Zodiac app](https://roles.gnosisguild.org) (connect your Safe, "Add a
Zodiac Roles Modifier"), or do it by hand via the Safe UI's "Apps → Transaction
Builder": deploy a Roles module instance via `ModuleProxyFactory.deployModule(
0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5, <setUp calldata>, <salt>)`, where the
`setUp` calldata encodes `(owner, avatar, target)` — `owner` is your own admin
address (able to reconfigure the role later; **not** the bot key), `avatar` and
`target` are both your Safe's address. Then, from the Safe itself, call
`enableModule(<the deployed Roles module address>)`.

If you'd rather see this exact flow with real calldata before doing it on mainnet,
run `scripts/setup-safe-roles-fork.ts` — it does precisely this, against a fork, and
prints the addresses it produces.

## 3. Scope the role

For each position in `config/sentinel.yaml`, scope the role (role key: pick any
`bytes32` value, e.g. `keccak256("sentinel-<chain>-withdraw")`) to that position's
pool or vault contract, its `withdraw` function only, with the recipient (and, for a
vault, the owner) pinned to your Safe's address. `src/actions/safe-roles/scoped-
targets.ts`'s `scopedTargetsForChain` computes exactly this from your config —
`scripts/setup-safe-roles-fork.ts` calls it directly, so its fork output is the real
scoping your mainnet role needs, not an approximation.

Concretely, for each configured position, the Zodiac app's role editor (or the
Transaction Builder, calling `Roles.scopeTarget` then `Roles.scopeFunction`) needs:

- **Aave v3** (`config/sentinel.yaml`'s current Ethereum + Base Core USDC
  positions): target = the market's `Pool` address, function = `withdraw(address,
  uint256,address)` (selector `0x69328dec`), condition: the 3rd argument (`to`) must
  equal your Safe.
- **Morpho vault** (the currently-configured Gauntlet USDC Prime vault on Base):
  target = the vault address, function = `withdraw(uint256,address,address)`
  (selector `0xb460af94`), condition: both the 2nd argument (`receiver`) and 3rd
  argument (`owner`) must equal your Safe.

Verify your own config's exact addresses (`config/sentinel.yaml`, `docs/SOURCES.md`)
rather than trusting the ones written into an earlier version of this file — a
position added after this guide was written won't be listed above.

## 4. Assign the role to the bot key

Generate a fresh key for the bot — never reuse a key that holds anything else, never
one you've used before. Fund it with a small amount of gas money only (spec's own
wording: "the bot key holds only a small amount of gas money"). Call
`Roles.assignRoles(<bot address>, [<role key>], [true])`, as the Roles module's
`owner` (your admin address from step 2).

Store the bot's private key in an environment variable only — never in
`config/sentinel.yaml`, never committed, never logged. Sentinel reads it from the
env var named in `config.execution.roles.<chain>.botPrivateKeyEnvVar` (see
`src/actions/live-executor.ts`'s doc comment for exactly how and when it's read —
only once, only to sign, never printed).

## 5. Verify before trusting it

Before ever setting `execution.mode: live`, confirm:

- `Roles.execTransactionWithRole` from the bot key, calling `withdraw` on a
  configured pool/vault with the recipient set to your Safe, succeeds.
- The same call with the recipient set to *any other address* — including the bot's
  own address — reverts.
- A `transfer`/`approve` call through the Roles module, to anything, reverts (the
  role has no permission for it at all).

`scripts/setup-safe-roles-fork.ts` plus `test/integration/actions/safe-roles-
setup.test.ts` exercise exactly this sequence against a fork; there is no reason the
real deployment should behave differently, but confirm it yourself on the real
Safe before relying on it — a fork test proves the *mechanism*, not that you
configured *this specific* deployment correctly.

## 6. Only then, enable live mode — yourself

Set `execution.mode: live` and add the chain to `execution.liveChains` in
`config/sentinel.yaml` **yourself**. Per docs/SPEC.md §8.4 and this project's own
safety rules, Sentinel (and the assistant building it) never does this for you —
`docs/adr/0012-live-executor-not-wired-into-pipeline.md` explains that live
execution isn't even wired into the automatic pipeline yet, so setting `mode: live`
alone has no effect today; when that wiring lands, it will still default to `off`
and require this same explicit, per-chain opt-in.

## Revoking access

At any time: call `Roles.revokeTarget(<role key>, <pool/vault address>)` (or
`assignRoles(<bot address>, [<role key>], [false])` to pull the bot out of the role
entirely), or simply `disableModule` the Roles module from the Safe. Any of these
immediately removes the bot's ability to call anything, with no dependency on
Sentinel's own code or uptime. The kill switch (`sentinel kill`) stops Sentinel from
*attempting* withdrawals; revoking the Roles permission is the on-chain backstop
that works even if Sentinel itself is compromised.
