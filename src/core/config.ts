import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { ConfigError } from './errors.js';

/**
 * Substitutes `${VAR_NAME}` tokens in raw config text with values from `env` before
 * the text is parsed as YAML. This is how secrets (RPC keys, bot tokens) get into
 * config without ever being written to the config file itself (safety rule 1,
 * docs/SPEC.md #2) — the file only ever contains the variable name.
 *
 * An unset variable is left as a hard error rather than silently becoming an empty
 * string, since an empty RPC URL or an empty Safe address would otherwise fail far
 * from here with a confusing message.
 *
 * This runs on the raw file text before YAML parsing, so a literal `${...}` anywhere
 * in the file — including inside a YAML comment — is treated as a real reference.
 * Config authors should avoid that syntax in comments.
 */
export function substituteEnvVars(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  return raw.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) => {
    const value = env[name];
    if (value === undefined) {
      throw new ConfigError(
        `Config references \${${name}}, but that environment variable is not set. ` +
          `Set it (see .env.example) or remove the reference.`,
      );
    }
    return value;
  });
}

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 40-hex-char address');

const rpcEndpointSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
});

const chainSchema = z.object({
  chainId: z.number().int().positive(),
  confirmations: z.number().int().nonnegative(),
  rpc: z.array(rpcEndpointSchema).min(2, 'at least two independent RPC providers are required'),
});

const aaveV3PositionSchema = z.object({
  protocol: z.literal('aave-v3'),
  chain: z.string().min(1),
  market: z.string().min(1),
  asset: z.string().min(1),
});

const morphoBluePositionSchema = z.object({
  protocol: z.literal('morpho-blue'),
  chain: z.string().min(1),
  marketId: z.string().min(1),
});

const morphoVaultPositionSchema = z.object({
  protocol: z.literal('morpho-vault'),
  chain: z.string().min(1),
  vault: addressSchema,
});

const positionSchema = z.discriminatedUnion('protocol', [
  aaveV3PositionSchema,
  morphoBluePositionSchema,
  morphoVaultPositionSchema,
]);

// Per-detector threshold shapes vary a lot (see docs/SPEC.md #7 — some detectors have
// watch/danger/critical, some have a single threshold, D12 is per-change-type, etc.),
// and detectors themselves aren't implemented until Phase 4. Phase 1 validates that
// each entry is a flat record of numbers/strings/booleans keyed by detector id, and
// each detector will layer its own precise zod schema over its own key in Phase 4
// rather than this file trying to enumerate all sixteen shapes up front.
const detectorConfigSchema = z.record(
  z.string().regex(/^D\d{2}_/, 'detector config keys must look like "D01_utilization"'),
  z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
);

const withdrawActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('alert') }),
  z.object({ action: z.literal('partial_withdraw'), fraction: z.number().min(0).max(1) }),
  z.object({ action: z.literal('full_exit') }),
]);

const policySchema = z.object({
  watch: withdrawActionSchema.optional().default({ action: 'alert' }),
  danger: withdrawActionSchema,
  critical: withdrawActionSchema,
  maxShareOfAvailableLiquidity: z.number().min(0).max(1),
});

const executionModeSchema = z.enum(['off', 'paper', 'live']);

/** Per-chain Zodiac Roles deployment details (docs/SPEC.md §8.4, docs/
 * MAINNET_SETUP.md) — required for a chain to be live-capable at all, independent of
 * whether it's currently enabled (see `liveChains` below). `roleKey` is a `bytes32`
 * value (any value; convention is `keccak256("sentinel-<chain>-withdraw")`, matching
 * `scripts/setup-safe-roles-fork.ts`). */
const rolesConfigSchema = z.object({
  rolesModAddress: addressSchema,
  roleKey: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 32-byte value'),
  botPrivateKeyEnvVar: z.string().min(1),
});

const executionSchema = z.object({
  mode: executionModeSchema.default('off'),
  maxPriorityFeeGwei: z.record(z.string(), z.number().nonnegative()),
  /** Per-chain live-execution opt-in (spec §8.4: "allowed ... per chain, in
   * config" — the user's own explicit gate, never set by Sentinel or the assistant
   * building it). A chain only actually goes live once live execution is wired into
   * the pipeline (docs/adr/0012-live-executor-not-wired-into-pipeline.md) *and*
   * `mode` is `'live'` *and* the chain is listed here — three independent gates,
   * every one of them required. */
  liveChains: z.array(z.string()).default([]),
  /** Per-chain Roles config — see `rolesConfigSchema` above. Keyed by chain name,
   * same as `chains`/`positions`. */
  roles: z.record(z.string(), rolesConfigSchema).default({}),
});

const telegramNotifySchema = z.object({
  tokenEnv: z.string().min(1),
  allowedChatIds: z.array(z.string()).default([]),
});

const notifySchema = z.object({
  telegram: telegramNotifySchema.optional(),
  discordWebhookEnv: z.string().min(1).optional(),
});

const benchmarkSchema = z.object({
  kind: z.enum(['pool_base_rate', 'vault']),
  vault: addressSchema.optional(),
});

const reportsSchema = z.object({
  dailyUtcHour: z.number().int().min(0).max(23).default(0),
  benchmark: benchmarkSchema,
});

export const sentinelConfigSchema = z.object({
  safe: z.object({ address: addressSchema }),
  chains: z.record(z.string(), chainSchema),
  positions: z.array(positionSchema),
  detectors: detectorConfigSchema,
  policy: policySchema,
  execution: executionSchema,
  notify: notifySchema,
  reports: reportsSchema,
});

export type SentinelConfig = z.infer<typeof sentinelConfigSchema>;
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export interface LoadedConfig {
  config: SentinelConfig;
  /** sha256 of the post-substitution, parsed-and-reserialized config — used to stamp
   * every DecisionRecord so a decision can always be traced back to the exact config
   * that produced it (docs/ARCHITECTURE.md #5, docs/SPEC.md #5.1). */
  hash: string;
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const raw = readFileSync(path, 'utf-8');
  const substituted = substituteEnvVars(raw, env);

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(substituted);
  } catch (cause) {
    throw new ConfigError(`Failed to parse ${path} as YAML`, { cause });
  }

  const result = sentinelConfigSchema.safeParse(parsedYaml);
  if (!result.success) {
    throw new ConfigError(`Invalid config at ${path}:\n${result.error.toString()}`);
  }

  const hash = createHash('sha256').update(JSON.stringify(result.data)).digest('hex');
  return { config: result.data, hash };
}
