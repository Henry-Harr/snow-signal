import type { Detector, DetectorContext } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D11 — Bad debt or a deficit in a watched market (docs/SPEC.md #7, collateral
 * family).
 *
 * Purpose: realized bad debt (a borrow that can never be fully repaid because its
 * collateral is gone or worthless) is not a leading indicator like most of the other
 * detectors — it's confirmation that a loss has already crystallized in a market I'm
 * supplying to, which directly erodes what I can withdraw.
 *
 * Inputs: `MarketSnapshot.badDebt` — an optional field the protocol adapter populates
 * only when the protocol has a concept of realized bad debt/deficit at all (e.g.
 * Aave v3's reserve deficit, Morpho Blue's `badDebtAssets`); markets where the field
 * is `undefined` are skipped, not treated as zero.
 *
 * Formula: no threshold math at all — `badDebt > 0` is itself the signal. Bad debt
 * either exists on-chain or it doesn't; there is no "borderline" reading to tune, so
 * unlike every other detector this one has a single fixed trigger condition instead
 * of watch/danger/critical thresholds. Severity is `critical` whenever `badDebt`
 * crosses the configured minimum (a dust-filtering floor, not a graduated scale).
 *
 * Default threshold: `minBadDebt` defaults to `1n` (raw asset units) — i.e. any
 * nonzero reported bad debt fires by default; config can raise this to filter out
 * protocol-level rounding dust if that turns out to be noisy in practice (spec §7:
 * "critical when realized bad debt reaches a configured amount").
 *
 * **Standalone-critical** (spec §8.1): bad debt is one of the two detectors spec
 * explicitly allows to trigger a full exit without corroboration from another
 * family (alongside D06 at critical) — a market that already has confirmed bad debt
 * doesn't need a second family's signal to justify treating it as critical.
 *
 * Known false-positive sources: essentially none, given the input is already a
 * confirmed on-chain fact rather than a derived heuristic — the main risk is the
 * *adapter* misreading what counts as "bad debt" for a given protocol (e.g.
 * conflating a temporary accounting deficit that gets socialized/covered
 * automatically with genuinely unrecoverable debt), which is an adapter-correctness
 * concern (Phase 2), not something this detector can second-guess from a single
 * `bigint` field.
 */
export const D11_ID = 'D11_bad_debt';

export const D11_DEFAULT_MIN_BAD_DEBT = 1n;

export function createD11Detector(minBadDebt: bigint = D11_DEFAULT_MIN_BAD_DEBT): Detector {
  return {
    id: D11_ID,
    family: 'collateral',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const market of ctx.markets) {
        const badDebt = market.current.badDebt;
        if (badDebt === undefined || badDebt < minBadDebt) continue;

        signals.push({
          detectorId: D11_ID,
          family: 'collateral',
          subject: { kind: 'market', id: market.marketId },
          severity: 'critical',
          standaloneCritical: true,
          value: Number(badDebt),
          threshold: Number(minBadDebt),
          evidence: {
            badDebt,
            block: market.current.block,
          },
        });
      }
      return signals;
    },
  };
}
