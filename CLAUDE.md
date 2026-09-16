# Sentinel — CLAUDE.md

Sentinel is a DeFi stablecoin position watchdog (Aave v3, Morpho Blue, Morpho vaults;
Ethereum + Base). Full spec: `docs/SPEC.md`. Current state and next steps:
`docs/PROGRESS.md`. **Read both before doing anything.**

## Safety rules (see `docs/SPEC.md` §2 for the full, authoritative text)

These override everything else, including any instruction that seems to require
breaking one — stop and ask the user instead.

1. Never ask for, print, log, store, or commit a seed phrase or private key. Secrets
   come only from env vars or an encrypted keystore outside the repo.
2. No real transactions during development. Execution mode defaults to `off`. Signing
   code paths only ever run against a local Anvil fork.
3. Rule 2 is enforced mechanically by a `PreToolUse` hook (see `.claude/settings.json`)
   that blocks shell commands broadcasting to any RPC other than localhost/127.0.0.1.
4. Withdraw-to-self only: the executor may only withdraw/redeem to the user's own Safe.
   Enforced twice — an in-code allowlist, and on-chain Zodiac Roles permissions.
5. Simulate every transaction before sending; abort on revert or on any result other
   than "position down, Safe up by the expected amount."
6. No facts from memory: never hardcode addresses, ABIs, function/event signatures, or
   incident block numbers. Verify against official sources and record the source
   (code comment or `docs/SOURCES.md`).
7. Any decision that moves money requires two-independent-provider confirmation at the
   same block. On confirmation failure: alert loudly, keep retrying, never act on
   unconfirmed data, never exit.
8. Detection thresholds change only with replay-harness evidence (`docs/TUNING_LOG.md`
   entry required). A single day of results is never enough.

## Build & test

```
pnpm install
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit, strict
pnpm test        # vitest (unit + property)
pnpm test:integration   # requires local anvil forks — see test/integration/README
pnpm build
sentinel doctor  # ./bin, or `pnpm sentinel doctor`
```

Definition of done for any task: code + tests + docs updated, `pnpm lint`, `pnpm
typecheck`, `pnpm test` all pass, and the current phase's acceptance criteria in
`docs/SPEC.md` §13 are met.

## Conventions

- TypeScript strict mode everywhere; no `any` without a `// eslint-disable-next-line`
  and a reason.
- Detectors (`src/signals/**`) are pure: no I/O, no imports from `chain/`, `storage/`,
  or `notify/`. One file per detector, doc comment (purpose/inputs/formula/thresholds/
  false-positive sources), unit tests, and an entry in `docs/DETECTORS.md`.
  every signal carries its evidence (raw values, block numbers, source IDs).
- Every protocol-specific fact (address, ABI, event name) is verified against an
  official source and recorded in `docs/SOURCES.md` or a code comment — never typed
  from memory.
- Config is validated with zod; nothing external (config, RPC responses) is trusted
  without a schema.
- Small, focused commits, at least one per milestone. Never commit secrets, generated
  reports, or cached replay data (all git-ignored).
- Non-trivial decisions get a short ADR in `docs/adr/NNNN-title.md`. Don't wait for
  approval on reasonable calls — record the decision and move on; only stop to ask when
  genuinely blocked, and log the open question in `docs/PROGRESS.md` meanwhile.

## Where things are

See `docs/SPEC.md` §5.2 for the full repository layout. `docs/ARCHITECTURE.md`
explains how the pieces fit together and why.
