import { expect, test } from '@playwright/test';
import { fetchAllPasses } from '../lib/passes';

test('loads passes beyond the first 100 records', async () => {
  const originalFetch = globalThis.fetch;
  const cursors: (string | null)[] = [];
  globalThis.fetch = async (input) => {
    const cursor = new URL(String(input), 'http://localhost').searchParams.get('cursor');
    cursors.push(cursor);
    return new Response(JSON.stringify({
      items: cursor ? [{ id: 'pass-101' }] : Array.from({ length: 100 }, (_, i) => ({ id: `pass-${i + 1}` })),
      nextCursor: cursor ? null : 'after-100',
    }), { status: 200 });
  };
  try {
    const passes = await fetchAllPasses('society');
    expect(passes).toHaveLength(101);
    expect(passes.at(-1)?.id).toBe('pass-101');
    expect(cursors).toEqual([null, 'after-100']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects a cursor cycle', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [], nextCursor: 'same' }), { status: 200 });
  try {
    await expect(fetchAllPasses('society')).rejects.toThrow('repeated cursor');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
