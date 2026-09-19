# Replay results

_Regenerated 2026-09-19T19:25:02.575Z by `sentinel replay` (docs/SPEC.md §9.3) — regenerate whenever detectors or thresholds change, per that section's own instruction._

**Reading these numbers**: a lead time or false-alarm count only means what it looks like if the underlying decisions are actually about the scenario's own incident. A pre-existing condition unrelated to the scenario (e.g. small standing bad debt already present before an incident scenario's window even starts) can make a lead time look artificially long, or a "quiet" period look falsely noisy — always check a few of the underlying `DecisionRecord.rule` values (via `sentinel label` or the raw decision records) before trusting a number at face value. See `docs/TUNING_LOG.md` for concrete findings from past runs.

## Scenarios that failed to run

- `scenarios/usdc-depeg-2023-03.yaml`: aave-v3:ethereum:core:USDC getReserveData: The contract function "getReserveData" returned no data ("0x").

## Incident scenarios

### kelpdao-rseth-exploit-2026-04

- Point of no return: 2026-04-18T17:35:00.000Z (block 24908282)
- Lead time to WATCH: 17.5h before
- Lead time to DANGER: _never reached_
- Lead time to CRITICAL: _never reached_
- Recoverable share at point of no return: 100.0%
- Final decision level: WATCH
- Gas spent: _not available — needs the withdrawal planner, Phase 7_
- Blocks sampled: 96

## Quiet periods (false-alarm rate)

### quiet-base-2026-08

- Duration: 36.0 days
- False alarms: 68
- False alarms per week: 13.22
- Blocks sampled: 145

### quiet-ethereum-2026-08

- Duration: 35.9 days
- False alarms: 12
- False alarms per week: 2.34
- Blocks sampled: 144

## Synthetic fault-injection scenarios

| Scenario | Expected min. level | Actual level | Result |
|---|---|---|---|
| utilization-spike | WATCH | WATCH | PASS |
| frozen-oracle | WATCH | WATCH | PASS |
| depeg | WATCH | WATCH | PASS |
| whale-exit | WATCH | WATCH | PASS |
| paused-withdrawals | WATCH | NORMAL | **FAIL** |
