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
  signal?: AbortSignal;
}

export interface ScanResult {
  items: HistoryEvent[];
  cursor: string | null;
  scanned: number;
  duplicates: number;
  truncated: boolean;
  reason: 'max-pages' | 'max-records' | 'timeout' | 'query-error' | 'invalid-cursor' | 'cancelled' | null;
}

type Pager = { page: (projectId: string, query: HistoryQuery) => Promise<{ items: HistoryEvent[]; nextCursor: string | null }> };

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('history page timeout')), ms)),
  ]);
}

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
    if (options.signal?.aborted) { reason = 'cancelled'; break; }
    if (pages >= options.maxPages) { reason = 'max-pages'; break; }
    if (now() - started > options.timeoutMs) { reason = 'timeout'; break; }
    let page;
    try {
      // Bound the page call itself: a hung journal/DB query must not hold the HTTP request
      // past the proxy timeout. On timeout we return what has been scanned so far.
      page = await withTimeout(store.page(projectId, {
        kind: options.kind, from: options.from, to: options.to, asOf: options.asOf, cursor: cursor ?? undefined, limit: options.limit, signal: options.signal,
      }), Math.max(1_000, Math.min(options.timeoutMs, Math.max(1_000, options.timeoutMs - (now() - started)))));
    } catch (error) {
      // Never look like a clean end. Classify without leaking SQL, connection strings or
      // driver internals to the caller.
      const message = error instanceof Error ? error.message : '';
      if (options.signal?.aborted) reason = 'cancelled';
      else if (/timeout/i.test(message)) reason = 'timeout';
      else if (/cursor/i.test(message)) reason = 'invalid-cursor';
      else reason = 'query-error';
      break;
    }
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
