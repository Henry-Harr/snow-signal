# 0002: One risk-engine state machine per position, positions can share underlying risk

## Context

A user can be exposed to the same underlying market/asset risk through more than one
path — e.g. directly supplying USDC to Aave's core market, *and* holding a Morpho
vault share whose look-through allocation includes that same Aave market (once
cross-protocol vault allocation exists) or a Morpho Blue market sharing a collateral
asset with something else the user is exposed to. The risk engine (spec §8.1) is
specified as "one state machine per position." We need to decide what a "position" is
and how shared underlying risk (e.g. D14 contagion) is supposed to interact with that.

## Decision

- A **position** is one row of the user's configured `positions` list (spec §14
  example config): a specific (protocol, chain, market-or-vault, asset) the user holds
  directly. Each position gets its own state machine instance.
- Underlying risk that's *shared* across positions (an asset flagged by a
  collateral/oracle detector, a market flagged by a pool-flow detector) is not
  deduplicated at the state-machine level. Instead, D14 (contagion) is the mechanism
  that propagates a flagged asset's severity into *every* position exposed to it,
  including through vault look-through — each affected position's own state machine
  receives its own (possibly downgraded, per D14's rule) signal and evaluates it
  independently.
- This means the *same* underlying incident can legitimately push multiple positions
  into WATCH/DANGER/CRITICAL at once, each with its own DecisionRecord. That's
  intentional: the withdrawal planner and alerts operate per position (a user's Safe
  can only withdraw from where it actually holds a position), so per-position state
  and per-position decision records are what the action layer needs to act correctly.

## Alternatives considered

- **One state machine per underlying market/asset, positions just reference it**:
  simpler deduplication, but doesn't fit cleanly with "the risk engine decides what
  action to take for *this user's money in this specific place*" — action planning
  needs a position-shaped decision (withdraw *this* position) more than it needs a
  market-shaped one. Rejected, but the underlying-risk-detection layer (detectors that
  operate on markets/assets, not positions) still exists independently and feeds
  multiple position state machines via D14 — so we get most of the simplicity benefit
  without losing position-level actionability.

## Consequences

- Contagion (D14) is load-bearing for correctness: if it has a bug that fails to
  propagate a flagged asset to an exposed position, that position's state machine
  simply never hears about the risk. D14 needs strong test coverage, including through
  vault look-through, before Phase 5 ships.
- Reports and alerts should make the shared-root-cause relationship visible to the
  user (e.g. "3 positions escalated, all due to asset X") rather than presenting three
  seemingly-unrelated incidents — a reports/UX concern for Phase 5/10, noted here so
  it isn't lost.
