# 0010: Paper-mode simulation is not wired into the replay engine

## Context

Spec §9.1/Phase 7's own "done when" (docs/SPEC.md §13) asks that "replays show what
paper mode would have done." Phase 7 built the withdrawal planner, fork simulator,
and paper executor (`src/actions/{planner,simulator,paper-executor}.ts`) and verified
them end to end against a real Aave v3 position created on a fork. The natural next
step was wiring `runPaperExecution` into `src/replay/runner.ts` so a scenario's
`IncidentScore.gasSpentWei` (currently always `undefined`, per its own doc comment)
would carry a real figure.

That wiring turns out to conflict with a decision already made and recorded in ADR
0009: replay scenarios use a **synthetic** `Position` (`positionOverrides`), not a
real discovered on-chain balance — deliberately, since replaying a scenario from the
past against the configured Safe's actual historical balance would either find
nothing or accidentally depend on unrelated history. `runPaperExecution` has no
equivalent override: it always calls `adapter.discoverPositions(safeAddress, at)`
fresh against its own freshly-spawned fork. For a synthetic scenario position, that
address typically holds no real balance at that block — the paper executor would
correctly report `'no-position'` and never actually simulate a withdrawal, which
would silently make `gasSpentWei` look "wired" while never producing a real number
for the scenarios that matter most (the ones that actually reach DANGER/CRITICAL).

Closing that gap "for real" has exactly two shapes, both rejected:

1. **Give `runPaperExecution` a position override too**, mirroring `positionOverrides`,
   and simulate a withdrawal *as if* the synthetic balance were real. But a
   `TxRequest` built from `buildWithdraw()` still executes against the fork's real
   state — withdrawing a balance the impersonated address doesn't actually hold on
   that fork reverts (insufficient balance), so this alone doesn't work.
2. **Fabricate the synthetic balance on the fork** before simulating (e.g.
   `anvil_setStorageAt` to write a raw aToken balance). This is the exact approach
   already considered and rejected once this phase, for the paper executor's own
   fork test (see that file's doc comment): Aave's scaled-balance accounting means
   guessing the right storage slot/encoding risks getting it wrong in a way that's
   silently incorrect rather than loudly broken — a worse failure mode than an
   honestly-missing number. The same reasoning applies here, more so, since a wrong
   guess would then poison `docs/REPLAY_RESULTS.md` with a fabricated-looking-real
   gas figure.

## Decision

Do not wire paper-mode simulation into the replay engine. `IncidentScore.gasSpentWei`
stays `undefined`, exactly as it already was and already documented, rather than a
misleading fabricated number.

What *is* real and already answers the spirit of "what would paper mode have done":
`recoverableShareAtPointOfNoReturn`, computed from `adapter.withdrawable()` read
against the real historical pool state at the point of no return — a genuine,
on-chain-verified answer to "how much of the (synthetic) position could actually have
been pulled out," which is the number that actually matters for scoring a detection
system (spec §9.3's own framing: lead time and recoverable share are the headline
metrics; gas is a secondary cost figure). What's missing is specifically the
*mechanical* proof (a real simulated transaction, real gas) that a withdrawal call
against that exact historical market would not have reverted — genuinely useful, but
a materially smaller and different claim than "recoverable share."

The paper executor and daily drill are both verified for real, against a real
position, elsewhere (`test/integration/actions/{paper-executor,exit-drill}.test.ts`)
— this gap is specifically "replay drives it too," not "it doesn't work."

## Consequence

Phase 7's spec-stated "done when" is met partially: the drill runs and reports
correctly (fully met); replays show recoverable share but not simulated gas (the
narrower literal reading is not met, for the reason above). Revisit only if a future
session designs a real (not fabricated) way to fund a synthetic replay position on a
fork — e.g. sourcing an actual historical whale for each scenario the way the paper
executor's own fork test does, which is realistic for the two real-incident
scenarios but not for the five synthetic fault-injection scenarios (docs/adr/0009),
which have no real-world counterpart to source a funded address from at all.
