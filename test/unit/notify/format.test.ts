import { describe, expect, it } from 'vitest';

import { formatAlertText } from '../../../src/notify/format.js';
import { testAlert, testSignal } from './helpers.js';

describe('formatAlertText', () => {
  it('includes the position, level, rule, block, and decision id', () => {
    const text = formatAlertText(testAlert());
    expect(text).toContain('[DANGER]');
    expect(text).toContain('aave-v3:ethereum:core:USDC');
    expect(text).toContain('corroborated across 2 families');
    expect(text).toContain('21500000');
    expect(text).toContain('/ack 1');
  });

  it('includes the block explorer link when present, omits it when absent', () => {
    expect(formatAlertText(testAlert())).toContain('https://etherscan.io/block/21500000');
    expect(formatAlertText(testAlert({ blockExplorerUrl: undefined }))).not.toContain('https://');
  });

  it('lists every signal with its key numbers', () => {
    const text = formatAlertText(
      testAlert({
        signals: [
          testSignal({ detectorId: 'D01_utilization_level', value: 0.96, threshold: 0.95 }),
          testSignal({ detectorId: 'D06_oracle_market_deviation', value: 0.1, threshold: 0.05 }),
        ],
      }),
    );
    expect(text).toContain('D01_utilization_level');
    expect(text).toContain('value=0.96');
    expect(text).toContain('D06_oracle_market_deviation');
  });

  it('shows the transition only when the level actually changed', () => {
    expect(formatAlertText(testAlert({ previousLevel: 'WATCH', level: 'DANGER' }))).toContain(
      'WATCH -> DANGER',
    );
    expect(formatAlertText(testAlert({ previousLevel: 'DANGER', level: 'DANGER' }))).not.toContain(
      '->',
    );
  });

  it('notes when a withdrawal was suppressed by the kill switch', () => {
    const text = formatAlertText(
      testAlert({ action: { kind: 'alert', suppressedByKillSwitch: true } }),
    );
    expect(text).toContain('suppressed by kill switch');
  });

  it('notes the standing rule when set', () => {
    expect(formatAlertText(testAlert({ standingAlert: true }))).toContain('Standing rule');
    expect(formatAlertText(testAlert({ standingAlert: false }))).not.toContain('Standing rule');
  });

  it('describes a full_exit action as planned, not executed', () => {
    const text = formatAlertText(testAlert({ action: { kind: 'full_exit' } }));
    expect(text).toContain('full exit');
    expect(text).toContain('not yet executed');
  });
});
