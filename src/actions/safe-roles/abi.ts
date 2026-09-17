/**
 * ABI fragments for Safe v1.4.1, its `SafeProxyFactory`, Zodiac's shared
 * `ModuleProxyFactory`, and the Zodiac Roles Modifier v2.1.0 — restricted to exactly
 * what `src/actions/safe-roles/setup.ts` and the live executor need. Every entry
 * copied verbatim from an official source, not retyped from memory (safety rule 6):
 * the Safe/factory entries from `safe-global/safe-deployments`'s own published
 * `v1.4.1/{safe_l2,safe_proxy_factory}.json` (which bundle both address and ABI);
 * the Roles entries from the Roles repo's own build artifact
 * (`zodiac-modifier-roles/packages/evm/mastercopies.json`); `ModuleProxyFactory`'s
 * ABI from the `@gnosis-guild/zodiac` npm package's bundled ABI file. See
 * `docs/SOURCES.md`'s "Safe" and "Zodiac Roles Modifier" entries for the exact URLs
 * and fetch date (2026-09-17).
 */

export const safeAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      }
    ],
    "name": "enableModule",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      },
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      },
      {
        "internalType": "enum Enum.Operation",
        "name": "operation",
        "type": "uint8"
      },
      {
        "internalType": "uint256",
        "name": "safeTxGas",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "baseGas",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "gasPrice",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "gasToken",
        "type": "address"
      },
      {
        "internalType": "address payable",
        "name": "refundReceiver",
        "type": "address"
      },
      {
        "internalType": "bytes",
        "name": "signatures",
        "type": "bytes"
      }
    ],
    "name": "execTransaction",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getOwners",
    "outputs": [
      {
        "internalType": "address[]",
        "name": "",
        "type": "address[]"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getThreshold",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      },
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      },
      {
        "internalType": "enum Enum.Operation",
        "name": "operation",
        "type": "uint8"
      },
      {
        "internalType": "uint256",
        "name": "safeTxGas",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "baseGas",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "gasPrice",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "gasToken",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "refundReceiver",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "_nonce",
        "type": "uint256"
      }
    ],
    "name": "getTransactionHash",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      }
    ],
    "name": "isModuleEnabled",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "nonce",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address[]",
        "name": "_owners",
        "type": "address[]"
      },
      {
        "internalType": "uint256",
        "name": "_threshold",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      },
      {
        "internalType": "address",
        "name": "fallbackHandler",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "paymentToken",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "payment",
        "type": "uint256"
      },
      {
        "internalType": "address payable",
        "name": "paymentReceiver",
        "type": "address"
      }
    ],
    "name": "setup",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;

export const safeProxyFactoryAbi = [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "contract SafeProxy",
        "name": "proxy",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "singleton",
        "type": "address"
      }
    ],
    "name": "ProxyCreation",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_singleton",
        "type": "address"
      },
      {
        "internalType": "bytes",
        "name": "initializer",
        "type": "bytes"
      },
      {
        "internalType": "uint256",
        "name": "saltNonce",
        "type": "uint256"
      }
    ],
    "name": "createProxyWithNonce",
    "outputs": [
      {
        "internalType": "contract SafeProxy",
        "name": "proxy",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;

export const moduleProxyFactoryAbi = [
  {
    "inputs": [],
    "name": "FailedInitialization",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "address_",
        "type": "address"
      }
    ],
    "name": "TakenAddress",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "target",
        "type": "address"
      }
    ],
    "name": "TargetHasNoCode",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "target",
        "type": "address"
      }
    ],
    "name": "ZeroAddress",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "proxy",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "masterCopy",
        "type": "address"
      }
    ],
    "name": "ModuleProxyCreation",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "masterCopy",
        "type": "address"
      },
      {
        "internalType": "bytes",
        "name": "initializer",
        "type": "bytes"
      },
      {
        "internalType": "uint256",
        "name": "saltNonce",
        "type": "uint256"
      }
    ],
    "name": "deployModule",
    "outputs": [
      {
        "internalType": "address",
        "name": "proxy",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;

export const rolesAbi = [
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "roleKey",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "targetAddress",
        "type": "address"
      },
      {
        "internalType": "bytes4",
        "name": "selector",
        "type": "bytes4"
      },
      {
        "internalType": "enum ExecutionOptions",
        "name": "options",
        "type": "uint8"
      }
    ],
    "name": "allowFunction",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "roleKey",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "targetAddress",
        "type": "address"
      },
      {
        "internalType": "enum ExecutionOptions",
        "name": "options",
        "type": "uint8"
      }
    ],
    "name": "allowTarget",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "module",
        "type": "address"
      },
      {
        "internalType": "bytes32[]",
        "name": "roleKeys",
        "type": "bytes32[]"
      },
      {
        "internalType": "bool[]",
        "name": "memberOf",
        "type": "bool[]"
      }
    ],
    "name": "assignRoles",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "avatar",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      },
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      },
      {
        "internalType": "enum Enum.Operation",
        "name": "operation",
        "type": "uint8"
      },
      {
        "internalType": "bytes32",
        "name": "roleKey",
        "type": "bytes32"
      },
      {
        "internalType": "bool",
        "name": "shouldRevert",
        "type": "bool"
      }
    ],
    "name": "execTransactionWithRole",
    "outputs": [
      {
        "internalType": "bool",
        "name": "success",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "roleKey",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "targetAddress",
        "type": "address"
      },
      {
        "internalType": "bytes4",
        "name": "selector",
        "type": "bytes4"
      }
    ],
    "name": "revokeFunction",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "roleKey",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "targetAddress",
        "type": "address"
      }
    ],
    "name": "revokeTarget",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "roleKey",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "targetAddress",
        "type": "address"
      },
      {
        "internalType": "bytes4",
        "name": "selector",
        "type": "bytes4"
      },
      {
        "components": [
          {
            "internalType": "uint8",
            "name": "parent",
            "type": "uint8"
          },
          {
            "internalType": "enum ParameterType",
            "name": "paramType",
            "type": "uint8"
          },
          {
            "internalType": "enum Operator",
            "name": "operator",
            "type": "uint8"
          },
          {
            "internalType": "bytes",
            "name": "compValue",
            "type": "bytes"
          }
        ],
        "internalType": "struct ConditionFlat[]",
        "name": "conditions",
        "type": "tuple[]"
      },
      {
        "internalType": "enum ExecutionOptions",
        "name": "options",
        "type": "uint8"
      }
    ],
    "name": "scopeFunction",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "roleKey",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "targetAddress",
        "type": "address"
      }
    ],
    "name": "scopeTarget",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes",
        "name": "initParams",
        "type": "bytes"
      }
    ],
    "name": "setUp",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "target",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

