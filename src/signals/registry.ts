import { createD01Detector } from './D01_utilization_level.js';
import { createD02Detector } from './D02_utilization_velocity.js';
import { createD03Detector } from './D03_exit_coverage.js';
import { createD04Detector } from './D04_abnormal_outflows.js';
import { createD05Detector } from './D05_large_holder_exits.js';
import { createD06Detector } from './D06_oracle_market_deviation.js';
import { createD07Detector } from './D07_frozen_oracle.js';
import { createD08Detector } from './D08_collateral_supply_anomaly.js';
import { createD09Detector } from './D09_liquidation_depth.js';
import { createD10Detector } from './D10_peg_deviation.js';
import { createD11Detector } from './D11_bad_debt.js';
import { createD12Detector } from './D12_risky_governance_change.js';
import { createD13Detector } from './D13_vault_allocation_drift.js';
import { createD14Detector, D14_ID } from './D14_contagion.js';
import { createD15Detector } from './D15_debt_near_liquidation.js';
import { createD16Detector } from './D16_infra_health.js';
import type { Detector, DetectorContext } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * The detector registry (docs/SPEC.md #7). Every detector uses its spec-placeholder
 * default thresholds — config-driven threshold overrides are a Phase 5 concern (the
 * risk engine is what reads `sentinel.yaml` and constructs the registry for a real
 * run); this module just wires the sixteen detectors together with sane defaults so
 * `evaluateAll` is usable immediately.
 */
export function defaultDetectors(): Detector[] {
  return [
    createD01Detector(),
    createD02Detector(),
    createD03Detector(),
    createD04Detector(),
    createD05Detector(),
    createD06Detector(),
    createD07Detector(),
    createD08Detector(),
    createD09Detector(),
    createD10Detector(),
    createD11Detector(),
    createD12Detector(),
    createD13Detector(),
    createD14Detector(),
    createD15Detector(),
    createD16Detector(),
  ];
}

/**
 * Runs every detector in `detectors` against `ctx` and returns the combined signals.
 *
 * D14 (contagion) is special-cased into a second pass (ADR 0007): every other
 * detector runs first, against `ctx` with `priorSignals` left exactly as the caller
 * provided (normally empty — see `DetectorContext.priorSignals`'s doc comment); then,
 * if `detectors` includes D14, it runs once more against a copy of `ctx` whose
 * `priorSignals` is the full set of signals the first pass produced. Every other
 * detector's `evaluate` is called exactly once — this function is what makes the
 * two-pass structure invisible to the detectors themselves, matching ADR 0007's
 * design (the detectors stay pure and uniform; the orchestration lives here).
 *
 * `ctx.priorSignals` from the caller (if non-empty) is preserved and included in
 * what D14 sees, concatenated with the first pass's own output — so a caller
 * re-running the registry with signals carried over from elsewhere (e.g. a longer
 * lookback) doesn't lose them.
 */
export function evaluateAll(detectors: Detector[], ctx: DetectorContext): Signal[] {
  const firstPass = detectors.filter((d) => d.id !== D14_ID);
  const contagionPass = detectors.filter((d) => d.id === D14_ID);

  const firstPassSignals = firstPass.flatMap((d) => d.evaluate(ctx));
  if (contagionPass.length === 0) return firstPassSignals;

  const contagionCtx: DetectorContext = {
    ...ctx,
    priorSignals: [...ctx.priorSignals, ...firstPassSignals],
  };
  const contagionSignals = contagionPass.flatMap((d) => d.evaluate(contagionCtx));
  return [...firstPassSignals, ...contagionSignals];
}
