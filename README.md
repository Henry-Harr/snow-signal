# Polymarket stop-loss bot

Watches the live price of your Polymarket positions and automatically sells
when a configured price threshold is crossed. Polymarket's CLOB has no native
stop-loss/conditional order type (verified against the real order-type list —
GTC/GTD/FAK/FOK only) — this bot *is* the stop-loss: it watches the real-time
best bid over the CLOB websocket and fires a real sell order (FAK: fill
whatever's available immediately, cancel the rest) the moment your threshold
is crossed.

This bot does **not** buy positions for you. You acquire the shares you want
to protect yourself (on polymarket.com or however you like); this only
manages the downside exit on positions you tell it about.

## Safety model

- **`executionMode` defaults to `"paper"`** in every config — it logs exactly
  what it would have sold (price, size) without ever signing or sending a real
  order. You must explicitly set `"executionMode": "live"` for any real order
  to be placed. This mirrors how every previous system built in this
  repository's history defaulted to `off`/paper until deliberately switched on.
- Your wallet's private key is read from the `WALLET_PRIVATE_KEY` environment
  variable only — never typed into a config file, never logged, never
  committed. `.env` is gitignored.
- Every real order is signed with `signatureType: EOA` (0) directly by your
  own key — this bot never uses a Polymarket proxy wallet or a Gnosis Safe
  signature type.
- Orders are placed as **FAK** ("fill and kill"): whatever fills immediately
  against the real order book fills; the rest is cancelled. Never GTC (could
  sit unfilled indefinitely while the price keeps falling) and never FOK
  (all-or-nothing — a partial fill during a real crash is strictly better than
  none).
- A configurable slippage tolerance (default 3%) is subtracted from the
  triggering bid before the order is sent, so a real FAK order actually has a
  realistic chance of filling against a book that's still moving.
- Every trigger — paper or live — is logged to `stoploss.sqlite`
  (`trigger_log` table): timestamp, position, trigger price, the exact
  maker/taker amounts sent, and the real order id or rejection reason.

## Setup

1. `pnpm install`
2. Copy `config/stoploss.example.json` to `config/stoploss.json` and fill in
   your real position(s):
   - `tokenId`: the CLOB ERC1155 token id for the specific outcome share you
     hold. Find it via `https://gamma-api.polymarket.com/markets?slug=<market-slug>`
     — the `clobTokenIds` field is a JSON array `[yesTokenId, noTokenId]`.
   - `negRisk`: `true` for multi-outcome ("neg risk") markets, `false` for a
     simple binary market — determines which of Polymarket's two exchange
     contracts your order is signed against. If you're not sure, check the
     market's own page or the Gamma API response for a `negRisk` field.
   - `shares`: how many shares you hold, as a decimal string in the CLOB's
     6-decimal integer units (1 share = `"1000000"`).
   - `stopPrice`: sell when the best bid falls to or below this (0–1).
3. Set `WALLET_PRIVATE_KEY` in `.env` (never commit this file).
4. Build and run in paper mode first: `pnpm build && node dist/cli/index.js run`
   — watch the logs and `stoploss.sqlite`'s `trigger_log` table to confirm it
   behaves the way you expect before ever setting `executionMode` to `"live"`.

### Going live

Only after you've watched it run correctly in paper mode:

1. Get a Polymarket CLOB API key (L2 credentials) — via their own site/SDK
   flow, which derives one from an L1 signature by your wallet.
2. Set `CLOB_API_KEY`, `CLOB_API_SECRET`, `CLOB_API_PASSPHRASE` in `.env`.
3. Set `"executionMode": "live"` in your config.
4. Make sure `WALLET_PRIVATE_KEY` actually holds the shares you configured,
   on Polygon, and has enough MATIC for gas if your flow needs it.

## Development

```
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## What's verified vs. what to verify yourself before trusting real capital to it

Everything money-critical here — the exact EIP-712 order struct, the real
CTF Exchange / Neg Risk CTF Exchange contract addresses, the order endpoint
and schema, the auth scheme — was cross-checked against at least two
independent official sources (Polymarket's own docs and the literal source of
`Polymarket/ctf-exchange-v2`'s `Structs.sol`), not typed from memory. The
signing code is tested against a real recoverable-signature check, and the
price feed was validated against Polymarket's real, live websocket before
this was considered done.

What was **not** independently verified against a live order fill: this bot
has not yet placed a real order end-to-end (that would require real funds and
a live CLOB API key neither of which existed while building this). Before
trusting real capital to live mode, place one small, deliberate real order
yourself first and confirm it behaves as expected.
