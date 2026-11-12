import type { MarketProject, ProjectMarket } from '../shared/types.ts';
import { BUCKET, performance, type WatchRow, type WatchOverview } from '../shared/watch-overview.ts';
const entries=new Map<string,{at:number;promise:Promise<WatchRow>}>();
async function candles(market:ProjectMarket,projectId:string,end:number,klines:{get:(symbol:string,interval:string,limit:number,end:number)=>Promise<Array<{time:number;close:number;volume:number}>>}):Promise<WatchRow>{
  const key=JSON.stringify([market.exchange,market.marketType,market.symbol,end]);
  let entry=entries.get(key);
  if(!entry || Date.now()-entry.at>60_000){
    const promise=(async()=>{
      const row:WatchRow={projectId:'',venue:market.exchange,symbol:market.symbol,marketType:market.marketType,quote:market.quote,candles:[],error:null};
      try{
        if(!['binance','aster'].includes(market.exchange) || (market.exchange==='aster' && market.marketType==='spot')) throw new Error('Candle coverage unavailable for this market');
        const spot=market.marketType==='spot';
        if(market.exchange==='binance' && !spot){
          // Incremental candles over WebSocket; REST only bootstraps through the governor.
          row.candles=(await klines.get(market.symbol,'5m',320,end)).map(c=>({time:c.time,close:c.close,volume:c.volume}));
          if(!row.candles.length) throw new Error('No closed candles returned');
          try{
            const fundingUrl=new URL('/fapi/v1/fundingRate',process.env.BINANCE_REST_BASE??'https://fapi.binance.com');
            fundingUrl.search=new URLSearchParams({symbol:market.symbol,limit:'2'}).toString();
            const history=await binanceGovernor.json<Array<{fundingTime:number;fundingRate:string}>>(fundingUrl.toString());
            if(Array.isArray(history)&&history.length===2){const time=Number(history[1].fundingTime),hours=Math.round((time-Number(history[0].fundingTime))/3_600_000*100)/100,rate=Number(history[1].fundingRate);if(Number.isFinite(rate)&&hours>0&&hours<=24&&time<=Date.now()&&Date.now()-time<24*3_600_000)row.funding={rate,hours,time};}
          }catch{row.funding=null;}
          return row;
        }
        const base=market.exchange==='aster' ? (process.env.ASTER_REST_BASE ?? 'https://fapi.asterdex.com') : spot ? 'https://api.binance.com' : (process.env.BINANCE_REST_BASE ?? 'https://fapi.binance.com');
        const url=new URL(spot?'/api/v3/klines':'/fapi/v1/klines',base);
        url.search=new URLSearchParams({symbol:market.symbol,interval:'5m',limit:'320',endTime:String(end-1)}).toString();
        const response=await fetch(url,{signal:AbortSignal.timeout(9000)});
        if(!response.ok) throw new Error(`Market source HTTP ${response.status}`);
        const raw:unknown=await response.json(); if(!Array.isArray(raw)) throw new Error('Invalid candle response');
        row.candles=raw.filter((p:unknown)=>Array.isArray(p)&&Number(p[6])<end).map((p:unknown[])=>({time:Number(p[0])+BUCKET,close:Number(p[4]),volume:Number(p[7])})).filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.close)&&p.close>0&&Number.isFinite(p.volume)&&p.volume>=0).sort((a,b)=>a.time-b.time);
        if(!row.candles.length) throw new Error('No closed candles returned');
        if(!spot){
          try {
            const fundingUrl=new URL('/fapi/v1/fundingRate',base);
            fundingUrl.search=new URLSearchParams({symbol:market.symbol,limit:'2'}).toString();
            const result=await fetch(fundingUrl,{signal:AbortSignal.timeout(4000)});
            const history:unknown=result.ok?await result.json():null;
            if(Array.isArray(history) && history.length===2){
              const time=Number(history[1].fundingTime),hours=Math.round((time-Number(history[0].fundingTime))/3_600_000*100)/100,rate=Number(history[1].fundingRate);
              if(Number.isFinite(rate)&&hours>0&&hours<=24&&time<=Date.now()&&Date.now()-time<24*3_600_000) row.funding={rate,hours,time};
            }
          }catch { row.funding=null; }
        }
      }catch(error){row.error=error instanceof Error?error.message:'Market source unavailable';}
      return row;
    })();
    entry={at:Date.now(),promise};entries.set(key,entry);
    if(entries.size>300) for(const [k,v] of entries) if(Date.now()-v.at>60_000) entries.delete(k);
  }
  return {...await entry.promise,projectId};
}
import type { OrderFlowService } from './orderflow-service.ts';
import type { HistoryStore } from './history-store.ts';
import type { WatchFlow } from '../shared/watch-overview.ts';
import { buildWatchMetrics } from '../shared/watch-overview.ts';
import { binanceKlineStream } from './binance-kline-stream.ts';
import { snapshotPrices } from './price-history.ts';
import { binanceGovernor } from './binance-governor.ts';

