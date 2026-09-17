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
 * Default threshold: `minBadDebt` defaults to `2_000_000_000n` — $2,000-equivalent
 * raw units, assuming a 6-decimal stablecoin (every currently-watched asset is USDC;
 * revisit if a non-6-decimal or non-$1-pegged asset is ever added — this detector has
 * no decimals/price input to convert against). Originally `1n` (any nonzero bad debt
 * at all) through Phase 4; raised per `docs/TUNING_LOG.md`'s 2026-09-16 entry, applied
 * 2026-09-17 after this exact default caused real false CRITICAL/full-exit alerts in
 * production on both watched Aave v3 Core USDC reserves' small persistent reserve
 * deficit (~$1.60 Ethereum, ~$30.88 Base — real, but dust, not a crisis). $2,000 clears
 * both by a wide margin while still catching genuinely material bad debt; see the
 * tuning log for the replay evidence behind both the original finding and this value.
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

export const D11_DEFAULT_MIN_BAD_DEBT = 2_000_000_000n;

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
