import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../../src/core/errors.js';
import { loadConfig, substituteEnvVars } from '../../../src/core/config.js';

const VALID_YAML = `
safe:
  address: '0x1111111111111111111111111111111111111111'
chains:
  ethereum:
    chainId: 1
    confirmations: 2
    rpc:
      - { name: primary, url: '\${ETH_RPC_PRIMARY}' }
      - { name: secondary, url: 'https://secondary.example.com' }
positions:
  - { protocol: aave-v3, chain: ethereum, market: core, asset: USDC }
detectors:
  D01_utilization: { watch: 0.9, danger: 0.95, critical: 0.99 }
policy:
  danger: { action: partial_withdraw, fraction: 0.5 }
  critical: { action: full_exit }
  maxShareOfAvailableLiquidity: 0.05
execution:
  mode: off
  maxPriorityFeeGwei: { ethereum: 50 }
notify:
  telegram: { tokenEnv: TELEGRAM_BOT_TOKEN, allowedChatIds: [] }
reports:
  dailyUtcHour: 0
  benchmark: { kind: pool_base_rate }
`;

function writeTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-config-test-'));
  const path = join(dir, 'sentinel.yaml');
  writeFileSync(path, contents);
  return path;
}

describe('substituteEnvVars', () => {
  it('replaces ${VAR} with the environment value', () => {
    const result = substituteEnvVars('url: ${FOO}', { FOO: 'https://example.com' });
    expect(result).toBe('url: https://example.com');
  });

  it('throws ConfigError when the variable is unset', () => {
    expect(() => substituteEnvVars('url: ${MISSING}', {})).toThrow(ConfigError);
  });

  it('leaves text with no ${} references untouched', () => {
    expect(substituteEnvVars('plain: text', {})).toBe('plain: text');
  });
});

describe('loadConfig', () => {
  it('loads, substitutes, and validates a well-formed config', () => {
    const path = writeTempConfig(VALID_YAML);
    const { config, hash } = loadConfig(path, { ETH_RPC_PRIMARY: 'https://primary.example.com' });

    expect(config.safe.address).toBe('0x1111111111111111111111111111111111111111');
    expect(config.chains['ethereum']?.rpc[0]?.url).toBe('https://primary.example.com');
    expect(config.execution.mode).toBe('off');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic: identical config produces identical hash', () => {
    const path = writeTempConfig(VALID_YAML);
    const env = { ETH_RPC_PRIMARY: 'https://primary.example.com' };
    const first = loadConfig(path, env);
    const second = loadConfig(path, env);
    expect(first.hash).toBe(second.hash);
  });

  it('rejects a config with fewer than two RPC providers for a chain', () => {
    const badYaml = VALID_YAML.replace(
      "- { name: secondary, url: 'https://secondary.example.com' }\n",
      '',
    );
    const path = writeTempConfig(badYaml);
    expect(() => loadConfig(path, { ETH_RPC_PRIMARY: 'https://primary.example.com' })).toThrow(
      ConfigError,
    );
  });

  it('rejects a Safe address that is not a valid 0x-address', () => {
    const badYaml = VALID_YAML.replace(
      "address: '0x1111111111111111111111111111111111111111'",
      "address: 'not-an-address'",
    );
    const path = writeTempConfig(badYaml);
    expect(() => loadConfig(path, { ETH_RPC_PRIMARY: 'https://primary.example.com' })).toThrow(
      ConfigError,
    );
  });

  it('rejects execution.mode values outside off|paper|live', () => {
    const badYaml = VALID_YAML.replace('mode: off', 'mode: yolo');
    const path = writeTempConfig(badYaml);
    expect(() => loadConfig(path, { ETH_RPC_PRIMARY: 'https://primary.example.com' })).toThrow(
      ConfigError,
    );
  });

  it('throws ConfigError (not a generic error) when a referenced env var is missing', () => {
    const path = writeTempConfig(VALID_YAML);
    expect(() => loadConfig(path, {})).toThrow(ConfigError);
  });
});
