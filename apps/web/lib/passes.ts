import { apiRequest } from './api';
import type { PassPage, PassView } from './types';

export async function fetchAllPasses(societyId: string): Promise<PassView[]> {
  const items: PassView[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  while (true) {
    const params = new URLSearchParams({ societyId, limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const pageResult = await apiRequest<PassPage>(`/api/v1/visitor-passes?${params.toString()}`);
    items.push(...pageResult.items);
    cursor = pageResult.nextCursor;
    if (!cursor) break;
    if (seen.has(cursor)) throw new Error('Pass pagination returned a repeated cursor. Please retry.');
    seen.add(cursor);
  }
  return items;
}
