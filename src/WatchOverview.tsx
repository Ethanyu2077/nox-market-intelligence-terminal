import { useEffect, useMemo, useState } from 'react';
import type { MarketProject } from '../shared/types';
import { performance, windowPoints, volumeRatio, BUCKET, type WatchOverview as OverviewData, type WatchRow } from '../shared/watch-overview';
import { api } from './api';
import './watch-overview.css';
const COLORS=['#64c7b5','#8eabeb','#d5af72','#c192ca'];
const pct=(v:number|null)=>v===null?'—':`${v>0?'+':''}${v.toFixed(2)}%`;
const money=(v:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:2}).format(v);
export function WatchOverview({projects,language,onOpen,onManage}:{projects:MarketProject[];language:'zh'|'en';onOpen:(id:string)=>void;onManage:()=>void}){
  const zh=language==='zh',t=(cn:string,en:string)=>zh?cn:en;
  const [data,setData]=useState<OverviewData|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  const [minutes,setMinutes]=useState(60),[benchmark,setBenchmark]=useState('absolute'),[selected,setSelected]=useState<string[]|null>(null),[rank,setRank]=useState('surge'),[market,setMarket]=useState('perpetual');
  const [priceGate,setPriceGate]=useState(1),[volumeGate,setVolumeGate]=useState(2);
  const signature=projects.map(p=>`${p.id}:${p.updatedAt}`).join('|');
  useEffect(()=>{
    let alive=true,controller:AbortController|null=null;
    async function load(){if(document.hidden)return;controller=new AbortController();setLoading(true);
      try {const value=await api<OverviewData>('/watchlist/overview',{signal:controller.signal});if(alive){setData(value);setError('');}}
      catch(e){if(alive&&!(e instanceof DOMException&&e.name==='AbortError'))setError(e instanceof Error?e.message:String(e));}
      finally{if(alive)setLoading(false);}
    }
    void load();const timer=window.setInterval(()=>void load(),60_000);document.addEventListener('visibilitychange',load);
    return()=>{alive=false;controller?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',load);};
  },[signature,refresh]);
  const names=new Map(projects.map(p=>[p.id,p.tokenSymbol||p.name]));
  const rows=(data?.rows??[]).filter(r=>names.has(r.projectId));
  const reference=data?.benchmarks.find(r=>r.projectId===benchmark);
  const relative=(r:WatchRow,m=minutes)=>{const value=performance(r.candles,data!.end,m);if(benchmark==='absolute')return value;const ref=reference?performance(reference.candles,data!.end,m):null;return value!==null&&ref!==null?value-ref:null;};
  const relativeLabel=(v:number|null)=>v===null?'—':benchmark==='absolute'?pct(v):`${v>0?'+':''}${v.toFixed(2)} pp`;
  const sorted=[...rows].sort((a,b)=>(relative(b)??-Infinity)-(relative(a)??-Infinity));
  const chartRows=(selected!==null?rows.filter(r=>selected.includes(r.projectId)):sorted.slice(0,3)).slice(0,4);
  const chartSeries=chartRows.map((row,i)=>{const points=windowPoints(row.candles,data!.end,minutes),ref=reference?windowPoints(reference.candles,data!.end,minutes):null;
    return {row,color:COLORS[i],values:points&&(benchmark==='absolute'||ref)?points.map((p,j)=>(p.close/points[0].close-1)*100-(ref?(ref[j].close/ref[0].close-1)*100:0)):null};});
  const vals=chartSeries.flatMap(s=>s.values??[]),max=Math.max(.1,...vals.map(Math.abs));
  const events=useMemo(()=>{
    return (data?.rows??[]).flatMap(row=>row.candles.flatMap((c,i)=>{
      if(!i||c.time<data!.end-86_400_000||row.candles[i-1].time!==c.time-BUCKET)return[];
      const change=(c.close/row.candles[i-1].close-1)*100,ratio=volumeRatio(row.candles,i);
      return Math.abs(change)>=priceGate||(ratio!==null&&ratio>=volumeGate)?[{row,time:c.time,change,ratio}]:[];
    })).sort((a,b)=>b.time-a.time).slice(0,80);
  },[data,priceGate,volumeGate]);
  const ranked=rows.filter(r=>r.marketType===market&&r.quote==='USDT'&&!r.error).map(row=>{
    const recent=row.candles.at(-1),fresh=recent?.time===data?.end;
    let value:number|null=null;
    if(rank==='surge')value=fresh?volumeRatio(row.candles,row.candles.length-1):null;
    else if(rank==='volume'){const p=windowPoints(row.candles,data!.end,1440);value=p?p.slice(1).reduce((sum,c)=>sum+c.volume,0):null;}
    else if(row.funding)value=row.funding.rate*100*8/row.funding.hours;
    return {row,value};
  }).filter((r):r is {row:WatchRow;value:number}=>r.value!==null&&Number.isFinite(r.value)&&(rank!=='positive'||r.value>0)&&(rank!=='negative'||r.value<0)).sort((a,b)=>rank==='negative'?a.value-b.value:b.value-a.value);
  const stale=!!data&&(Date.now()-data.end>10*60_000||!!error);
  return <div className="wo">
    <div className="wo-heading"><div><h1>{t('关注总览','Watchlist Overview')}</h1><p>{t('只关注你添加的标的 · 行情研究与交易执行独立','Your selected projects · Research independent from execution')}</p></div><div className="wo-actions"><span role="status">{loading?t('更新中…','Updating…'):data?`${t('截至','As of')} ${new Date(data.end).toLocaleTimeString(zh?'zh-CN':'en-GB')}`:'—'}</span><button onClick={()=>setRefresh(n=>n+1)} disabled={loading}>{t('刷新','Refresh')}</button><button onClick={onManage}>{t('管理关注','Manage projects')}</button></div></div>
    {error&&<div className="wo-notice" role="alert">{t('更新失败，保留上次数据：','Update failed; retaining previous data: ')}{error}</div>}
    {stale&&<div className="wo-notice">{t('数据已延迟，请核对时间后使用。','Data delayed. Check timestamps before use.')}</div>}
    {!projects.some(p=>!p.archived)?<div className="wo-empty"><h2>{t('先添加你的关注项目','Add your first project')}</h2><p>{t('总览只加载已添加的项目，不扫描全市场。','This overview only loads your projects.')}</p><button onClick={onManage}>{t('添加项目','Add project')}</button></div>:<>
    <section className="wo-panel"><div className="wo-panel-head"><h2>{t('相对强弱','Relative strength')}</h2><div className="wo-controls"><div className="wo-tabs">{[15,60,240,1440].map(m=><button key={m} aria-pressed={minutes===m} onClick={()=>setMinutes(m)}>{m<60?`${m}m`:`${m/60}h`}</button>)}</div><select aria-label={t('比较基准','Benchmark')} value={benchmark} onChange={e=>setBenchmark(e.target.value)}><option value="absolute">{t('绝对涨跌','Absolute return')}</option><option value="BTCUSDT">vs BTC</option><option value="ETHUSDT">vs ETH</option></select></div></div>
    <div className="wo-strength"><div className="wo-chart"><div className="wo-legend">{chartSeries.map(s=><span key={s.row.projectId} style={{color:s.color}}>{names.get(s.row.projectId)} {s.values?relativeLabel(s.values.at(-1)!):t('历史不足','Insufficient history')}</span>)}</div>{vals.length?<svg viewBox="0 0 700 220" role="img" aria-label={t('同一时间起点的涨跌幅比较','Returns from a common starting time')}><text x="4" y="18">+{max.toFixed(2)}{benchmark==='absolute'?'%':'pp'}</text><text x="4" y="210">−{max.toFixed(2)}{benchmark==='absolute'?'%':'pp'}</text><line x1="52" x2="690" y1="110" y2="110" stroke="currentColor" opacity=".2"/>{chartSeries.filter(s=>s.values).map(s=><polyline key={s.row.projectId} fill="none" stroke={s.color} strokeWidth="2" points={s.values!.map((v,i)=>`${52+i/(s.values!.length-1)*638},${110-v/max*90}`).join(' ')}/>)}</svg>:<div className="wo-empty">{loading?t('正在加载已收盘行情…','Loading closed candles…'):t('暂无连续历史可比较','No continuous history to compare')}</div>}<p className="wo-caption">{t('最多对比 4 个标的 · 5 分钟已收盘数据 · 相对值为收益率之差（百分点）','Up to 4 projects · Closed 5m candles · Relative return in percentage points')}</p></div>
    <div className="wo-table-scroll"><table><thead><tr><th>{t('对比 / 标的','Compare / Project')}</th>{[15,60,240,1440].map(m=><th key={m}>{m<60?`${m}m`:`${m/60}h`}</th>)}</tr></thead><tbody>{sorted.map(r=><tr key={r.projectId}><td><input aria-label={`${t('对比','Compare')} ${names.get(r.projectId)}`} type="checkbox" checked={chartRows.some(c=>c.projectId===r.projectId)} onChange={()=>setSelected(current=>{const ids=current??chartRows.map(c=>c.projectId);return ids.includes(r.projectId)?ids.filter(id=>id!==r.projectId):[...ids.slice(-3),r.projectId];})}/><button className="wo-link" onClick={()=>onOpen(r.projectId)}>{names.get(r.projectId)}</button><small title={r.error??''}>{r.venue} · {r.marketType==='spot'?t('现货','Spot'):t('永续','Perp')}{r.error?' · !':''}</small></td>{[15,60,240,1440].map(m=>{const v=relative(r,m);return <td key={m} className={v===null?'':v>=0?'wo-up':'wo-down'}>{relativeLabel(v)}</td>;})}</tr>)}</tbody></table></div></div></section>
    <div className="wo-bottom"><section className="wo-panel"><div className="wo-panel-head"><h2>{t('异动流','Anomaly flow')}</h2><span>{t('最近 24h','Last 24h')}</span></div><div className="wo-thresholds"><label>{t('5m 涨跌 ≥','5m move ≥')}<input type="number" min="0.1" step="0.1" max="100" value={priceGate} onChange={e=>setPriceGate(Math.min(100,Math.max(.1,Number(e.target.value)||.1)))}/>%</label><label>{t('放量 ≥','Volume ≥')}<input type="number" min="1" step="0.5" max="100" value={volumeGate} onChange={e=>setVolumeGate(Math.min(100,Math.max(1,Number(e.target.value)||1)))}/>×</label></div><div className="wo-feed">{events.filter(e=>names.has(e.row.projectId)).map(e=><button className="wo-event" key={`${e.row.projectId}:${e.time}`} onClick={()=>onOpen(e.row.projectId)}><time title={new Date(e.time).toLocaleString()}>{new Date(e.time).toLocaleTimeString(zh?'zh-CN':'en-GB',{hour:'2-digit',minute:'2-digit'})}</time><div><strong>{names.get(e.row.projectId)}</strong><span>{e.row.venue} · {e.row.symbol} · {e.row.marketType==='spot'?t('现货','Spot'):t('永续','Perpetual')}</span></div><div className="wo-event-values"><b className={e.change>=0?'wo-up':'wo-down'}>{pct(e.change)}</b>{e.ratio!==null&&e.ratio>=volumeGate&&<span>{e.ratio.toFixed(1)}× {t('放量','volume')}</span>}</div></button>)}{!events.length&&<div className="wo-empty">{t('暂无满足条件的已收盘异动','No closed-candle events match these thresholds')}</div>}</div><p className="wo-caption">{t('放量 = 当前 5m 成交额 / 此前 12 根中位数；同一标的每根 K 线合并为一条观测。','Volume ratio = latest 5m turnover / previous 12-candle median. One observation per project and candle.')}</p></section>
    <section className="wo-panel"><div className="wo-panel-head"><h2>{t('资金与成交排行','Funding & volume')}</h2><select aria-label={t('市场类型','Market type')} value={market} onChange={e=>setMarket(e.target.value)}><option value="perpetual">{t('永续','Perpetual')}</option><option value="spot">{t('现货','Spot')}</option></select></div><div className="wo-tabs wo-rank-tabs">{[['surge',t('放量倍数','Volume spike')],['volume',t('24h 成交额','24h turnover')],['positive',t('正费率','Positive funding')],['negative',t('负费率','Negative funding')]].map(([id,label])=><button key={id} aria-pressed={rank===id} onClick={()=>setRank(id)}>{label}</button>)}</div><div className="wo-feed">{ranked.map(({row,value},i)=><button className="wo-event" key={row.projectId} onClick={()=>onOpen(row.projectId)}><time>{String(i+1).padStart(2,'0')}</time><div><strong>{names.get(row.projectId)}</strong><span>{row.venue} · {row.symbol}{row.funding&&rank!=='surge'&&rank!=='volume'?` · ${row.funding.hours}h · ${new Date(row.funding.time).toLocaleTimeString()}`:''}</span></div><b>{rank==='surge'?`${value.toFixed(2)}×`:rank==='volume'?`${money(value)} USDT`:pct(value)}</b></button>)}{!ranked.length&&<div className="wo-empty">{t('暂无满足口径的有效样本','No comparable samples available')}</div>}</div><p className="wo-caption">{rank==='positive'||rank==='negative'?t('最近一期已结算费率，按观测结算间隔折算至 8h；非预测费率。周期未知或结算超过 24h 不排名。','Latest settled funding, normalized to 8h using observed interval. Not a forecast. Unknown intervals or settlements older than 24h excluded.'):t('仅 USDT 报价，同市场类型比较；历史缺口及过期样本不排名。','USDT-quoted markets only, separated by market type. Incomplete or stale samples excluded.')}</p></section></div>
    {rows.some(r=>r.error)&&<details className="wo-coverage"><summary>{t('查看数据覆盖与限制','Data coverage & limitations')}</summary>{rows.filter(r=>r.error).map(r=><p key={r.projectId}>{names.get(r.projectId)} · {r.venue} · {r.error}</p>)}</details>}
    </>}
  </div>;
}
