# Tuning log

Detection thresholds change only with supporting evidence from the replay harness
(`docs/SPEC.md` §9, safety rule 8: "a single day of results is never enough"). Every
proposed or applied change is recorded here with the replay evidence that justifies
it — never edited from a single day's alerts, and never applied without first being
tested in replay (spec §11.4: "propose only changes that improve results without
increasing misses").

## 2026-09-16 — D11 (bad debt) `minBadDebt` is too sensitive to real dust

**Status: applied 2026-09-17** (`src/signals/D11_bad_debt.ts`, `D11_DEFAULT_MIN_BAD_DEBT`
raised from `1n` to `2_000_000_000n`, i.e. $2,000-equivalent). Forced by this exact
false positive reaching a real production deployment on its first poll — full detail
below under "Applied 2026-09-17".

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

### Applied 2026-09-17

Forcing event: the user's first real production deployment (Docker, Discord
notifications) fired `[CRITICAL] ... full exit` alerts on **both** watched Aave v3
Core USDC positions within seconds of `sentinel watch` starting — exactly this
already-diagnosed false positive (`D11_bad_debt` on `1,604,836`/`30,875,030` raw,
i.e. the same ~$1.60/~$30.88 dust cited above), reaching a real user in real time.
`config.detectors` still isn't wired (that gap remains, see `docs/PROGRESS.md`), so
the fix is a direct change to `D11_DEFAULT_MIN_BAD_DEBT` in
`src/signals/D11_bad_debt.ts` (`1n` → `2_000_000_000n`, $2,000-equivalent, the
middle of the originally-proposed $1,000–$10,000 range) rather than a config value —
config is unaffected either way since it was never reaching the detector before.

**Before/after replay** (`sentinel replay`, real archive RPC data, same scenarios):

| Scenario | Before | After |
|---|---|---|
| `quiet-base-2026-08` (36.0d) | 28.19 false alarms/week | **14.00** false alarms/week |
| `quiet-ethereum-2026-08` (35.9d) | 28.10 false alarms/week | 27.91 false alarms/week (see below) |
| `kelpdao-rseth-exploit-2026-04` | CRITICAL (lead time 1.7d — the confound already flagged above) | WATCH only (lead time to WATCH: 1.4d; DANGER/CRITICAL never reached) |

Full detail (all scenarios) in `docs/REPLAY_RESULTS.md`, regenerated the same run.

**Base improved roughly as expected** — D11 was a real, significant contributor to
its false-alarm rate. **Ethereum barely moved**, and digging into why revealed a
second, distinct issue: the same live false-CRITICAL alert also carried a `D01_
utilization_level watch: value=0.92 threshold=0.9` signal — Ethereum's Aave Core
USDC reserve runs at roughly 92% utilization as a matter of course, independently
keeping decisions above `NORMAL` almost continuously regardless of D11. **Not fixed
here** — this is a materially different kind of tuning decision (utilization is a
genuine leading risk indicator, not an obvious detector-design flaw like "any
nonzero bad debt is a crisis" was) and deserves its own proper investigation (is 92%
this market's real steady-state, or itself informative?) rather than a second rushed
change made under the same pressure. Logged as a new, separate, not-yet-applied
finding — see `docs/PROGRESS.md`'s Known issues. Practical consequence in the
meantime: expect occasional `[WATCH]`-level (alert-only, never a withdrawal
recommendation) Ethereum notifications until this is resolved.

**KelpDAO scenario's "CRITICAL" was the same confound, not real coverage** — this
scenario is watched through the same Aave v3 Ethereum Core USDC position (the
exploit's own collateral was WETH; the scenario deliberately tests contagion/panic
behavior on the *watched stablecoin reserve*, per its own YAML description), so it
inherited the identical persistent-dust false positive from day one of its own
9-day window — exactly what this entry's original finding already predicted
("the very first sampled block ... was already CRITICAL"). After the fix, the
confound is gone and the scenario honestly reports what the contagion-relevant
detectors (D01–D05, D08, D14) actually did during this real panic: reached WATCH
1.4 days before the point of no return, never escalated further. This is **not a
regression introduced by this change** — the previous CRITICAL was never genuine
coverage of this incident, so losing it isn't losing real detection; it's the first
honest reading of these detectors' actual performance on this scenario. Whether
topping out at WATCH represents a real, separate coverage gap for cross-market
contagion events is a legitimate open question, logged in `docs/PROGRESS.md`'s Known
issues rather than acted on here — spec §11.4's "improves results without
increasing misses" bar is satisfied (no real miss existed before to lose), but this
is a materially different, bigger question than the one this entry set out to
answer.

**Synthetic fault-injection scenarios**: unchanged (still 4/5 PASS, the pre-existing
`paused-withdrawals` FAIL is unrelated to D11 — not investigated as part of this
change).
