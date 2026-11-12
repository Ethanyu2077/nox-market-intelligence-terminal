import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Instrument, MarketProject, ProjectMarket } from '../shared/types.ts';
import type { FlowGap, FlowInterval, FlowReset, FlowTrade, FlowVenue, LiquidationEvent, OrderFlowResponse } from '../shared/orderflow.ts';
import { aggregateFlow, clusterFlowTrades, flowBuckets, flowDivergences, flowKey, timeGrid } from './orderflow-calculations.ts';
import { openFlowStream, orderFlowCapability, recentFlowTrades, verifiedFlowInstrument } from './orderflow-adapters.ts';
import { OrderFlowCheckpoint } from './orderflow-checkpoint.ts';
import { SnapshotBudget } from './snapshot-budget.ts';
import { storageLimit } from './storage-limits.ts';

const MAX_TRADES = 50_000;
type Feed = {
  market: ProjectMarket; trades: FlowTrade[]; seen: Set<string>; gaps: FlowGap[]; state: FlowVenue['state']; detail: string;
  checkedAt: number | null; coverageFrom: number | null; coverageTo: number | null; lastWs: number | null;
  refs: number; stop?: () => void; timer?: NodeJS.Timeout; flush?: NodeJS.Timeout; closing?: NodeJS.Timeout;
  instrument?: Instrument; stopped: boolean; loading: boolean; liquidationState: string; liquidations: LiquidationEvent[];
  dirty: boolean; checkpoint: OrderFlowCheckpoint;
};
/** Merge the newest 1,000 eligible trades without copying each feed's 50,000-trade history. */
function latestTape(feeds: Feed[], at: number) {
  const cursors = feeds.map(({trades}) => {
    let low = 0, high = trades.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (trades[mid].time <= at) low = mid + 1;
      else high = mid;
    }
    return low - 1;
  });
  const trades: FlowTrade[] = [];
  while (trades.length < 1000) {
    let newest = -1;
    for (let index = 0; index < feeds.length; index++) {
      if (cursors[index] < 0) continue;
      // The later feed comes last on equal timestamps in the original stable sort.
      if (newest < 0 || feeds[index].trades[cursors[index]].time >= feeds[newest].trades[cursors[newest]].time) newest = index;
    }
    if (newest < 0) break;
    trades.push(feeds[newest].trades[cursors[newest]--]);
  }
  return trades.reverse();
}

/** Venues whose public liquidation stream is normalised in this version. */
const LIQUIDATION_FEEDS = new Set(['binance', 'bybit', 'okx']);

