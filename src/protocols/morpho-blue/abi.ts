/**
 * Morpho Blue ABI fragments, restricted to exactly what the adapter reads/decodes.
 * Safety rule 6 (docs/SPEC.md #2): every signature below was pulled verbatim from the
 * official `morpho-org/morpho-blue` repo (raw.githubusercontent.com, `main` branch,
 * fetched 2026-09-16) — see docs/SOURCES.md. Re-verify against whatever commit/tag is
 * actually pinned as a dependency before trusting this file in a later session.
 *
 * Source files:
 * - src/interfaces/IMorpho.sol (`type Id is bytes32` — a Solidity user-defined value
 *   type; it compiles to plain `bytes32` in the ABI, so every `Id` parameter/return
 *   below is typed `bytes32`)
 * - src/libraries/EventsLib.sol
 * - src/interfaces/IOracle.sol
 * - src/interfaces/IIrm.sol
 */

const marketParamsTuple = {
  type: 'tuple',
  components: [
    { name: 'loanToken', type: 'address' },
    { name: 'collateralToken', type: 'address' },
    { name: 'oracle', type: 'address' },
    { name: 'irm', type: 'address' },
    { name: 'lltv', type: 'uint256' },
  ],
} as const;

const marketTuple = {
  type: 'tuple',
  components: [
    { name: 'totalSupplyAssets', type: 'uint128' },
    { name: 'totalSupplyShares', type: 'uint128' },
    { name: 'totalBorrowAssets', type: 'uint128' },
    { name: 'totalBorrowShares', type: 'uint128' },
    { name: 'lastUpdate', type: 'uint128' },
    { name: 'fee', type: 'uint128' },
  ],
} as const;

export const morphoBlueAbi = [
  {
    type: 'function',
    name: 'market',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ name: '', ...marketTuple }],
  },
  {
    type: 'function',
    name: 'idToMarketParams',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ name: '', ...marketParamsTuple }],
  },
  {
    type: 'function',
    name: 'position',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'user', type: 'address' },
    ],
    outputs: [
      { name: 'supplyShares', type: 'uint256' },
      { name: 'borrowShares', type: 'uint128' },
      { name: 'collateral', type: 'uint128' },
    ],
  },
  {
    // "Either `assets` or `shares` should be zero" (IMorpho.sol doc comment,
    // verified 2026-09-16). Full withdraw: pass the position's `supplyShares` with
    // `assets = 0`, to withdraw everything rather than leave rounding dust.
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketParams', ...marketParamsTuple },
      { name: 'assets', type: 'uint256' },
      { name: 'shares', type: 'uint256' },
      { name: 'onBehalf', type: 'address' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [
      { name: 'assetsWithdrawn', type: 'uint256' },
      { name: 'sharesWithdrawn', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'Supply',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'caller', type: 'address', indexed: true },
      { name: 'onBehalf', type: 'address', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Withdraw',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'caller', type: 'address', indexed: false },
      { name: 'onBehalf', type: 'address', indexed: true },
      { name: 'receiver', type: 'address', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Borrow',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'caller', type: 'address', indexed: false },
      { name: 'onBehalf', type: 'address', indexed: true },
      { name: 'receiver', type: 'address', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Repay',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'caller', type: 'address', indexed: true },
      { name: 'onBehalf', type: 'address', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SupplyCollateral',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'caller', type: 'address', indexed: true },
      { name: 'onBehalf', type: 'address', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WithdrawCollateral',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'caller', type: 'address', indexed: false },
      { name: 'onBehalf', type: 'address', indexed: true },
      { name: 'receiver', type: 'address', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
    ],
  },
  {
    // `badDebtAssets`/`badDebtShares` are the direct on-chain signal for D11
    // (realized bad debt) on a Morpho Blue market.
    type: 'event',
    name: 'Liquidate',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'caller', type: 'address', indexed: true },
      { name: 'borrower', type: 'address', indexed: true },
      { name: 'repaidAssets', type: 'uint256', indexed: false },
      { name: 'repaidShares', type: 'uint256', indexed: false },
      { name: 'seizedAssets', type: 'uint256', indexed: false },
      { name: 'badDebtAssets', type: 'uint256', indexed: false },
      { name: 'badDebtShares', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CreateMarket',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'marketParams', ...marketParamsTuple, indexed: false },
    ],
  },
] as const;

/** `price()` returns the price of 1 collateral-token asset quoted in loan-token
 * asset, scaled by 1e36 and adjusted for decimals — re-verified directly against
 * docs.morpho.org 2026-09-16 (docs/SOURCES.md). */
export const morphoOracleAbi = [
  {
    type: 'function',
    name: 'price',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** Returns the borrow rate **per second, scaled by WAD (1e18)** — confirmed via the
 * `IIrm.sol` doc comment. Not every market necessarily uses an IRM implementing this
 * interface, but every market Sentinel is configured to watch does (verify per-market
 * if a new one is ever added — see the adapter's own comment at the call site). */
export const morphoIrmAbi = [
  {
    type: 'function',
    name: 'borrowRateView',
    stateMutability: 'view',
    inputs: [
      { name: 'marketParams', ...marketParamsTuple },
      { name: 'market', ...marketTuple },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
