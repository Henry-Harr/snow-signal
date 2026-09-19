import { describe, expect, it, vi } from 'vitest';

import { fetchLiquidationCandidates, parseUsersPage } from '../../../src/liquidations/subgraph.js';

describe('parseUsersPage', () => {
  it('parses users into candidates and reports the last id as the next cursor', () => {
    const result = parseUsersPage({ data: { users: [{ id: '0xaaa' }, { id: '0xbbb' }] } });
    expect(result.candidates).toEqual([{ user: '0xaaa' }, { user: '0xbbb' }]);
    expect(result.lastId).toBe('0xbbb');
  });

  it('returns no candidates and an undefined cursor for an empty page', () => {
    const result = parseUsersPage({ data: { users: [] } });
    expect(result.candidates).toEqual([]);
    expect(result.lastId).toBeUndefined();
  });

  it('throws on a GraphQL errors response rather than silently returning nothing', () => {
    expect(() => parseUsersPage({ errors: [{ message: 'bad api key' }] })).toThrow(/bad api key/);
  });
});

describe('fetchLiquidationCandidates', () => {
  it('paginates until a page comes back shorter than the page size', async () => {
    const page1 = { data: { users: Array.from({ length: 100 }, (_, i) => ({ id: `0x${i}` })) } };
    const page2 = { data: { users: [{ id: '0xlast' }] } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page1) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page2) });

    const candidates = await fetchLiquidationCandidates(
      { apiKey: 'test-key', subgraphId: 'test-subgraph' },
      fetchMock,
    );

    expect(candidates).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call's query should carry the first page's last id as the cursor.
    const secondCallBody = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body) as {
      query: string;
    };
    expect(secondCallBody.query).toContain('id_gt: "0x99"');
  });

  it('throws with the HTTP status and body on a non-ok response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: () => Promise.resolve('rate limited') });

    await expect(
      fetchLiquidationCandidates(
        { apiKey: 'test-key', subgraphId: 'test-subgraph' },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/429/);
  });
});
