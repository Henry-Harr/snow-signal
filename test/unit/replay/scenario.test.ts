import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadScenario, ReplayScenarioError } from '../../../src/replay/scenario.js';

function writeScenario(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-scenario-test-'));
  const path = join(dir, 'scenario.yaml');
  writeFileSync(path, yaml);
  return path;
}

const VALID_INCIDENT = `
id: test-incident
description: A test incident scenario.
kind: incident
chain: ethereum
chainId: 1
position:
  protocol: aave-v3
  market: core
  asset: USDC
blockRange: { from: 100, to: 200 }
sampleIntervalBlocks: 10
simulatedPositionBalanceRaw: "1000000000"
groundTruth:
  - at: "2023-03-11T00:00:00Z"
    blockNumber: 150
    description: "Something happened."
    pointOfNoReturn: true
sources:
  - url: "https://example.com/postmortem"
    note: "Official postmortem."
`;

describe('loadScenario', () => {
  it('parses a valid incident scenario', () => {
    const scenario = loadScenario(writeScenario(VALID_INCIDENT));
    expect(scenario.id).toBe('test-incident');
    expect(scenario.blockRange).toEqual({ from: 100n, to: 200n });
    expect(scenario.simulatedPositionBalanceRaw).toBe('1000000000');
    expect(scenario.groundTruth[0]?.pointOfNoReturn).toBe(true);
  });

  it('parses a valid morpho-vault position', () => {
    const yaml = VALID_INCIDENT.replace(
      'position:\n  protocol: aave-v3\n  market: core\n  asset: USDC',
      'position:\n  protocol: morpho-vault\n  vault: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61"',
    );
    const scenario = loadScenario(writeScenario(yaml));
    expect(scenario.position).toEqual({
      protocol: 'morpho-vault',
      vault: '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61',
    });
  });

  it('rejects a missing file', () => {
    expect(() => loadScenario('/nonexistent/scenario.yaml')).toThrow(ReplayScenarioError);
  });

  it('rejects malformed YAML', () => {
    expect(() => loadScenario(writeScenario('not: [valid: yaml'))).toThrow(ReplayScenarioError);
  });

  it('rejects a schema violation (missing sources)', () => {
    const yaml = VALID_INCIDENT.replace(/sources:[\s\S]*$/, '');
    expect(() => loadScenario(writeScenario(yaml))).toThrow(ReplayScenarioError);
  });

  it('rejects blockRange.from > blockRange.to', () => {
    const yaml = VALID_INCIDENT.replace(
      'blockRange: { from: 100, to: 200 }',
      'blockRange: { from: 200, to: 100 }',
    );
    expect(() => loadScenario(writeScenario(yaml))).toThrow(/from must be <= blockRange\.to/);
  });

  it('rejects an incident scenario with no pointOfNoReturn event', () => {
    const yaml = VALID_INCIDENT.replace('    pointOfNoReturn: true', '    pointOfNoReturn: false');
    expect(() => loadScenario(writeScenario(yaml))).toThrow(/exactly one groundTruth event/);
  });

  it('rejects more than one pointOfNoReturn event', () => {
    const yaml = VALID_INCIDENT.replace(
      'sources:',
      `  - at: "2023-03-11T01:00:00Z"
    blockNumber: 160
    description: "Also this."
    pointOfNoReturn: true
sources:`,
    );
    expect(() => loadScenario(writeScenario(yaml))).toThrow(/at most one/);
  });

  it('allows a quiet scenario with no groundTruth events at all', () => {
    const yaml = VALID_INCIDENT.replace('kind: incident', 'kind: quiet').replace(
      /groundTruth:[\s\S]*?(?=sources:)/,
      '',
    );
    const scenario = loadScenario(writeScenario(yaml));
    expect(scenario.groundTruth).toEqual([]);
  });
});
