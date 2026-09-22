import { writeFileSync, unlinkSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/core/config.js';

const TMP_PATH = '/tmp/stoploss-config-test.json';

function writeConfig(obj: unknown): void {
  writeFileSync(TMP_PATH, JSON.stringify(obj));
}

describe('loadConfig', () => {
  it('defaults executionMode to "paper" when omitted', () => {
    writeConfig({
      positions: [{ label: 'p', tokenId: '1', negRisk: false, shares: '1000000', stopPrice: 0.5 }],
    });
    const config = loadConfig(TMP_PATH);
    expect(config.executionMode).toBe('paper');
    unlinkSync(TMP_PATH);
  });

  it('parses shares as a bigint, not a number (avoids float precision loss on real share counts)', () => {
    writeConfig({
      positions: [
        { label: 'p', tokenId: '1', negRisk: false, shares: '123456789012345', stopPrice: 0.5 },
      ],
    });
    const config = loadConfig(TMP_PATH);
    expect(config.positions[0]?.shares).toBe(123_456_789_012_345n);
    unlinkSync(TMP_PATH);
  });

  it('rejects a stopPrice outside [0, 1]', () => {
    writeConfig({
      positions: [{ label: 'p', tokenId: '1', negRisk: false, shares: '1', stopPrice: 1.5 }],
    });
    expect(() => loadConfig(TMP_PATH)).toThrow();
    unlinkSync(TMP_PATH);
  });

  it('rejects an empty positions list', () => {
    writeConfig({ positions: [] });
    expect(() => loadConfig(TMP_PATH)).toThrow();
    unlinkSync(TMP_PATH);
  });

  it('accepts an explicit executionMode of "live"', () => {
    writeConfig({
      executionMode: 'live',
      positions: [{ label: 'p', tokenId: '1', negRisk: false, shares: '1', stopPrice: 0.5 }],
    });
    const config = loadConfig(TMP_PATH);
    expect(config.executionMode).toBe('live');
    unlinkSync(TMP_PATH);
  });
});