export class OrderFlowService {
  private feeds = new Map<string, Feed>();
  private checkpoints = new Map<string, Promise<void>>();
  private budget: SnapshotBudget;
  constructor(private directory: string, private adapters = { verify: verifiedFlowInstrument, recent: recentFlowTrades, stream: openFlowStream }, private archive?: (kind: 'trade' | 'liquidation', event: FlowTrade | LiquidationEvent) => void,
    maxBytes = storageLimit('NOX_ORDERFLOW_MAX_BYTES', 512 * 1024 ** 2)) {
    const dir = path.join(directory, 'orderflow');
    this.budget = new SnapshotBudget(dir, 'flow', maxBytes, group => {
      const file = path.join(dir, group);
      return this.checkpoints.has(file) || [...this.feeds.values()].some(feed => feed.checkpoint.file === file);
    });
  }
  initStorage() { return this.budget.init(); }
  storageStatus() { return this.budget.status(); }
  async close() {
    const feeds = [...this.feeds.values()];
    for (const feed of feeds) { feed.stopped = true; feed.stop?.(); if (feed.timer) clearTimeout(feed.timer); if (feed.flush) clearInterval(feed.flush); if (feed.closing) clearTimeout(feed.closing); }
    await Promise.all([...feeds.map(feed => this.persist(feed, true)), ...this.checkpoints.values()]); this.feeds.clear(); this.budget.close();
  }
  acquire(project: MarketProject) {
    if (!project.monitoring.streamingEnabled || project.monitoring.collectionMode === 'paused') return () => {};
    const releases = [...new Map(project.markets.map(m => [flowKey(m), m])).values()].map(market => {
      const key = flowKey(market); let feed = this.feeds.get(key);
      if (!feed) {
        const file = path.join(this.directory, 'orderflow', `${createHash('sha256').update(key).digest('hex')}.json`);
        feed = { market, trades: [], seen: new Set(), gaps: [], state: 'connecting', detail: '', checkedAt: null, coverageFrom: null, coverageTo: null, lastWs: null, refs: 0, stopped: false, loading: false, dirty: false, checkpoint: new OrderFlowCheckpoint(file, this.budget), liquidations: [], liquidationState: 'waiting-for-verified-events' };
        this.feeds.set(key, feed);
        // A previous incarnation can be finishing its final checkpoint. Its single
        // completion handler starts whichever feed still owns this key at that time.
        if (!this.checkpoints.has(file)) void this.start(feed);
      }
      feed.refs++; if (feed.closing) clearTimeout(feed.closing);
      const current = feed;
      let released = false;
      return () => {
        if (released) return; released = true;
        current.refs = Math.max(0, current.refs - 1);
        if (!current.refs) current.closing = setTimeout(() => { if (current.refs) return; current.stopped = true; current.stop?.(); if (current.timer) clearTimeout(current.timer); if (current.flush) clearInterval(current.flush); void this.persist(current, true); this.feeds.delete(key); }, 5000);
      };
    });
    return () => releases.forEach(release => release());
  }
  private persist(feed: Feed, final = false) {
    const file = feed.checkpoint.file;
    const previous = this.checkpoints.get(file);
    if (previous && !final) return previous;
    if (!feed.dirty && (!previous || !feed.instrument)) return previous;
    const work = (previous ?? Promise.resolve()).then(async () => {
      if (!feed.dirty) return;
      try {
        feed.dirty = false;
        await feed.checkpoint.save(feed);
      } catch (error) {
        feed.dirty = true;
        feed.detail = `Persistence failed: ${String(error)}`;
      }
    }).finally(() => {
      if (this.checkpoints.get(file) !== work) return;
      this.checkpoints.delete(file);
      const current = this.feeds.get(flowKey(feed.market));
      if (current && current !== feed && !current.stopped) void this.start(current);
    });
    this.checkpoints.set(file, work);
    return work;
  }
  private async start(feed: Feed) {
    const capability = orderFlowCapability(feed.market);
    if (!capability.available) { feed.state = 'unavailable'; feed.detail = capability.reason; return; }
    try {
      feed.instrument = await this.adapters.verify(feed.market); if (feed.stopped) return;
      try {
        await this.initStorage();
        const saved = await feed.checkpoint.load();
        if (feed.stopped) return;
        feed.trades = saved.trades.filter(t => flowKey(t) === flowKey(feed.market) && t.time >= Date.now() - 86_400_000).slice(-MAX_TRADES);
        feed.dirty = feed.trades.length !== saved.trades.length;
        feed.seen = new Set(feed.trades.map(t => t.id));
        if (feed.seen.size !== feed.trades.length) {
          feed.trades = [...new Map(feed.trades.map(trade => [trade.id, trade])).values()];
          feed.dirty = true;
        }
        if (feed.trades.some((trade, index, tape) => index > 0 && trade.time < tape[index - 1].time)) {
          feed.trades.sort((a, b) => a.time - b.time);
          feed.dirty = true;
        }
        feed.gaps = saved.gaps.slice(); feed.coverageFrom = saved.coverageFrom; feed.coverageTo = saved.coverageTo; feed.liquidations = saved.liquidations.slice();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') feed.detail = 'Local history unavailable; rebuilding from real recent trades'; }
      await this.poll(feed);
      if (feed.stopped) return;
      if (feed.market && !feed.stopped) feed.stop = this.adapters.stream(feed.market, feed.instrument, trade => {
        if (feed.stopped) return;
        this.insert(feed, [trade]); feed.lastWs = Date.now(); feed.state = 'live'; feed.detail = 'Verified trade frames received; REST overlap defines complete coverage';
        // REST coverage is authoritative. Socket receipt alone does not certify contiguous history.
      }, (state, detail) => { if (state === 'stale' || state === 'degraded') feed.state = 'stale'; else if (state === 'connecting') feed.state = 'connecting'; feed.detail = detail ?? ''; }, event => {
        if (feed.stopped) return;
        if (!feed.liquidations.some(e => e.id === event.id)) {
          feed.liquidations.push(event); feed.liquidations = feed.liquidations.slice(-1000);
          feed.dirty = true; this.archive?.('liquidation', event);
        }
        feed.liquidationState = 'partial feed · events observed';
      }, state => { feed.liquidationState = `${state} · venue-limited partial feed`; });
      feed.flush = setInterval(() => { void this.persist(feed); }, 15_000);
      const tick = async () => { if (feed.stopped) return; await this.poll(feed); if (!feed.stopped) feed.timer = setTimeout(() => void tick(), 5000); };
      feed.timer = setTimeout(() => void tick(), 5000);
    } catch (error) { feed.state = 'unavailable'; feed.detail = String(error); if (!feed.stopped) feed.timer = setTimeout(() => void this.start(feed), 30_000); }
  }
  private insert(feed: Feed, incoming: FlowTrade[]) {
    let reordered = false;
    for (const trade of incoming) { if (flowKey(trade) !== flowKey(feed.market) || feed.seen.has(trade.id)) continue; if ((feed.trades.at(-1)?.time ?? 0) > trade.time) reordered = true; feed.seen.add(trade.id); feed.trades.push(trade); feed.dirty = true; this.archive?.('trade', trade); }
    if (reordered) feed.trades.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    let remove = 0; const cutoff = Date.now() - 86_400_000;
    while (remove < feed.trades.length && feed.trades[remove].time < cutoff) remove++;
    const count = Math.max(remove, feed.trades.length - MAX_TRADES);
    if (count > 0) { for (const trade of feed.trades.splice(0, count)) feed.seen.delete(trade.id); feed.coverageFrom = Math.max(feed.coverageFrom ?? 0, (feed.trades[0]?.time ?? Date.now()) + 1); feed.dirty = true; }
  }
  private async poll(feed: Feed) {
    if (feed.loading || !feed.instrument || feed.stopped) return;
    feed.loading = true;
    try {
      const recent = await this.adapters.recent(feed.market, feed.instrument);
      if (feed.stopped) return;
      const latest = feed.coverageTo, first = recent[0]?.time ?? null, last = recent.at(-1)?.time ?? null;
      const previousFrom = feed.coverageFrom, previousGapCount = feed.gaps.length;
      if (latest != null && first != null && first > latest) {
        feed.gaps.push({ from: latest, to: first + 1, reason: 'Recent-trade limit did not overlap previous coverage. Unrecovered gap; CVD resets.' });
        feed.dirty = true;
      }
      if (first != null && last != null) feed.gaps = feed.gaps.filter(g => !(first <= g.from && last >= g.to));
      if (first != null) feed.coverageFrom = feed.coverageFrom == null ? first + 1 : Math.min(feed.coverageFrom, first + 1);
      if (last != null) feed.coverageTo = Math.max(feed.coverageTo ?? 0, last);
      this.insert(feed, recent); feed.gaps = feed.gaps.filter(g => g.to > Date.now() - 86_400_000).slice(-500);
      if (previousFrom !== feed.coverageFrom || latest !== feed.coverageTo || previousGapCount !== feed.gaps.length) feed.dirty = true;
      feed.checkedAt = Date.now(); feed.state = feed.lastWs != null && Date.now() - feed.lastWs < 30_000 ? 'live' : 'partial';
      if (!feed.lastWs) feed.detail = 'REST recent trades; bounded coverage, not a complete historical archive';
    } catch (error) { feed.state = 'stale'; feed.detail = String(error); }
    finally { feed.loading = false; }
  }
  /** 1s live display aggregate; separate from the persisted 1m/5m research buckets. */
  tick(project: MarketProject, at = Date.now(), windowMs = 1_000) {
    const feeds = [...new Map(project.markets.map(m => [flowKey(m), m])).values()]
      .map(m => this.feeds.get(flowKey(m))).filter((feed): feed is Feed => Boolean(feed));
    let buy = 0, sell = 0, spotDelta = 0, perpDelta = 0, trades = 0;
    for (const feed of feeds) for (const trade of feed.trades) {
      if (trade.time < at - windowMs) continue;
      const notional = trade.notional;
      if (trade.side === 'buy') buy += notional; else sell += notional;
      if (trade.marketType === 'spot') spotDelta += (trade.side === 'buy' ? notional : -notional);
      else perpDelta += (trade.side === 'buy' ? notional : -notional);
      trades += 1;
    }
    return { projectId: project.id, at, windowMs, buy, sell, delta: buy - sell, cvd: buy - sell, spotDelta, perpDelta, trades };
  }

  snapshot(project: MarketProject, interval: FlowInterval, reset: FlowReset, at = Date.now()): OrderFlowResponse {
    const times = timeGrid(at, interval);
    const markets = [...new Map(project.markets.map(m => [flowKey(m), m])).values()];
    // With collection paused there is no feed by design; reporting 'connecting' forever
    // made a disabled collector look like a network problem.
    const collectionPaused = !project.monitoring.streamingEnabled || project.monitoring.collectionMode === 'paused';
    const venues: FlowVenue[] = markets.map(market => {
      const key = flowKey(market), feed = this.feeds.get(key), capability = orderFlowCapability(market);
      return { key, market, state: feed ? feed.checkedAt != null && at - feed.checkedAt > 30_000 ? 'stale' : feed.state : collectionPaused ? 'unavailable' : capability.available ? 'connecting' : 'unavailable', transport: feed?.lastWs && at - feed.lastWs < 30_000 ? 'WebSocket + REST overlap recovery' : 'REST recent trades', lastTradeAt: feed?.trades.at(-1)?.time ?? null, checkedAt: feed?.checkedAt ?? null, coverageFrom: feed?.coverageFrom ?? null, coverageTo: feed?.coverageTo ?? null, gaps: feed?.gaps ?? [], buckets: flowBuckets(feed?.trades ?? [], interval, reset, times, { from: feed?.coverageFrom ?? null, to: feed?.coverageTo == null ? null : Math.min(at, feed.coverageTo), gaps: feed?.gaps ?? [] }, at), warnings: [capability.reason, collectionPaused ? 'Collection is paused/streaming disabled for this project; no trades are being ingested.' : '', feed?.detail ?? '', 'USDT quote notional; USD-equivalent convention only, no live USDT/USD conversion.', 'First/last buckets can be partial. CVD never fills unknown time with zero.'].filter(Boolean), retainedTrades: feed?.trades.length ?? 0 };
    });
    const aggregate = (type: 'spot' | 'perpetual') => {
      const group = venues.filter(v => v.market.marketType === type);
      return { requested: group.length, covered: group.filter(v => v.buckets.some(b => b.complete)).length, keys: group.map(v => v.key), buckets: aggregateFlow(group, times, interval, reset) };
    };
    const aggregates = { spot: aggregate('spot'), perpetual: aggregate('perpetual') };
    const feeds = markets.map(m => this.feeds.get(flowKey(m))).filter((feed): feed is Feed => Boolean(feed));
    const trades = latestTape(feeds, at);
    return {
      projectId: project.id, generatedAt: Date.now(), interval, reset, unit: 'USDT', venues, aggregates, trades,
      tradeClusters: clusterFlowTrades(trades), signals: flowDivergences(aggregates.spot.buckets, aggregates.perpetual.buckets, at),
      liquidations: feeds.flatMap(f => f.liquidations).filter(e => e.time <= at).sort((a, b) => b.time - a.time).slice(0, 200),
      liquidationCoverage: markets.filter(m => m.marketType === 'perpetual').map(m => ({
        exchange: m.exchange,
        symbol: m.symbol,
        state: LIQUIDATION_FEEDS.has(m.exchange) ? this.feeds.get(flowKey(m))?.liquidationState ?? 'not-subscribed' : 'unavailable',
        note: LIQUIDATION_FEEDS.has(m.exchange)
          ? `${m.exchange} public liquidation stream: venue-throttled and partial (aggregated/limited events). Silence is not evidence of no liquidation.`
          : 'No liquidation feed verified for this venue. Unavailable is not zero.',
      })),
      methodology: [
        'Spot and perpetual trades are separate ledgers. Deduplication key is venue + market type + symbol + native trade ID.',
        'Trade notional = price × base quantity; contract multipliers applied before arithmetic. USDT quoted markets only.',
        'Aggregates require every selected market in that market type to have a complete, aligned bucket. Unsupported/stale coverage is not replaced with zero.',
        'CVD resets at window/UTC hour/UTC day and after gaps. A missing full reset period means covered-segment CVD, not full-period CVD.',
        'Robust anomaly baseline: ≥20 prior completed buckets, MAD-scaled z-score. Divergence requires |z|≥2 for both aligned markets; hypotheses, not forecasts.',
        'Recent REST backfill is bounded. Up to 50,000 trades per market / 24h retained locally; longer history requires archival infrastructure.',
        'Tape clusters group same-venue/symbol/market/side prints in 2s windows; constituent native IDs are preserved. Binance aggTrade prints can already contain multiple fills upstream.'
      ]
    };
  }
}
