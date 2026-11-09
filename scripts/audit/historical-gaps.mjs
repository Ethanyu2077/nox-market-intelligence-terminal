#!/usr/bin/env node
/**
 * Read-only historical gap audit. Uses the public API with an admin session from env
 * (NOX_AUDIT_USER / NOX_AUDIT_PASSWORD) and never writes to production.
 *
 *   node scripts/audit/historical-gaps.mjs --base=https://ans.y2k.ventures --days=3 --min-gap-minutes=10
 */
const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=') || '1']; }));
const base = args.get('base') ?? 'http://127.0.0.1:8787';
const days = Math.max(1, Number(args.get('days') ?? 3));
const minGapMs = Math.max(1, Number(args.get('min-gap-minutes') ?? 10)) * 60_000;
const user = process.env.NOX_AUDIT_USER;
const password = process.env.NOX_AUDIT_PASSWORD;
if (!user || !password) { console.error(JSON.stringify({ status: 'NOT VERIFIED', reason: 'NOX_AUDIT_USER / NOX_AUDIT_PASSWORD required' })); process.exit(2); }

const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: user, password }) });
const cookie = (login.headers.getSetCookie?.()[0] ?? '').split(';')[0];
const get = async (path) => { const r = await fetch(`${base}${path}`, { headers: { cookie } }); if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`); return await r.json(); };
const projectList = (await get('/api/projects')).items ?? [];
const now = Date.now();
const from = now - days * 86_400_000;
const report = { generatedAt: new Date().toISOString(), base, days, minGapMs, projects: [] };

for (const project of projectList) {
  const events = new Map();
  let cursor = null, pages = 0;
  do {
    const query = `/api/projects/${project.id}/history?kind=snapshot&limit=1000&from=${from}&asOf=${now}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await get(query);
    for (const event of page.items ?? []) events.set(`${event.eventTime}:${event.id}`, event);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor && pages < 30);

  const rows = [...events.values()].filter((event) => event.ingestTime >= from).sort((a, b) => a.ingestTime - b.ingestTime);
  const byExchange = new Map();
  for (const event of rows) {
    const exchange = event.payload?.exchange ?? 'unknown';
    const list = byExchange.get(exchange) ?? [];
    list.push(event.ingestTime);
    byExchange.set(exchange, list);
  }
  const gaps = [];
  for (const [exchange, times] of byExchange) {
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i] - times[i - 1];
      if (gap >= minGapMs) gaps.push({ exchange, from: times[i - 1], to: times[i], durationMs: gap, estimatedMissing: Math.round(gap / 300_000) - 1 });
    }
  }
  const allTimes = rows.map((event) => event.ingestTime);
  let globalGap = null;
  for (let i = 1; i < allTimes.length; i += 1) {
    const gap = allTimes[i] - allTimes[i - 1];
    if (!globalGap || gap > globalGap.durationMs) globalGap = { from: allTimes[i - 1], to: allTimes[i], durationMs: gap };
  }
  report.projects.push({
    project: project.name, sampledSnapshots: rows.length, pages,
    firstIngest: allTimes[0] ?? null, lastIngest: allTimes.at(-1) ?? null,
    largestGap: globalGap, venues: [...byExchange.keys()],
    gaps: gaps.sort((a, b) => b.durationMs - a.durationMs).slice(0, 20),
  });
}
console.log(JSON.stringify(report, null, 2));
