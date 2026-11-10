import type { MarketProject, ProjectMarket } from '../shared/types.ts';
import { BUCKET, type WatchRow, type WatchOverview } from '../shared/watch-overview.ts';
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
import { binanceKlineStream } from './binance-kline-stream.ts';
import { binanceGovernor } from './binance-governor.ts';

function flowOf(service: OrderFlowService | undefined, project: MarketProject, end: number): WatchFlow | null {
  if (!service) return null;
  try {
    const snapshot = service.snapshot(project, '5m', 'window', end);
    const perp = snapshot.aggregates.perpetual, spot = snapshot.aggregates.spot;
    const sum = (rows: typeof perp.buckets, key: 'buy' | 'sell' | 'delta') => {
      const values = rows.map((row) => row[key]).filter((value): value is number => value != null && Number.isFinite(value));
      return values.length ? values.reduce((total, value) => total + value, 0) : null;
    };
    const perpBuckets = perp.buckets.map((row) => ({ time: row.time, buy: row.buy, sell: row.sell, delta: row.delta, cvd: row.cvd }));
    const lastCvd = [...perp.buckets].reverse().find((row) => row.cvd != null)?.cvd ?? null;
    return {
      buy: sum(perp.buckets, 'buy'), sell: sum(perp.buckets, 'sell'), delta: sum(perp.buckets, 'delta'),
      cvd: lastCvd, spotDelta: sum(spot.buckets, 'delta'), perpDelta: sum(perp.buckets, 'delta'),
      buckets: perpBuckets,
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

async function oiSeriesOf(store: HistoryStore | undefined, project: MarketProject, end: number): Promise<Array<{ time: number; oiUsd: number }> | undefined> {
  if (!store) return undefined;
  const primary = project.markets.find((market) => market.id === project.primaryMarketId) ?? project.markets[0];
  if (!primary) return undefined;
  try {
    const events = await store.read(project.id, 'snapshot', end, 2_000);
    const buckets = new Map<number, number>();
    for (const event of events) {
      const payload = event.payload as { exchange?: string; symbol?: string; oiUsd?: number | null; eventTime?: number };
      if (payload.exchange !== primary.exchange || payload.symbol !== primary.symbol) continue;
      if (payload.oiUsd == null || !Number.isFinite(payload.oiUsd)) continue;
      const time = Math.floor((event.eventTime ?? payload.eventTime ?? 0) / 300_000) * 300_000;
      if (time > 0) buckets.set(time, payload.oiUsd);
    }
    const series = [...buckets.entries()].map(([time, oiUsd]) => ({ time, oiUsd })).sort((a, b) => a.time - b.time);
    return series.length >= 2 ? series.slice(-288) : undefined;
  } catch { return undefined; }
}

export async function watchOverview(projects:MarketProject[], orderFlow?: OrderFlowService, history?: HistoryStore, klines:{get:(symbol:string,interval:string,limit:number,end:number)=>Promise<Array<{time:number;close:number;volume:number}>>} = binanceKlineStream):Promise<WatchOverview>{
  const asOf=Date.now(),end=Math.floor(asOf/BUCKET)*BUCKET;
  const active=projects.filter(p=>!p.archived && p.monitoring.collectionMode!=='paused');
  const rows:WatchRow[]=[];
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(3,active.length)},async()=>{
    while(cursor<active.length){const p=active[cursor++];const market=p.markets.find(m=>m.id===p.primaryMarketId)??p.markets[0];
      const row = market ? await candles(market, p.id, end, klines) : {projectId:p.id,venue:'',symbol:'',marketType:'',quote:'',candles:[],error:'No primary market'};
      rows.push(market ? { ...row, flow: flowOf(orderFlow, p, end), oiSeries: await oiSeriesOf(history, p, end) } : row);
    }
  }));
  const benchmarks=active.length?await Promise.all(['BTCUSDT','ETHUSDT'].map(symbol=>candles({id:symbol,exchange:'binance',marketType:'perpetual',symbol,base:symbol.slice(0,-4),quote:'USDT',status:'active'} as ProjectMarket,symbol,end,klines))):[];
  return {asOf,end,rows,benchmarks};
}