function flowOf(service: OrderFlowService | undefined, project: MarketProject, end: number, start: number): WatchFlow | null {
  if (!service) return null;
  try {
    const snapshot = service.snapshot(project, '5m', 'window', end);
    const perp = snapshot.aggregates.perpetual;
    const sum = (rows: Array<{ buy: number | null; sell: number | null; delta: number | null }>, key: 'buy' | 'sell' | 'delta') => {
      const values = rows.map((row) => row[key]).filter((value): value is number => value != null && Number.isFinite(value));
      return values.length ? values.reduce((total, value) => total + value, 0) : null;
    };
    // Aggregate buckets are null unless every requested venue is covered; per-venue buckets
    // still carry real trades. Sum those and expose coverage separately instead of hiding data.
    const perpVenues = snapshot.venues.filter((venue) => venue.market.marketType === 'perpetual');
    const spotVenues = snapshot.venues.filter((venue) => venue.market.marketType !== 'perpetual');
    const perpBuckets = [...snapshot.venues.filter((venue) => venue.market.marketType === 'perpetual')
      .flatMap((venue) => venue.buckets).filter((row) => row.time >= start && row.time <= end).reduce((map, row) => {
        if (row.buy == null && row.sell == null && row.delta == null) return map;
        const current = map.get(row.time) ?? { time: row.time, buy: 0, sell: 0, delta: 0 };
        current.buy += row.buy ?? 0; current.sell += row.sell ?? 0; current.delta += row.delta ?? 0;
        map.set(row.time, current); return map;
      }, new Map<number, { time: number; buy: number; sell: number; delta: number }>()).values()]
      .sort((a, b) => a.time - b.time);
    let runningCvd = 0;
    const perpBucketsWithCvd = perpBuckets.map((row) => ({ ...row, cvd: (runningCvd += row.delta) }));
    return {
      buy: sum(perpBuckets, 'buy'), sell: sum(perpBuckets, 'sell'), delta: sum(perpBuckets, 'delta'),
      cvd: perpBucketsWithCvd.at(-1)?.cvd ?? null, spotDelta: sum(spotVenues.flatMap((venue) => venue.buckets).filter((row) => row.time >= start && row.time <= end), 'delta'),
      perpDelta: sum(perpVenues.flatMap((venue) => venue.buckets).filter((row) => row.time >= start && row.time <= end), 'delta'),
      buckets: perpBucketsWithCvd,
      venues: snapshot.venues.map((venue) => {
        const sum = (key: 'buy' | 'sell' | 'delta') => {
          const values = venue.buckets.map((row) => row[key]).filter((value): value is number => value != null && Number.isFinite(value));
          return values.length ? values.reduce((total, value) => total + value, 0) : null;
        };
        return { exchange: venue.market.exchange, marketType: venue.market.marketType, buy: sum('buy'), sell: sum('sell'), delta: sum('delta') };
      }).filter((venue) => venue.buy != null || venue.sell != null || venue.delta != null),
      covered: perp.covered, requested: perp.requested, source: 'orderflow',
    };
  } catch { return null; }
}

async function oiSeriesOf(store: HistoryStore | undefined, project: MarketProject, end: number, row: WatchRow): Promise<Array<{ time: number; oiUsd: number }> | undefined> {
  if (!store) return undefined;
  const primary = project.markets.find((market) => market.id === project.primaryMarketId) ?? project.markets[0];
  if (!primary) return undefined;
  try {
    const events = await store.read(project.id, 'snapshot', end, 2_000);
    const buckets = new Map<number, number>();
    const prices: {t: number; p: number}[] = [];
    for (const event of events) {
      const payload = event.payload as { exchange?: string; symbol?: string; marketType?: string; price?: number; oiUsd?: number | null; eventTime?: number };
      if (payload.exchange !== primary.exchange || payload.symbol !== primary.symbol) continue;
      if (payload.marketType === primary.marketType && payload.price != null && Number.isFinite(payload.price) && payload.price > 0 &&
          event.eventTime >= end - 86_400_000 && event.quality !== 'stale' && event.quality !== 'unavailable')
        prices.push({t: event.eventTime, p: payload.price});
      if (payload.oiUsd == null || !Number.isFinite(payload.oiUsd)) continue;
      const time = Math.floor((event.eventTime ?? payload.eventTime ?? 0) / 300_000) * 300_000;
      if (time > 0) buckets.set(time, payload.oiUsd);
    }
    snapshotPrices.set(row, prices);
    const series = [...buckets.entries()].map(([time, oiUsd]) => ({ time, oiUsd })).sort((a, b) => a.time - b.time);
    return series.length >= 2 ? series.slice(-288) : undefined;
  } catch { return undefined; }
}

