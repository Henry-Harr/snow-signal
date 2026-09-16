# Tuning log

Detection thresholds change only with supporting evidence from the replay harness
(`docs/SPEC.md` §9, safety rule 8: "a single day of results is never enough"). Every
proposed or applied change is recorded here with the replay evidence that justifies
it — never edited from a single day's alerts, and never applied without first being
tested in replay (spec §11.4: "propose only changes that improve results without
increasing misses").

## 2026-09-16 — D11 (bad debt) `minBadDebt` is too sensitive to real dust

**Status: proposed, not applied.**

**Evidence**: the first real `sentinel replay` run against live archive RPC data
(`docs/REPLAY_RESULTS.md`, this session) measured **28.19 false alarms/week on Base**
and **28.10 false alarms/week on Ethereum** over 36-day "quiet" windows (both chains'
Aave v3 Core USDC reserve) — essentially every single sampled block (4 samples/day at
the scenario's 6-hour stride) produced a non-`NORMAL` decision. The
`kelpdao-rseth-exploit-2026-04` incident scenario shows the same pattern from a
different angle: it reports `CRITICAL` reached with a lead time of "1.7 days before"
the point of no return — a number that looks like an excellent early warning until
you notice 1.7 days is almost exactly the scenario's _entire pre-incident window_,
meaning the very first sampled block (well before the KelpDAO exploit happened at
all) was already `CRITICAL`.

**Root cause**: `D11_bad_debt`'s default threshold (`D11_DEFAULT_MIN_BAD_DEBT = 1n`,
`src/signals/D11_bad_debt.ts`) fires `critical` (standalone-critical — a full-exit
recommendation, no corroboration required) on _any_ nonzero reported bad debt. The
real, currently-configured Aave v3 Core USDC reserves carry small amounts of reserve
deficit continuously: ~$1.60 on Ethereum and ~$30.88 on Base (converting the raw
`badDebt` values `1,604,836` / `30,875,030`, both USDC's 6 decimals, seen throughout
this session's fork tests and this replay run) — real, but dust relative to reserves
in the tens-to-hundreds-of-millions range, not evidence of an acute crisis. `D11`'s
own doc comment already anticipated this exact failure mode: "config can raise this
to filter out protocol-level rounding dust if that turns out to be noisy in
practice" — this replay run is that evidence.

**Proposed change**: raise `minBadDebt` to a value representing roughly $1,000–10,000
USD-equivalent (exact figure needs a decision on what "material" means for the
configured position sizes) rather than the current effectively-zero floor.

**Why not applied in this session**:

1. `config/sentinel.yaml`'s `detectors:` section isn't actually wired to anything yet
   (a separate, deeper gap found in this same session — see docs/PROGRESS.md's Known
   Issues) — there's no way to _apply_ a tuned threshold today without also building
   that wiring, which is its own scoped piece of work.
2. Spec's own process (§11.4) asks for a before/after replay comparison showing the
   change "improves results without increasing misses" before applying it — that
   comparison run hasn't been done yet.
3. The KelpDAO scenario's own confound (see above) means its lead-time score can't be
   trusted at face value until this is fixed and re-run — changing the threshold and
   re-running this exact scenario is also the natural way to confirm the fix actually
   produces a _meaningful_ WATCH/DANGER/CRITICAL signal timed to the real incident,
   not just fewer alerts.

**Next step for whoever picks this up**: wire `config.detectors` into
`defaultDetectors()`'s construction (the gap above), pick a concrete `minBadDebt`
value, re-run `sentinel replay`, and confirm quiet-period false alarms drop while the
KelpDAO scenario's `CRITICAL` decision (if it still fires) traces to a decision
genuinely near the real incident rather than the very first sampled block.
