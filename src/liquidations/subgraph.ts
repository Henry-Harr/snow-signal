import type { Address } from '../core/types.js';
import type { LiquidationCandidate } from './types.js';

/**
 * Aave v3's official subgraph (docs/adr/0014-liquidation-scanner.md): the
 * *discovery* half of the scanner — find candidate borrowers cheaply, then verify
 * every one of them against real on-chain state (`aave-reserves.ts`,
 * `src/watchers/large-holders.ts`'s `fetchAaveBorrowerHealth`) before trusting
 * anything about them. The subgraph schema itself was verified against the official
 * `aave/protocol-subgraphs` repo (`schemas/v3.schema.graphql`,
 * raw.githubusercontent.com, `main` branch, fetched 2026-09-19) — see
 * docs/SOURCES.md. Confirmed: the schema does **not** expose a computed health
 * factor anywhere (`User`/`UserReserve` only carry raw balances) — this client only
 * ever asks the subgraph "who has an active borrow," never "who is unsafe."
 *
 * The Graph's old free hosted service is fully deprecated — this queries the
 * decentralized network's gateway, which needs an API key (`GRAPH_API_KEY`, free
 * tier: 100,000 queries/month, thegraph.com/studio). The subgraph deployment ID
 * itself should be re-confirmed against the live Explorer once that key exists
 * (docs/SOURCES.md notes this as not independently re-verified against a live
 * query this session, only against the README/schema).
 */

const GATEWAY_BASE = 'https://gateway.thegraph.com/api';

export interface SubgraphConfig {
  apiKey: string;
  subgraphId: string;
}

const PAGE_SIZE = 100; // The Graph's own per-query cap.

/** `id_gt`-cursor pagination rather than `skip` — skip-based pagination on The
 * Graph degrades/is capped at deep offsets; a cursor on `id` (monotonic per Graph's
 * own ordering) has no such limit and is the documented recommended approach. */
function buildBorrowersQuery(afterId: string | undefined): string {
  const where = afterId
    ? `where: { borrowedReservesCount_gt: 0, id_gt: "${afterId}" }`
    : `where: { borrowedReservesCount_gt: 0 }`;
  return `{
    users(first: ${PAGE_SIZE}, orderBy: id, orderDirection: asc, ${where}) {
      id
    }
  }`;
}

interface UsersQueryResponse {
  data?: { users: { id: string }[] };
  errors?: { message: string }[];
}

/** Parses one page's raw response into candidates — pure, no I/O, so this is unit
 * testable against fixture JSON without a real API key. `User.id` in this schema is
 * the borrower's address (lowercased, per The Graph's standard convention for
 * address-typed IDs). */
export function parseUsersPage(response: UsersQueryResponse): {
  candidates: LiquidationCandidate[];
  lastId: string | undefined;
} {
  if (response.errors && response.errors.length > 0) {
    throw new Error(`Aave subgraph query failed: ${response.errors.map((e) => e.message).join('; ')}`);
  }
  const users = response.data?.users ?? [];
  return {
    candidates: users.map((u) => ({ user: u.id as Address })),
    lastId: users.length > 0 ? users[users.length - 1]!.id : undefined,
  };
}

/** Fetches every candidate borrower (active-borrow accounts), paginating until a
 * page comes back shorter than `PAGE_SIZE`. No upper bound on total pages — a
 * real market's active-borrower count is large but finite and this is a periodic
 * batch scan, not a low-latency path. */
export async function fetchLiquidationCandidates(
  config: SubgraphConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<LiquidationCandidate[]> {
  const url = `${GATEWAY_BASE}/${config.apiKey}/subgraphs/id/${config.subgraphId}`;
  const all: LiquidationCandidate[] = [];
  let afterId: string | undefined;

  for (;;) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: buildBorrowersQuery(afterId) }),
    });
    if (!res.ok) {
      throw new Error(`Aave subgraph query failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as UsersQueryResponse;
    const { candidates, lastId } = parseUsersPage(body);
    all.push(...candidates);
    if (candidates.length < PAGE_SIZE || lastId === undefined) break;
    afterId = lastId;
  }

  return all;
}
