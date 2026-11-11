import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { MarketProject } from '../shared/types.ts';
import { openExchangeStream } from './exchange-streams.ts';

export type LiveChannel = 'quotes' | 'flow' | 'edge' | 'depth';
export const LIVE_CHANNELS: LiveChannel[] = ['quotes', 'flow', 'edge', 'depth'];
export interface LiveTick { projectId: string; symbol: string; price: number | null; change24hPct: number | null; fundingRate: number | null; at: number; stale: boolean }

export function parseLiveEvent(payload: unknown, at: number): Omit<LiveTick, 'projectId' | 'symbol'> | null {
  const message = payload as { stream?: string; data?: Record<string, unknown> } | null;
  const data = message?.data ?? (payload as Record<string, unknown> | null);
  if (!data || typeof data !== 'object') return null;
  const num = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
  const price = num(data.c ?? data.lastPrice ?? data.p);
  const change = num(data.P ?? data.priceChangePercent);
  const funding = num(data.r ?? data.lastFundingRate);
  if (price == null && change == null && funding == null) return null;
  return { price, change24hPct: change, fundingRate: funding, at, stale: false };
}

interface Client { socket: WebSocket; projects: Set<string>; channels: Set<LiveChannel>; seq: Record<string, number>; alive: boolean }
interface Feed { stop: () => void; tick: LiveTick }

export function createLiveHub(server: Server, projects: () => MarketProject[], options: { intervalMs?: number } = {}) {
  const wss = new WebSocketServer({ server, path: '/ws/live', maxPayload: 4_096 });
  const clients = new Set<Client>();
  const feeds = new Map<string, Feed>();
  const quotesEvery = options.intervalMs ?? 1_000;
  const edgeEvery = 5_000;

  const send = (client: Client, payload: unknown) => {
    if (client.socket.readyState !== WebSocket.OPEN || client.socket.bufferedAmount > 1_000_000) return;
    client.socket.send(JSON.stringify(payload));
  };
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
    send(client, { type: 'snapshot', channel, seq: client.seq[channel], asOf: Date.now(), ticks: ticksFor(client) });
  };

  const timers = [setInterval(() => publish('quotes'), quotesEvery), setInterval(() => publish('edge'), edgeEvery)];
  timers.forEach((timer) => timer.unref?.());

  const ensureFeed = (project: MarketProject) => {
    if (feeds.has(project.id)) return;
    const market = project.markets.find((item) => item.id === project.primaryMarketId) ?? project.markets[0];
    if (!market) return;
    const tick: LiveTick = { projectId: project.id, symbol: market.symbol, price: null, change24hPct: null, fundingRate: null, at: 0, stale: true };
    let stop = () => {};
    try {
      stop = openExchangeStream(market.exchange, market.symbol.toUpperCase(), (payload) => {
        const parsed = parseLiveEvent(payload, Date.now());
        if (!parsed) return;
        tick.price = parsed.price ?? tick.price;
        tick.change24hPct = parsed.change24hPct ?? tick.change24hPct;
        tick.fundingRate = parsed.fundingRate ?? tick.fundingRate;
        tick.at = parsed.at; tick.stale = false;
      }, (state) => { tick.stale = state !== 'live'; });
    } catch { /* unsupported venue */ }
    feeds.set(project.id, { stop, tick });
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
        for (const id of client.projects) ensureFeed(byId.get(id)!);
        for (const channel of client.channels) {
          if (channel === 'quotes' || channel === 'edge') snapshot(client, channel);
          else send(client, { type: 'status', channel, state: 'UNAVAILABLE', reason: `${channel} live channel is not implemented yet` });
        }
      } else if (message.op === 'resync' && typeof message.channel === 'string' && LIVE_CHANNELS.includes(message.channel as LiveChannel)) {
        snapshot(client, message.channel as LiveChannel);
      }
    });
    socket.on('close', () => {
      clients.delete(client);
      const needed = new Set([...clients].flatMap((item) => [...item.projects]));
      for (const [id, feed] of feeds) if (!needed.has(id)) { feed.stop(); feeds.delete(id); }
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
  return () => { timers.forEach((timer) => clearInterval(timer)); clearInterval(heartbeat); for (const feed of feeds.values()) feed.stop(); wss.close(); };
}
