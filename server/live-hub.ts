import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { MarketProject } from '../shared/types.ts';
import { openExchangeStream } from './exchange-streams.ts';
import { openSpotFlowStream } from './orderflow-adapters.ts';
import { STRENGTH_WINDOW_MS } from '../shared/strength-history.ts';
import { QuoteReplay } from './quote-replay.ts';

export type LiveChannel = 'quotes' | 'flow' | 'edge' | 'depth';
export const LIVE_CHANNELS: LiveChannel[] = ['quotes', 'flow', 'edge', 'depth'];
export interface LiveFlow { projectId: string; at: number; windowMs: number; buy: number; sell: number; delta: number; cvd: number; spotDelta: number; perpDelta: number; trades: number }
export interface LiveTick { projectId: string; marketKey: string; symbol: string; price: number | null; priceAt: number | null; change24hPct: number | null; fundingRate: number | null; at: number; stale: boolean }

export function parseLiveEvent(payload: unknown, receivedAt: number): Omit<LiveTick, 'projectId' | 'marketKey' | 'symbol' | 'priceAt'> | null {
  const message = payload as { stream?: string; data?: Record<string, unknown> } | null;
  const data = message?.data ?? (payload as Record<string, unknown> | null);
  if (!data || typeof data !== 'object') return null;
  const num = (value: unknown) => {
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const trade = data.e === 'aggTrade' || data.e === 'trade';
  // Binance uses p for both the executed price of a trade and the mark in a funding frame.
  const quoted = num(data.c ?? data.lastPrice ?? data.price ?? (trade ? data.p : null));
  const price = quoted != null && quoted > 0 ? quoted : null;
  const change = num(data.P ?? data.priceChangePercent ?? data.change24hPct);
  const funding = num(data.r ?? data.lastFundingRate ?? data.fundingRate);
  if (price == null && change == null && funding == null) return null;
  const sourceAt = num(data.eventTime ?? data.time ?? (trade ? data.T ?? data.E : data.E));
  const at = sourceAt != null && sourceAt > 0 ? sourceAt : receivedAt;
  if (at > receivedAt + 5_000) return null;
  return { price, change24hPct: change, fundingRate: funding, at, stale: false };
}

interface Client { socket: WebSocket; projects: Set<string>; channels: Set<LiveChannel>; seq: Record<string, number>; alive: boolean }
interface Feed { stop: () => void; tick: LiveTick; replay: QuoteReplay; release?: NodeJS.Timeout }

export function createLiveHub(server: Server, projects: () => MarketProject[], options: { intervalMs?: number; flowTick?: (project: MarketProject, at: number) => LiveFlow; openPerpetualStream?: typeof openExchangeStream } = {}) {
  const wss = new WebSocketServer({ server, path: '/ws/live', maxPayload: 4_096 });
  const clients = new Set<Client>();
  const feeds = new Map<string, Feed>();
  const quotesEvery = options.intervalMs ?? 1_000;
  const edgeEvery = 5_000;
  const openPerpetualStream = options.openPerpetualStream ?? openExchangeStream;

  const send = (client: Client, payload: unknown) => {
    if (client.socket.readyState !== WebSocket.OPEN || client.socket.bufferedAmount > 1_000_000) return;
    client.socket.send(JSON.stringify(payload));
  };
  const flowsFor = (client: Client) => options.flowTick ? [...client.projects].map((id) => { const project = projects().find((item) => item.id === id); return project ? options.flowTick!(project, Date.now()) : null; }).filter((flow): flow is LiveFlow => Boolean(flow)) : [];
  const ticksFor = (client: Client) => [...client.projects].map((id) => feeds.get(id)?.tick).filter((tick): tick is LiveTick => Boolean(tick));
  const publish = (channel: LiveChannel) => {
    if (!clients.size) return;
    for (const client of clients) {
      if (!client.channels.has(channel)) continue;
      const ticks = ticksFor(client);
      if (!ticks.length) continue;
      client.seq[channel] = (client.seq[channel] ?? 0) + 1;
      send(client, { type: 'tick', channel, seq: client.seq[channel], asOf: Date.now(), ticks });
    }
  };
  const snapshot = (client: Client, channel: LiveChannel) => {
    client.seq[channel] = (client.seq[channel] ?? 0) + 1;
    if (channel === 'quotes') {
      const asOf = Date.now();
      const ticks = ticksFor(client);
      const replay = ticks.map(({ projectId, marketKey }) => ({
        projectId, marketKey, points: feeds.get(projectId)!.replay.window(asOf),
      }));
      send(client, { type: 'snapshot', channel, seq: client.seq[channel], asOf, ticks, replay });
      return;
    }
    if (channel === 'flow') send(client, { type: 'snapshot', channel, seq: client.seq[channel], asOf: Date.now(), flows: flowsFor(client) });
    else send(client, { type: 'snapshot', channel, seq: client.seq[channel], asOf: Date.now(), ticks: ticksFor(client) });
  };

  const publishFlow = () => {
    if (!clients.size || !options.flowTick) return;
    for (const client of clients) {
      if (!client.channels.has('flow')) continue;
      const flows = flowsFor(client);
      client.seq.flow = (client.seq.flow ?? 0) + 1;
      send(client, { type: 'tick', channel: 'flow', seq: client.seq.flow, asOf: Date.now(), flows });
    }
  };
  const timers = [setInterval(() => publish('quotes'), quotesEvery), setInterval(() => publish('edge'), edgeEvery), setInterval(publishFlow, quotesEvery)];
  timers.forEach((timer) => timer.unref?.());

  const ensureFeed = (project: MarketProject) => {
    const market = project.markets.find((item) => item.id === project.primaryMarketId) ?? project.markets[0];
    const key = market && `${market.exchange}:${market.marketType}:${market.symbol}`;
    const existing = feeds.get(project.id);
    if (existing && existing.tick.marketKey === key) return;
    clearTimeout(existing?.release);
    existing?.stop();
    feeds.delete(project.id);
    if (!market) return;
    const tick: LiveTick = { projectId: project.id, marketKey: key, symbol: market.symbol, price: null, priceAt: null, change24hPct: null, fundingRate: null, at: 0, stale: true };
    const replay = new QuoteReplay();
    const updatePrice = (price: number, at: number) => {
      // A delayed trade can fill an earlier bucket without moving the current quote backwards.
      replay.record(price, at, Date.now());
      if (tick.priceAt != null && at < tick.priceAt) return;
      tick.price = price;
      tick.priceAt = at;
      tick.at = Math.max(tick.at, at);
      tick.stale = false;
    };
    const onState = (state: string) => { if (state !== 'live') tick.stale = true; };
    let stop = () => {};
    try {
      if (market.marketType === 'spot') {
        stop = openSpotFlowStream(market, trade => updatePrice(trade.price, trade.time), onState);
      } else {
        stop = openPerpetualStream(market.exchange, market.symbol.toUpperCase(), (payload) => {
          const parsed = parseLiveEvent(payload, Date.now());
          if (!parsed) return;
          if (parsed.price != null) updatePrice(parsed.price, parsed.at);
          tick.change24hPct = parsed.change24hPct ?? tick.change24hPct;
          tick.fundingRate = parsed.fundingRate ?? tick.fundingRate;
          tick.at = Math.max(tick.at, parsed.at);
        }, onState);
      }
    } catch { /* unsupported venue */ }
    feeds.set(project.id, { stop, tick, replay });
  };

  // Keep collecting through a short browser disconnect, then dispose unused upstream sockets.
  const reconcileFeeds = () => {
    const needed = new Set<string>();
    for (const client of clients) if (client.channels.size) for (const id of client.projects) needed.add(id);
    for (const [id, feed] of feeds) {
      if (needed.has(id)) {
        clearTimeout(feed.release);
        feed.release = undefined;
      } else if (!feed.release) {
        feed.release = setTimeout(() => {
          if (feeds.get(id) !== feed) return;
          feeds.delete(id);
          feed.stop();
        }, STRENGTH_WINDOW_MS);
        feed.release.unref();
      }
    }
  };

  const syncClientFeeds = (client: Client, byId: Map<string, MarketProject>) => {
    for (const id of client.projects) {
      const project = byId.get(id);
      if (!project) client.projects.delete(id);
      else if (client.channels.size) ensureFeed(project);
    }
    reconcileFeeds();
  };

  wss.on('connection', (socket, request) => {
    const origin = request.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !/^https:\/\/ans\.y2k\.ventures$/.test(origin)) { socket.close(1008, 'origin'); return; }
    const client: Client = { socket, projects: new Set(), channels: new Set(), seq: {}, alive: true };
    clients.add(client);
    send(client, { type: 'hello', asOf: Date.now(), channels: LIVE_CHANNELS });
    socket.on('pong', () => { client.alive = true; });
    socket.on('message', (raw) => {
      const text = raw.toString();
      if (text.length > 4_096) return;
      let message: { op?: string; projects?: unknown; channels?: unknown; channel?: unknown };
      try { message = JSON.parse(text); } catch { return; }
      if (message.op === 'subscribe') {
        const byId = new Map(projects().map((project) => [project.id, project]));
        if (Array.isArray(message.projects)) client.projects = new Set(message.projects.filter((id): id is string => typeof id === 'string' && byId.has(id)).slice(0, 12));
        if (Array.isArray(message.channels)) client.channels = new Set(message.channels.filter((channel): channel is LiveChannel => LIVE_CHANNELS.includes(channel as LiveChannel)));
        syncClientFeeds(client, byId);
        for (const channel of client.channels) {
          if (channel === 'quotes' || channel === 'edge' || channel === 'flow') snapshot(client, channel);
          else send(client, { type: 'status', channel, state: 'UNAVAILABLE', reason: `${channel} live channel is not implemented yet` });
        }
      } else if (message.op === 'resync' && typeof message.channel === 'string' && LIVE_CHANNELS.includes(message.channel as LiveChannel)) {
        if (message.channel === 'quotes') syncClientFeeds(client, new Map(projects().map(project => [project.id, project])));
        snapshot(client, message.channel as LiveChannel);
      }
    });
    socket.on('close', () => {
      clients.delete(client);
      reconcileFeeds();
    });
    socket.on('error', () => undefined);
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) { client.socket.terminate(); clients.delete(client); continue; }
      client.alive = false;
      try { client.socket.ping(); } catch { /* ignore */ }
    }
  }, 30_000);
  heartbeat.unref?.();
  return () => {
    timers.forEach((timer) => clearInterval(timer));
    clearInterval(heartbeat);
    for (const feed of feeds.values()) { clearTimeout(feed.release); feed.stop(); }
    feeds.clear();
    for (const client of clients) client.socket.terminate();
    clients.clear();
    wss.close();
  };
}
