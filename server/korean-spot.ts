import type {Instrument,MarketProject,ProjectMarket} from '../shared/types.ts';
import type {KoreanSpotResponse,KoreanSpotSnapshot,KoreanVenue} from '../shared/korean-spot.ts';
const ORIGINS={upbit:'https://api.upbit.com',bithumb:'https://api.bithumb.com'} as const;
const row=(v:unknown):Record<string,unknown>=>v!=null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const numeric=(v:unknown)=>{if((typeof v!=='number'&&typeof v!=='string')||(typeof v==='string'&&!v.trim()))return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const positive=(v:unknown)=>{const n=numeric(v);return n!=null&&n>=0?n:null;};
const time=(v:unknown,now:number)=>{const n=numeric(v);return n!=null&&n>=1e12&&n<=now+5000?n:null;};
export function koreanBaseSymbol(query:string){
  const upper=query.trim().toUpperCase();
  const prefix=upper.match(/^KRW[-/_]([A-Z0-9]+)$/),suffix=upper.match(/^([A-Z0-9]+)[-/_]KRW$/);
  return prefix?.[1]??suffix?.[1]??null;
}
export function normalizeKoreanCatalog(venue:KoreanVenue,data:unknown):Instrument[]{
  if(!Array.isArray(data))throw new Error('invalid-market-catalog');
  const seen=new Set<string>();
  return data.flatMap(value=>{
    const r=row(value),symbol=typeof r.market==='string'?r.market:'';
    if(!/^KRW-[A-Z0-9]+$/.test(symbol)||seen.has(symbol))return [];
    seen.add(symbol);return [{id:`${venue}:spot:${symbol}`,venue,marketType:'spot',nativeSymbol:symbol,base:symbol.slice(4),quote:'KRW',settlement:'KRW',contractType:'SPOT',status:'listed',tickSize:0,stepSize:0}];
  });
}
export function normalizeKoreanSpot(market:ProjectMarket,ticker:unknown,book:unknown,now=Date.now()):KoreanSpotSnapshot{
  if(!['upbit','bithumb'].includes(market.exchange)||market.marketType!=='spot'||market.quote!=='KRW'||market.symbol!==`KRW-${market.base}`)throw new Error('unsupported-market-identity');
  const r=row(ticker);if(r.market!==market.symbol)throw new Error('ticker-identity-mismatch');
  const b=row(book),first=row(Array.isArray(b.orderbook_units)?b.orderbook_units[0]:null);
  const bookTime=b.market===market.symbol?time(b.timestamp,now):null;
  const bookFresh=bookTime!=null&&now-bookTime<=90_000;
  const rawBid=bookFresh?positive(first.bid_price):null,rawAsk=bookFresh?positive(first.ask_price):null;
  const validBook=rawBid!=null&&rawBid>0&&rawAsk!=null&&rawAsk>=rawBid;
  const bid=validBook?rawBid:null,ask=validBook?rawAsk:null,sourceTime=time(r.timestamp,now);
  const rawPrice=positive(r.trade_price),price=rawPrice!=null&&rawPrice>0?rawPrice:null;
  return {market,quote:'KRW',priceKrw:price,changeFromPreviousClosePct:numeric(r.signed_change_rate)==null?null:numeric(r.signed_change_rate)!*100,volume24hBase:positive(r.acc_trade_volume_24h),turnover24hKrw:positive(r.acc_trade_price_24h),bidKrw:bid,askKrw:ask,spreadBps:bid!=null&&ask!=null?(ask-bid)/((bid+ask)/2)*10000:null,sourceTime,rawSourceTime:numeric(r.timestamp),timestampIssue:sourceTime==null?(numeric(r.timestamp)!=null&&numeric(r.timestamp)!>now+5000?'future-source-time':'missing-source-time'):null,lastTradeTime:time(r.trade_timestamp,now),bookTime,fetchedAt:now,quality:sourceTime!=null&&now-sourceTime>90_000?'stale':price!=null&&sourceTime!=null?'live':'partial',bookState:validBook?'available':'unavailable',source:`${market.exchange} public REST ticker / orderbook (KRW)`};
}
export class KoreanSpotService {
  private cache=new Map<string,{until:number;data:unknown;fetchedAt:number}>();
  private pending=new Map<string,Promise<{data:unknown;fetchedAt:number}>>();
  private gates=new Map<KoreanVenue,Promise<void>>();
  private cooldown=new Map<KoreanVenue,number>();
  constructor(private transport:typeof fetch=fetch){}
  private async request(venue:KoreanVenue,endpoint:'market/all'|'ticker'|'orderbook',symbol?:string){
    const query=symbol?`?markets=${encodeURIComponent(symbol)}`:'?isDetails=true';
    const url=`${ORIGINS[venue]}/v1/${endpoint}${query}`,ttl=endpoint==='market/all'?30*60_000:10_000;
    const hit=this.cache.get(url);if(hit&&hit.until>Date.now())return hit;
    const pending=this.pending.get(url);if(pending)return pending;
    if(this.pending.size>=60)throw new Error('request-queue-full');
    const task=(async()=>{
      const gate=(this.gates.get(venue)??Promise.resolve()).then(async()=>{await new Promise(resolve=>setTimeout(resolve,200));if((this.cooldown.get(venue)??0)>Date.now())throw new Error('rate-limited');});this.gates.set(venue,gate.catch(()=>{}));await gate;
      let response:Response;try{response=await this.transport(url,{redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});}catch{throw new Error('network-unavailable');}
      if(response.status===429){this.cooldown.set(venue,Date.now()+60_000);throw new Error('rate-limited');}
      if(!response.ok)throw new Error(`http-${response.status}`);
      let data:unknown;try{data=await response.json();}catch{throw new Error('invalid-response');}
      if(!Array.isArray(data))throw new Error('invalid-response');
      const result={data,fetchedAt:Date.now()};if(this.cache.size>=300)this.cache.delete(this.cache.keys().next().value!);this.cache.set(url,{...result,until:Date.now()+ttl});return result;
    })();this.pending.set(url,task);try{return await task;}finally{this.pending.delete(url);}
  }
  async instruments(venue:KoreanVenue){return normalizeKoreanCatalog(venue,(await this.request(venue,'market/all')).data);}
  private async snapshot(market:ProjectMarket){
    const venue=market.exchange as KoreanVenue;
    const supported=(await this.instruments(venue)).some(i=>i.id===market.id&&i.nativeSymbol===market.symbol&&i.base===market.base&&market.marketType==='spot'&&market.quote==='KRW');
    if(!supported)throw new Error('market-not-listed');
    const [ticker,book]=await Promise.allSettled([this.request(venue,'ticker',market.symbol),this.request(venue,'orderbook',market.symbol)]);
    if(ticker.status==='rejected')throw ticker.reason;
    const values=ticker.value.data as unknown[],books=book.status==='fulfilled'?book.value.data as unknown[]:[];
    // A cached ticker retains its original fetch time and exchange timestamp.
    return {...normalizeKoreanSpot(market,values.find(v=>row(v).market===market.symbol),books.find(v=>row(v).market===market.symbol)),fetchedAt:ticker.value.fetchedAt};
  }
  async project(project:MarketProject):Promise<KoreanSpotResponse>{
    const markets=[...new Map(project.markets.filter(m=>['upbit','bithumb'].includes(m.exchange)&&m.marketType==='spot'&&m.quote==='KRW').map(m=>[m.id,m])).values()];
    const settled=await Promise.allSettled(markets.map(m=>this.snapshot(m)));const items:KoreanSpotSnapshot[]=[],failures:KoreanSpotResponse['failures']=[];
    settled.forEach((r,i)=>r.status==='fulfilled'?items.push(r.value):failures.push({marketId:markets[i].id,exchange:markets[i].exchange as KoreanVenue,symbol:markets[i].symbol,reason:r.reason instanceof Error?r.reason.message:'upstream-unavailable'}));
    return {projectId:project.id,quote:'KRW',items,failures,requested:markets.length,fetchedAt:Date.now()};
  }
}
export const koreanSpot=new KoreanSpotService();
