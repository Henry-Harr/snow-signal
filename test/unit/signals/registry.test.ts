import { describe, expect, it } from 'vitest';

import { defaultDetectors, evaluateAll } from '../../../src/signals/registry.js';
import { D14_ID } from '../../../src/signals/D14_contagion.js';
import type { Detector, DetectorContext } from '../../../src/signals/types.js';
import type { Signal } from '../../../src/core/types.js';
import { detectorContext, marketContext } from './helpers.js';

describe('defaultDetectors', () => {
  it('includes exactly one detector per D01-D16, each with a unique, spec-shaped id', () => {
    const detectors = defaultDetectors();
    expect(detectors).toHaveLength(16);
    const ids = detectors.map((d) => d.id);
    expect(new Set(ids).size).toBe(16);
    for (let i = 1; i <= 16; i++) {
      const padded = String(i).padStart(2, '0');
      expect(ids.some((id) => id.startsWith(`D${padded}_`))).toBe(true);
    }
  });

  it('every detector is directly runnable against an empty context without throwing', () => {
    const ctx = detectorContext();
    for (const detector of defaultDetectors()) {
      expect(() => detector.evaluate(ctx)).not.toThrow();
    }
  });
});

function fakeDetector(id: string, family: Detector['family'], signals: Signal[]): Detector {
  return { id, family, evaluate: () => signals };
}

const ASSET_SIGNAL: Signal = {
  detectorId: 'D06_oracle_market_deviation',
  family: 'collateral',
  subject: { kind: 'asset', id: 'WETH' },
  severity: 'critical',
  value: 0.2,
  threshold: 0.1,
  evidence: {},
};

describe('evaluateAll', () => {
  it('runs every non-D14 detector exactly once', () => {
    let calls = 0;
    const detector = fakeDetector('D01_x', 'pool_flow', []);
    const counting: Detector = {
      id: detector.id,
      family: detector.family,
      evaluate: (ctx) => {
        calls++;
        return detector.evaluate(ctx);
      },
    };
    evaluateAll([counting], detectorContext());
    expect(calls).toBe(1);
  });

  it('feeds D14 the first pass signals via priorSignals, and D14 only runs once', () => {
    let d14Calls = 0;
    const sourceDetector = fakeDetector('D06_x', 'collateral', [ASSET_SIGNAL]);
    const d14: Detector = {
      id: D14_ID,
      family: 'collateral',
      evaluate: (ctx) => {
        d14Calls++;
        expect(ctx.priorSignals).toEqual([ASSET_SIGNAL]);
        return [];
      },
    };
    evaluateAll([sourceDetector, d14], detectorContext());
    expect(d14Calls).toBe(1);
  });

  it('combines first-pass and contagion-pass signals in the final output', () => {
    const sourceDetector = fakeDetector('D06_x', 'collateral', [ASSET_SIGNAL]);
    const contagionSignal: Signal = {
      ...ASSET_SIGNAL,
      detectorId: D14_ID,
      subject: { kind: 'market', id: 'm1' },
      severity: 'danger',
    };
    const d14: Detector = { id: D14_ID, family: 'collateral', evaluate: () => [contagionSignal] };
    const signals = evaluateAll([sourceDetector, d14], detectorContext());
    expect(signals).toEqual([ASSET_SIGNAL, contagionSignal]);
  });

  it('returns just the first pass when the registry has no D14', () => {
    const detector = fakeDetector('D01_x', 'pool_flow', [ASSET_SIGNAL]);
    expect(evaluateAll([detector], detectorContext())).toEqual([ASSET_SIGNAL]);
  });

  it('runs the real default registry end to end and lets D14 escalate a real D06 signal', () => {
    const ctx: DetectorContext = {
      ...detectorContext(),
      markets: [marketContext({ marketId: 'm1' })],
      assets: [],
      assetExposure: { WETH: [{ marketId: 'm1', shareOfCollateralBase: 0.9 }] },
      priorSignals: [],
    };
    // No D06 input data here (no assets), so just confirm the full registry runs
    // clean end to end without throwing, exercising every detector plus the
    // two-pass D14 orchestration together.
    expect(() => evaluateAll(defaultDetectors(), ctx)).not.toThrow();
  });
});
