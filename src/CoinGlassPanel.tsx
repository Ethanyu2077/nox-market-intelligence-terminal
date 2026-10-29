import {useEffect,useState} from 'react';
import type {MarketProject} from '../shared/types';
import type {CoinGlassResponse,CoinGlassSection,CoinGlassHistoryBar} from '../shared/coinglass';
const fmt=(n:number|null)=>n==null?'—':new Intl.NumberFormat('en-US',{maximumSignificantDigits:8}).format(n);
const reasons:Record<string,[string,string]>={
  'not-configured':['请到设置 / 数据源配置 CoinGlass Key','Configure a CoinGlass key in Settings / Data Sources'],
  'symbol-unsupported':['该符号不在 CoinGlass 支持列表中','Symbol is not supported by CoinGlass'],
  'authentication-failed':['Key 鉴权失败','API key authentication failed'],
  'permission-or-plan-restricted':['权限或套餐不支持此指标','Permission or plan does not support this metric'],
  'rate-limited':['已限频，稍后重试','Rate limited; retry later'],
  'network-unavailable':['上游网络不可用','Upstream network unavailable'],
};
function HistoryTable({bars,zh}:{bars:CoinGlassHistoryBar[];zh:boolean}){return <div className="table-wrap"><table><thead><tr>{[zh?'时间':'Time','Open','High','Low','Close'].map(s=><th key={s}>{s}</th>)}</tr></thead><tbody>{bars.slice(-30).reverse().map(b=><tr key={b.time}><td>{new Date(b.time).toLocaleString()}</td><td>{fmt(b.open)}</td><td>{fmt(b.high)}</td><td>{fmt(b.low)}</td><td>{fmt(b.close)}</td></tr>)}</tbody></table></div>;}
export function CoinGlassPanel({project,language,onSettings}:{project:MarketProject;language:string;onSettings:()=>void}){
  const zh=language==='zh',[data,setData]=useState<CoinGlassResponse|null>(null),[error,setError]=useState(''),[range,setRange]=useState('24h'),[history,setHistory]=useState(''),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    let active=true,busy=false;const abort=new AbortController();setData(null);setError('');
    const load=async()=>{if(busy)return;busy=true;try{const r=await fetch(`/api/projects/${encodeURIComponent(project.id)}/coinglass?range=${range}${history?'&history='+history:''}`,{signal:abort.signal});if(!r.ok)throw new Error();const result=await r.json();if(active){setData(result);setError('');}}catch{if(active)setError(zh?'CoinGlass 暂不可用':'CoinGlass unavailable');}finally{busy=false;}};
    const changed=()=>void load();void load();const timer=setInterval(changed,60_000);window.addEventListener('nox:providers-changed',changed);return()=>{active=false;abort.abort();clearInterval(timer);window.removeEventListener('nox:providers-changed',changed);};
  },[project.id,range,history,refresh,zh]);
  const status=(s:CoinGlassSection<unknown>)=><p>{s.reason?(reasons[s.reason]?.[zh?0:1]??(zh?'上游拒绝或未返回有效数据':'Upstream rejected or returned invalid data')):s.state==='empty'?(zh?'无匹配记录':'No matching records'):(zh?'已返回数据':'Data returned')} · {zh?'获取时间':'Fetched'}: {s.fetchedAt?new Date(s.fetchedAt).toLocaleString():'—'} · {zh?'源观测时间：未知':'Source observation time: unknown'}</p>;
  return <section className="ops-panel" id="coinglass-metrics"><h2>CoinGlass · {zh?'跨所衍生品指标':'Cross-exchange derivatives metrics'}</h2>
    <p>{zh?'按项目符号查询；未验证链与合约身份，同名币需人工核对。CoinGlass 数据独立展示，不重复相加到原生交易所指标。':'Queried by project symbol; contract identity is unverified. Confirm ticker collisions. CoinGlass is displayed independently and never added to native venue totals.'}</p>
    <div className="ops-controls"><span>{data?.symbol??project.tokenSymbol}</span><label>{zh?'成交 / 清算窗口':'Flow / liquidation range'} <select aria-label={zh?'成交清算窗口':'Flow liquidation range'} value={range} onChange={e=>setRange(e.target.value)}>{['4h','12h','24h'].map(v=><option key={v}>{v}</option>)}</select></label><button onClick={()=>setRefresh(v=>v+1)}>{zh?'刷新':'Refresh'}</button><button onClick={onSettings}>{zh?'配置 Key':'Configure key'}</button></div>
    {error&&<p role="alert">{error}</p>}{!data&&!error&&<p role="status">{zh?'正在读取…':'Loading…'}</p>}
    {data&&!data.configured&&<p>{reasons['not-configured'][zh?0:1]}</p>}
    {data?.configured&&<>
      <h3>{zh?'持仓量与变化':'Open interest & changes'}</h3>{status(data.oi)}
      <div className="table-wrap"><table><thead><tr>{[zh?'交易所':'Exchange','OI USD','5M %','15M %','30M %','1H %','4H %','24H %'].map(s=><th key={s}>{s}</th>)}</tr></thead><tbody>{data.oi.data?.map((r,i)=><tr key={i}><td>{r.exchange}</td><td>{fmt(r.oiUsd)}</td>{['5m','15m','30m','1h','4h','24h'].map(k=><td key={k}>{fmt(r.changes[k])}</td>)}</tr>)}</tbody></table></div>
      <h3>{zh?'资金费率':'Funding rates'}</h3>{status(data.funding)}
      <div className="table-wrap"><table><thead><tr>{(zh?['交易所','保证金','费率（上游原值）','周期 / 小时','下次结算']:['Exchange','Margin','Rate (provider raw)','Interval / hours','Next funding']).map(s=><th key={s}>{s}</th>)}</tr></thead><tbody>{data.funding.data?.map((r,i)=><tr key={i}><td>{r.exchange}</td><td>{r.margin}</td><td>{fmt(r.rateRaw)}</td><td>{fmt(r.intervalHours)}</td><td>{r.nextFundingTime?new Date(r.nextFundingTime).toLocaleString():'—'}</td></tr>)}</tbody></table></div>
      <h3>{zh?'主动买卖与成交差额':'Taker buy/sell & volume delta'}</h3>{status(data.flow)}
      <div className="table-wrap"><table><thead><tr>{(zh?['交易所','买入 USD','卖出 USD','差额 USD（非CVD）','买入 %','卖出 %']:['Exchange','Buy USD','Sell USD','Delta USD (not CVD)','Buy %','Sell %']).map(s=><th key={s}>{s}</th>)}</tr></thead><tbody>{data.flow.data?.map((r,i)=><tr key={i}><td>{r.exchange}</td><td>{fmt(r.buyUsd)}</td><td>{fmt(r.sellUsd)}</td><td>{fmt(r.deltaUsd)}</td><td>{fmt(r.buyPct)}</td><td>{fmt(r.sellPct)}</td></tr>)}</tbody></table></div>
      <h3>{zh?'多空清算':'Long/short liquidations'}</h3>{status(data.liquidations)}
      <div className="table-wrap"><table><thead><tr>{(zh?['交易所','合计 USD','多头 USD','空头 USD']:['Exchange','Total USD','Long USD','Short USD']).map(s=><th key={s}>{s}</th>)}</tr></thead><tbody>{data.liquidations.data?.map((r,i)=><tr key={i}><td>{r.exchange}</td><td>{fmt(r.totalUsd)}</td><td>{fmt(r.longUsd)}</td><td>{fmt(r.shortUsd)}</td></tr>)}</tbody></table></div>
      <div className="ops-controls"><label>{zh?'历史 OI / 加权资金费率':'Historical OI / weighted funding'} <select value={history} onChange={e=>setHistory(e.target.value)}><option value="">{zh?'按需加载':'Load on demand'}</option>{['1h','4h','1d'].map(v=><option key={v}>{v}</option>)}</select></label></div>
      {data.history&&<><h3>{zh?'历史 OI · USD':'Historical OI · USD'}</h3>{status(data.history.oi)}{data.history.oi.data&&<HistoryTable zh={zh} bars={data.history.oi.data}/>}<h3>{zh?'OI 加权资金费率 · 上游原值':'OI-weighted funding · provider raw'}</h3>{status(data.history.funding)}{data.history.funding.data&&<HistoryTable zh={zh} bars={data.history.funding.data}/>}</>}
      <p>{zh?'All 是上游汇总，不与交易所分项相加。费率保留上游口径；滚动成交差额不累加为 CVD。每60秒刷新，历史表展示最近30根已返回有效K线；可用精度和覆盖取决于套餐。':'All is an upstream aggregate, not added to exchange rows. Rates retain provider units; rolling delta is not accumulated as CVD. Refreshes every 60s. History shows the latest 30 valid returned bars; granularity and coverage depend on plan.'}</p>
    </>}
  </section>;
}

