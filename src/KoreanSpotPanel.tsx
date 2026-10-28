import {useEffect,useState} from 'react';
import type {MarketProject} from '../shared/types';
import type {KoreanSpotResponse} from '../shared/korean-spot';
const fmt=(n:number|null)=>n==null?'—':new Intl.NumberFormat('en-US',{maximumSignificantDigits:10}).format(n);
export function KoreanSpotPanel({project,language}:{project:MarketProject;language:string}){
  const zh=language==='zh',[data,setData]=useState<KoreanSpotResponse|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const selected=project.markets.some(m=>['upbit','bithumb'].includes(m.exchange)&&m.marketType==='spot'&&m.quote==='KRW');
  useEffect(()=>{
    if(!selected)return;let active=true,busy=false;const abort=new AbortController();setData(null);setError('');
    const load=async()=>{if(busy)return;busy=true;try{const r=await fetch(`/api/projects/${encodeURIComponent(project.id)}/korean-spot`,{signal:abort.signal});if(!r.ok)throw new Error();const body=await r.json();if(active){setData(body);setError('');}}catch{if(active)setError(zh?'韩元现货行情暂不可用':'KRW spot data unavailable');}finally{busy=false;}};
    void load();const timer=setInterval(()=>void load(),30_000);return()=>{active=false;abort.abort();clearInterval(timer);};
  },[project.id,project.updatedAt,selected,refresh,zh]);
  if(!selected)return null;
  return <section className="ops-panel" id="korean-spot-markets"><h2>{zh?'Upbit / Bithumb · KRW 现货':'Upbit / Bithumb · KRW Spot'}</h2>
    <p>{zh?'仅查询项目已选的韩元现货。价格与成交额使用 KRW，不转换为 USD，也不混入 USDT 合约汇总、OI、资金费率或 CVD。涨跌幅基于交易所的前收盘价，不标为滚动24小时收益。':'Selected KRW spot markets only. Prices/turnover retain KRW, without USD conversion or inclusion in USDT futures totals, OI, funding or CVD. Change uses the venue previous close, not a rolling 24-hour return.'}</p>
    <div className="ops-controls"><span>{zh?'每30秒刷新':'Refreshes every 30 seconds'} · {data?`${data.items.length}/${data.requested}`:'…'}</span><button onClick={()=>setRefresh(v=>v+1)}>{zh?'刷新现货行情':'Refresh spot data'}</button></div>
    {error&&<p role="alert">{error}</p>}{!data&&!error&&<p role="status">{zh?'正在读取…':'Loading…'}</p>}
    <div className="table-wrap"><table><thead><tr>{(zh?['交易所 / 现货交易对','价格 KRW','较前收盘 %','24H成交量 / 代币','24H成交额 KRW','买一 / 卖一 KRW','价差 bps','来源时间 / 状态']:['Venue / Spot pair','Price KRW','Vs previous close %','24H volume / base','24H turnover KRW','Bid / ask KRW','Spread bps','Source time / state']).map(s=><th key={s}>{s}</th>)}</tr></thead><tbody>{data?.items.map(s=><tr key={s.market.id}><td>{s.market.exchange==='upbit'?'Upbit':'Bithumb'}<small>{s.market.symbol} · {s.market.base}/KRW</small></td><td>₩{fmt(s.priceKrw)}</td><td>{fmt(s.changeFromPreviousClosePct)}</td><td>{fmt(s.volume24hBase)} {s.market.base}</td><td>₩{fmt(s.turnover24hKrw)}</td><td>{fmt(s.bidKrw)} / {fmt(s.askKrw)}<small>{s.bookState==='unavailable'?(zh?'盘口缺失或过期':'Book missing or stale'):''}</small></td><td>{fmt(s.spreadBps)}</td><td>{s.sourceTime?new Date(s.sourceTime).toLocaleTimeString():'—'}<small>{s.timestampIssue?(zh?'来源时间缺失或异常':'Source time missing or invalid')+' · ':''}{zh?({live:'正常',stale:'延迟',partial:'部分数据',unavailable:'不可用'} as const)[s.quality]:s.quality}</small></td></tr>)}</tbody></table></div>
    {data?.failures.map(f=><p role="alert" key={f.marketId}>{f.exchange.toUpperCase()} · {f.symbol} · {zh?'未返回有效数据':'No valid data returned'} ({f.reason})</p>)}
    <p>{zh?'盘口是 REST 买一卖一快照，不是序列校验后的深度或可执行交易报价。添加市场时仍需核对同名代币身份。':'Orderbook data is a REST top-of-book snapshot, not sequence-verified depth or an executable quote. Verify token identity when selecting markets.'}</p>
  </section>;
}