export async function watchOverview(projects:MarketProject[], orderFlow?: OrderFlowService, history?: HistoryStore, klines:{get:(symbol:string,interval:string,limit:number,end:number)=>Promise<Array<{time:number;close:number;volume:number}>>} = binanceKlineStream, minutes = 60):Promise<WatchOverview>{
  const asOf=Date.now(),end=Math.floor(asOf/BUCKET)*BUCKET;
  const start=end-Math.max(5,Math.min(1440,Math.round(minutes)))*60_000;
  const active=projects.filter(p=>!p.archived && p.monitoring.collectionMode!=='paused');
  const rows:WatchRow[]=[];
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(3,active.length)},async()=>{
    while(cursor<active.length){const p=active[cursor++];const market=p.markets.find(m=>m.id===p.primaryMarketId)??p.markets[0];
      const row = market ? await candles(market, p.id, end, klines) : {projectId:p.id,venue:'',symbol:'',marketType:'',quote:'',candles:[],error:'No primary market'};
      if (market) {
        row.collectionMode = p.monitoring.collectionMode;
        row.hasSpot = p.markets.some((m) => m.marketType === 'spot');
        row.hasPerp = p.markets.some((m) => m.marketType === 'perpetual');
        row.flow = flowOf(orderFlow, p, end, start);
        row.oiSeries = await oiSeriesOf(history, p, end, row);
        row.metrics = buildWatchMetrics(row);
      }
      rows.push(row);
    }
  }));
  const benchmarks=active.length?await Promise.all(['BTCUSDT','ETHUSDT'].map(symbol=>candles({id:symbol,exchange:'binance',marketType:'perpetual',symbol,base:symbol.slice(0,-4),quote:'USDT',status:'active'} as ProjectMarket,symbol,end,klines))):[];
  return {asOf,end,rows,benchmarks};
}

/** Minute closes are shared in the stream's bounded RAM buffer.
 * Attach them to this response only, after reading the regular overview cache. */
export async function withMinuteCloses(
  overview: WatchOverview, projectIds: readonly string[], benchmark: string | undefined, minutes: number,
  stream: Pick<typeof binanceKlineStream, 'get'> = binanceKlineStream, now = Date.now(),
): Promise<WatchOverview> {
  const end = Math.floor(now / 60_000) * 60_000;
  const seedMinutes = Math.min(60, minutes);
  const selected: WatchRow[] = [];
  if (minutes <= 60) {
    if (projectIds.length) {
      const ids = new Set(projectIds.slice(0, 4));
      selected.push(...overview.rows.filter(row => ids.has(row.projectId)));
    } else {
      const ranked = overview.rows.map(row => ({ row, value: performance(row.candles, overview.end, minutes) ?? -Infinity }));
      selected.push(...ranked.sort((a, b) => b.value - a.value).slice(0, 4).map(item => item.row));
    }
  }
  const reference = overview.benchmarks.find(row => row.projectId === benchmark);
  if (reference) selected.push(reference);
  const supported = (row: WatchRow) => row.venue === 'binance' && row.marketType === 'perpetual' && row.symbol;
  const start = end - seedMinutes * 60_000;
  const needsSeed = (row: WatchRow) => {
    if (!row.priceHistory?.length) return true;
    const covered = new Set(row.priceHistory.filter(point => point.t > start && point.t <= end && point.p > 0)
      .map(point => Math.ceil(point.t / 60_000)));
    return covered.size < seedMinutes;
  };
  const symbols = new Set(selected.filter(row => supported(row) && needsSeed(row)).map(row => row.symbol));
  if (!symbols.size) return overview;
  const closes = new Map<string, NonNullable<WatchRow['minuteCloses']>>();
  const pending = Promise.all([...symbols].map(async symbol => {
    try {
      const candles = await stream.get(symbol, '1m', seedMinutes + 1, end);
      if (candles.length) closes.set(symbol, candles.map(({ time, close }) => ({ time, close })));
    } catch { /* Existing five-minute closes remain available when the minute feed is offline. */ }
  }));
  // If the exchange is slow on first open, serve the original chart while its seed warms.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, 1_200); })]);
  } finally { clearTimeout(timer); }
  const attach = (row: WatchRow): WatchRow => {
    const minuteCloses = supported(row) ? closes.get(row.symbol) : undefined;
    return minuteCloses ? { ...row, minuteCloses } : row;
  };
  return { ...overview, rows: overview.rows.map(attach), benchmarks: overview.benchmarks.map(attach) };
}
