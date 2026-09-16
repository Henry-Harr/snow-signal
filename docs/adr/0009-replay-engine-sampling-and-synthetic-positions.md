# 0009: Replay engine — block sampling interval and synthetic positions

## Context

Spec §9.1 asks for a deterministic replay engine that "feeds historical blocks through
the same pipeline" (`src/core/pipeline.ts`'s `runOnce`), and §9.2 asks for scenarios
spanning from a few days (the named incidents) to "at least 30 recent days per chain"
(quiet periods). Two questions had no single obvious answer and had to be settled
before writing any replay code.

## Decision

- **Sampling interval, not every confirmed block.** The live pipeline runs once per
  confirmed block (~12s on Ethereum, ~2s on Base). Replaying 30 days at that cadence is
  roughly 200,000+ `runOnce` calls per chain per scenario — computationally infeasible
  (even served entirely from the disk cache, that's 200,000+ full detector-registry +
  risk-engine passes) and unnecessary: nothing in spec §9.3's scoring (lead time,
  recoverable share, false alarms/week, gas) needs block-level resolution, only
  "roughly how the position would have fared over time." Each scenario YAML declares
  its own `sampleIntervalBlocks` — a real block is still read and pinned at every
  sampled point (never interpolated or synthesized), so every detector's input is
  still genuine on-chain state at that block; only the _interval between_ evaluated
  blocks is coarser than "every single one." Crisis scenarios (hours to days) use a
  small interval to resolve the point of no return precisely; quiet-period scenarios
  (30 days) use a much larger one, since their whole purpose is a false-alarm count,
  not micro-timing.
- **Synthetic positions, not live position discovery.** The live pipeline discovers the
  configured Safe's actual on-chain balance (`ProtocolAdapter.discoverPositions`).
  Replaying a scenario from years ago against a Safe that (a) didn't hold a position in
  that market at that block, and/or (b) is a real address whose historical balance is
  irrelevant to "what would Sentinel have told _a_ position holder" would either find
  nothing (empty context, nothing to score) or accidentally depend on the Safe's real
  unrelated history. Spec §9.2 itself says a scenario declares "a simulated position for
  me" — so `PipelineDeps` gains an optional `positionOverrides: Record<marketId,
Position>`; when present for a market, `src/core/pipeline.ts` uses that `Position`
  directly instead of calling `discoverPositions`, skipping the live discovery RPC
  calls entirely (a synthetic position needs no live balance read). Everything
  downstream — snapshotting, collateral exposure, governance/pool-flow events, the
  detector registry, the risk engine, decision persistence, alert formatting — is
  **unchanged, the same code path live and replay both run** (docs/ARCHITECTURE.md
  #2's "one code path" principle). Only the _source_ of one input (the position) is
  swapped, exactly the same shape of extension point `Clock`/`BlockSource` already are.
- **Event fetch windows must cover the gap between samples, not just the sampled
  block.** `src/core/pipeline.ts`'s governance/pool-flow event fetch was originally
  hardcoded to `[at.number, at.number]` — correct for live (every confirmed block is
  processed, so there's never a gap) but silently wrong for a strided replay: any
  large-holder or governance event in a skipped block between samples would never be
  recorded, quietly breaking D05/D12/D13 for any scenario with a stride wider than one
  block. Fixed by adding `PipelineDeps.eventsFromBlock` (defaults to `at.number`,
  live's existing behavior unchanged) — the replay runner sets it to the previous
  sampled block, so each step's fetch covers the full gap. This interacts with the
  already-known ~10-block `eth_getLogs` free-tier cap (`src/watchers/governance.ts`,
  found in the Phase 3 session): a stride wider than ~10 blocks risks the RPC
  provider rejecting that fetch outright — confirmed for real running the full
  scenario suite against live archive RPCs (Alchemy _and_ Ankr both hard-error past
  their own range cap, rather than silently truncating), which crashed the whole
  multi-scenario run the first time it happened, discarding every already-completed
  scenario's results. Rather than build chunked fetching now (a real side-project of
  its own), the runner **clamps** `eventsFromBlock` to the last 9 blocks before the
  current sample — Alchemy's actual limit, confirmed from its error response's own
  suggested corrected range (`toBlock - fromBlock === 9`), not the rounder "10 block
  range" wording in its error message's prose — (logging a warning each time) instead
  of requesting the full gap —
  scenarios needing accurate D05/D12/D13 coverage are expected to use a small enough
  stride to stay under the cap in the first place; quiet-period scenarios, which don't
  need that fidelity, can use a much larger stride and accept the resulting gap
  without it ever becoming a hard failure.
- **Scoring gaps stay honest, not fabricated.** "Gas that would have been spent" (spec
  §9.3) needs a real withdrawal planner with gas estimation, which doesn't exist until
  Phase 7. The replay scorer reports this field as `undefined`/"not available until
  Phase 7" rather than a guessed number — same discipline `daily-report.ts` already
  established for its own placeholder sections.

## Consequences

- A scenario's `sampleIntervalBlocks` is itself a real parameter that affects results
  (too coarse and a fast-moving crisis's lead time reads wrong) — each scenario's own
  YAML documents why its interval was chosen, and `docs/REPLAY_RESULTS.md` states the
  interval used per scenario so a reader can judge the resolution the numbers are
  actually good to.
- `positionOverrides` bypasses `discoverPositions`, so a replay run never exercises
  that adapter method — Phase 2's fork tests already cover it against live state; this
  isn't a regression in coverage, just a scope note.
- Recoverable share still calls the _real_ `withdrawable()` per protocol at each
  sampled block for the synthetic position, since that path doesn't depend on how the
  position was sourced — this is the one place replay's "recoverable share" score is
  genuinely measuring real historical liquidity, not a synthetic figure.
