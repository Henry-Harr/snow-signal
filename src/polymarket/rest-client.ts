import { CLOB_BASE_URL } from './constants.js';
import type { ClobApiCredentials } from './hmac-auth.js';
import { buildAuthHeaders } from './hmac-auth.js';
import type { SignedOrder } from './eip712.js';

/**
 * Order submission against the real Polymarket CLOB REST API — endpoint, method,
 * and request body schema verified against docs.polymarket.com/developers/CLOB/
 * orders/create-order (see `src/polymarket/constants.ts`'s doc comment for the
 * full citation). `postOrder` is the only network-touching, money-moving call in
 * this codebase — everything upstream of it (`buildSignedOrder`, the stop-loss
 * engine) is pure and independently tested precisely so this one call is doing
 * as little untested logic as possible.
 */
export type PolymarketOrderType = 'GTC' | 'GTD' | 'FAK' | 'FOK';

export interface PostOrderRequest {
  order: SignedOrder;
  orderType: PolymarketOrderType;
}

export interface PostOrderResponse {
  success: boolean;
  orderId?: string;
  errorMsg?: string;
  status?: string;
}

export class ClobRestClient {
  constructor(
    private readonly creds: ClobApiCredentials,
    private readonly baseUrl: string = CLOB_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async postOrder(req: PostOrderRequest): Promise<PostOrderResponse> {
    const path = '/order';
    const body = JSON.stringify({
      order: req.order,
      orderType: req.orderType,
      owner: this.creds.apiKey,
    });
    const headers = {
      'content-type': 'application/json',
      ...buildAuthHeaders(this.creds, 'POST', path, body),
    };

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body,
    });
    const json = (await res.json()) as PostOrderResponse;
    if (!res.ok) {
      return { success: false, errorMsg: json.errorMsg ?? `HTTP ${res.status}` };
    }
    return json;
  }
}
