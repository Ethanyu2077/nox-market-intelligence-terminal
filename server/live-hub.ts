import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { MarketProject } from '../shared/types.ts';
import { openExchangeStream } from './exchange-streams.ts';

export interface LiveTick { projectId: string; symbol: string; price: number | null; change24hPct: number | null; fundingRate: number | null; at: number; stale: boolean }

/** Only parser shape kept pure for tests; venue-specific payloads degrade to null. */
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

interface Client { socket: WebSocket; projects: Set<string>; seq: number }
interface Feed { stop: () => void; tick: LiveTick }

export function createLiveHub(server: Server, projects: () => MarketProject[], options: { intervalMs?: number } = {}) {
  const wss = new WebSocketServer({ server, path: '/ws/live', maxPayload: 4_096 });
  const clients = new Set<Client>();
  const feeds = new Map<string, Feed>();
  const timer = setInterval(() => {
    if (!clients.size) return;
    for (const client of clients) {
      if (client.socket.readyState !== WebSocket.OPEN || client.socket.bufferedAmount > 1_000_000) continue;
      const ticks = [...client.projects].map((id) => feeds.get(id)?.tick).filter(Boolean);
      if (!ticks.length) continue;
      client.seq += 1;
      client.socket.send(JSON.stringify({ type: 'tick', seq: client.seq, asOf: Date.now(), ticks }));
    }
  }, options.intervalMs ?? 1_000);
  timer.unref?.();

  const ensureFeed = (project: MarketProject) => {
    if (feeds.has(project.id)) return;
    const market = project.markets.find((item) => item.id === project.primaryMarketId) ?? project.markets[0];
    if (!market) return;
    const tick: LiveTick = { projectId: project.id, symbol: market.symbol, price: null, change24hPct: null, fundingRate: null, at: null as unknown as number, stale: true };
    let stop = () => {};
    try {
      stop = openExchangeStream(market.exchange, market.symbol.toUpperCase(), (payload) => {
        const parsed = parseLiveEvent(payload, Date.now());
        if (!parsed) return;
        tick.price = parsed.price ?? tick.price; tick.change24hPct = parsed.change24hPct ?? tick.change24hPct;
        tick.fundingRate = parsed.fundingRate ?? tick.fundingRate; tick.at = parsed.at; tick.stale = false;
      }, (state) => { tick.stale = state !== 'live'; });
    } catch { /* unsupported venue: keep stale feed */ }
    feeds.set(project.id, { stop, tick });
  };

  const sendSnapshot = (client: Client) => {
    const ticks = [...client.projects].map((id) => feeds.get(id)?.tick).filter(Boolean);
    client.seq += 1;
    client.socket.send(JSON.stringify({ type: 'snapshot', seq: client.seq, asOf: Date.now(), ticks }));
  };

  wss.on('connection', (socket, request) => {
    const origin = request.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !/^https:\/\/ans\.y2k\.ventures$/.test(origin)) { socket.close(1008, 'origin'); return; }
    const client: Client = { socket, projects: new Set(), seq: 0 };
    clients.add(client);
    socket.send(JSON.stringify({ type: 'hello', seq: 0, asOf: Date.now() }));
    socket.on('message', (raw) => {
      const text = raw.toString();
      if (text.length > 4_096) return;
      let message: { op?: string; projects?: unknown };
      try { message = JSON.parse(text); } catch { return; }
      if (message.op !== 'subscribe' || !Array.isArray(message.projects)) return;
      const byId = new Map(projects().map((project) => [project.id, project]));
      client.projects = new Set(message.projects.filter((id): id is string => typeof id === 'string' && byId.has(id)).slice(0, 12));
      for (const id of client.projects) ensureFeed(byId.get(id)!);
      sendSnapshot(client);
    });
    socket.on('close', () => {
      clients.delete(client);
      const stillNeeded = new Set([...clients].flatMap((item) => [...item.projects]));
      for (const [id, feed] of feeds) if (!stillNeeded.has(id)) { feed.stop(); feeds.delete(id); }
    });
    socket.on('error', () => undefined);
  });

  const heartbeat = setInterval(() => { for (const client of clients) if (client.socket.readyState === WebSocket.OPEN) client.socket.ping(); }, 30_000);
  heartbeat.unref?.();
  return () => { clearInterval(timer); clearInterval(heartbeat); for (const feed of feeds.values()) feed.stop(); wss.close(); };
}
