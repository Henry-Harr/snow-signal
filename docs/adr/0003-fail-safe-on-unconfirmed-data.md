# 0003: Fail-safe direction when quorum data can't be confirmed

## Context

Safety rule 7 (spec §2): any decision that moves money must rest on data confirmed by
at least two independent RPC providers at the same block. If confirmation fails,
Sentinel must "alert loudly and keep retrying, but never exit on unconfirmed data."
This is a trade-off that needs to be stated explicitly, because it has a real cost.

## Decision

When quorum confirmation fails for a decision-critical read (balance, liquidity,
oracle price, pause/freeze flag) at a block where an exit-driving decision would
otherwise fire:

- Sentinel does **not** execute the withdrawal/exit on the unconfirmed data, even if
  the single available reading looks critical.
- Sentinel raises an infra signal (D16) and a loud, repeat-until-acknowledged alert
  distinct from a normal detector alert — "I can't confirm what's happening, and that
  itself might mean something is wrong" is a valid and important thing to tell the
  user.
- Sentinel keeps retrying quorum confirmation on every subsequent block; it does not
  give up, time out into "assume the worst" mode, or time out into "assume it's fine"
  mode. Both of those are decisions-by-inaction that spec §2 doesn't authorize.
- The one exception is D16 itself: infra signals (including "quorum failed") never
  trigger an exit on their own (spec §8.1 invariant) — they can only ever make
  Sentinel *more* vocal, never move money by themselves.

## Trade-off being accepted

**We are explicitly choosing to risk a slower reaction over risking an action based on
bad data.** If a real, fast-moving incident happens to coincide with a provider
disagreement or outage (plausible — incidents often correlate with infra stress, e.g.
everyone's RPC providers get hammered during a market-wide liquidation cascade), the
withdrawal could be delayed until quorum is restored, by which point some of the
position's liquidity may no longer be recoverable.

This is accepted because the alternative — acting on unconfirmed, single-source data —
opens Sentinel up to a single compromised or buggy RPC provider single-handedly
triggering an incorrect withdrawal (see `docs/THREAT_MODEL.md` §3). Given priority 1
in the spec ("Sentinel itself must never lose or misdirect funds") ranks above priority
2 ("detect real danger early"), a false negative caused by an infra outage is judged
less bad than a false action caused by trusting bad data. The loud, repeating,
un-ignorable alert during a confirmation failure is the mitigation for the "reaction
gets slower" cost: the user is a fallback decision-maker who can act manually the
moment they see it, even while Sentinel itself declines to.

## Consequences

- Provider diversity and uptime matter more than they would under a "best effort,
  proceed on one provider if needed" design — this raises the bar for what counts as
  an acceptable RPC setup (spec §15 asks the user for two independent providers per
  chain specifically because of this).
- The "confirmation failed" alert path needs to be tested as thoroughly as any
  detector (chaos tests, Phase 9: "kill providers, inject stale data") since it is
  itself a safety-critical code path, not just a logging nicety.
