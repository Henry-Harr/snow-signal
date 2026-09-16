import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { SentinelError } from '../core/errors.js';

/**
 * Replay scenario format (docs/SPEC.md §9.2): "a description, chains, block range,
 * markets and vaults, a simulated position for me, ground-truth events with
 * timestamps, and source links." Covers scenario types 1–4 (the three named real
 * incidents plus quiet periods) — all of which replay the real pipeline against real
 * archived block ranges. Type 5 (synthetic fault injection) is a structurally
 * different kind of scenario — no real block range to replay against, since faults
 * like "RPC outage" or "provider disagreement" are about the infra layer's own
 * behavior, not market data — and is covered by `src/replay/synthetic-scenario.ts`
 * instead; see that file's header comment for the full reasoning.
 */

export class ReplayScenarioError extends SentinelError {}

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 40-hex-char address');

const aaveV3ScenarioPositionSchema = z.object({
  protocol: z.literal('aave-v3'),
  market: z.string().min(1),
  asset: z.string().min(1),
});

const morphoVaultScenarioPositionSchema = z.object({
  protocol: z.literal('morpho-vault'),
  vault: addressSchema,
});

const scenarioPositionSchema = z.discriminatedUnion('protocol', [
  aaveV3ScenarioPositionSchema,
  morphoVaultScenarioPositionSchema,
]);

const groundTruthEventSchema = z.object({
  at: z.string().datetime({ offset: true }),
  blockNumber: z.coerce.bigint(),
  description: z.string().min(1),
  /** Marks the scenario's defined "point of no return" (docs/SPEC.md §9.3's lead-time
   * score is measured against this) — at most one event should set this `true`. */
  pointOfNoReturn: z.boolean().default(false),
});

const sourceSchema = z.object({
  url: z.string().url(),
  note: z.string().min(1),
});

export const replayScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be lowercase-kebab-case'),
  description: z.string().min(1),
  /** `'incident'` scores lead time/recoverable share against `groundTruth`'s point of
   * no return; `'quiet'` has no incident — every alert during it counts toward the
   * false-alarms/week score instead (docs/SPEC.md §9.2 items 1–3 vs. item 4). */
  kind: z.enum(['incident', 'quiet']),
  chain: z.string().min(1),
  chainId: z.number().int().positive(),
  position: scenarioPositionSchema,
  blockRange: z.object({ from: z.coerce.bigint(), to: z.coerce.bigint() }),
  /** See docs/adr/0009 for why replay samples at a stride instead of every block. */
  sampleIntervalBlocks: z.coerce.bigint().positive(),
  /** Raw units (the asset's smallest denomination), as a string since YAML/JSON have
   * no native bigint. */
  simulatedPositionBalanceRaw: z.string().regex(/^\d+$/),
  groundTruth: z.array(groundTruthEventSchema).default([]),
  sources: z.array(sourceSchema).min(1),
});

export type ReplayScenario = z.infer<typeof replayScenarioSchema>;

export function loadScenario(path: string): ReplayScenario {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (cause) {
    throw new ReplayScenarioError(`Could not read scenario file ${path}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    throw new ReplayScenarioError(`Failed to parse ${path} as YAML`, { cause });
  }

  const result = replayScenarioSchema.safeParse(parsed);
  if (!result.success) {
    throw new ReplayScenarioError(`Invalid scenario at ${path}:\n${result.error.toString()}`);
  }
  if (result.data.blockRange.from > result.data.blockRange.to) {
    throw new ReplayScenarioError(`${path}: blockRange.from must be <= blockRange.to`);
  }
  const pointsOfNoReturn = result.data.groundTruth.filter((e) => e.pointOfNoReturn);
  if (pointsOfNoReturn.length > 1) {
    throw new ReplayScenarioError(
      `${path}: at most one groundTruth event may set pointOfNoReturn (found ${pointsOfNoReturn.length})`,
    );
  }
  if (result.data.kind === 'incident' && pointsOfNoReturn.length === 0) {
    throw new ReplayScenarioError(
      `${path}: kind 'incident' scenarios need exactly one groundTruth event with pointOfNoReturn: true`,
    );
  }

  return result.data;
}
