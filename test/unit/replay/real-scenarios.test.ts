import { describe, expect, it } from 'vitest';

import { loadScenario } from '../../../src/replay/scenario.js';

/** Parses every real scenario YAML file in `scenarios/` — catches a schema
 * regression or a typo in a real scenario file immediately, rather than only at
 * `sentinel replay` run time. */
describe('real scenario files', () => {
  it('scenarios/usdc-depeg-2023-03.yaml parses and validates', () => {
    const scenario = loadScenario('scenarios/usdc-depeg-2023-03.yaml');
    expect(scenario.id).toBe('usdc-depeg-2023-03');
    expect(scenario.kind).toBe('incident');
    expect(scenario.blockRange.from).toBeLessThan(scenario.blockRange.to);
    expect(scenario.groundTruth.filter((e) => e.pointOfNoReturn)).toHaveLength(1);
  });

  it('scenarios/kelpdao-rseth-exploit-2026-04.yaml parses and validates', () => {
    const scenario = loadScenario('scenarios/kelpdao-rseth-exploit-2026-04.yaml');
    expect(scenario.id).toBe('kelpdao-rseth-exploit-2026-04');
    expect(scenario.kind).toBe('incident');
    expect(scenario.blockRange.from).toBeLessThan(scenario.blockRange.to);
    expect(scenario.groundTruth.filter((e) => e.pointOfNoReturn)).toHaveLength(1);
  });

  it.each(['quiet-ethereum-2026-08', 'quiet-base-2026-08'])(
    'scenarios/%s.yaml parses and validates, spanning at least 30 days',
    (id) => {
      const scenario = loadScenario(`scenarios/${id}.yaml`);
      expect(scenario.id).toBe(id);
      expect(scenario.kind).toBe('quiet');
      expect(scenario.groundTruth).toEqual([]);

      const approxSecondsPerBlock = scenario.chain === 'base' ? 2 : 12;
      const spanDays =
        (Number(scenario.blockRange.to - scenario.blockRange.from) * approxSecondsPerBlock) /
        86_400;
      expect(spanDays).toBeGreaterThanOrEqual(30);
    },
  );
});
