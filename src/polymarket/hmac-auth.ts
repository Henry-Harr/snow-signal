import { createHmac } from 'node:crypto';

/**
 * Polymarket CLOB L2 (API-key-level) request authentication — verified against
 * docs.polymarket.com/developers/CLOB/orders/orders and
 * .../orders/create-order (`src/polymarket/constants.ts` has the full source
 * citation for this module's sibling files; this scheme's specifics — the
 * five header names and the HMAC message format — came from the same fetch).
 *
 * Signature = base64(HMAC-SHA256(base64Decode(apiSecret), `${timestamp}${method}${path}${body}`)),
 * where `body` is the exact JSON string actually sent (omitted entirely, not
 * an empty string, for a body-less request like GET).
 */
export interface ClobApiCredentials {
  apiKey: string;
  apiSecret: string; // base64-encoded, as issued by Polymarket
  passphrase: string;
  address: `0x${string}`; // the signer address these credentials were derived for
}

export interface ClobAuthHeaders {
  POLY_ADDRESS: string;
  POLY_API_KEY: string;
  POLY_PASSPHRASE: string;
  POLY_SIGNATURE: string;
  POLY_TIMESTAMP: string;
  [key: string]: string;
}

export function buildAuthHeaders(
  creds: ClobApiCredentials,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: string,
): ClobAuthHeaders {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}${method}${path}${body ?? ''}`;
  const signature = createHmac('sha256', Buffer.from(creds.apiSecret, 'base64'))
    .update(message)
    .digest('base64');

  return {
    POLY_ADDRESS: creds.address,
    POLY_API_KEY: creds.apiKey,
    POLY_PASSPHRASE: creds.passphrase,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
  };
}
