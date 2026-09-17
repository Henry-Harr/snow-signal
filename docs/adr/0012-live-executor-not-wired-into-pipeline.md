# 0012: The live executor is not auto-wired into the pipeline

## Context

Phase 7 wired the paper executor into `src/core/pipeline.ts`'s `runOnce`: when
`execution.mode === 'paper'` and a decision recommends `partial_withdraw`/
`full_exit`, the pipeline calls it automatically on every matching confirmed block.
Phase 8's live executor (`src/actions/live-executor.ts`) is deliberately **not**
given the same treatment, even though it would be a mechanically similar change
(the pipeline already knows the action kind; it would just need a Roles-config
lookup and a call).

Spec §8.4's own list of Phase 8 deliverables — "the live executor, Safe and Roles
setup scripts for forks, private transaction submission, the kill switch, the
end-to-end and negative permission tests, and a step-by-step guide" — doesn't name
"wire it into the pipeline" as a separate item, unlike Phase 7's spec text
(§8.4: "paper: ... simulate on a fork", which the pipeline is the natural place to
invoke from since nothing else in this codebase runs "every confirmed block").

## Decision

Ship the live executor as a complete, independently correct, and independently
tested primitive (`runLiveExecution`) — verified end to end against a real signed
transaction on a fork (`test/integration/actions/live-executor.test.ts`) — without
also deciding, in the same pass, exactly how and when the running system should
invoke it automatically. That's a materially bigger decision than "add a function
call": it's the line between "a system that watches and simulates" and "a system
that moves real money on its own schedule," and it deserves its own explicit design
pass — config shape for per-chain Roles deployment details (mastercopy address,
role key, bot key env var, which RPC to broadcast through), how the kill switch and
manual controls interact with an in-flight live campaign, and what "trigger a
synthetic crisis and verify the bot exits" (spec §11) means for a wiring decision
that, unlike everything reviewed so far this phase, has a real effect the moment
`execution.mode` is ever actually `live` — rather than folding it in as a smaller
piece of an already-large phase, under time pressure, alongside three other new
subsystems (the setup script, the condition-tree encoder, the live executor itself).

## Consequence

Phase 8's spec-stated deliverables are otherwise all met (live executor, Safe/Roles
setup, private-tx submission via configurable RPC, kill switch, e2e + negative
tests, mainnet guide). Wiring `runLiveExecution` into `runOnce` — the equivalent of
Phase 7's paper-executor wiring, plus the config schema additions it needs
(per-chain `liveChains`/`roles` config) — is the concrete next task, tracked in
`docs/PROGRESS.md`'s Known Issues rather than rushed into this session's already
large diff. Until that wiring exists, `execution.mode: 'live'` has no effect even
if a future session (or the user, reading the mainnet guide) sets it — a safe
default for a flag spec says only the user may ever turn on.
