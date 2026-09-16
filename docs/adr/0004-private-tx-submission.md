# 0004: Private transaction submission per chain

## Context

Spec §8.3: "Use a private-transaction RPC where available (for example Flashbots
Protect on Ethereum mainnet). Research the options for Base and record the choice in
an ADR."

Research (2026-09-15, see `docs/SOURCES.md`): Flashbots Protect explicitly supports
only Ethereum mainnet, Sepolia, and Holesky — no Base support found. Base's own MEV
mitigation ("Flashblocks," ~200ms sequencer pre-confirmations, co-developed with
Flashbots) operates at the sequencer level and isn't a private-mempool submission
endpoint that a client independently sends transactions through the way Flashbots
Protect works on L1.

## Decision

- **Ethereum mainnet**: submit withdraw/redeem transactions through Flashbots Protect
  (or an equivalent private-transaction RPC) rather than the public mempool, per spec.
- **Base**: submit through the chain's configured RPC directly (no private-mempool
  layer), because:
  1. No established, verifiable private-transaction submission option was found for
     Base as of this research date.
  2. Sentinel's on-chain footprint is narrow by design — it only ever sends
     withdraw/redeem calls to a small, allowlisted set of pool/vault contracts, with
     the recipient locked to the user's own Safe. These transactions have no
     extractable MEV value to a frontrunner or sandwicher the way a swap or a
     liquidation would: there's no slippage to sandwich and no ordering-dependent
     value to extract from "Sentinel withdraws its own funds to its own Safe." The
     private-mempool requirement is much lower-stakes here than for, say, a DEX trade.
  3. Base's Flashblocks pre-confirmations already reduce the _inclusion-time_ risk
     (the thing that matters most for an exit racing against a draining pool) even
     without a dedicated private-tx endpoint.

## Revisit when

- A Base-native private-transaction relay becomes clearly established and documented
  (re-check via official Base docs / Flashbots announcements before Phase 8 ships, not
  just from this Phase 0 research pass — this is exactly the kind of fact spec rule 6
  says not to trust from an earlier note without re-verifying).
- If Sentinel's scope ever grows to include anything with real MEV value (it
  shouldn't, per spec §1.2, but if that ever changes this decision must be revisited
  first).

## Consequences

- Base withdrawals are marginally more exposed to public-mempool visibility than
  Ethereum ones, accepted per the reasoning above. This should be called out plainly
  in `docs/RUNBOOK.md` so the user isn't surprised by the asymmetry.
