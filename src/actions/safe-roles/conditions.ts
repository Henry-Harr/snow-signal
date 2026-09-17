import { encodeAbiParameters } from 'viem';
import type { Address } from '../../core/types.js';

/**
 * Zodiac Roles v2 permission-condition tree types and a builder for the one shape
 * Sentinel actually needs: "this function's calldata must have exactly N arguments,
 * and argument at index K must equal this address" (docs/SPEC.md §8.4: "parameter
 * conditions requiring the recipient (and owner, where relevant) to be the Safe
 * itself"). Grounded directly in the Roles v2.1.0 mastercopy's own `Types.sol`
 * source (see `docs/SOURCES.md`'s Zodiac Roles entry and
 * `docs/adr/0011-hand-built-roles-conditions.md` for why this is hand-built rather
 * than using `zodiac-roles-sdk`), not from memory — every enum ordinal below matches
 * that source exactly.
 */

/** `Types.sol`'s `ParameterType` enum, verbatim ordinals. */
export const ParameterType = {
  None: 0,
  Static: 1,
  Dynamic: 2,
  Tuple: 3,
  Array: 4,
  Calldata: 5,
  AbiEncoded: 6,
} as const;

/** `Types.sol`'s `Operator` enum — only the ordinals Sentinel's own scoping uses are
 * named here (the full enum has 32 slots, several reserved/placeholder). */
export const Operator = {
  Pass: 0,
  Matches: 5,
  EqualTo: 16,
} as const;

/** `Types.sol`'s `ExecutionOptions` enum, verbatim ordinals. */
export const ExecutionOptions = {
  None: 0,
  Send: 1,
  DelegateCall: 2,
  Both: 3,
} as const;

/** Mirrors `Types.sol`'s `ConditionFlat` struct field-for-field. */
export interface ConditionFlat {
  parent: number;
  paramType: number;
  operator: number;
  compValue: `0x${string}`;
}

/** One function argument's scoping: unconstrained (`kind: 'pass'`) or pinned to a
 * specific address (`kind: 'equalToAddress'`) — the only two Sentinel's own withdraw/
 * redeem calls need (every argument is a `Static` type — address/uint256/bool — never
 * a dynamic/array/tuple one, for both Aave's `withdraw` and the vault's `withdraw`). */
export type ArgCondition = { kind: 'pass' } | { kind: 'equalToAddress'; address: Address };

/**
 * Builds a `ConditionFlat[]` for `scopeFunction` requiring an exact argument count
 * and shape: a root `Calldata`/`Matches` node (per `Topology.sol`'s own comment,
 * "first item is the root" — every other node's `parent` is that node's index in
 * this same array, `0` for a direct child of the root), followed by one `Static`
 * child per argument, `Pass` (no constraint) or `EqualTo` (pinned to an address).
 */
export function buildArgumentConditions(args: ArgCondition[]): ConditionFlat[] {
  const root: ConditionFlat = {
    parent: 0,
    paramType: ParameterType.Calldata,
    operator: Operator.Matches,
    compValue: '0x',
  };
  const children: ConditionFlat[] = args.map((arg) =>
    arg.kind === 'equalToAddress'
      ? {
          parent: 0,
          paramType: ParameterType.Static,
          operator: Operator.EqualTo,
          compValue: encodeAbiParameters([{ type: 'address' }], [arg.address]),
        }
      : { parent: 0, paramType: ParameterType.Static, operator: Operator.Pass, compValue: '0x' },
  );
  return [root, ...children];
}
