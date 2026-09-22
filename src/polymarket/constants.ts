/**
 * Polymarket CLOB/Exchange facts, verified against official sources
 * (2026-09-22) rather than typed from memory — the same "no facts from memory"
 * discipline used everywhere else in this codebase's history, because getting
 * any of this wrong means either a rejected order or, worse, a validly-signed
 * order for something other than what was intended.
 *
 * - CLOB REST base URL, order endpoint/schema, order types (GTC/GTD/FAK/FOK),
 *   auth header scheme: docs.polymarket.com/developers/CLOB/orders/create-order,
 *   docs.polymarket.com/developers/CLOB/orders/orders.
 * - Market data websocket: docs.polymarket.com/developers/CLOB/websocket/market-channel.
 * - EIP-712 domain (name/version/chainId) and the V2 Order struct's exact field
 *   list/types: cross-verified two ways — (1) an aggregated web search citing
 *   Polymarket's own py-clob-client-v2 signing code, and (2) the literal
 *   `struct Order { ... }` block fetched directly from
 *   raw.githubusercontent.com/Polymarket/ctf-exchange-v2/main/src/exchange/
 *   libraries/Structs.sol. Both agree.
 * - CTFExchangeV2 / NegRiskCtfExchangeV2 addresses: cross-verified two ways —
 *   docs.polymarket.com/resources/contracts, and
 *   github.com/Polymarket/ctf-exchange-v2's own README "Deployed Contract
 *   Addresses on Polygon" section. Both agree. (The older, single-exchange V1
 *   address findable via PolygonScan/the V1 repo, 0x4bFb41d5B3570DeFd03C39a9A4D8
 *   dE6Bd8B8982E, is explicitly marked outdated by the V1 repo's own README —
 *   not used here.)
 */

export const CLOB_BASE_URL = 'https://clob.polymarket.com';
export const CLOB_WS_MARKET_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export const POLYGON_CHAIN_ID = 137;

export const CTF_EXCHANGE_V2 = '0xE111180000d2663C0091e4f400237545B87B996B' as const;
export const NEG_RISK_CTF_EXCHANGE_V2 = '0xe2222d279d744050d28e00520010520000310F59' as const;

export function exchangeAddressFor(negRisk: boolean): `0x${string}` {
  return negRisk ? NEG_RISK_CTF_EXCHANGE_V2 : CTF_EXCHANGE_V2;
}

export const EIP712_DOMAIN_NAME = 'Polymarket CTF Exchange';
export const EIP712_DOMAIN_VERSION = '2';

/** Exact field order matters — this is hashed as part of the EIP-712 type hash,
 * verified verbatim against the real `Structs.sol` source (see module doc
 * comment above), not reconstructed from a paraphrase. */
export const ORDER_EIP712_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'metadata', type: 'bytes32' },
    { name: 'builder', type: 'bytes32' },
  ],
} as const;

/** `Side` enum, ABI-encoded as uint8 per `Structs.sol` (`enum Side { BUY, SELL }`). */
export const ORDER_SIDE_UINT8 = { BUY: 0, SELL: 1 } as const;

/** `SignatureType` enum, ABI-encoded as uint8 — this bot signs with a plain EOA
 * private key (`EOA = 0`); the other three (proxy wallet, Gnosis Safe, EIP-1271)
 * aren't used here. */
export const SIGNATURE_TYPE_EOA = 0;

export const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as const;
