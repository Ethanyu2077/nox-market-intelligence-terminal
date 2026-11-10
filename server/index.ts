import { resolveAllowedOrigins } from './env.ts';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getInstruments, marketSeries, openMarketStream, overview, scanner } from './binance.ts';
import { marketSeries as asterMarketSeries } from './aster.ts';
import { discoverAcrossExchanges, exchangeCapabilities, getExchangeInstruments, projectVenueSnapshots } from './exchanges.ts';
import { openExchangeStream } from './exchange-streams.ts';
import { EXCHANGE_IDS, type ExchangeId } from '../shared/types.ts';
import { FileStore } from './store.ts';
import { getProjectOnchainSnapshot } from './dexpaprika.ts';
import {BinanceWeb3Service} from './binance-web3.ts';
import {koreanSpot} from './korean-spot.ts';
import {CoinGlassService,CoinGlassClient} from './coinglass.ts';
import {ProviderCredentials,installProviderSettings} from './provider-credentials.ts';
import {BinanceExchangeService} from './binance-exchange.ts';
import { analyzeResearch, READ_ONLY_TOOLS, signalsFromSnapshots } from './research.ts';
import { SignalRegistry } from './signal-registry.ts';
import { addAiHypotheses } from './research-ai.ts';
import { installAiRoutes } from './ai/routes.ts';
import { OrderFlowService } from './orderflow-service.ts';
import { HistoryStore } from './history-store.ts';
import { AuthStore, defaultAuthDirectory } from './auth.ts';
import { ProjectCollector } from './collector.ts';
import { flowKey } from './orderflow-calculations.ts';
import { signalLab } from './regime.ts';
import { RegimeRecorder } from './regime-recorder.ts';
import type { RegimeReport } from '../shared/regime-v2.ts';
import {REGIME_WINDOWS} from '../shared/regime-v2.ts';
import {OutcomeStore} from './outcome-store.ts';
import {EventStudyService} from './event-study-service.ts';
import {volumeMatrix} from './volume-matrix.ts';
import {volumeShareHistory} from './volume-share.ts';
import {buildVolumeBars} from './volume-bars.ts';
import {timeframeAlignment} from './timeframe-consistency.ts';
import {alignmentHistory} from './alignment-history.ts';
import {alignmentOutcomes} from './alignment-outcome.ts';
import {projectDataCoverage} from './data-coverage.ts';
import {venueCoverage} from './venue-coverage.ts';
import {signalReadiness,weightedConsensus} from './research-readiness.ts';
import { watchOverview } from './watch-overview.ts';
import { watchlistQuotes } from './watchlist.ts';
import { ccxtHealth, getCcxtMarkets } from './ccxt/client.ts';
import { venueBreakers } from './venue-health.ts';
import { isDepthVenue, orderBookSnapshot } from './orderbook.ts';
import { capabilityRegistry } from './capability-registry.ts';
import { acquireL2 } from './l2/feed.ts';
import { analyzeLeadLag } from './leadlag.ts';
import { L2Collector } from './l2/collector.ts';
import { buildFactorEvidence, factorSamplesFromL2, factorSamplesFromSnapshots, resampleFactorSamples, FACTOR_TIMEFRAMES } from './crossfactor.ts';
import { scanHistory } from './history-scan.ts';
import { ResearchJobManager } from './research-jobs.ts';
import { apiNotFound } from './api-not-found.ts';
import { versionInfo } from './version.ts';
import { buildDataHealth } from './data-health.ts';
import { buildProviderChecks } from './provider-crosscheck.ts';
import { acceptanceRouteEnabled } from './acceptance-access.ts';
import { registerAcceptanceRoute } from './acceptance-route.ts';
import type { PriceSample } from '../shared/leadlag.ts';
import { AlertService } from './alert-service.ts';
import { enabledCcxtVenues, resolveCcxtConfig } from './ccxt/config.ts';

const port = Number(process.env.PORT ?? 8787);
const app = express();
const store = new FileStore(process.env.DATA_DIR ?? '.data');
await store.init();
const signalRegistry = new SignalRegistry(process.env.DATA_DIR ?? '.data');
const dataDirectory = process.env.DATA_DIR ?? '.data';
const providerCredentials=new ProviderCredentials(defaultAuthDirectory());await providerCredentials.init();
let coinglass=new CoinGlassService(new CoinGlassClient(providerCredentials.get('coinglass')??process.env.COINGLASS_API_KEY??''));
const binanceWeb3=new BinanceWeb3Service();
const binanceExchange=new BinanceExchangeService();
const history = new HistoryStore(dataDirectory, process.env.DATABASE_URL);
await history.init();
let archiveError: string | null = null;
const orderFlow = new OrderFlowService(dataDirectory, undefined, (kind, event) => {
  const key = kind === 'trade' && 'marketType' in event ? flowKey(event) : `${event.exchange}:perpetual:${event.symbol}`;
  void history.append({ id: `${key}:${kind}:${event.id}`, kind, marketKey: key, projectId: null, eventTime: event.time, ingestTime: Date.now(), source: 'source' in event ? event.source : 'exchange-liquidation-snapshot', quality: kind === 'liquidation' ? 'partial' : 'verified-aggressor', payload: event }).catch(() => { archiveError = 'History write failed; inspect disk availability'; });
});
const eventStudies=new EventStudyService(history,new OutcomeStore(dataDirectory));
const collector = new ProjectCollector(() => store.getProjects(true), orderFlow, history, undefined, new RegimeRecorder(dataDirectory,history),project=>eventStudies.refresh(project), undefined, project=>timeframeAlignment(project));
const allowedOrigins = resolveAllowedOrigins(port);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) { res.status(403).json({ error: { message: 'Origin not allowed' } }); return; }
  // DELETE carries no payload in this API; browsers may omit Content-Length, and type-is treats
  // a bodyless request as having no media type. Only methods that must send JSON require it.
  const jsonMethod = !['GET','HEAD','OPTIONS','DELETE'].includes(req.method);
  if (jsonMethod && !req.is('application/json')) { res.status(415).json({ error: { message: 'JSON requests required' } }); return; }
  next();
});
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)), credentials: true }));
app.use(express.json({ limit: '160kb' }));
const PROCESS_STARTED_AT = Date.now();
const researchJobs = await ResearchJobManager.open(history as never, undefined, { dataDirectory });
const l2Collector = new L2Collector(() => store.getProjects(true), history);
l2Collector.start();
const alerts = new AlertService(dataDirectory, () => store.getAlerts(), () => store.getProjects(true));
await alerts.init();
alerts.start();
const auth = new AuthStore(defaultAuthDirectory(), dataDirectory); await auth.init(); auth.install(app);
installProviderSettings(app,auth,providerCredentials,key=>{coinglass=new CoinGlassService(new CoinGlassClient(key));});
installAiRoutes(app, {
  auth,
  project: (id) => store.getProjects(true).find((item) => item.id === id),
  evidence: async (project) => { const venues = await projectVenueSnapshots(project.markets); return { report: analyzeResearch(project, venues), venues }; },
});
collector.start();

