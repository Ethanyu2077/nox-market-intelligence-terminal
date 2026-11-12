import { hasMarketStream } from '../shared/market-live.ts';
import { openSpotFlowStream, orderFlowCapability } from './orderflow-adapters.ts';
import type { MarketConnection, MarketFrame, MarketQuote, TapePrint } from '../shared/market-live.ts';
import type { LiveSource } from '../shared/live-channel.ts';
import type { ExchangeId, MarketProject } from '../shared/types.ts';
import { openExchangeStream } from './exchange-streams.ts';

type Viewer = { projectId: string; emit: (value: MarketFrame) => void; unavailable: () => void };
type Feed = { viewers: Set<Viewer>; publish: (projects: MarketProject[]) => void; stop: () => void };
const MAX_PENDING_TRADES = 8192;

export function createMarketChannel(projects: () => MarketProject[], dial = openExchangeStream, cadenceMs = 1000, dialSpot = openSpotFlowStream): LiveSource {
  const feeds = new Map<string, Feed>();
  let clock: NodeJS.Timeout | undefined;
  function eligible(project: MarketProject | undefined, exchange: string, symbol: string, marketType: string) {
    return project && !project.archived && project.monitoring.streamingEnabled && project.monitoring.collectionMode !== 'paused' &&
      project.markets.find(market => market.exchange === exchange && market.symbol === symbol && market.marketType === marketType);
  }
  return ({projectId, exchange, symbol, marketType}, emit, unavailable) => {
    const market = eligible(projects().find(p => p.id === projectId), exchange, symbol, marketType);
    if (!market || (marketType !== 'perpetual' && marketType !== 'spot') || !hasMarketStream(exchange, marketType) ||
        (marketType === 'spot' && !orderFlowCapability(market).available)) {
      unavailable(); return () => {};
    }
    const key = exchange + ':' + marketType + ':' + symbol;
    let feed = feeds.get(key);
    if (!feed) {
      if (feeds.size >= 64) { unavailable(); return () => {}; }
      const viewers = new Set<Viewer>();
      let quote: MarketQuote = {}, trades: TapePrint[] = [];
      let state: MarketConnection = 'connecting', dirty = true, lastId = -1;
      const publish = (watched: MarketProject[]) => {
        for (const viewer of viewers) if (!eligible(watched.find(p => p.id === viewer.projectId), exchange, symbol, marketType)) viewer.unavailable();
        if (!dirty) return;
        const frame: MarketFrame = {exchange: exchange as ExchangeId, marketType, symbol, state, quote, trades};
        for (const viewer of viewers) viewer.emit(frame);
        dirty = false; quote = {}; trades = [];
      };
      const set = (field: keyof MarketQuote, raw: unknown, at: number) => {
        if ((typeof raw !== 'number' && !(typeof raw === 'string' && raw.trim())) || !Number.isFinite(Number(raw))) return;
        if ((field === 'price' || field === 'markPrice') && Number(raw) <= 0) return;
        if ((quote[field]?.at ?? 0) > at) return;
        quote[field] = {value: Number(raw), at}; dirty = true;
      };
      const onState = (value: string) => {
        if (value === 'live' || value === 'connecting' || value === 'degraded' || value === 'stale') {
          state = value;
          dirty = true;
        }
      };
      const release = marketType === 'spot'
        ? dialSpot(market, trade => set('price', trade.price, trade.time), onState)
        : dial(exchange as ExchangeId, symbol, payload => {
        const wrapper = payload as {exchange?: string; transport?: string; data?: Record<string, unknown>};
        const row = wrapper?.data;
        if (!row || (wrapper.exchange && wrapper.exchange !== exchange) || (row.s && row.s !== symbol)) return;
        const at = Number(row.e === 'aggTrade' ? row.T : row.eventTime ?? row.time ?? row.E);
        if (!Number.isSafeInteger(at) || at <= 0 || at > Date.now() + 5000) return;
        if (row.e === 'aggTrade') {
          const id = Number(row.a), price = Number(row.p), size = Number(row.q);
          if (!Number.isSafeInteger(id) || id <= lastId || !Number.isFinite(price * size) || price <= 0 || size <= 0 || typeof row.m !== 'boolean') return;
          lastId = id;
          set('price', price, at); trades.push([id, at, (row.m ? -1 : 1) * price * size]);
          // Bound memory even under bursts. Deliver a full buffer instead of discarding flow.
          if (trades.length >= MAX_PENDING_TRADES) publish(projects());
        } else if (row.e === '24hrTicker') {
          set('price', row.c, at); set('change24hPct', row.P, at); set('volume24hBase', row.v, at); set('volume24hUsd', row.q, at);
        } else if (row.e === 'markPriceUpdate') {
          set('markPrice', row.p, at); set('fundingRate', row.r, at); set('nextFundingTime', row.T, at);
        } else {
          set('price', row.price, at); set('markPrice', row.markPrice, at); set('fundingRate', row.fundingRate, at);
          set('nextFundingTime', row.nextFundingTime, at); set('change24hPct', row.change24hPct, at);
          set('volume24hBase', row.volumeBase, at); set('volume24hUsd', row.volumeUsd, at);
          set('oiBase', row.oiBase, at); set('oiUsd', row.oiUsd, at);
        }
        if (wrapper.transport === 'rest-fallback') state = 'degraded';
      }, onState);
      feed = { viewers, publish, stop: release };
      feeds.set(key, feed);
      clock ??= setInterval(() => {
        const watched = projects();
        for (const entry of feeds.values()) entry.publish(watched);
      }, cadenceMs).unref();
    }
    const viewer = {projectId, emit, unavailable}, current = feed;
    current.viewers.add(viewer);
    return () => {
      if (current.viewers.delete(viewer) && !current.viewers.size) {
        feeds.delete(key);
        current.stop();
        if (!feeds.size) { clearInterval(clock); clock = undefined; }
      }
    };
  };
}
