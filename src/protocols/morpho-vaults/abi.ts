/**
 * Minimal ABIs covering only the functions/events Sentinel reads, for a MetaMorpho
 * (Morpho Vault v1.1) ERC-4626 vault. Verified against the official
 * morpho-org/metamorpho source (not from memory, per safety rule 6 — docs/SPEC.md #2)
 * on 2026-09-16. If a watched vault turns out to be a Morpho Vault V2 (structurally
 * different — see docs/SOURCES.md), this ABI does not apply; that needs its own
 * adapter variant, not assumed compatible with this one.
 */

// Source: EIP-4626 (stable public standard, not protocol-specific — https://eips.ethereum.org/EIPS/eip-4626)
export const erc4626Abi = [
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'maxWithdraw',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
] as const;

// Source: https://github.com/morpho-org/metamorpho/blob/main/src/interfaces/IMetaMorpho.sol
export const metaMorphoAbi = [
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
    // Source: https://github.com/morpho-org/metamorpho/blob/main/src/libraries/PendingLib.sol
    type: 'function',
    name: 'config',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
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
    name: 'owner',
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
    // Source: https://github.com/morpho-org/metamorpho/blob/main/src/libraries/PendingLib.sol
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
] as const;

// Source: https://github.com/morpho-org/metamorpho/blob/main/src/libraries/EventsLib.sol
export const metaMorphoEventsAbi = [
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
      { name: 'caller', type: 'address', indexed: true },
      { name: 'newTimelock', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SetCurator',
    inputs: [{ name: 'newCurator', type: 'address', indexed: true }],
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
] as const;
