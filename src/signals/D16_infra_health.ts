import type { Detector, DetectorContext } from './types.js';
import type { Signal } from '../core/types.js';

/**
 * D16 — Infra health (docs/SPEC.md #7, infra family).
 *
 * Purpose: tells the difference between "the market is actually fine" and "I can't
 * tell, because my own data pipeline is behind/disagreeing/stale" — the risk engine
 * needs this distinction to avoid either false confidence (acting on stale data as if
 * it were current) or false alarm (treating a data gap as a market event).
 *
 * Inputs: `DetectorContext.infra` (`InfraChainSnapshot[]`) — per-chain head lag,
 * RPC-provider disagreement count, reorg depth, and per-source staleness.
 *
 * Formula: four independent threshold checks, each producing its own signal when it
 * crosses `watch`/`danger` (no `critical` — see below), rather than one combined
 * per-chain signal: `headLagBlocks`, `providerDisagreementCount`, `reorgDepth`
 * (per chain), and each entry in `staleSources` (per source, by `ageSeconds`).
 *
 * Default thresholds (spec placeholders — spec only says "watch or danger by lag and
 * duration," no numbers given): head lag watch ≥ 5 blocks, danger ≥ 20 blocks;
 * provider disagreement watch ≥ 1, danger ≥ 3 (a disagreement is already a quorum-
 * read failure event, so even one is worth a watch); reorg depth watch ≥ 1 block,
 * danger ≥ 3 blocks; stale source age watch ≥ 300s, danger ≥ 1800s.
 *
 * **This detector's signals never reach `critical` and are never
 * `standaloneCritical`** — spec's own wording caps D16 at "watch or danger," and spec
 * §8.1 additionally states infra signals alone must never cause an exit (the risk
 * engine, Phase 5, enforces the family-level exclusion; this detector doing its part
 * is to never claim a severity that would look exit-worthy on its own).
 *
 * Known false-positive sources: a brief, single-block head-lag blip during normal
 * network propagation is expected and not a real infra problem — the `watch`
 * threshold (5 blocks) is set well above single-block noise for exactly this reason.
 * A reorg of depth 1 is routine on most chains during normal operation; only sustained
 * or deep reorgs are actually notable, which is why reorg watch/danger are kept low
 * in absolute terms but still above the "every single block might reorg by one"
 * baseline.
 */
export const D16_ID = 'D16_infra_health';

export interface D16Thresholds {
  headLagBlocks: { watch: number; danger: number };
  providerDisagreementCount: { watch: number; danger: number };
  reorgDepth: { watch: number; danger: number };
  staleSourceAgeSeconds: { watch: number; danger: number };
}

export const D16_DEFAULT_THRESHOLDS: D16Thresholds = {
  headLagBlocks: { watch: 5, danger: 20 },
  providerDisagreementCount: { watch: 1, danger: 3 },
  reorgDepth: { watch: 1, danger: 3 },
  staleSourceAgeSeconds: { watch: 300, danger: 1800 },
};

function severityFor(
  value: number,
  t: { watch: number; danger: number },
): 'watch' | 'danger' | undefined {
  if (value >= t.danger) return 'danger';
  if (value >= t.watch) return 'watch';
  return undefined;
}

export function createD16Detector(thresholds: D16Thresholds = D16_DEFAULT_THRESHOLDS): Detector {
  return {
    id: D16_ID,
    family: 'infra',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const chain of ctx.infra) {
        const checks: { value: number; t: { watch: number; danger: number }; category: string }[] =
          [
            { value: chain.headLagBlocks, t: thresholds.headLagBlocks, category: 'head_lag' },
            {
              value: chain.providerDisagreementCount,
              t: thresholds.providerDisagreementCount,
              category: 'provider_disagreement',
            },
            { value: chain.reorgDepth, t: thresholds.reorgDepth, category: 'reorg' },
          ];
        for (const check of checks) {
          const severity = severityFor(check.value, check.t);
          if (!severity) continue;
          signals.push({
            detectorId: D16_ID,
            family: 'infra',
            subject: { kind: 'infra', id: `chain:${chain.chainId}:${check.category}` },
            severity,
            standaloneCritical: false,
            value: check.value,
            threshold: check.t[severity],
            evidence: { chainId: chain.chainId, category: check.category },
          });
        }

        for (const source of chain.staleSources) {
          const severity = severityFor(source.ageSeconds, thresholds.staleSourceAgeSeconds);
          if (!severity) continue;
          signals.push({
            detectorId: D16_ID,
            family: 'infra',
            subject: { kind: 'infra', id: `source:${source.sourceId}` },
            severity,
            standaloneCritical: false,
            value: source.ageSeconds,
            threshold: thresholds.staleSourceAgeSeconds[severity],
            evidence: {
              chainId: chain.chainId,
              category: 'stale_source',
              sourceId: source.sourceId,
            },
          });
        }
      }
      return signals;
    },
  };
}