const exchangeSchema = z.enum(EXCHANGE_IDS);
const projectMarketSchema = z.object({ id: z.string(), exchange: exchangeSchema, marketType: z.enum(['spot', 'perpetual']), symbol: z.string(), base: z.string(), quote: z.string(), status: z.string() });
const projectBodySchema = z.object({
  name: z.string().trim().min(1).max(80), tokenSymbol: z.string().trim().min(1).max(20), contractAddress: z.string().nullable(),
  identitySource: z.enum(['symbol', 'contract']), identityNetwork: z.string().nullable(), markets: z.array(projectMarketSchema).min(1), primaryMarketId: z.string(),
  monitoring: z.object({ collectionMode: z.enum(['active','standard','paused']).optional(), defaultInterval: z.enum(['1m', '5m', '15m', '1h', '4h']).optional(), streamingEnabled: z.boolean().optional() }).optional()
});

const safe = (handler: express.RequestHandler): express.RequestHandler => async (req, res, next) => {
  try { await handler(req, res, next); }
  catch (error) {
    // A handler can throw after streaming a response (client aborted, SSE ended). Trying to
    // send a JSON error then throws ERR_HTTP_HEADERS_SENT and kills the process.
    if (res.headersSent) { if (!res.writableEnded && !res.destroyed) res.end(); return; }
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message, timestamp: Date.now() } });
  }
};
const flowQuery = z.object({ interval: z.enum(['1m', '5m', '15m', '1h', '4h']).default('1m'), reset: z.enum(['window', 'utc-day', 'utc-hour']).default('window'), at: z.coerce.number().finite().min(1e12).optional() });
app.get('/api/version', (_req, res) => res.json(versionInfo(process.env, PROCESS_STARTED_AT, process.version)));
app.get('/api/operations', (_req, res) => res.json({
  process: { pid: process.pid, startedAt: PROCESS_STARTED_AT },
  l2Collection: l2Collector.health(),
  researchJobs: { total: researchJobs.size() }, storage: history.status(), archiveError, collectors: collector.status(), eventStudies:eventStudies.status(), authentication: 'RBAC enforced for mutations', publishingEnabled: false, tradingEnabled: false }));
