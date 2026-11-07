import type { HistoryEvent } from '../shared/history.ts';
import type { HistoryQuery } from './history-store.ts';

/** Bounded, cursor-resumable journal scan with explicit truncation semantics. */
export interface ScanOptions {
  kind: HistoryEvent['kind'];
  from?: number;
  to?: number;
  asOf?: number;
  cursor?: string | null;
  limit: number;
  maxPages: number;
  maxRecords: number;
  timeoutMs: number;
  now?: () => number;
}

export interface ScanResult {
  items: HistoryEvent[];
  cursor: string | null;
  scanned: number;
  duplicates: number;
  truncated: boolean;
  reason: 'max-pages' | 'max-records' | 'timeout' | null;
}

type Pager = { page: (projectId: string, query: HistoryQuery) => Promise<{ items: HistoryEvent[]; nextCursor: string | null }> };

export async function scanHistory(store: Pager, projectId: string, options: ScanOptions): Promise<ScanResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const seen = new Set<string>();
  const items: HistoryEvent[] = [];
  let cursor = options.cursor ?? null;
  let scanned = 0;
  let duplicates = 0;
  let pages = 0;
  let reason: ScanResult['reason'] = null;

  while (true) {
    if (pages >= options.maxPages) { reason = 'max-pages'; break; }
    if (now() - started > options.timeoutMs) { reason = 'timeout'; break; }
    const page = await store.page(projectId, {
      kind: options.kind, from: options.from, to: options.to, asOf: options.asOf, cursor: cursor ?? undefined, limit: options.limit,
    });
    // Consume the WHOLE page. Stopping mid-page and returning that page's next cursor
    // would silently skip the remaining records; maxRecords is a soft bound of one page.
    for (const item of page.items) {
      scanned += 1;
      // Stable identity: the same event can reappear on a page boundary after a new write.
      if (seen.has(item.id)) { duplicates += 1; continue; }
      seen.add(item.id);
      items.push(item);
    }
    pages += 1;
    cursor = page.nextCursor;
    if (items.length >= options.maxRecords) { reason = 'max-records'; break; }
    if (!cursor) break;
  }

  return { items, cursor, scanned, duplicates, truncated: reason != null, reason };
}
