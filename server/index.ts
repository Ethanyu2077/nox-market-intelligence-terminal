import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getInstruments, marketSeries, openMarketStream, overview, scanner } from './binance.ts';
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
import {signalReadiness,weightedConsensus} from './research-readiness.ts';

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
const collector = new ProjectCollector(() => store.getProjects(true), orderFlow, history, undefined, new RegimeRecorder(dataDirectory,history),project=>eventStudies.refresh(project));
const allowedOrigins = new Set((process.env.NOX_ALLOWED_ORIGINS ?? `http://127.0.0.1:${port},http://localhost:${port},http://127.0.0.1:5173,http://localhost:5173`).split(',').map(s => s.trim()));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) { res.status(403).json({ error: { message: 'Origin not allowed' } }); return; }
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && !req.is('application/json')) { res.status(415).json({ error: { message: 'JSON requests required' } }); return; }
  next();
});
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)), credentials: true }));
app.use(express.json({ limit: '100kb' }));
const auth = new AuthStore(defaultAuthDirectory(), dataDirectory); await auth.init(); auth.install(app);
installProviderSettings(app,auth,providerCredentials,key=>{coinglass=new CoinGlassService(new CoinGlassClient(key));});
collector.start();

const exchangeSchema = z.enum(EXCHANGE_IDS);
const projectMarketSchema = z.object({ id: z.string(), exchange: exchangeSchema, marketType: z.enum(['spot', 'perpetual']), symbol: z.string(), base: z.string(), quote: z.string(), status: z.string() });
const projectBodySchema = z.object({
  name: z.string().trim().min(1).max(80), tokenSymbol: z.string().trim().min(1).max(20), contractAddress: z.string().nullable(),
  identitySource: z.enum(['symbol', 'contract']), identityNetwork: z.string().nullable(), markets: z.array(projectMarketSchema).min(1), primaryMarketId: z.string(),
  monitoring: z.object({ collectionMode: z.enum(['active','standard','paused']).optional(), defaultInterval: z.enum(['1m', '5m', '15m', '1h', '4h']).optional(), streamingEnabled: z.boolean().optional() }).optional()
});

