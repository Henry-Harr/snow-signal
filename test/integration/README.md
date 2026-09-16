# Integration tests

These tests exercise protocol adapters against real historical chain state, pinned to
a specific block, so results are deterministic and reproducible. Unlike
`test/unit`/`test/property`, they need:

1. **Foundry's `anvil`** on `PATH`. Install via `curl -L https://foundry.paradigm.xyz |
bash && foundryup` (or, if `foundryup`'s GitHub attestation check fails in a
   sandboxed environment, download the release tarball directly from
   `github.com/foundry-rs/foundry/releases` and put `anvil`/`cast`/`forge` on `PATH`
   by hand — that's what this session did).
2. **A real, archive-capable RPC URL** per chain under test, in `.env` (see
   `.env.example`): `ETH_RPC_ARCHIVE` for Ethereum, `BASE_RPC_ARCHIVE` for Base — the
   same vars CI's `fork-integration-tests` job already wires up from repo secrets.
   Each chain's test suite skips cleanly (not fails) if its RPC var isn't set, so
   `pnpm test:integration` degrades gracefully with partial config — same philosophy
   as `sentinel doctor`.

Run:

```
set -a && source .env && set +a   # or otherwise export the RPC vars
pnpm test:integration
```

## What these tests do, and don't, cover

Each test spins up a **local `anvil` fork** (`test/integration/helpers/anvil.ts`)
pinned to a specific block, forked from the real RPC. The adapter under test reads
through that local fork; the test separately makes its own direct `viem` calls against
the same fork and asserts the two agree. This is read-only — nothing here signs or
broadcasts a transaction (safety rules 2–3, `docs/SPEC.md` §2 — those rules are about
_execution_, which doesn't exist yet as of Phase 2).

Using a local fork rather than hitting the live RPC directly in every assertion means:
runs are deterministic (always the same pinned block, not whatever the chain tip
happens to be when CI runs), and repeated reads across several assertions in the same
test don't multiply against the configured provider's rate limit — anvil fork mode
still fetches state from the upstream RPC, but lazily and only once per storage slot
actually touched, then serves it locally for every read in the rest of the test.

## Picking a pinned block

Aave's `AAVE_PROTOCOL_DATA_PROVIDER` (and other periphery contracts) get redeployed
when Aave ships a new minor version — the address itself doesn't change (it's the same
proxy per `docs/SOURCES.md`), but a **too-old** pinned block can predate that proxy's
deployment entirely, and a read against it returns `0x` ("no data") rather than a
useful revert reason. This bit us once already (docs/PROGRESS.md has the story) — if a
fork test starts failing with "returned no data" against an address that's otherwise
correctly sourced from the address book, check whether the pinned block just predates
a redeployment, and bump it forward (`cast block-number --rpc-url <url>` for the
current head, then pick something recent with a small safety margin).

## CI

`.github/workflows/ci.yml`'s `fork-integration-tests` job installs Foundry via
`foundry-rs/foundry-toolchain@v1` and only runs when the RPC secrets are configured, so
these tests never block a PR from a contributor without archive RPC access — they just
skip.
