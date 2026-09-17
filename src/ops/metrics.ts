import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { RiskLevel } from '../risk/types.js';

/**
 * Prometheus metrics (docs/SPEC.md §9 Phase 9). One shared `Registry` — created once
 * per process (`sentinel watch`), fed by the pipeline/watch loop, read by
 * `src/ops/health-server.ts`'s `/metrics` endpoint. Deliberately narrow: only the
 * counters/gauges that actually help answer "is this instance healthy, and if not,
 * why" — blocks processed, decisions by level, alert dispatch outcome, per-provider
 * RPC health (consecutive failures, latency), and detector-registry evaluation time.
 * Not a general-purpose metrics dumping ground.
 */
export const registry = new Registry();

export const blocksProcessedTotal = new Counter({
  name: 'sentinel_blocks_processed_total',
  help: 'Confirmed blocks the pipeline has run for, per chain.',
  labelNames: ['chain'] as const,
  registers: [registry],
});

export const decisionsTotal = new Counter({
  name: 'sentinel_decisions_total',
  help: 'Risk-engine decisions recorded, by position and resulting level.',
  labelNames: ['position_id', 'level'] as const,
  registers: [registry],
});

export const alertsDispatchedTotal = new Counter({
  name: 'sentinel_alerts_dispatched_total',
  help: 'Notifier dispatch attempts, by notifier and outcome.',
  labelNames: ['notifier', 'outcome'] as const, // outcome: 'success' | 'failure'
  registers: [registry],
});

export const rpcProviderConsecutiveFailures = new Gauge({
  name: 'sentinel_rpc_provider_consecutive_failures',
  help: "An RPC provider's current consecutive-failure count (0 = healthy).",
  labelNames: ['chain', 'provider'] as const,
  registers: [registry],
});

export const rpcProviderLatencyMs = new Gauge({
  name: 'sentinel_rpc_provider_latency_ms',
  help: "An RPC provider's most recently observed round-trip latency.",
  labelNames: ['chain', 'provider'] as const,
  registers: [registry],
});

export const pipelineRunDurationSeconds = new Histogram({
  name: 'sentinel_pipeline_run_duration_seconds',
  help: 'Wall-clock time for one runOnce() call (collect, detect, decide, dispatch), per chain.',
  labelNames: ['chain'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export function recordDecision(positionId: string, level: RiskLevel): void {
  decisionsTotal.inc({ position_id: positionId, level });
}

export function recordProviderHealth(
  chain: string,
  health: { provider: string; consecutiveFailures: number; lastLatencyMs: number | undefined }[],
): void {
  for (const p of health) {
    rpcProviderConsecutiveFailures.set({ chain, provider: p.provider }, p.consecutiveFailures);
    if (p.lastLatencyMs !== undefined) {
      rpcProviderLatencyMs.set({ chain, provider: p.provider }, p.lastLatencyMs);
    }
  }
}
