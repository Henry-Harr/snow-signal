import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { buildAuthHeaders, type ClobApiCredentials } from '../../../src/polymarket/hmac-auth.js';

const creds: ClobApiCredentials = {
  apiKey: 'test-key',
  apiSecret: Buffer.from('test-secret').toString('base64'),
  passphrase: 'test-pass',
  address: '0x1111111111111111111111111111111111111111',
};

describe('buildAuthHeaders', () => {
  it('includes all five required headers', () => {
    const headers = buildAuthHeaders(creds, 'GET', '/order');
    expect(headers.POLY_ADDRESS).toBe(creds.address);
    expect(headers.POLY_API_KEY).toBe(creds.apiKey);
    expect(headers.POLY_PASSPHRASE).toBe(creds.passphrase);
    expect(headers.POLY_SIGNATURE).toBeTruthy();
    expect(headers.POLY_TIMESTAMP).toBeTruthy();
  });

  it('computes the signature as HMAC-SHA256(base64Decode(secret), timestamp+method+path+body)', () => {
    const headers = buildAuthHeaders(creds, 'POST', '/order', '{"a":1}');
    const expected = createHmac('sha256', Buffer.from(creds.apiSecret, 'base64'))
      .update(`${headers.POLY_TIMESTAMP}POST/order{"a":1}`)
      .digest('base64');
    expect(headers.POLY_SIGNATURE).toBe(expected);
  });

  it('produces a different signature for a GET (no body) than a POST with the same path', () => {
    const get = buildAuthHeaders(creds, 'GET', '/order');
    const post = buildAuthHeaders(creds, 'POST', '/order', '{}');
    expect(get.POLY_SIGNATURE).not.toBe(post.POLY_SIGNATURE);
  });
});
