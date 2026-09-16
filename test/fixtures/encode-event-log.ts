import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';

/**
 * Builds `{ data, topics }` for a fabricated event log, for tests that need a
 * realistic ABI-encoded log to feed into an adapter's `decodeEvents`. viem 2.x
 * doesn't export a single `encodeEventLog` helper (only `decodeEventLog` and
 * `encodeEventTopics`), so this combines `encodeEventTopics` (indexed args) with
 * `encodeAbiParameters` over the non-indexed inputs, in declaration order — the
 * same encoding `decodeEventLog` expects to reverse.
 */
export function encodeTestEventLog<TAbi extends Abi>(
  abi: TAbi,
  eventName: string,
  args: Record<string, unknown>,
): { data: `0x${string}`; topics: [`0x${string}`, ...`0x${string}`[]] } {
  // viem's `encodeEventTopics` types `args` against the exact per-event arg shape
  // inferred from a literal ABI const, which a generic `TAbi` here can't satisfy —
  // this helper is a test fixture that trades that precision for flexibility across
  // any ABI passed in.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const topics = encodeEventTopics({ abi, eventName, args } as any) as unknown as [
    `0x${string}`,
    ...`0x${string}`[],
  ];

  const eventAbi = abi.find((item) => item.type === 'event' && item.name === eventName);
  if (!eventAbi || eventAbi.type !== 'event') {
    throw new Error(`No event named ${eventName} in the given ABI`);
  }
  const nonIndexedInputs = eventAbi.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(
    nonIndexedInputs,
    nonIndexedInputs.map((input) => args[input.name!]),
  );

  return { data, topics };
}
