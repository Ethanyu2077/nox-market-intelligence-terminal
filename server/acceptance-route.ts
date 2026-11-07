import type { Express } from 'express';
import { authorizeAcceptance } from './acceptance-access.ts';

export interface AcceptanceRouteDeps {
  enabled: boolean;
  user: (req: { headers: Record<string, unknown> }) => { role?: string } | null;
  page: (projectId: string, query: { kind: 'snapshot'; source: string; limit: number }) => Promise<{ items: Array<{ id: string; eventTime: number; ingestTime: number; payload: unknown }> }>;
}

/** Registers the read-only acceptance hook only when the environment allows it. */
export function registerAcceptanceRoute(app: Express, deps: AcceptanceRouteDeps): boolean {
  if (!deps.enabled) return false;
  app.get('/api/acceptance/records', async (req, res) => {
    const decision = authorizeAcceptance(deps.user(req as never), req.query.source);
    if (!decision.ok) { res.status(decision.status ?? 400).json({ error: { message: decision.reason ?? 'Forbidden' } }); return; }
    try {
      const page = await deps.page('acceptance', { kind: 'snapshot', source: String(req.query.source), limit: 100 });
      res.json({ items: page.items.slice(0, 100).map((event) => ({ id: event.id, eventTime: event.eventTime, ingestTime: event.ingestTime, payload: event.payload })) });
    } catch (error) {
      res.status(503).json({ error: { message: error instanceof Error ? error.message : 'read failed' } });
    }
  });
  return true;
}
