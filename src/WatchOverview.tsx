import { useEffect, useMemo, useState } from 'react';
import type { MarketProject } from '../shared/types';
import { buildWatchMetrics, performance, windowPoints, volumeRatio, watchStatus, BUCKET, type WatchOverview as OverviewData, type WatchRow } from '../shared/watch-overview';
import { api } from './api';
import './watch-overview.css';
import { CapitalFlowVisual } from './CapitalFlowVisual';
import { FlowCards } from './FlowCards';
import { LiveFlowEvents } from './LiveFlowEvents';
const COLORS=Array.from({length:8},(_,i)=>`var(--series-${i+1})`);
const pct=(v:number|null)=>v===null?'—':`${v>0?'+':''}${v.toFixed(2)}%`;
const money=(v:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:2}).format(v);
export function WatchOverview({projects,language,onOpen,onManage}:{projects:MarketProject[];language:'zh'|'en';onOpen:(id:string)=>void;onManage:()=>void}){
  const zh=language==='zh',t=(cn:string,en:string)=>zh?cn:en;
  const [data,setData]=useState<OverviewData|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  const end=data?.end??0;
  const [indicator,setIndicator]=useState<'price'|'cvd'|'flow'|'oi'>('price');
  const [minutes,setMinutes]=useState(60),[benchmark,setBenchmark]=useState('absolute'),[selected,setSelected]=useState<string[]|null>(null),[rank,setRank]=useState('surge'),[market,setMarket]=useState('perpetual');
  const [priceGate,setPriceGate]=useState(1),[volumeGate,setVolumeGate]=useState(2);
  const [feedFilter,setFeedFilter]=useState('all'),[tableOpen,setTableOpen]=useState(false),[hover,setHover]=useState<number|null>(null);
  const [flowOpen,setFlowOpen]=useState(true), [cardsOpen,setCardsOpen]=useState(true), [fullscreen,setFullscreen]=useState(false);
  const signature=projects.map(p=>`${p.id}:${p.updatedAt}`).join('|');
  useEffect(()=>{
    let alive=true,controller:AbortController|null=null;
    async function load(){if(document.hidden)return;controller=new AbortController();setLoading(true);
      try {const value=await api<OverviewData>(`/watchlist/overview?minutes=${minutes}`,{signal:controller.signal});if(alive){setData(value);setError('');}}
      catch(e){if(alive&&!(e instanceof DOMException&&e.name==='AbortError'))setError(e instanceof Error?e.message:String(e));}
      finally{if(alive)setLoading(false);}
    }
    void load();const timer=window.setInterval(()=>void load(),60_000);document.addEventListener('visibilitychange',load);
    return()=>{alive=false;controller?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',load);};
  },[signature,refresh,minutes]);
  const names=new Map(projects.map(p=>[p.id,p.tokenSymbol||p.name]));
  const rows=(data?.rows??[]).filter(r=>names.has(r.projectId));
  const reference=data?.benchmarks?.find(r=>r.projectId===benchmark);
  const relative=(r:WatchRow,m=minutes)=>{const value=performance(r.candles,end,m);if(benchmark==='absolute')return value;const ref=reference?performance(reference.candles,end,m):null;return value!==null&&ref!==null?value-ref:null;};
  const relativeLabel=(v:number|null)=>v===null?'—':benchmark==='absolute'?pct(v):`${v>0?'+':''}${v.toFixed(2)} pp`;
  const sorted=[...rows].sort((a,b)=>(relative(b)??-Infinity)-(relative(a)??-Infinity));
  const chartRows=(selected!==null?rows.filter(r=>selected.includes(r.projectId)):sorted.slice(0,4)).slice(0,4);
  const chartSeries=chartRows.map((row)=>{
    const color=COLORS[Math.max(0,projects.findIndex(p=>p.id===row.projectId))%COLORS.length];
    const points=windowPoints(row.candles,end,minutes),ref=reference?windowPoints(reference.candles,end,minutes):null;
    let values:Array<number|null>|null=null;
    if(indicator==='price'){
      values=points&&(benchmark==='absolute'||ref)?points.map((p,j)=>(p.close/points[0].close-1)*100-(ref?(ref[j].close/ref[0].close-1)*100:0)):null;
    } else if((indicator==='cvd'||indicator==='flow')&&row.flow&&points){
      const map=new Map(row.flow.buckets.map(b=>[b.time,b]));
      let base:number|null=null, running=0;
      values=points.map(p=>{const b=map.get(p.time);const v=indicator==='cvd'?(b?.cvd??null):(b?.delta??null);if(v==null)return null;if(indicator==='flow'){running+=v;return running;}base??=v;return v-base;});
    } else if(indicator==='oi'&&row.oiSeries&&points){
      const map=new Map(row.oiSeries.map(o=>[o.time,o.oiUsd]));
      const base=points.map(p=>map.get(p.time)).find(v=>v!=null)??null;
      values=base?points.map(p=>{const v=map.get(p.time);return v==null?null:(v/base-1)*100;}):null;
    }
    return {row,color,values};
  });
  const vals=chartSeries.flatMap(s=>s.values??[]).filter((v):v is number=>v!=null),max=Math.max(.1,...vals.map(Math.abs));
  const events=useMemo(()=>{
    return (data?.rows??[]).flatMap(row=>row.candles.flatMap((c,i)=>{
      if(!i||c.time<end-86_400_000||row.candles[i-1].time!==c.time-BUCKET)return[];
      const change=(c.close/row.candles[i-1].close-1)*100,ratio=volumeRatio(row.candles,i);
      return Math.abs(change)>=priceGate||(ratio!==null&&ratio>=volumeGate)?[{row,time:c.time,change,ratio}]:[];
    })).sort((a,b)=>b.time-a.time).slice(0,80);
  },[data,end,priceGate,volumeGate]);
  if(!data) return <section className="wo-panel wo-main-panel"><div className="wo-panel-head"><h2><i>01</i>{t('关注总览','Watch overview')}</h2></div><div className="wo-empty">{error?<><strong>{t('数据加载失败','Failed to load')}</strong><span>{error}</span><button onClick={()=>setRefresh(n=>n+1)}>{t('重试','Retry')}</button></>:<span>{loading?t('加载中…','Loading…'):t('暂无数据','No data')}</span>}</div></section>;

  const comparable=rows.filter(r=>r.marketType===market&&r.quote==='USDT'&&!r.error);
  const ranked=comparable.map(row=>{
    const fresh=row.candles.at(-1)?.time===data?.end;
    const points=rank==='volume'?windowPoints(row.candles,end,1440):null;
    const value=rank==='volume'?(points?points.slice(1).reduce((sum,c)=>sum+c.volume,0):null):fresh?volumeRatio(row.candles,row.candles.length-1):null;
    return {row,value};
  }).filter((r):r is {row:WatchRow;value:number}=>r.value!==null&&Number.isFinite(r.value)).sort((a,b)=>b.value-a.value);
  const funding=rows.filter(r=>r.marketType==='perpetual'&&r.quote==='USDT'&&!r.error&&r.funding).map(row=>({row,value:row.funding!.rate*100*8/row.funding!.hours})).filter(r=>Number.isFinite(r.value));
  const gainers=sorted.filter(r=>(relative(r)??0)>0),losers=[...sorted].reverse().filter(r=>(relative(r)??0)<0);
  const valid=rows.map(r=>relative(r)).filter((v):v is number=>v!==null);
  const average=valid.length?valid.reduce((sum,v)=>sum+v,0)/valid.length:null;
  const visibleEvents=events.filter(e=>names.has(e.row.projectId)&&(feedFilter==='all'||feedFilter==='up'&&e.change>=priceGate||feedFilter==='down'&&e.change<=-priceGate||feedFilter==='volume'&&e.ratio!==null&&e.ratio>=volumeGate));
  const stamp=(time:number)=>new Date(time).toLocaleTimeString(zh?'zh-CN':'en-GB',{hour:'2-digit',minute:'2-digit'});
  const toggle=(id:string)=>setSelected(current=>{const ids=current??chartRows.map(c=>c.projectId);return ids.includes(id)?ids.filter(value=>value!==id):[...ids.slice(-3),id];});
  const unit=indicator==='price'?(benchmark==='absolute'?'%':'pp'):indicator==='oi'?'%':indicator==='cvd'?'USDT':'USDT';
  const indicatorLabel=(value:number|null)=>value==null?'—':indicator==='price'?relativeLabel(value):indicator==='oi'?`${value>0?'+':''}${value.toFixed(2)}%`:`${value>0?'+':''}${money(value)}`;
  const y=(value:number|null)=>value==null?326:180-value/max*143;
  const lastOf=(values:(number|null)[]):number|null=>{for(let i=values.length-1;i>=0;i--)if(values[i]!=null)return values[i];return null;};
  const segments=(values:(number|null)[])=>{const out:Array<Array<{x:number;y:number}>>=[];let current:Array<{x:number;y:number}>=[];values.forEach((value,index)=>{if(value==null){if(current.length)out.push(current);current=[];}else current.push({x:46+index/(values.length-1)*624,y:y(value)});});if(current.length)out.push(current);return out;};
  // Place endpoint labels independently of their lines to keep close returns legible.
  const endpoints=chartSeries.filter(s=>s.values&&lastOf(s.values)!==null).map(s=>({...s,target:y(lastOf(s.values!))})).sort((a,b)=>a.target-b.target);
  endpoints.forEach((s,i)=>{s.target=Math.max(28,s.target,i?endpoints[i-1].target+22:0);});
  if(endpoints.length&&endpoints.at(-1)!.target>326){const offset=endpoints.at(-1)!.target-326;endpoints.forEach(s=>{s.target-=offset;});}
  const stale=!!data&&(Date.now()-data.end>10*60_000||!!error);
  return <div className="wo">
    <div className="wo-heading"><div><h1>{t('关注总览','Watchlist Overview')}</h1></div><div className="wo-actions"><span role="status">{loading?t('更新中…','Updating…'):data?<>{data.cache?.stale?'STALE · ':''}{t('截至','As of')} {new Date(data.end).toLocaleTimeString(zh?'zh-CN':'en-GB')}</>:'—'}</span><button onClick={()=>setRefresh(n=>n+1)} disabled={loading}>{t('刷新','Refresh')}</button><button onClick={()=>setFlowOpen(v=>!v)} aria-pressed={flowOpen}>{t('资金流','Flow')}</button><button onClick={()=>setCardsOpen(v=>!v)} aria-pressed={cardsOpen}>{t('流动卡','Cards')}</button><button onClick={()=>setFullscreen(v=>!v)} aria-pressed={fullscreen}>{t('全屏','Fullscreen')}</button><button onClick={onManage}>{t('管理关注','Manage projects')}</button></div></div>
    {error&&<div className="wo-notice" role="alert">{t('更新失败，保留上次数据：','Update failed; retaining previous data: ')}{error}</div>}
    {stale&&<div className="wo-notice">{t('数据已延迟，请核对时间后使用。','Data delayed. Check timestamps before use.')}</div>}
    {!projects.some(p=>!p.archived)?<div className="wo-empty"><h2>{t('先添加你的关注项目','Add your first project')}</h2><p>{t('总览只加载已添加的项目，不扫描全市场。','This overview only loads your projects.')}</p><button onClick={onManage}>{t('添加项目','Add project')}</button></div>:<>
    <div className="wo-ticker" aria-label={t('关注行情','Watchlist quotes')}>
      {rows.map(r=><button key={r.projectId} onClick={()=>onOpen(r.projectId)}><strong>{names.get(r.projectId)}</strong><span>{r.candles.at(-1)?.close.toLocaleString(zh?'zh-CN':'en-US',{maximumSignificantDigits:7})??'—'} <small>{r.quote} · {watchStatus(r)}</small></span><b className={(performance(r.candles,end,1440)??0)>=0?'wo-up':'wo-down'}>{pct(performance(r.candles,end,1440))}</b></button>)}
    </div>
    <div className="wo-pulse"><span className="wo-scope">{t('关注范围','WATCHLIST')} <b>{rows.length}</b></span><span>{t('上涨','Advancing')} <b className="wo-up">▲ {gainers.length}</b></span><span>{t('下跌','Declining')} <b className="wo-down">▼ {losers.length}</b></span><span>{t('平均','Average')} <b className={(average??0)>=0?'wo-up':'wo-down'}>{relativeLabel(average)}</b></span><span>{t('有效样本','Valid samples')} <b>{valid.length}/{rows.length}</b></span><span className="wo-pulse-end">{minutes<60?`${minutes}m`:`${minutes/60}h`} · {benchmark==='absolute'?t('绝对涨跌','Absolute'):benchmark.replace('USDT','')} · {t('5m 收盘','5m close')}</span></div>
    <section className={`wo-panel wo-main-panel ${fullscreen?'wo-fullscreen':''}`}><div className="wo-panel-head"><h2><i>01</i>{t('相对强弱','Relative strength')}</h2><div className="wo-controls"><select aria-label={t('指标','Indicator')} value={indicator} onChange={e=>{setIndicator(e.target.value as typeof indicator);setHover(null);}}><option value="price">{t('价格强弱','Price strength')}</option><option value="cvd">CVD</option><option value="flow">{t('主动净额','Flow Δ')}</option><option value="oi">{t('OI 变化','OI Δ')}</option></select><div className="wo-tabs">{[5,15,60,240,1440].map(m=><button key={m} aria-pressed={minutes===m} onClick={()=>{setMinutes(m);setHover(null);}}>{m<60?`${m}m`:`${m/60}h`}</button>)}</div><select aria-label={t('比较基准','Benchmark')} value={benchmark} onChange={e=>setBenchmark(e.target.value)}><option value="absolute">{t('绝对涨跌','Absolute return')}</option><option value="BTCUSDT">vs BTC</option><option value="ETHUSDT">vs ETH</option></select></div></div>
    <div className="wo-strength"><div className="wo-chart"><div className="wo-legend">{rows.map(row=>{const series=chartSeries.find(s=>s.row.projectId===row.projectId);return <button key={row.projectId} aria-pressed={!!series} onClick={()=>toggle(row.projectId)} style={{color:series?.color}}><span className="wo-dot"/>{names.get(row.projectId)} <b>{series?.values?indicatorLabel(series.values[hover??series.values.length-1]):'—'}</b></button>;})}<small>{t('最多选 4 个','Up to 4')}</small></div>
    {vals.length?<svg viewBox="0 0 820 370" role="img" aria-label={t('同一时间起点的涨跌幅比较','Returns from a common starting time')} onMouseLeave={()=>setHover(null)} onMouseMove={event=>{const rect=event.currentTarget.getBoundingClientRect();const count=chartSeries.find(s=>s.values)?.values?.length??1;setHover(Math.round(Math.max(0,Math.min(1,((event.clientX-rect.left)/rect.width*820-46)/624))*(count-1)));}}>
      {[-1,-.5,0,.5,1].map(factor=><g key={factor}><line x1="46" x2="670" y1={y(max*factor)} y2={y(max*factor)} className={factor===0?'wo-zero':'wo-grid'}/><text x="3" y={y(max*factor)-5}>{(max*factor).toFixed(1)}{unit}</text></g>)}
      {[0,.25,.5,.75,1].map(factor=><g key={factor}><line x1={46+624*factor} x2={46+624*factor} y1="28" y2="326" className="wo-grid"/><text x={46+624*factor} y="357" textAnchor={factor===0?'start':factor===1?'end':'middle'}>{stamp(end-minutes*60_000*(1-factor))}</text></g>)}
      <defs><filter id="wo-line-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      {chartSeries.filter(s=>s.values).flatMap(s=>segments(s.values!).map((segment,index)=><g key={`${s.row.projectId}-${index}-${end}`}><polyline className="wo-line" fill="none" stroke={s.color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" filter="url(#wo-line-glow)" points={segment.map(p=>`${p.x},${p.y}`).join(' ')}/><polyline className="wo-flow-line" fill="none" stroke={s.color} strokeWidth="2.4" strokeLinecap="round" vectorEffect="non-scaling-stroke" filter="url(#wo-line-glow)" points={segment.map(p=>`${p.x},${p.y}`).join(' ')}/></g>))}
      {endpoints.map(s=><g className="wo-end-label" key={s.row.projectId}><circle cx="670" cy={y(lastOf(s.values!))} r="3" fill={s.color}/><path d={`M674 ${y(lastOf(s.values!))} L689 ${s.target}`} fill="none" stroke={s.color} opacity=".6"/><rect x="692" y={s.target-10} width="124" height="20" rx="2" fill={s.color} opacity=".12"/><text x="698" y={s.target+4} style={{fill:s.color}}>{names.get(s.row.projectId)} {indicatorLabel(lastOf(s.values!))}</text></g>)}
      {hover!==null&&<g><line x1={46+hover/((chartSeries.find(s=>s.values)?.values?.length??2)-1)*624} x2={46+hover/((chartSeries.find(s=>s.values)?.values?.length??2)-1)*624} y1="28" y2="326" className="wo-cursor"/>{chartSeries.filter(s=>s.values&&s.values[hover]!=null).map(s=><circle key={s.row.projectId} cx={46+hover/(s.values!.length-1)*624} cy={y(s.values![hover])} r="3" fill={s.color}/>)}<text x="46" y="18">{stamp(end-minutes*60_000+hover*BUCKET)}</text></g>}
    </svg>:<div className="wo-empty wo-chart-empty">{loading?t('正在加载已收盘行情…','Loading closed candles…'):t('选择标的以对比连续历史','Select projects with continuous history')}</div>}
    <div className="wo-chart-foot"><span>{t('共同起点 · 收益率归零','Common origin · Returns rebased to zero')}</span><button onClick={()=>setTableOpen(!tableOpen)} aria-expanded={tableOpen}>{tableOpen?t('收起周期矩阵 ↑','Hide matrix ↑'):t('周期矩阵 ↓','Timeframe matrix ↓')}</button></div></div>
    <aside className="wo-leaders">{[{title:t('强势榜','Leaders'),items:gainers,positive:true},{title:t('弱势榜','Laggards'),items:losers,positive:false}].map(group=><div className="wo-leader-column" key={group.title}><h3 className={group.positive?'wo-up':'wo-down'}>{group.positive?'↗':'↘'} {group.title}<small>{unit}</small></h3>{group.items.slice(0,10).map((r,i)=><button className="wo-leader-row" key={r.projectId} onClick={()=>toggle(r.projectId)} aria-pressed={chartRows.some(c=>c.projectId===r.projectId)} title={t('点击加入或移出图表','Toggle chart comparison')}><em>{i+1}</em><strong>{names.get(r.projectId)}</strong><b className={group.positive?'wo-up':'wo-down'}>{relativeLabel(relative(r))}</b><span className={group.positive?'wo-meter wo-positive':'wo-meter wo-negative'} style={{width:`${Math.min(100,Math.abs(relative(r)??0)/Math.max(.01,...valid.map(Math.abs))*100)}%`}}/></button>)}{!group.items.length&&<div className="wo-small-empty">{t('暂无符合标的','No matching projects')}</div>}</div>)}</aside></div>
    <details className="wo-coverage wo-metric-coverage"><summary>{t('指标覆盖详情','Metric coverage')}</summary><div className="wo-metric-grid">{rows.map(r=><div key={r.projectId} className="wo-metric-row"><strong>{names.get(r.projectId)}</strong>{Object.entries(buildWatchMetrics(r)).map(([name,metric])=><span key={name} className={metric.state==='LIVE'?'ok':'off'} title={`${metric.state}${metric.at?` · ${new Date(metric.at).toLocaleTimeString()}`:''}${metric.error?` · ${metric.error}`:''}${metric.source?` · ${metric.source}`:''}`}>{name}</span>)}</div>)}</div></details>
    {tableOpen&&<div className="wo-table-scroll"><table><thead><tr><th>{t('标的 / 研究','Project / Research')}</th>{[15,60,240,1440].map(m=><th key={m}>{m<60?`${m}m`:`${m/60}h`}</th>)}</tr></thead><tbody>{sorted.map(r=><tr key={r.projectId}><td><button className="wo-link" onClick={()=>onOpen(r.projectId)}>{names.get(r.projectId)} ↗</button><small title={r.error??''}>{r.venue} · {r.marketType==='spot'?t('现货','Spot'):t('永续','Perp')}{r.error?' · !':''}</small></td>{[15,60,240,1440].map(m=>{const v=relative(r,m);return <td key={m} className={v===null?'':v>=0?'wo-up':'wo-down'}>{relativeLabel(v)}</td>;})}</tr>)}</tbody></table></div>}
    </section>
    <div className="wo-bottom wo-dock">
    {flowOpen&&<CapitalFlowVisual rows={chartRows} names={names} colors={COLORS} language={language}/>}
    <LiveFlowEvents rows={rows} names={names} end={end} onOpen={onOpen} language={language}/>
    {cardsOpen&&<FlowCards rows={rows} names={names} end={end} language={language}/>}
    <section className="wo-panel"><div className="wo-panel-head"><h2><i>02</i>{t('异动流','Anomaly flow')}</h2><span>{t('最近 24h','Last 24h')}</span></div><div className="wo-tabs wo-dock-tabs">{[['all',t('全部','All')],['up',t('急涨','Rising')],['down',t('急跌','Falling')],['volume',t('放量','Volume')]].map(([id,label])=><button key={id} aria-pressed={feedFilter===id} onClick={()=>setFeedFilter(id)}>{label}</button>)}</div>
    <div className="wo-feed">{visibleEvents.map(e=><button className="wo-event wo-tape-row" key={`${e.row.projectId}:${e.time}`} onClick={()=>onOpen(e.row.projectId)} title={`${e.row.venue} · ${e.row.symbol} · ${new Date(e.time).toLocaleString()}`}><time>{stamp(e.time)}</time><strong>{names.get(e.row.projectId)}</strong><span className={Math.abs(e.change)>=priceGate?(e.change>0?'wo-tag wo-up':'wo-tag wo-down'):'wo-tag'}>{Math.abs(e.change)>=priceGate?(e.change>0?t('急涨','Rise'):t('急跌','Fall')):t('放量','Volume')}</span><b className={e.change>=0?'wo-up':'wo-down'}>{pct(e.change)}</b><small>{e.ratio!==null&&e.ratio>=volumeGate?`${e.ratio.toFixed(1)}×`:''}</small></button>)}{!visibleEvents.length&&<div className="wo-empty">{t('暂无满足条件的观测','No matching observations')}</div>}</div>
    <details className="wo-method"><summary>{t('阈值与口径 · 5m 已收盘','Thresholds · Closed 5m candles')}</summary><div className="wo-thresholds"><label>{t('涨跌 ≥','Move ≥')}<input type="number" min="0.1" step="0.1" max="100" value={priceGate} onChange={e=>setPriceGate(Math.min(100,Math.max(.1,Number(e.target.value)||.1)))}/>%</label><label>{t('放量 ≥','Volume ≥')}<input type="number" min="1" step="0.5" max="100" value={volumeGate} onChange={e=>setVolumeGate(Math.min(100,Math.max(1,Number(e.target.value)||1)))}/>×</label></div><p>{t('5m 成交额 / 前 12 根中位数；每根合并一条，最多 80 条。','5m turnover / prior 12-candle median. One observation per candle, latest 80.')}</p></details></section>
    <section className="wo-panel"><div className="wo-panel-head"><h2><i>03</i>{t('资金费率极值','Funding extremes')}</h2><span>{t('已结算 · 8h 折算','Settled · 8h equiv.')}</span></div><div className="wo-funding-pair">{[{positive:true,title:t('正费率','Positive')},{positive:false,title:t('负费率','Negative')}].map(group=>{const list=funding.filter(r=>group.positive?r.value>0:r.value<0).sort((a,b)=>group.positive?b.value-a.value:a.value-b.value);return <div key={group.title}><h3 className={group.positive?'wo-up':'wo-down'}>{group.title}<small>{list.length}</small></h3>{list.map(({row,value})=><button className="wo-funding-row" key={row.projectId} onClick={()=>onOpen(row.projectId)} title={`${row.venue} · ${row.symbol} · ${new Date(row.funding!.time).toLocaleString()}`}><strong>{names.get(row.projectId)}</strong><small>{row.funding!.hours}h</small><b className={group.positive?'wo-up':'wo-down'}>{pct(value)}</b></button>)}{!list.length&&<div className="wo-small-empty">{t('暂无有效样本','No valid samples')}</div>}</div>;})}</div><details className="wo-method"><summary>{t('费率口径与结算时间','Funding methodology & timestamps')}</summary><p>{t('最近一期已结算费率，按观测结算间隔折算至 8h；非预测费率。周期未知或结算超过 24h 不排名。','Latest settled funding normalized to 8h using observed interval; not a forecast. Unknown intervals or settlements older than 24h excluded.')}</p>{funding.map(({row})=><p key={row.projectId}>{names.get(row.projectId)} · {row.venue} · {new Date(row.funding!.time).toLocaleString()}</p>)}</details></section>
    <section className="wo-panel"><div className="wo-panel-head"><h2><i>04</i>{t('成交活跃度','Volume activity')}</h2><select aria-label={t('市场类型','Market type')} value={market} onChange={e=>setMarket(e.target.value)}><option value="perpetual">{t('永续','Perpetual')}</option><option value="spot">{t('现货','Spot')}</option></select></div><div className="wo-tabs wo-dock-tabs">{[['surge',t('5m 放量倍数','5m volume spike')],['volume',t('24h 成交额','24h turnover')]].map(([id,label])=><button key={id} aria-pressed={rank===id} onClick={()=>setRank(id)}>{label}</button>)}</div><div className="wo-feed">{ranked.map(({row,value},i)=><button className="wo-volume-row" key={row.projectId} onClick={()=>onOpen(row.projectId)}><em>{String(i+1).padStart(2,'0')}</em><div><strong>{names.get(row.projectId)}</strong><small>{row.venue} · {row.symbol}</small></div><b>{rank==='surge'?`${value.toFixed(2)}×`:`${money(value)} USDT`}</b><span className="wo-volume-meter" style={{width:`${Math.min(100,value/Math.max(.01,ranked[0]?.value??1)*100)}%`}}/></button>)}{!ranked.length&&<div className="wo-empty">{t('暂无满足口径的有效样本','No comparable samples available')}</div>}</div><details className="wo-method"><summary>{t('仅 USDT · 查看统计口径','USDT only · Methodology')}</summary><p>{t('同市场类型比较；历史缺口及过期样本不排名。5m 放量以此前 12 根中位数为基准，24h 成交额为完整窗口求和。','Compared within the same market type. Gaps and stale candles excluded. Spike uses the prior 12-candle median; 24h turnover uses a complete window.')}</p></details></section></div>
    {rows.some(r=>r.error)&&<details className="wo-coverage"><summary>{t('查看数据覆盖与限制','Data coverage & limitations')}</summary>{rows.filter(r=>r.error).map(r=><p key={r.projectId}>{names.get(r.projectId)} · {r.venue} · {r.error}</p>)}</details>}
    </>}
  </div>;
}
