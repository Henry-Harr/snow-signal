# Fork integration tests (not yet implemented)

Phase 2's actual done-when criterion (`docs/SPEC.md` §13) is: **"fork integration
tests on Ethereum and Base match direct contract reads at pinned blocks."** That has
not been done yet — this directory is currently empty except for this README. Unit
tests against mocked `ContractReader` responses (`test/unit/protocols/`) stand in for
it for now; they prove the adapters decode data correctly, but not that the real
deployed contracts return data shaped the way the adapters assume.

## Why this is blocked

Running a real fork integration test needs:

1. **An archive-capable RPC URL** for Ethereum and for Base (Foundry's `anvil --fork-url
<url> --fork-block-number <N>` needs archive access to fork at an arbitrary
   historical block). This is Phase 0's still-open question 1 (`docs/PROGRESS.md`) —
   nobody has provided one yet.
2. **Foundry** (`anvil`, `cast`) installed in the environment running the tests. Not
   installed in the sandbox this phase was built in (checked via `anvil --version`,
   Phase 0's tooling check) — needed either in CI's `fork-integration-tests` job
   (already wired up in `.github/workflows/ci.yml`, gated on
   `vars.RUN_FORK_TESTS == 'true'`) or locally.

## What the real test should do, once unblocked

For each adapter, at a specific pinned block on each chain:

1. Fork at that block: `anvil --fork-url $ETH_RPC_ARCHIVE --fork-block-number <N>`.
2. Point a real `createViemContractReader` (see `src/chain/contract-reader.ts`) at the
   local Anvil instance.
3. Call the adapter's `snapshotMarkets`/`discoverPositions`/`collateralExposure` for a
   real, known market (e.g. Aave v3 Ethereum core USDC reserve) and a real address with
   a known position.
4. Independently fetch the same data with raw `cast call` commands against the same
   forked block (or a second, separately-constructed viem client hitting the same
   Anvil instance) and assert the adapter's output matches exactly — this is what
   proves the ABI fragments in `src/protocols/*/abi.ts` are correct against the real
   deployed bytecode, not just internally consistent with the unit tests' own mocks.
5. Addresses (Aave pool/data-provider/oracle, Morpho Blue, MetaMorpho vaults) should
   come from `@aave-dao/aave-address-book` for Aave and from official Morpho
   deployment references for Morpho — not re-typed by hand — per safety rule 6
   (`docs/SPEC.md` §2) and `docs/SOURCES.md`.

Do not guess block numbers or addresses to fill this in speculatively — get them from
the user (RPC access) and from the official sources above, exactly as safety rule 6
requires.