const safe = (handler: express.RequestHandler): express.RequestHandler => async (req, res, next) => { try { await handler(req, res, next); } catch (error) { const message = error instanceof Error ? error.message : 'Unknown error'; res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message, timestamp: Date.now() } }); } };
const flowQuery = z.object({ interval: z.enum(['1m', '5m', '15m', '1h', '4h']).default('1m'), reset: z.enum(['window', 'utc-day', 'utc-hour']).default('window'), at: z.coerce.number().finite().min(1e12).optional() });
app.get('/api/operations', (_req, res) => res.json({ storage: history.status(), archiveError, collectors: collector.status(), eventStudies:eventStudies.status(), authentication: 'RBAC enforced for mutations', publishingEnabled: false, tradingEnabled: false }));
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
  const parsed = z.object({kind:z.enum(['trade','liquidation','snapshot','regime']),from:z.coerce.number().finite().min(0).optional(),to:z.coerce.number().finite().min(0).optional(),asOf:z.coerce.number().finite().min(0).optional(),marketKey:z.string().max(200).optional(),limit:z.coerce.number().int().min(1).max(1000).default(200),cursor:z.string().max(2000).optional()}).safeParse(req.query);
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
app.get('/api/exchanges', (_req, res) => res.json({ items: exchangeCapabilities(), timestamp: Date.now() }));
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
app.get('/api/data-health', safe(async (_req, res) => { const started = Date.now(); await getInstruments(); res.json({ venue: 'binance', market: 'USDⓈ-M', status: 'live', latencyMs: Date.now() - started, checkedAt: Date.now(), source: 'fapi.binance.com' }); }));
app.get('/api/instruments', safe(async (req, res) => { const q = String(req.query.search ?? '').toUpperCase(); const exchange = exchangeSchema.catch('binance').parse(req.query.exchange) as ExchangeId; const items = (await getExchangeInstruments(exchange)).filter((i) => !q || i.nativeSymbol.includes(q) || i.base.includes(q)).slice(0, 50); res.json({ items, total: items.length, exchange, timestamp: Date.now() }); }));
app.get('/api/projects', (_req, res) => res.json({ items: store.getProjects(true), selectedProjectId: store.getSelectedProjectId() }));
app.post('/api/projects/discover', safe(async (req, res) => { const body = z.object({ query: z.string().trim().min(1).max(100) }).parse(req.body); res.json(await discoverAcrossExchanges(body.query)); }));
app.get('/api/projects/:id/venues', safe(async (req, res) => { const project = store.getProjects(true).find((item) => item.id === String(req.params.id)); if (!project) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found', timestamp: Date.now() } }); return; } res.json(await projectVenueSnapshots(project.markets)); }));
app.get('/api/projects/:id/korean-spot',safe(async(req,res)=>{const project=store.getProjects(true).find(p=>p.id===String(req.params.id));if(!project){res.status(404).json({error:{message:'Project not found'}});return;}res.json(await koreanSpot.project(project));}));
app.get('/api/projects/:id/binance',safe(async(req,res)=>{const project=store.getProjects(true).find(p=>p.id===String(req.params.id));if(!project){res.status(404).json({error:{message:'Project not found'}});return;}res.json(await binanceExchange.project(project));}));
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
app.get('/api/market/:exchange/:symbol/stream', (req, res) => {
  const exchange = exchangeSchema.safeParse(req.params.exchange); if (!exchange.success) { res.status(400).json({ error: { code: 'INVALID_EXCHANGE', message: 'Unsupported exchange', timestamp: Date.now() } }); return; }
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
  const send = (event: string, payload: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  const stop = openExchangeStream(exchange.data, String(req.params.symbol), (payload) => send('market', payload), (state, detail) => send('connection', { state, detail, timestamp: Date.now() }));
  const heartbeat = setInterval(() => send('heartbeat', { timestamp: Date.now() }), 15_000);
  req.on('close', () => { clearInterval(heartbeat); stop(); });
});
app.get('/api/market/:symbol/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
  const send = (event: string, payload: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  const stop = openMarketStream(String(req.params.symbol), (payload) => send('market', payload), (state, detail) => send('connection', { state, detail, timestamp: Date.now() }));
  const heartbeat = setInterval(() => send('heartbeat', { timestamp: Date.now() }), 15_000);
  req.on('close', () => { clearInterval(heartbeat); stop(); });
});
app.get('/api/watchlists', (_req, res) => res.json({ symbols: store.getWatchlist() }));
app.post('/api/watchlists', safe(async (req, res) => { const body = z.object({ symbols: z.array(z.string().regex(/^[A-Z0-9]{5,20}$/)).max(100) }).parse(req.body); res.json({ symbols: await store.setWatchlist(body.symbols) }); }));
app.get('/api/alerts/rules', (_req, res) => res.json({ items: store.getAlerts() }));
app.post('/api/alerts/rules', safe(async (req, res) => { const body = z.object({ symbol: z.string(), metric: z.enum(['price_change_24h', 'funding_rate', 'volume_24h_usd']), operator: z.enum(['gt', 'lt']), threshold: z.number().finite(), enabled: z.boolean().default(true) }).parse(req.body); res.status(201).json(await store.addAlert(body)); }));

if (process.env.NODE_ENV === 'production') {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  app.use(express.static(root)); app.get('*', (_req, res) => res.sendFile(path.join(root, 'index.html')));
}
const server = app.listen(port, '127.0.0.1', () => console.log(`NOX API listening on http://127.0.0.1:${port}`));
let shuttingDown = false;
const shutdown = async () => { if (shuttingDown) return; shuttingDown = true; await collector.close(); await eventStudies.close(); await orderFlow.close(); await history.close(); auth.close(); providerCredentials.close(); server.close(); server.closeAllConnections(); process.exit(0); };
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