app.get('/api/projects/:id/event-study',safe(async(req,res)=>{
  const project=store.getProjects(true).find(p=>p.id===String(req.params.id));if(!project){res.status(404).json({error:{message:'Project not found'}});return;}
  const parsed=z.object({horizon:z.coerce.number().refine(v=>[15,60,240,1440].includes(v)).default(60),interval:z.enum(['5m','15m','1h','4h']).optional(),venue:exchangeSchema.optional(),label:z.string().max(100).optional(),minQuality:z.coerce.number().min(0).max(100).default(0),concentration:z.enum(['all','high','low']).default('all'),days:z.coerce.number().int().min(1).max(30).default(7),asOf:z.coerce.number().finite().min(1e12).optional()}).safeParse(req.query);
  if(!parsed.success){res.status(400).json({error:{message:'Invalid event-study query'}});return;}
  const q=parsed.data;res.json(await eventStudies.study(project.id,{horizonMinutes:q.horizon as 15|60|240|1440,interval:q.interval,venue:q.venue,label:q.label,minQuality:q.minQuality,concentration:q.concentration,asOf:Math.min(q.asOf??Date.now(),Date.now())},q.days));
}));
app.get('/api/projects/:id/readiness',safe(async(req,res)=>{
  const project=store.getProjects(true).find(p=>p.id===String(req.params.id));if(!project){res.status(404).json({error:{message:'Project not found'}});return;}
  const interval=z.enum(['5m','15m','1h','4h']).safeParse(req.query.interval??'5m');if(!interval.success){res.status(400).json({error:{message:'Invalid interval'}});return;}
  const now=Date.now(),[samples,recent,events]=await Promise.all([history.sampleSnapshots(project.id,REGIME_WINDOWS[interval.data],now),history.read(project.id,'snapshot',now,100),history.page(project.id,{kind:'regime',source:'nox.regime.v2',regimeInterval:interval.data,limit:1,asOf:now})]);
  const latest=events.items.map(e=>e.payload as RegimeReport).find(r=>r.interval===interval.data);
  res.json({...signalReadiness(project,samples,recent,orderFlow.snapshot(project,interval.data,'utc-day',now),interval.data,now),weighted:latest?weightedConsensus(latest):null,backend:history.status().queryBackend});
}));
app.get('/api/projects/:id/history', safe(async (req,res) => {
  const project = store.getProjects(true).find(p => p.id === String(req.params.id));
  if (!project) { res.status(404).json({error:{message:'Project not found'}}); return; }
  const parsed = z.object({kind:z.enum(['trade','liquidation','snapshot','regime','volume','alignment']),from:z.coerce.number().finite().min(0).optional(),to:z.coerce.number().finite().min(0).optional(),asOf:z.coerce.number().finite().min(0).optional(),marketKey:z.string().max(200).optional(),limit:z.coerce.number().int().min(1).max(1000).default(200),cursor:z.string().max(2000).optional()}).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({error:{message:'Invalid history query'}}); return; }
  try { res.json(await history.page(project.id,parsed.data)); } catch (error) { if (error instanceof Error && /Invalid historical/.test(error.message)) { res.status(400).json({error:{message:error.message}}); return; } throw error; }
}));
app.get('/api/projects/:id/regimes', safe(async (req, res) => res.json({ items: (await history.read(String(req.params.id), 'regime', Date.now(), 1000)).filter(e=>e.source!=='nox.regime.v2').slice(-200).map(e => e.payload) })));
app.get('/api/projects/:id/regimes-v2',safe(async(req,res)=>{
  const interval=z.enum(['5m','15m','1h','4h']).safeParse(req.query.interval??'5m');
  if(!interval.success){res.status(400).json({error:{message:'Invalid regime interval'}});return;}
  const eventId=z.string().regex(/^[a-f0-9]{64}$/).optional().safeParse(req.query.eventId);
  if(!eventId.success){res.status(400).json({error:{message:'Invalid event ID'}});return;}
  const records=eventId.data?(await history.page(String(req.params.id),{kind:'regime',id:eventId.data,limit:1})).items:(await history.page(String(req.params.id),{kind:'regime',source:'nox.regime.v2',regimeInterval:interval.data,summarizeRegime:true,limit:100})).items.reverse();
  const reports=records.filter(e=>e.source==='nox.regime.v2'&&(e.payload as RegimeReport).interval===interval.data).slice(-100).map(e=>e.payload as RegimeReport);
  res.json({items:eventId.data?reports:reports.map(r=>({...r,venues:r.venues.map(v=>({...v,inputSnapshotCount:v.input.snapshots?.length??v.inputSnapshotCount??0,input:{...v.input,snapshots:[],perpBuckets:[],spotBuckets:[]}}))})),historicalEdge:null,inputsIncluded:!!eventId.data});
}));
// Read-only analysis, like /research/analysis: anonymous GET, no mutation.
app.get('/api/projects/:id/research/leadlag', safe(async (req, res) => {
  const project = store.getProjects(true).find((item) => item.id === String(req.params.id));
  if (!project) { res.status(404).json({ error: { message: 'Project not found' } }); return; }
  const body = z.object({
    venueA: exchangeSchema,
    venueB: exchangeSchema,
    windowMs: z.coerce.number().int().min(60_000).max(3_600_000).optional(),
    horizonMs: z.coerce.number().int().min(60_000).max(3_600_000).optional(),
    maxDelayMs: z.coerce.number().int().min(0).max(300_000).optional(),
    costBpsPerSide: z.coerce.number().min(0).max(100).optional(),
  }).parse(req.query);
  // Samples come from the locally collected snapshot journal: event time, ingest time and
  // price are recorded separately, so feed delay is measured rather than assumed.
  const page = await history.page(project.id, { kind: 'snapshot', limit: 2000 });
  const samples = new Map<string, PriceSample[]>();
  for (const entry of page.items) {
    const payload = entry.payload as { snapshots?: Array<{ exchange: string; eventTime: number; price: number | null }> };
    for (const snapshot of payload?.snapshots ?? []) {
      if (snapshot.price == null || !Number.isFinite(snapshot.price)) continue;
      const rows = samples.get(snapshot.exchange) ?? [];
      rows.push({ venue: snapshot.exchange, time: snapshot.eventTime, availableAt: entry.ingestTime, price: snapshot.price });
      samples.set(snapshot.exchange, rows);
    }
  }
  const report = analyzeLeadLag({
    venueA: body.venueA,
    venueB: body.venueB,
    samplesA: (samples.get(body.venueA) ?? []).sort((a, b) => a.time - b.time),
    samplesB: (samples.get(body.venueB) ?? []).sort((a, b) => a.time - b.time),
  }, { ...(body.windowMs ? { windowMs: body.windowMs } : {}), ...(body.horizonMs ? { horizonMs: body.horizonMs } : {}), ...(body.maxDelayMs != null ? { maxDelayMs: body.maxDelayMs } : {}), ...(body.costBpsPerSide != null ? { costBpsPerSide: body.costBpsPerSide } : {}) });
  res.json(report);
}));
// Read-only multi-factor evidence. Factors without comparable, aligned data return
// unavailable instead of a fabricated number.
app.get('/api/projects/:id/research/cross-factor', safe(async (req, res) => {
  const project = store.getProjects(true).find((item) => item.id === String(req.params.id));
  if (!project) { res.status(404).json({ error: { message: 'Project not found' } }); return; }
  const factor = z.enum(['oi_level', 'oi_delta', 'spot_volume_delta', 'perp_volume_delta', 'cvd_divergence', 'funding_basis', 'depth_change']).parse(req.query.factor);
  const timeframe = z.enum(['1m', '5m', '15m', '1h']).default('5m').parse(req.query.timeframe);
  const start = z.coerce.number().int().optional().parse(req.query.start);
  const end = z.coerce.number().int().optional().parse(req.query.end);
  const asOf = z.coerce.number().int().optional().parse(req.query.asOf);
  const limit = z.coerce.number().int().min(1).max(2_000).default(500).parse(req.query.limit);
  const snapshotCursor = z.string().optional().parse(req.query.snapshotCursor);
  const l2Cursor = z.string().optional().parse(req.query.l2Cursor);
  const scanBase = { from: start, to: end, asOf, limit, maxPages: 2, maxRecords: 2_000, timeoutMs: 15_000 };
  const [snapshots, l2] = await Promise.all([
    scanHistory(history, project.id, { ...scanBase, kind: 'snapshot', cursor: snapshotCursor }),
    scanHistory(history, project.id, { ...scanBase, kind: 'l2', cursor: l2Cursor }),
  ]);
  const raw = [...factorSamplesFromSnapshots(snapshots.items), ...factorSamplesFromL2(l2.items)].filter((sample) => sample.factor === factor);
  // Factors that need per-venue spot/perp/cvd series not present in the journal stay empty
  // and therefore return `unavailable` rather than an inferred value.
  const report = buildFactorEvidence(factor, resampleFactorSamples(raw, FACTOR_TIMEFRAMES[timeframe]), {
    bucketMs: FACTOR_TIMEFRAMES[timeframe],
    ...(start ? { windowStart: start } : {}),
    ...(end ? { windowEnd: end } : {}),
  });
  const truncated = snapshots.truncated || l2.truncated;
  const truncationReason = snapshots.reason ?? l2.reason;
  const researchComplete = !truncated && snapshots.scanned > 0;
  if (!researchComplete) {
    // Partial history cannot support a complete-range lead relationship.
    report.verdict = 'insufficient';
    report.counterEvidence = [...report.counterEvidence, `Historical scan incomplete (${truncationReason ?? 'no snapshot history'}); conclusions are limited to the scanned range`];
  }
  res.json({
    ...report,
    partial: !researchComplete,
    snapshotCursor: snapshots.cursor,
    l2Cursor: l2.cursor,
    scannedRecords: snapshots.scanned + l2.scanned,
    excludedRecords: snapshots.duplicates + l2.duplicates + report.excludedSamples,
    truncated,
    truncationReason,
    researchComplete,
    asOf: asOf ?? Date.now(),
    dataWindow: { ...report.dataWindow, bucketMs: FACTOR_TIMEFRAMES[timeframe] },
  });
}));
// Read-only acceptance hook, registered only in an explicit test environment with the
// acceptance flag. Production/development/missing NODE_ENV never expose it.
registerAcceptanceRoute(app, {
  enabled: acceptanceRouteEnabled(),
  user: (req) => auth.user(req as never),
  page: (projectId, query) => history.page(projectId, query),
});
// Full-history research jobs: bounded pages, independent cursors, explicit PARTIAL.
const researchJobBody = z.object({
  factor: z.enum(['oi_level', 'oi_delta', 'spot_volume_delta', 'perp_volume_delta', 'cvd_divergence', 'funding_basis', 'depth_change']),
  timeframe: z.enum(['1m', '5m', '15m', '1h']),
  start: z.coerce.number().int().optional(),
  end: z.coerce.number().int().optional(),
  asOf: z.coerce.number().int().optional(),
});
app.post('/api/projects/:id/research/jobs', safe(async (req, res) => {
  const project = store.getProjects(true).find((item) => item.id === String(req.params.id));
  if (!project) { res.status(404).json({ error: { message: 'Project not found' } }); return; }
  const body = researchJobBody.parse(req.body);
  const { job, duplicate } = researchJobs.create(project.id, body);
  res.status(duplicate ? 200 : 202).json({ job, duplicate });
}));
app.get('/api/projects/:id/research/jobs', safe(async (req, res) => {
  const project = store.getProjects(true).find((item) => item.id === String(req.params.id));
  if (!project) { res.status(404).json({ error: { message: 'Project not found' } }); return; }
  res.json({ items: researchJobs.list(project.id) });
}));
app.get('/api/projects/:id/research/jobs/:jobId', safe(async (req, res) => {
  const job = researchJobs.get(String(req.params.jobId));
  if (!job || job.projectId !== String(req.params.id)) { res.status(404).json({ error: { message: 'Job not found' } }); return; }
  res.json({ job });
}));
app.delete('/api/projects/:id/research/jobs/:jobId', safe(async (req, res) => {
  const job = researchJobs.cancel(String(req.params.jobId));
  if (!job || job.projectId !== String(req.params.id)) { res.status(404).json({ error: { message: 'Job not found' } }); return; }
  res.json({ job });
}));
app.get('/api/projects/:id/provider-crosscheck', safe(async (req, res) => {
  const project = store.getProjects(true).find((item) => item.id === String(req.params.id));
  if (!project) { res.status(404).json({ error: { message: 'Project not found' } }); return; }
  const [venues, coinGlass] = await Promise.all([projectVenueSnapshots(project.markets), coinglass.project(project)]);
  res.json({
    generatedAt: Date.now(), projectId: project.id,
    coinGlass: coinglass.health(),
    checks: buildProviderChecks(project.id, venues.snapshots, coinGlass.oi.data, coinGlass.funding.data),
  });
}));
app.get('/api/projects/:id/l2/metrics', safe(async (req, res) => {
  const project = store.getProjects(true).find((item) => item.id === String(req.params.id));
  if (!project) { res.status(404).json({ error: { message: 'Project not found' } }); return; }
  const bucketMs = z.coerce.number().int().refine((value) => [1_000, 5_000, 60_000].includes(value), 'bucket must be 1000, 5000 or 60000').parse(req.query.bucket ?? 5_000);
  const limit = z.coerce.number().int().min(1).max(1_000).parse(req.query.limit ?? 200);
  const page = await history.page(project.id, { kind: 'l2', limit: 1_000 });
  const includeUnusable = req.query.includeUnusable === '1';
  const items = page.items.map((item) => item.payload)
    .filter((payload): payload is { bucketMs: number; researchUsable?: boolean } => Boolean(payload && typeof payload === 'object' && 'bucketMs' in payload))
    .filter((payload) => payload.bucketMs === bucketMs && (includeUnusable || payload.researchUsable !== false))
    .slice(-limit);
  res.json({ items, bucketMs, includeUnusable });
}));
app.get('/api/projects/:id/signal-lab', safe(async (req, res) => {
  const query = z.object({ horizon: z.coerce.number().int().min(5).max(1440).default(60), costBps: z.coerce.number().min(0).max(1000).default(10), asOf: z.coerce.number().finite().min(1e12).optional() }).parse(req.query);
  const asOf = Math.min(query.asOf ?? Date.now(), Date.now()), id = String(req.params.id);
  res.json(signalLab(await history.read(id, 'regime', asOf), await history.read(id, 'snapshot', asOf, 10_000), query.horizon, query.costBps, asOf));
}));
app.get('/api/projects/:id/orderflow', safe(async (req, res) => {
  const project = store.getProjects(true).find(p => p.id === String(req.params.id) && !p.archived);
  if (!project) { res.status(404).json({ error: { message: 'Project not found' } }); return; }
  const query = flowQuery.parse(req.query);
  res.json(orderFlow.snapshot(project, query.interval, query.reset, Math.min(query.at ?? Date.now(), Date.now())));
}));
app.get('/api/projects/:id/orderflow/stream', (req, res) => {
  const project = store.getProjects(true).find(p => p.id === String(req.params.id) && !p.archived);
  const query = flowQuery.safeParse(req.query);
  if (!project || !query.success) { res.status(400).json({ error: { message: 'Invalid project or interval' } }); return; }
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
  const release = orderFlow.acquire(project);
  const send = () => { const current = store.getProjects(true).find(p => p.id === project.id); if (!current || current.archived || current.monitoring.collectionMode === 'paused' || JSON.stringify(current.markets) !== JSON.stringify(project.markets)) { res.end(); release(); return; } if (!res.destroyed && res.writableLength < 1_000_000) res.write(`event: orderflow\ndata: ${JSON.stringify(orderFlow.snapshot(project, query.data.interval, query.data.reset))}\n\n`); };
  send(); const timer = setInterval(send, 2000);
  req.on('close', () => { clearInterval(timer); release(); });
});

