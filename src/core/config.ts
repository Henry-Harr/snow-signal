import { readFileSync } from 'node:fs';
import { z } from 'zod';

import type { WatchedPosition } from './types.js';

const positionSchema = z.object({
  label: z.string(),
  tokenId: z.string().regex(/^\d+$/, 'tokenId must be a decimal uint256 string'),
  negRisk: z.boolean(),
  shares: z.string().regex(/^\d+$/, 'shares must be a decimal integer string'),
  stopPrice: z.number().min(0).max(1),
  sellFraction: z.number().min(0).max(1).optional(),
});

const configSchema = z.object({
  /** 'paper' (default, safe): logs what would have been sold, never sends a real
   * order. 'live': signs and submits real sell orders. Real capital is only ever
   * at risk in 'live' mode — this must be explicitly set, never assumed. */
  executionMode: z.enum(['paper', 'live']).default('paper'),
  positions: z.array(positionSchema).min(1),
  pollIntervalMs: z.number().int().positive().default(2000),
});

export interface StopLossConfig {
  executionMode: 'paper' | 'live';
  positions: WatchedPosition[];
  pollIntervalMs: number;
}

export function loadConfig(path: string): StopLossConfig {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  const parsed = configSchema.parse(raw);
  return {
    executionMode: parsed.executionMode,
    pollIntervalMs: parsed.pollIntervalMs,
    positions: parsed.positions.map((p) => ({
      label: p.label,
      tokenId: p.tokenId,
      negRisk: p.negRisk,
      shares: BigInt(p.shares),
      stopPrice: p.stopPrice,
      ...(p.sellFraction !== undefined ? { sellFraction: p.sellFraction } : {}),
    })),
  };
}
