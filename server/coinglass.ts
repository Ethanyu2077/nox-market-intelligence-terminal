import type { MarketProject } from '../shared/types.ts';
import type { CoinGlassResponse, CoinGlassSection, CoinGlassOi, CoinGlassFunding, CoinGlassLiquidation, CoinGlassFlow, CoinGlassHistoryBar } from '../shared/coinglass.ts';
import { numeric } from './binance-web3.ts';
const ROUTES = new Set(['/api/futures/taker-buy-sell-volume/exchange-list', '/api/futures/open-interest/aggregated-history', '/api/futures/funding-rate/oi-weight-history', '/api/futures/supported-coins', '/api/futures/open-interest/exchange-list', '/api/futures/funding-rate/exchange-list', '/api/futures/liquidation/exchange-list']);
type Row = Record<string, unknown>;
const row = (v: unknown): Row => v != null && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const rows = (v: unknown): Row[] => { if (!Array.isArray(v)) throw new Error('invalid-response'); return v.map(row); };
const name = (v: unknown) => typeof v === 'string' && v.trim() ? v : null;
const nonnegative = (v: unknown) => { const n = numeric(v); return n != null && n >= 0 ? n : null; };
export class CoinGlassClient {
  private cache = new Map<string, { until: number; data: unknown; fetchedAt: number }>();
  private pending = new Map<string, Promise<{ data: unknown; fetchedAt: number }>>();
  private gate = Promise.resolve();
  private cooldown = 0;
  constructor(private key = process.env.COINGLASS_API_KEY ?? '', private transport: typeof fetch = fetch) {}
  get configured() { return !!this.key; }
  async request(path: string, params: Record<string, string> = {}, ttl = 60_000): Promise<{data: unknown; fetchedAt: number}> {
    if (!ROUTES.has(path)) throw new Error('endpoint-not-allowed');
    if (!this.configured) throw new Error('not-configured');
    const query = new URLSearchParams(params).toString(), url = `https://open-api-v4.coinglass.com${path}${query ? '?' + query : ''}`;
    const cached = this.cache.get(url); if (cached && cached.until > Date.now()) return cached;
    const pending = this.pending.get(url); if (pending) return pending;
    if (this.pending.size >= 40) throw new Error('request-queue-full');
    const task = (async () => {
      const slot = this.gate.then(async () => { await new Promise(resolve => setTimeout(resolve, 650)); if (this.cooldown > Date.now()) throw new Error('rate-limited'); });
      this.gate = slot.catch(() => {}); await slot;
      let response: Response;
      try { response = await this.transport(url, { headers: { accept: 'application/json', 'CG-API-KEY': this.key }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
      catch { throw new Error('network-unavailable'); }
      const fail = (code: number): never => {
        if (code === 429) { const delay = Number(response.headers.get('Retry-After')); this.cooldown = Date.now() + (Number.isFinite(delay) && delay > 0 ? Math.min(delay, 3600) * 1000 : 60_000); }
        throw new Error(code === 429 ? 'rate-limited' : code === 401 ? 'authentication-failed' : code === 403 ? 'permission-or-plan-restricted' : `upstream-${code}`);
      };
      if (!response.ok) fail(response.status);
      let body: Row; try { body = row(await response.json()); } catch { throw new Error('invalid-response'); }
      if (body.code !== 0 && body.code !== '0') { const code = numeric(body.code); if (code === 401 || code === 403 || code === 429) fail(code); throw new Error('upstream-rejected'); }
      const result = { data: body.data, fetchedAt: Date.now() };
      if (this.cache.size >= 300) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(url, { ...result, until: Date.now() + ttl }); return result;
    })();
    this.pending.set(url, task); try { return await task; } finally { this.pending.delete(url); }
  }
}
export function normalizeCoinGlassOi(data: unknown, symbol: string): CoinGlassOi[] {
  return rows(data).filter(r => r.symbol === symbol && name(r.exchange)).map(r => ({ exchange: String(r.exchange), oiUsd: nonnegative(r.open_interest_usd), change1hPct: numeric(r.open_interest_change_percent_1h), change24hPct: numeric(r.open_interest_change_percent_24h), changes:Object.fromEntries(['5m','15m','30m','1h','4h','24h'].map(period=>[period,numeric(r['open_interest_change_percent_'+period])])) }));
}
export function normalizeCoinGlassFunding(data: unknown, symbol: string): CoinGlassFunding[] {
  return rows(data).filter(r => r.symbol === symbol).flatMap(r => (['stablecoin', 'coin'] as const).flatMap(margin => {
    const list = r[margin === 'stablecoin' ? 'stablecoin_margin_list' : 'token_margin_list'];
    return (Array.isArray(list) ? list.map(row) : []).filter(r => name(r.exchange)).map(r => ({ exchange: String(r.exchange), margin, rateRaw: numeric(r.funding_rate), intervalHours: nonnegative(r.funding_rate_interval), nextFundingTime: nonnegative(r.next_funding_time) }));
  }));
}
export function normalizeCoinGlassLiquidations(data: unknown): CoinGlassLiquidation[] {
  return rows(data).filter(r => name(r.exchange)).map(r => ({ exchange: String(r.exchange), totalUsd: nonnegative(r.liquidation_usd), longUsd: nonnegative(r.long_liquidation_usd), shortUsd: nonnegative(r.short_liquidation_usd) }));
}
export function normalizeCoinGlassFlow(data:unknown,symbol:string):CoinGlassFlow[]{
  const r=row(data);if(r.symbol!==symbol)throw new Error('invalid-response');
  const convert=(r:Row,exchange:string)=>{const buyUsd=nonnegative(r.buy_vol_usd),sellUsd=nonnegative(r.sell_vol_usd);const percent=(v:unknown)=>{const n=nonnegative(v);return n!=null&&n<=100?n:null;};return {exchange,buyUsd,sellUsd,deltaUsd:buyUsd!=null&&sellUsd!=null?buyUsd-sellUsd:null,buyPct:percent(r.buy_ratio),sellPct:percent(r.sell_ratio)};};
  return [convert(r,'All'),...(Array.isArray(r.exchange_list)?r.exchange_list.map(row):[]).filter(r=>name(r.exchange)&&r.exchange!=='All').map(r=>convert(r,String(r.exchange)))].filter(r=>[r.buyUsd,r.sellUsd,r.buyPct,r.sellPct].some(n=>n!=null));
}
export function normalizeCoinGlassHistory(data:unknown,nonnegativeOnly:boolean,now=Date.now()):CoinGlassHistoryBar[]{
  const bars=new Map<number,CoinGlassHistoryBar>();
  for(const r of rows(data)){const time=numeric(r.time),open=numeric(r.open),high=numeric(r.high),low=numeric(r.low),close=numeric(r.close);
    if(time==null||time<1e12||time>now||open==null||high==null||low==null||close==null||high<Math.max(open,close)||low>Math.min(open,close)||high<low||(nonnegativeOnly&&low<0))continue;
    bars.set(time,{time,open,high,low,close});
  }return [...bars.values()].sort((a,b)=>a.time-b.time);
}
const unavailable = <T>(state: CoinGlassSection<T>['state'], reason: string): CoinGlassSection<T> => ({ state, reason, data: null, sourceTime: null, fetchedAt: null });
export class CoinGlassService {
  constructor(private client = new CoinGlassClient()) {}
  get configured() { return this.client.configured; }
  async project(project: MarketProject, range: CoinGlassResponse['range'] = '24h', historyInterval?: '1h'|'4h'|'1d'): Promise<CoinGlassResponse> {
    const symbol = project.tokenSymbol.trim().toUpperCase();
    const blocked = <T>() => unavailable<T>(this.configured ? 'unsupported' : 'not-configured', this.configured ? 'symbol-unsupported' : 'not-configured');
    const result: CoinGlassResponse = { projectId: project.id, source: 'CoinGlass', configured: this.configured, symbol, identity: 'symbol-only', range, generatedAt: Date.now(), oi: blocked(), flow: blocked(), funding: blocked(), liquidations: blocked() };
    if(historyInterval)result.history={interval:historyInterval,oi:blocked(),funding:blocked()};
    if (!this.configured || !symbol) return result;
    try {
      const supported = await this.client.request('/api/futures/supported-coins', {}, 3_600_000);
      if (!Array.isArray(supported.data)) throw new Error('invalid-response');
      if (!supported.data.includes(symbol)) return result;
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'invalid-response';
      if(result.history){result.history.oi=unavailable('error',reason);result.history.funding=unavailable('error',reason);}
      result.flow=unavailable('error',reason);result.oi = unavailable('error', reason); result.funding = unavailable('error', reason); result.liquidations = unavailable('error', reason); return result;
    }
    const section = async <T extends unknown[]>(path: string, params: Record<string,string>, normalize: (data: unknown) => T): Promise<CoinGlassSection<T>> => {
      try { const response = await this.client.request(path, params), data = normalize(response.data); return { state: data.length ? 'available' : 'empty', data, reason: null, sourceTime: null, fetchedAt: response.fetchedAt }; }
      catch(e) { return unavailable('error', e instanceof Error ? e.message : 'invalid-response'); }
    };
    [result.oi, result.funding, result.liquidations, result.flow] = await Promise.all([
      section('/api/futures/open-interest/exchange-list', {symbol}, data => normalizeCoinGlassOi(data, symbol)),
      section('/api/futures/funding-rate/exchange-list', {}, data => normalizeCoinGlassFunding(data, symbol)),
      section('/api/futures/liquidation/exchange-list', {symbol, range}, normalizeCoinGlassLiquidations),
      section('/api/futures/taker-buy-sell-volume/exchange-list',{symbol,range},data=>normalizeCoinGlassFlow(data,symbol)),
    ]);
    if(historyInterval&&result.history){[result.history.oi,result.history.funding]=await Promise.all([
      section('/api/futures/open-interest/aggregated-history',{symbol,interval:historyInterval,limit:'120',unit:'usd'},data=>normalizeCoinGlassHistory(data,true)),
      section('/api/futures/funding-rate/oi-weight-history',{symbol,interval:historyInterval,limit:'120'},data=>normalizeCoinGlassHistory(data,false)),
    ]);}
    return result;
  }
}

