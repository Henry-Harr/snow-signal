/**
 * Aave v3 ABI fragments, restricted to exactly what the adapter reads/decodes. Safety
 * rule 6 (docs/SPEC.md #2): every signature below was pulled verbatim from the
 * official `aave-dao/aave-v3-origin` repo (raw.githubusercontent.com, `main` branch,
 * fetched 2026-09-16) — see docs/SOURCES.md. Re-verify against whatever commit/tag is
 * actually pinned as a dependency before trusting this file in a later session.
 *
 * Source files:
 * - src/contracts/interfaces/IPool.sol
 * - src/contracts/interfaces/IPoolDataProvider.sol
 * - src/contracts/interfaces/IPoolAddressesProvider.sol
 * - src/contracts/interfaces/IPriceOracleGetter.sol / IAaveOracle.sol
 * - src/contracts/interfaces/IPoolConfigurator.sol
 */

export const poolAbi = [
  {
    type: 'function',
    name: 'getReservesList',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'ADDRESSES_PROVIDER',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    // IPool.sol, verified directly on-chain 2026-09-16 (`cast call` against the
    // real Ethereum Pool with a zero-position address, returning `healthFactor =
    // type(uint256).max` — the documented "no debt" sentinel). Used by the
    // large-holder watcher (docs/SPEC.md #6.6) to check top borrowers' health.
    type: 'function',
    name: 'getUserAccountData',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
  {
    // "Send the value type(uint256).max in order to withdraw the whole aToken
    // balance" — the withdrawal planner's `'max'` amount (docs/SPEC.md #5.3) maps
    // directly to `2n ** 256n - 1n`, no separate "max" call needed.
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Supply',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: false },
      { name: 'onBehalfOf', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'referralCode', type: 'uint16', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Withdraw',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Borrow',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: false },
      { name: 'onBehalfOf', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'interestRateMode', type: 'uint8', indexed: false },
      { name: 'borrowRate', type: 'uint256', indexed: false },
      { name: 'referralCode', type: 'uint16', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Repay',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'repayer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'useATokens', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LiquidationCall',
    inputs: [
      { name: 'collateralAsset', type: 'address', indexed: true },
      { name: 'debtAsset', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'debtToCover', type: 'uint256', indexed: false },
      { name: 'liquidatedCollateralAmount', type: 'uint256', indexed: false },
      { name: 'liquidator', type: 'address', indexed: false },
      { name: 'receiveAToken', type: 'bool', indexed: false },
    ],
  },
] as const;

export const poolDataProviderAbi = [
  {
    type: 'function',
    name: 'getReserveConfigurationData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'decimals', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'liquidationThreshold', type: 'uint256' },
      { name: 'liquidationBonus', type: 'uint256' },
      { name: 'reserveFactor', type: 'uint256' },
      { name: 'usageAsCollateralEnabled', type: 'bool' },
      { name: 'borrowingEnabled', type: 'bool' },
      { name: 'stableBorrowRateEnabled', type: 'bool' },
      { name: 'isActive', type: 'bool' },
      { name: 'isFrozen', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'unbacked', type: 'uint256' },
      { name: 'accruedToTreasuryScaled', type: 'uint256' },
      { name: 'totalAToken', type: 'uint256' },
      { name: 'totalStableDebt', type: 'uint256' },
      { name: 'totalVariableDebt', type: 'uint256' },
      { name: 'liquidityRate', type: 'uint256' },
      { name: 'variableBorrowRate', type: 'uint256' },
      { name: 'stableBorrowRate', type: 'uint256' },
      { name: 'averageStableBorrowRate', type: 'uint256' },
      { name: 'liquidityIndex', type: 'uint256' },
      { name: 'variableBorrowIndex', type: 'uint256' },
      { name: 'lastUpdateTimestamp', type: 'uint40' },
    ],
  },
  {
    type: 'function',
    name: 'getReserveCaps',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'borrowCap', type: 'uint256' },
      { name: 'supplyCap', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getPaused',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: 'isPaused', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getReserveTokensAddresses',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'aTokenAddress', type: 'address' },
      { name: 'stableDebtTokenAddress', type: 'address' },
      { name: 'variableDebtTokenAddress', type: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'getReserveDeficit',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export const poolAddressesProviderAbi = [
  {
    type: 'function',
    name: 'getPriceOracle',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    // Verified 2026-09-16 via a live `cast call` against both watched markets'
    // AddressesProvider contracts — Ethereum resolved to
    // 0x64b761D848206f447Fe2dd461b0c635Ec39EbB27, Base to
    // 0x5731a04B1E775f0fdd454Bf70f3335886e9A96be (the latter matching the
    // `POOL_CONFIGURATOR` constant already recorded in the address-book dump in
    // docs/SOURCES.md, cross-confirming both).
    type: 'function',
    name: 'getPoolConfigurator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

/** `getAssetPrice` returns a price in the oracle's base-currency units — for the
 * watched markets this is USD with 8 decimals (`BASE_CURRENCY_UNIT = 1e8`), per
 * `IPriceOracleGetter`'s doc comment ("1e8 for USD"). */
export const aaveOracleAbi = [
  {
    type: 'function',
    name: 'getAssetPrice',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getAssetsPrices',
    stateMutability: 'view',
    inputs: [{ name: 'assets', type: 'address[]' }],
    outputs: [{ name: '', type: 'uint256[]' }],
  },
] as const;

export const poolConfiguratorAbi = [
  {
    type: 'event',
    name: 'ReserveFrozen',
    inputs: [
      { name: 'asset', type: 'address', indexed: true },
      { name: 'frozen', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ReservePaused',
    inputs: [
      { name: 'asset', type: 'address', indexed: true },
      { name: 'paused', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ReserveActive',
    inputs: [
      { name: 'asset', type: 'address', indexed: true },
      { name: 'active', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CollateralConfigurationChanged',
    inputs: [
      { name: 'asset', type: 'address', indexed: true },
      { name: 'ltv', type: 'uint256', indexed: false },
      { name: 'liquidationThreshold', type: 'uint256', indexed: false },
      { name: 'liquidationBonus', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'BorrowCapChanged',
    inputs: [
      { name: 'asset', type: 'address', indexed: true },
      { name: 'oldBorrowCap', type: 'uint256', indexed: false },
      { name: 'newBorrowCap', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SupplyCapChanged',
    inputs: [
      { name: 'asset', type: 'address', indexed: true },
      { name: 'oldSupplyCap', type: 'uint256', indexed: false },
      { name: 'newSupplyCap', type: 'uint256', indexed: false },
    ],
  },
] as const;
