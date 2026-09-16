import { describe, expect, it } from 'vitest';

import { generateId } from '../../../src/core/ids.js';

describe('generateId', () => {
  it('prefixes the id as requested', () => {
    expect(generateId('alert')).toMatch(/^alert_/);
  });

  it('generates unique ids across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId('x')));
    expect(ids.size).toBe(1000);
  });
});
