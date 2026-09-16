import { describe, expect, it } from 'vitest';

import { createD14Detector, D14_ID } from '../../../src/signals/D14_contagion.js';
import { detectorContext, signal } from './helpers.js';

describe('D14 contagion', () => {
  const detector = createD14Detector();

  it('emits no signal when there are no prior asset-family signals', () => {
    const ctx = detectorContext({ priorSignals: [] });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('ignores prior signals not scoped to an asset (e.g. a market-level signal)', () => {
    const ctx = detectorContext({
      priorSignals: [signal({ subject: { kind: 'market', id: 'm1' } })],
      assetExposure: { WETH: [{ marketId: 'm1', shareOfCollateralBase: 0.9 }] },
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('demotes severity by one level for a market with modest exposure', () => {
    const ctx = detectorContext({
      priorSignals: [signal({ subject: { kind: 'asset', id: 'WETH' }, severity: 'critical' })],
      assetExposure: { WETH: [{ marketId: 'm1', shareOfCollateralBase: 0.1 }] },
    });
    const [out] = detector.evaluate(ctx);
    expect(out).toMatchObject({
      detectorId: D14_ID,
      family: 'collateral',
      subject: { kind: 'market', id: 'm1' },
      severity: 'danger', // critical demoted one level
    });
    expect(out?.evidence['fullContagion']).toBe(false);
  });

  it('demotes watch down to info (the floor of the demotion chain)', () => {
    const ctx = detectorContext({
      priorSignals: [signal({ subject: { kind: 'asset', id: 'WETH' }, severity: 'watch' })],
      assetExposure: { WETH: [{ marketId: 'm1', shareOfCollateralBase: 0.1 }] },
    });
    const [out] = detector.evaluate(ctx);
    expect(out?.severity).toBe('info');
  });

  it('inherits the same severity (no demotion) when exposure meets the full-contagion share', () => {
    const ctx = detectorContext({
      priorSignals: [signal({ subject: { kind: 'asset', id: 'WETH' }, severity: 'critical' })],
      assetExposure: { WETH: [{ marketId: 'm1', shareOfCollateralBase: 0.75 }] },
    });
    const [out] = detector.evaluate(ctx);
    expect(out?.severity).toBe('critical');
    expect(out?.evidence['fullContagion']).toBe(true);
  });

  it('emits one signal per exposed market, including vault look-through targets', () => {
    const ctx = detectorContext({
      priorSignals: [signal({ subject: { kind: 'asset', id: 'WETH' }, severity: 'danger' })],
      assetExposure: {
        WETH: [
          { marketId: 'aave-v3:ethereum:core', shareOfCollateralBase: 0.2 },
          { marketId: 'morpho-vault:base:0xVAULT', shareOfCollateralBase: 0.3 }, // via look-through
        ],
      },
    });
    const signals = detector.evaluate(ctx);
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.subject.id)).toEqual([
      'aave-v3:ethereum:core',
      'morpho-vault:base:0xVAULT',
    ]);
  });

  it('does not fire for an asset with no known exposure anywhere (false-positive guard)', () => {
    const ctx = detectorContext({
      priorSignals: [
        signal({ subject: { kind: 'asset', id: 'SOME_UNKNOWN_ASSET' }, severity: 'critical' }),
      ],
      assetExposure: { WETH: [{ marketId: 'm1', shareOfCollateralBase: 0.9 }] },
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });
});