app.get('/api/health', (_req, res) => res.json({ service: 'nox-market-intelligence-api', status: 'ok', mode: 'live-public', venues: EXCHANGE_IDS, timestamp: Date.now() }));
// Per-venue breaker state: lets the UI explain a fast-failing venue instead of showing a
// generic upstream error, and lets an operator see which venue is being cooled down.
app.get('/api/venues/health', (_req, res) => res.json({ items: venueBreakers.snapshot(), timestamp: Date.now() }));

let dataHealthCache: { at: number; value: unknown } | null = null;
app.get('/api/data-health/center', safe(async (_req, res) => {
  if (dataHealthCache && Date.now() - dataHealthCache.at < 10_000) { res.json(dataHealthCache.value); return; }
  const generatedAt = Date.now();
  const projects = store.getProjects(true);
  const storage = history.status();
  const inputs = {
    now: generatedAt,
    storage: {
      mode: storage.mode, connected: storage.connected,
      journalBytes: storage.capacity?.journalBytes ?? null,
      pendingBytes: storage.capacity?.pendingBytes ?? null,
      rows: storage.databaseRowsAcknowledged ?? null,
    },
    providers: [{ ...coinglass.health() }],
    collectors: collector.status().map((item) => ({ projectId: item.projectId, mode: item.mode ?? 'unknown', error: item.error, checkedAt: item.checkedAt })),
    l2: { ...l2Collector.health(), feeds: l2Collector.feedSnapshots() },
    breakers: venueBreakers.snapshot(),
    projects: [] as Array<{ id: string; name: string; mode: string; venues: unknown; coverage: unknown }>,
  };
  for (const project of projects) {
    const [venues, coverage] = await Promise.all([
      projectVenueSnapshots(project.markets),
      projectDataCoverage(history, project, generatedAt),
    ]);
    inputs.projects.push({ id: project.id, name: project.name, mode: project.monitoring.collectionMode ?? 'unknown', venues, coverage });
  }
  const value = buildDataHealth(inputs as never);
  dataHealthCache = { at: Date.now(), value };
  res.json(value);
}));
app.get('/api/exchanges', (_req, res) => res.json({ items: exchangeCapabilities(), timestamp: Date.now() }));
// Unified capability + live coverage registry; every page should read this rather than
// hard-coding per-venue support.
app.get('/api/capabilities', (_req, res) => res.json(capabilityRegistry()));
// CCXT diagnostics. `probe=1` loads the enabled venue catalogues so the settings panel can
// show real market counts and latency; without it the response is cache-only.
app.get('/api/ccxt/health', safe(async (req, res) => {
  const config = resolveCcxtConfig();
  if (config.enabled && req.query.probe === '1') {
    await Promise.allSettled(enabledCcxtVenues(config).map((id) => getCcxtMarkets(id, config)));
  }
  res.json({ ...ccxtHealth(config), ignored: config.ignored });
}));
app.get('/api/research/capabilities', (_req, res) => res.json({ tools: READ_ONLY_TOOLS, mode: process.env.NOX_RESEARCH_AI_ENABLED === 'true' ? 'ai-assisted-available' : 'evidence-only', aiProviderConfigured: process.env.NOX_RESEARCH_AI_ENABLED === 'true', publishingEnabled: false, publishingMode: 'disabled', livePublishingRoute: false }));
app.get('/api/projects/:id/research/analysis', safe(async (req, res) => {
  const project = store.getProjects(true).find(p => p.id === String(req.params.id));
  if (!project) { res.status(404).json({ error: { message: 'Project not found' } }); return; }
  res.json(analyzeResearch(project, await projectVenueSnapshots(project.markets)));
}));
app.post('/api/projects/:id/research/analysis', safe(async (req, res) => {
  const project = store.getProjects(true).find(p => p.id === String(req.params.id));
  if (!project) { res.status(404).json({ error: { message: 'Project not found' } }); return; }
  const { question } = z.object({ question: z.string().trim().min(1).max(1000) }).parse(req.body);
  res.json(await addAiHypotheses(analyzeResearch(project, await projectVenueSnapshots(project.markets)), question));
}));
app.get('/api/projects/:id/signals', safe(async (req, res) => res.json({ items: (await signalRegistry.list()).filter(s => s.projectId === String(req.params.id)), publishingEnabled: false })));
app.post('/api/projects/:id/signals/refresh', safe(async (req, res) => {
  const project = store.getProjects(true).find(p => p.id === String(req.params.id));
  if (!project) { res.status(404).json({ error: { message: 'Project not found' } }); return; }
  await signalRegistry.register(signalsFromSnapshots(project, await projectVenueSnapshots(project.markets)));
  res.json({ items: (await signalRegistry.list()).filter(s => s.projectId === project.id), publishingEnabled: false });
}));
// Health probes report dependency state; they must not turn a venue outage into a 5xx.
app.get('/api/data-health', async (_req, res) => {
  const started = Date.now();
  try {
    await getInstruments();
    res.json({ venue: 'binance', market: 'USDⓈ-M', status: 'live', latencyMs: Date.now() - started, checkedAt: Date.now(), source: 'fapi.binance.com' });
  } catch (error) {
    res.json({ venue: 'binance', market: 'USDⓈ-M', status: 'unavailable', latencyMs: Date.now() - started, checkedAt: Date.now(), source: 'fapi.binance.com', error: error instanceof Error ? error.message.slice(0, 200) : 'Upstream unavailable' });
  }
});
app.get('/api/instruments', safe(async (req, res) => { const q = String(req.query.search ?? '').toUpperCase(); const exchange = exchangeSchema.catch('binance').parse(req.query.exchange) as ExchangeId; const items = (await getExchangeInstruments(exchange)).filter((i) => !q || i.nativeSymbol.includes(q) || i.base.includes(q)).slice(0, 50); res.json({ items, total: items.length, exchange, timestamp: Date.now() }); }));
app.get('/api/projects', (_req, res) => res.json({ items: store.getProjects(true), selectedProjectId: store.getSelectedProjectId() }));
// Hydrated quotes for every active project, so the watchlist is a price board and not a
// list of dashes. Short server-side TTL; partial coverage is explicit per row.
app.get('/api/watchlist/overview', safe(async (_req, res) => res.json(await watchOverview(store.getProjects(true)))));
app.get('/api/watchlist/quotes', safe(async (_req, res) => res.json(await watchlistQuotes(store.getProjects(true)))));
app.post('/api/projects/discover', safe(async (req, res) => { const body = z.object({ query: z.string().trim().min(1).max(100) }).parse(req.body); res.json(await discoverAcrossExchanges(body.query)); }));
app.get('/api/projects/:id/venues', safe(async (req, res) => { const project = store.getProjects(true).find((item) => item.id === String(req.params.id)); if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found', timestamp: Date.now() } }); return; } res.json(await projectVenueSnapshots(project.markets)); }));
app.get('/api/projects/:id/korean-spot',safe(async(req,res)=>{const project=store.getProjects(true).find(p=>p.id===String(req.params.id));if(!project){res.status(404).json({error:{message:'Project not found'}});return;}res.json(await koreanSpot.project(project));}));
app.get('/api/projects/:id/binance',safe(async(req,res)=>{const project=store.getProjects(true).find(p=>p.id===String(req.params.id));if(!project){res.status(404).json({error:{message:'Project not found'}});return;}res.json(await binanceExchange.project(project));}));
app.get('/api/projects/:id/venue-coverage', safe(async (req, res) => { const project = store.getProjects(true).find((item) => item.id === String(req.params.id)); if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found', timestamp: Date.now() } }); return; } const limit = z.coerce.number().int().min(1).max(2000).default(500).parse(req.query.limit ?? 500); const asOf = Math.min(z.coerce.number().finite().min(1e12).optional().parse(req.query.asOf) ?? Date.now(), Date.now()); res.json(await venueCoverage(history, project, asOf, limit)); }));
app.get('/api/projects/:id/data-coverage', safe(async (req, res) => { const project = store.getProjects(true).find((item) => item.id === String(req.params.id)); if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found', timestamp: Date.now() } }); return; } const limit = z.coerce.number().int().min(10).max(20000).default(5000).parse(req.query.limit ?? 5000); res.json(await projectDataCoverage(history, project, Date.now(), limit)); }));
app.get('/api/projects/:id/alignment-outcomes', safe(async (req, res) => { const project = store.getProjects(true).find((item) => item.id === String(req.params.id)); if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found', timestamp: Date.now() } }); return; } const query = z.object({ horizon: z.coerce.number().int().refine((value) => [15, 60, 240, 1440].includes(value)).default(60), costBps: z.coerce.number().min(0).max(1000).default(10), asOf: z.coerce.number().finite().min(1e12).optional() }).parse(req.query); res.json(await alignmentOutcomes(history, project, { asOf: query.asOf, horizonMinutes: query.horizon, costBps: query.costBps })); }));
app.get('/api/projects/:id/alignment-history', safe(async (req, res) => { const project = store.getProjects(true).find((item) => item.id === String(req.params.id)); if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found', timestamp: Date.now() } }); return; } const limit = z.coerce.number().int().min(1).max(2000).default(500).parse(req.query.limit ?? 500); const asOf = Math.min(z.coerce.number().finite().min(1e12).optional().parse(req.query.asOf) ?? Date.now(), Date.now()); res.json(await alignmentHistory(history, project.id, asOf, limit)); }));
app.get('/api/projects/:id/timeframe-alignment', safe(async (req, res) => { const project = store.getProjects(true).find((item) => item.id === String(req.params.id) && !item.archived); if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found', timestamp: Date.now() } }); return; } res.json(await timeframeAlignment(project)); }));
app.get('/api/projects/:id/volume-bars', safe(async (req, res) => { const project = store.getProjects(true).find((item) => item.id === String(req.params.id) && !item.archived); if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found', timestamp: Date.now() } }); return; } const query = z.object({ interval: z.enum(['1m','5m','15m','1h','4h']).default('1m'), at: z.coerce.number().finite().min(1e12).optional() }).parse(req.query); const at = Math.min(query.at ?? Date.now(), Date.now()); res.json(buildVolumeBars(project.id, orderFlow.snapshot(project, query.interval, 'window', at), at)); }));
app.get('/api/projects/:id/volume-share', safe(async (req, res) => { const project = store.getProjects(true).find((item) => item.id === String(req.params.id)); if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found', timestamp: Date.now() } }); return; } const limit = z.coerce.number().int().min(1).max(2000).default(500).parse(req.query.limit ?? 500); const asOf = Math.min(z.coerce.number().finite().min(1e12).optional().parse(req.query.asOf) ?? Date.now(), Date.now()); res.json(await volumeShareHistory(history, project.id, asOf, limit)); }));
app.get('/api/projects/:id/volume-matrix', safe(async (req, res) => { const project = store.getProjects(true).find((item) => item.id === String(req.params.id)); if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found', timestamp: Date.now() } }); return; } res.json(await volumeMatrix(project)); }));
app.get('/api/projects/:id/onchain', safe(async (req, res) => { const project = store.getProjects(true).find((item) => item.id === String(req.params.id)); if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found', timestamp: Date.now() } }); return; } res.json(await getProjectOnchainSnapshot(project)); }));
app.get('/api/projects/:id/web3',safe(async(req,res)=>{
  const project=store.getProjects(true).find(p=>p.id===String(req.params.id));if(!project){res.status(404).json({error:{message:'Project not found'}});return;}
  const query=z.object({interval:z.enum(['1m','5m','15m','1h','4h']).default('5m'),page:z.coerce.number().int().min(1).max(1000).default(1)}).safeParse(req.query);
  if(!query.success){res.status(400).json({error:{message:'Invalid Web3 query'}});return;}
  res.json(await binanceWeb3.project(project,query.data.interval,query.data.page));
}));
app.get('/api/coinglass/capabilities',(_req,res)=>res.json({provider:'CoinGlass',configured:coinglass.configured,mode:'read-only',identity:'symbol-only',liveVerified:false}));
app.get('/api/projects/:id/coinglass',safe(async(req,res)=>{
  const project=store.getProjects(true).find(p=>p.id===String(req.params.id));if(!project){res.status(404).json({error:{message:'Project not found'}});return;}
  const range=z.enum(['4h','12h','24h']).safeParse(req.query.range??'24h');if(!range.success){res.status(400).json({error:{message:'Invalid liquidation range'}});return;}
  const history=z.enum(['1h','4h','1d']).optional().safeParse(req.query.history);if(!history.success){res.status(400).json({error:{message:'Invalid history interval'}});return;}
  res.json(await coinglass.project(project,range.data,history.data));
}));
app.get('/api/web3/capabilities',(_req,res)=>res.json({provider:'Binance Web3',configured:binanceWeb3.configured,mode:'read-only',signing:'server-side HMAC-SHA256',wallets:false,trading:false,publishing:false}));
app.get('/api/projects/:id/research-context', safe(async (req, res) => {
  const project = store.getProjects(true).find((item) => item.id === String(req.params.id));
  if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found', timestamp: Date.now() } }); return; }
  const [centralizedMarkets, onchain, web3, coinGlass, koreanSpotData] = await Promise.all([projectVenueSnapshots(project.markets), getProjectOnchainSnapshot(project),binanceWeb3.project(project),coinglass.project(project),koreanSpot.project(project)]);
  res.json({
    schemaVersion: 'nox.research-context.v1', generatedAt: Date.now(), project, centralizedMarkets, onchain,web3,coinglass:coinGlass,koreanSpot:koreanSpotData,
    interpretationBoundaries: [
      'Observed market data and inferred analytical labels are distinct fields.',
      'Open interest does not reveal long/short ownership or whether positions are opening or closing.',
      'Missing metrics remain null and are never substituted with zero.',
      'This context is market intelligence, not an execution instruction or investment recommendation.',
    ],
  });
}));
app.post('/api/projects', safe(async (req, res) => { const project = await store.addProject(projectBodySchema.parse(req.body)); res.status(201).json(project); }));
app.patch('/api/projects/:id', safe(async (req, res) => { const update = projectBodySchema.partial().extend({ archived: z.boolean().optional() }).parse(req.body); res.json(await store.updateProject(String(req.params.id), update)); }));
app.delete('/api/projects/:id', safe(async (req, res) => { await store.removeProject(String(req.params.id)); res.status(204).end(); }));
app.post('/api/projects/reorder', safe(async (req, res) => { const body = z.object({ ids: z.array(z.string()).min(1) }).parse(req.body); res.json({ items: await store.reorderProjects(body.ids) }); }));
app.post('/api/projects/selection', safe(async (req, res) => { const body = z.object({ id: z.string().nullable() }).parse(req.body); res.json({ selectedProjectId: await store.setSelectedProject(body.id) }); }));
app.get('/api/scanner', safe(async (req, res) => { const limit = Math.min(Number(req.query.limit ?? process.env.SCANNER_LIMIT ?? 24), 40); res.json({ items: await scanner(limit), timestamp: Date.now(), source: 'Binance USDⓈ-M public API', units: { price: 'USDT per base', volume24hUsd: 'USDT notional', oiBase: 'base quantity', oiUsd: 'USDT mark notional', fundingRate: 'decimal per settlement interval' } }); }));
app.get('/api/market/:symbol/overview', safe(async (req, res) => res.json(await overview(String(req.params.symbol)))));
app.get('/api/market/:symbol/series', safe(async (req, res) => { const interval = z.enum(['1m', '5m', '15m', '1h', '4h']).catch('5m').parse(req.query.interval); res.json(await marketSeries(String(req.params.symbol), interval)); }));
// Venue-scoped series so a non-Binance primary feed (e.g. Aster) can drive the native charts.
app.get('/api/market/:exchange/:symbol/series', safe(async (req, res) => {
  const exchange = exchangeSchema.safeParse(req.params.exchange);
  if (!exchange.success) { res.status(400).json({ error: { message: 'Unsupported exchange' } }); return; }
  const interval = z.enum(['1m', '5m', '15m', '1h', '4h']).catch('5m').parse(req.query.interval);
  if (exchange.data !== 'binance' && exchange.data !== 'aster') { res.status(501).json({ error: { message: `${exchange.data} has no native historical series adapter` } }); return; }
  if (!venueBreakers.allow(exchange.data, 'series')) { res.status(503).json({ error: { message: `${exchange.data} series is in an open-circuit cooldown` } }); return; }
  try {
    const series = exchange.data === 'binance'
      ? await marketSeries(String(req.params.symbol), interval)
      : await asterMarketSeries(String(req.params.symbol), interval);
    venueBreakers.success(exchange.data, 'series');
    res.json(series);
  } catch (error) {
    venueBreakers.failure(exchange.data, error instanceof Error ? error.message : 'series failed', 'series');
    throw error;
  }
  res.status(501).json({ error: { message: `${exchange.data} has no native historical series adapter` } });
}));
const l2VenueSchema = z.enum(['binance', 'bybit', 'okx']);
app.get('/api/market/:exchange/:symbol/book', safe(async (req, res) => {
  const venue = l2VenueSchema.safeParse(req.params.exchange);
  if (!venue.success) { res.status(501).json({ error: { code: 'L2_UNAVAILABLE', message: 'Continuous L2 is implemented for binance, bybit and okx', timestamp: Date.now() } }); return; }
  const { feed, release } = acquireL2(venue.data, String(req.params.symbol).toUpperCase());
  try { res.json({ snapshot: feed.snapshot(), metrics: feed.book.metricHistory().slice(-120) }); }
  finally { release(); }
}));
app.get('/api/market/:exchange/:symbol/book/stream', (req, res) => {
  const venue = l2VenueSchema.safeParse(req.params.exchange);
  if (!venue.success) { res.status(501).json({ error: { code: 'L2_UNAVAILABLE', message: 'Continuous L2 is implemented for binance, bybit and okx', timestamp: Date.now() } }); return; }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const { feed, release } = acquireL2(venue.data, String(req.params.symbol).toUpperCase());
  const send = () => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: book\ndata: ${JSON.stringify({ snapshot: feed.snapshot(), metrics: feed.book.metricHistory().slice(-1)[0] ?? null })}\n\n`);
  };
  send();
  const timer = setInterval(send, 250);
  req.on('close', () => { clearInterval(timer); release(); });
});
app.get('/api/market/:exchange/:symbol/depth', safe(async (req, res) => {
  const exchange = exchangeSchema.safeParse(req.params.exchange);
  if (!exchange.success) { res.status(400).json({ error: { code: 'INVALID_EXCHANGE', message: 'Unsupported exchange', timestamp: Date.now() } }); return; }
  if (!isDepthVenue(exchange.data)) { res.status(501).json({ error: { code: 'DEPTH_UNAVAILABLE', message: `${exchange.data} has no verified depth adapter`, timestamp: Date.now() } }); return; }
  const limit = z.coerce.number().int().min(5).max(50).default(20).safeParse(req.query.limit ?? 20);
  if (!limit.success) { res.status(400).json({ error: { code: 'INVALID_LIMIT', message: 'Depth limit must be 5-50', timestamp: Date.now() } }); return; }
  res.json(await orderBookSnapshot(exchange.data, String(req.params.symbol), limit.data));
}));
app.get('/api/market/:exchange/:symbol/stream', (req, res) => {
  const exchange = exchangeSchema.safeParse(req.params.exchange); if (!exchange.success) { res.status(400).json({ error: { code: 'INVALID_EXCHANGE', message: 'Unsupported exchange', timestamp: Date.now() } }); return; }
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
  const send = (event: string, payload: unknown) => { if (res.writableEnded || res.destroyed) return; res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); };
  const stop = openExchangeStream(exchange.data, String(req.params.symbol), (payload) => send('market', payload), (state, detail) => send('connection', { state, detail, timestamp: Date.now() }));
  const heartbeat = setInterval(() => send('heartbeat', { timestamp: Date.now() }), 15_000);
  req.on('close', () => { clearInterval(heartbeat); stop(); });
});
app.get('/api/market/:symbol/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
  const send = (event: string, payload: unknown) => { if (res.writableEnded || res.destroyed) return; res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); };
  const stop = openMarketStream(String(req.params.symbol), (payload) => send('market', payload), (state, detail) => send('connection', { state, detail, timestamp: Date.now() }));
  const heartbeat = setInterval(() => send('heartbeat', { timestamp: Date.now() }), 15_000);
  req.on('close', () => { clearInterval(heartbeat); stop(); });
});
app.get('/api/watchlists', (_req, res) => res.json({ symbols: store.getWatchlist() }));
app.post('/api/watchlists', safe(async (req, res) => { const body = z.object({ symbols: z.array(z.string().regex(/^[A-Z0-9]{5,20}$/)).max(100) }).parse(req.body); res.json({ symbols: await store.setWatchlist(body.symbols) }); }));
const alertScopeSchema = z.object({
  projectId: z.string().min(1).max(120).nullable().optional(),
  venue: exchangeSchema.nullable().optional(),
  marketType: z.enum(['spot', 'perpetual']).nullable().optional(),
  timeframe: z.enum(['1m', '5m', '15m', '1h', '4h']).nullable().optional(),
});
const alertRuleBody = z.object({
  symbol: z.string().trim().min(2).max(30).transform((value) => value.toUpperCase()),
  metric: z.enum(['price_change_24h', 'funding_rate', 'volume_24h_usd']),
  operator: z.enum(['gt', 'lt']),
  threshold: z.number().finite(),
  enabled: z.boolean().default(true),
}).merge(alertScopeSchema);
app.get('/api/alerts/rules', (_req, res) => res.json({ items: store.getAlerts() }));
app.get('/api/alerts/status', (_req, res) => res.json(alerts.status()));
app.post('/api/alerts/rules', safe(async (req, res) => {
  if (store.getAlerts().length >= 100) { res.status(409).json({ error: { message: 'Alert rule limit reached (100)' } }); return; }
  const body = alertRuleBody.parse(req.body);
  const rule = await store.addAlert(body);
  res.status(201).json(rule);
}));
app.patch('/api/alerts/rules/:id', safe(async (req, res) => {
  const body = z.object({ enabled: z.boolean().optional(), threshold: z.number().finite().optional() }).merge(alertScopeSchema).strict().parse(req.body);
  res.json(await store.updateAlert(String(req.params.id), body));
}));
app.delete('/api/alerts/rules/:id', safe(async (req, res) => { await store.removeAlert(String(req.params.id)); res.status(204).end(); }));
app.post('/api/alerts/evaluate', safe(async (_req, res) => { res.json(await alerts.evaluate()); }));
app.post('/api/alerts/events/clear', safe(async (_req, res) => { await alerts.clearEvents(); res.json(alerts.status()); }));

// Register before the SPA fallback: an unknown API route must be JSON 404, never HTML 200.
app.use('/api', apiNotFound);

if (process.env.NODE_ENV === 'production') {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  app.use(express.static(root)); app.get('*', (_req, res) => res.sendFile(path.join(root, 'index.html')));
}
const host = process.env.HOST ?? '127.0.0.1';
const server = app.listen(port, host, () => console.log(`NOX API listening on http://${host}:${port}`));

// CCXT catalogues are large (HTX ~2.5k markets) and slow on a cold cache. Warm them in
// the background so the first project discovery is not blocked by a 20s loadMarkets().
{
  const ccxt = resolveCcxtConfig();
  if (ccxt.enabled && ccxt.venues.length) {
    void Promise.allSettled(enabledCcxtVenues(ccxt).map((id) => getCcxtMarkets(id, ccxt)))
      .then((rows) => {
        const loaded = rows.filter((row) => row.status === 'fulfilled').length;
        console.log(`CCXT catalogues warmed: ${loaded}/${rows.length} (${ccxt.venues.join(', ')})`);
      });
  }
}
let shuttingDown = false;
const shutdown = async () => { if (shuttingDown) return; shuttingDown = true; try { await l2Collector.flush(); } catch { /* audit flush best effort */ } researchJobs.close(); l2Collector.stop(); alerts.stop(); await collector.close(); await eventStudies.close(); await orderFlow.close(); await history.close(); auth.close(); providerCredentials.close(); server.close(); server.closeAllConnections(); process.exit(0); };
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
