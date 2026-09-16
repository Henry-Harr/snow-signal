/**
 * MetaMorpho v1.1 ABI fragments, restricted to exactly what the adapter reads/decodes.
 * Safety rule 6 (docs/SPEC.md #2): every signature below was pulled verbatim from the
 * official `morpho-org/metamorpho` repo (raw.githubusercontent.com, `main` branch,
 * fetched 2026-09-16) — see docs/SOURCES.md. Standard ERC-4626/ERC-20 reads (
 * `totalAssets`, `maxWithdraw`, `maxRedeem`, `convertToAssets`, `balanceOf`, `asset`,
 * `withdraw`) come from viem's own maintained `erc4626Abi`/`erc20Abi`, not redeclared
 * here.
 *
 * **This adapter assumes MetaMorpho v1.1, not Vault V2** — confirmed specifically for
 * the user's watched vault (Gauntlet USDC Prime, Base) by calling `isMetaMorpho()` on
 * its deploying factory directly on-chain (2026-09-16): returned `true`, while the
 * same factory's `isVaultV2()` reverted (that function doesn't exist on a v1.1
 * factory). If a future watched vault turns out to be Vault V2, it needs a separate
 * adapter behind the same `ProtocolAdapter` interface (docs/SPEC.md #6.4) — this one
 * will misread it.
 *
 * Source files:
 * - src/interfaces/IMetaMorpho.sol (via IMetaMorphoBase/IOwnable)
 * - src/libraries/PendingLib.sol (MarketConfig, PendingUint192, PendingAddress)
 * - src/libraries/EventsLib.sol
 */

export const metaMorphoAbi = [
  {
    type: 'function',
    name: 'MORPHO',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'curator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'guardian',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'isAllocator',
    stateMutability: 'view',
    inputs: [{ name: 'target', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'fee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint96' }],
  },
  {
    type: 'function',
    name: 'feeRecipient',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'timelock',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'pendingTimelock',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'value', type: 'uint192' },
          { name: 'validAt', type: 'uint64' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'pendingGuardian',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'value', type: 'address' },
          { name: 'validAt', type: 'uint64' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'pendingCap',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'value', type: 'uint192' },
          { name: 'validAt', type: 'uint64' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'lastTotalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'supplyQueueLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'supplyQueue',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'withdrawQueueLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdrawQueue',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'config',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'cap', type: 'uint184' },
          { name: 'enabled', type: 'bool' },
          { name: 'removableAt', type: 'uint64' },
        ],
      },
    ],
  },
  {
    // ERC-4626-style, but MetaMorpho's own signature (assets, receiver, owner) —
    // identical to the standard, kept explicit here since it's encoded, not just read.
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'SetSupplyQueue',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'newSupplyQueue', type: 'bytes32[]', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SetWithdrawQueue',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'newWithdrawQueue', type: 'bytes32[]', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SubmitCap',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'cap', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SetCap',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'cap', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SubmitTimelock',
    inputs: [{ name: 'newTimelock', type: 'uint256', indexed: false }],
  },
  {
    type: 'event',
    name: 'SetTimelock',
    inputs: [
      { name: 'caller', type: 'address', indexed: false },
      { name: 'newTimelock', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SubmitGuardian',
    inputs: [{ name: 'newGuardian', type: 'address', indexed: true }],
  },
  {
    type: 'event',
    name: 'SetGuardian',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'guardian', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'SetCurator',
    inputs: [{ name: 'newCurator', type: 'address', indexed: true }],
  },
  {
    type: 'event',
    name: 'SetIsAllocator',
    inputs: [
      { name: 'allocator', type: 'address', indexed: true },
      { name: 'isAllocator', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SetFee',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'newFee', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SetFeeRecipient',
    inputs: [{ name: 'newFeeRecipient', type: 'address', indexed: true }],
  },
  {
    type: 'event',
    name: 'ReallocateSupply',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'suppliedAssets', type: 'uint256', indexed: false },
      { name: 'suppliedShares', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ReallocateWithdraw',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'withdrawnAssets', type: 'uint256', indexed: false },
      { name: 'withdrawnShares', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SubmitMarketRemoval',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'id', type: 'bytes32', indexed: true },
    ],
  },
] as const;
