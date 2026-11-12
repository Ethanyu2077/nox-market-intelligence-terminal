import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MarketProject } from '../shared/types';
import { buildWatchMetrics, historicalStrengthPoints, performance, windowPoints, volumeRatio, watchStatus, BUCKET, type WatchOverview as OverviewData, type WatchRow, type WatchIndicator } from '../shared/watch-overview';
import { api } from './api';
import './watch-overview.css';
import { CapitalFlowVisual } from './CapitalFlowVisual';
import { FlowCards } from './FlowCards';
import { LiveFlowEvents } from './LiveFlowEvents';
import { StrengthPlot } from './LiveStrengthChart';
import { liveStrengthReturns, strengthMarketKey, strengthValueAt, STRENGTH_GAP_MS } from '../shared/strength-history';
import { useStrengthFeed } from './useStrengthFeed';
import { periodPrices, periodPriceSeries, periodPriceValueAt, priceRefreshMs } from '../shared/period-strength';
import { connectWatchLive, type WatchLiveState } from './watch-live-connection';

const LIVE_PROJECT_LIMIT = 12; // /ws/live subscription limit
const COLORS=Array.from({length:8},(_,i)=>`var(--series-${i+1})`);
const pct=(v:number|null)=>v===null?'—':`${v>0?'+':''}${v.toFixed(2)}%`;
const windows = [1, 5, 15, 60, 240, 1440] as const;
const money=(v:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:2}).format(v);
export function WatchOverview({projects,language,onOpen,onManage}:{projects:MarketProject[];language:'zh'|'en';onOpen:(id:string)=>void;onManage:()=>void}){
  const zh=language==='zh',t=(cn:string,en:string)=>zh?cn:en;
  const windowLabel = (period: number) => period === 1 ? t('实时', 'Live') : period < 60 ? `${period}m` : `${period / 60}h`;
  const [data,setData]=useState<OverviewData|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  const end=data?.end??0;
  const [indicator,setIndicator]=useState<WatchIndicator>('price');
  const [minutes,setMinutes]=useState(1),[benchmark,setBenchmark]=useState('absolute'),[selected,setSelected]=useState<string[]|null>(null),[rank,setRank]=useState('surge'),[market,setMarket]=useState('perpetual');
  const [priceGate,setPriceGate]=useState(1),[volumeGate,setVolumeGate]=useState(2);
  const [feedFilter,setFeedFilter]=useState('all'),[tableOpen,setTableOpen]=useState(false),[hover,setHover]=useState<number|null>(null);
  const [flowOpen,setFlowOpen]=useState(true), [cardsOpen,setCardsOpen]=useState(true), [fullscreen,setFullscreen]=useState(false);
  const hasProjects = projects.some(project => !project.archived);
  const panelId = useId();
  const enterFullscreen = useRef<HTMLButtonElement>(null);
  const exitFullscreen = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!fullscreen) return;
    if (!hasProjects) { setFullscreen(false); return; }
    const entry = enterFullscreen.current;
    exitFullscreen.current?.focus({ preventScroll: true });
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        setFullscreen(false);
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', onEscape);
      if (entry?.isConnected) entry.focus({ preventScroll: true });
    };
  }, [fullscreen, hasProjects]);
  const liveWindow = minutes === 1;
  const periodPrice = !liveWindow && indicator === 'price';
  const cadence = priceRefreshMs(minutes);
  // The other overview panels use closed 5m buckets, including while the price plot is live.
  const historyMinutes = liveWindow ? 60 : minutes;
  const [connection, setConnection] = useState<WatchLiveState>('connecting');
  const liveConnected = connection === 'live' || connection === 'syncing';
  const activeProjects = useMemo(() => projects.filter(project =>
    !project.archived && project.monitoring.collectionMode !== 'paused'), [projects]);
  const liveProjects = useMemo(() => {
    if (activeProjects.length <= LIVE_PROJECT_LIMIT) return activeProjects;
    const ids = new Set(selected ?? []);
    const selectedProjects = activeProjects.filter(project => ids.has(project.id));
    const rest = activeProjects.filter(project => !ids.has(project.id));
    const subscribed = new Set([...selectedProjects, ...rest].slice(0, LIVE_PROJECT_LIMIT).map(project => project.id));
    return activeProjects.filter(project => subscribed.has(project.id));
  }, [activeProjects, selected]);
  const { series, start: liveStart, now, staleIds, ingest, restore } = useStrengthFeed(liveProjects, indicator === 'price' ? cadence : 0);
  const liveReturns = useMemo(() => liveStrengthReturns(liveWindow ? series : new Map(), now, staleIds, liveConnected),
    [liveWindow, series, now, staleIds, liveConnected]);
  const [live,setLive]=useState<Record<string,{price:number|null;change:number|null;stale:boolean;at:number}>>({});
  const [liveFlow,setLiveFlow]=useState<Record<string,{buy:number;sell:number;delta:number;cvd:number;spotDelta:number;perpDelta:number}>>({});
  const signature=projects.map(p=>`${p.id}:${p.updatedAt}`).join('|');
  const query = new URLSearchParams({ minutes: String(historyMinutes) });
  if (periodPrice) {
    query.set('priceDetail', '1');
    if (benchmark !== 'absolute') query.set('priceBenchmark', benchmark);
    for (const id of selected ?? []) query.append('priceProject', id);
  }
  const overviewUrl = '/watchlist/overview?' + query.toString();
  useEffect(()=>{
    let alive=true,controller:AbortController|null=null;
    async function load(){if(document.hidden || controller)return;controller=new AbortController();setLoading(true);
      try {const value=await api<OverviewData>(overviewUrl,{signal:controller.signal});if(alive){setData(value);setError('');}}
      catch(e){if(alive&&!(e instanceof DOMException&&e.name==='AbortError'))setError(e instanceof Error?e.message:String(e));}
      finally{controller=null;if(alive)setLoading(false);}
    }
    void load();const timer=window.setInterval(()=>void load(),60_000);document.addEventListener('visibilitychange',load);
    return()=>{alive=false;controller?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',load);};
  },[signature,refresh,overviewUrl]);
  const subscriptionKey = JSON.stringify(liveProjects.map(project => [project.id, strengthMarketKey(project)]));
  useEffect(() => {
    const subscriptions: [string, string | null][] = JSON.parse(subscriptionKey);
    const ids = subscriptions.filter(([, key]) => key !== null).map(([id]) => id);
    return connectWatchLive(ids, frame => {
      if (frame.channel === 'quotes') {
        if (frame.type === 'snapshot' && Array.isArray(frame.replay)) restore(frame.replay);
        if (Array.isArray(frame.ticks)) ingest(frame.ticks);
      }
      if (frame.channel === 'flow' && Array.isArray(frame.flows)) {
        const flows = frame.flows;
        setLiveFlow(current => {
          const next = { ...current };
          for (const flow of flows) {
            if (typeof flow?.projectId !== 'string') continue;
            next[flow.projectId] = {
              buy: flow.buy, sell: flow.sell, delta: flow.delta, cvd: flow.cvd,
              spotDelta: flow.spotDelta, perpDelta: flow.perpDelta,
            };
          }
          return next;
        });
      }
      if (!Array.isArray(frame.ticks) || !frame.ticks.length) return;
      const ticks = frame.ticks;
      setLive(current => {
        const next = { ...current };
        for (const tick of ticks) {
          if (typeof tick?.projectId !== 'string') continue;
          next[tick.projectId] = {
            price: Number.isFinite(tick.price) ? tick.price : null,
            change: Number.isFinite(tick.change24hPct) ? tick.change24hPct : null,
            stale: tick.stale === true,
            at: Number(tick.priceAt ?? tick.at) || Date.now(),
          };
        }
        return next;
      });
    }, setConnection);
  }, [subscriptionKey, ingest, restore]);

  const names = new Map(projects.map(project => [project.id, project.tokenSymbol || project.name]));
  const projectColors = new Map(projects.map((project, index) => [project.id, COLORS[index % COLORS.length]]));
  const rows = (data?.rows ?? []).filter(row => names.has(row.projectId));
  const reference = data?.benchmarks?.find(row => row.projectId === benchmark);
  const periodStart = (periodPrice ? now : end) - minutes * 60_000;
  const periodLines = useMemo(() => {
    const lines = new Map<string, ReturnType<typeof periodPriceSeries>>();
    if (!periodPrice || !data) return lines;
    const quoteMarkets = new Map(liveProjects.map(project => [strengthMarketKey(project), project.id]));
    const pricesFor = (row: WatchRow) => {
      const projectId = quoteMarkets.get(`${row.venue}:${row.marketType}:${row.symbol}`);
      return periodPrices(row, projectId ? series.get(projectId) : undefined, periodStart, now);
    };
    const comparison = benchmark === 'absolute' ? undefined : (reference ? pricesFor(reference) : []);
    for (const row of data.rows) lines.set(row.projectId, periodPriceSeries(pricesFor(row), comparison, cadence, periodStart));
    return lines;
  }, [periodPrice, data, liveProjects, series, periodStart, now, benchmark, reference, cadence]);
  const historicalReturn = (row: WatchRow, period: number) => {
    const value = performance(row.candles, end, period);
    if (benchmark === 'absolute' || value === null) return value;
    const ref = reference ? performance(reference.candles, end, period) : null;
    return ref === null ? null : value - ref;
  };
  const relativeLabel = (v: number | null) => v === null ? '—' : benchmark === 'absolute'
    ? pct(v) : `${v > 0 ? '+' : ''}${v.toFixed(2)} pp`;
  const returns = new Map(rows.map(row => {
    const line = periodLines.get(row.projectId), last = line?.points.at(-1);
    const value = liveWindow ? liveReturns.get(row.projectId)?.latest ?? null
      : periodPrice ? (line?.covered && last && now - last.t <= BUCKET ? last.value : null) : historicalReturn(row, minutes);
    return [row.projectId, value] as const;
  }));
  const relative = (row: WatchRow) => returns.get(row.projectId) ?? null;
  // Keep the same traces visible when a feed goes quiet. Rankings still require fresh returns.
  const lastObservedReturn = (row: WatchRow) => liveWindow
    ? liveReturns.get(row.projectId)?.points.at(-1)?.value : periodPrice ? periodLines.get(row.projectId)?.points.at(-1)?.value : relative(row);
  const sorted = [...rows].sort((a, b) => {
    const left = lastObservedReturn(a) ?? -Infinity, right = lastObservedReturn(b) ?? -Infinity;
    return left === right ? (liveWindow ? a.projectId.localeCompare(b.projectId) : 0) : right - left;
  });
  const chartRows = selected === null ? sorted.slice(0, 4) : rows.filter(row => selected.includes(row.projectId));
  const withLiveFlow=(row:WatchRow):WatchRow=>liveFlow[row.projectId]?{...row,flow:{...(row.flow??{buy:null,sell:null,delta:null,cvd:null,spotDelta:null,perpDelta:null,buckets:[],venues:[],covered:0,requested:0,source:'orderflow' as const}),...liveFlow[row.projectId]}}:row;
  const chartLines = chartRows.map(row => {
    const observed = liveReturns.get(row.projectId);
    return {
      id: row.projectId, name: names.get(row.projectId)!, color: projectColors.get(row.projectId)!,
      points: liveWindow ? observed?.points ?? [] : periodPrice ? periodLines.get(row.projectId)?.points ?? [] : historicalStrengthPoints(row, reference, end, minutes, indicator, benchmark),
      stale: liveWindow ? !!observed?.stale : periodPrice && now - (periodLines.get(row.projectId)?.points.at(-1)?.t ?? 0) > BUCKET,
    };
  });
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
  const unit = indicator === 'price' && benchmark !== 'absolute' ? 'pp'
    : indicator === 'price' || indicator === 'oi' ? '%' : 'USDT';
  const indicatorLabel=(value:number|null)=>value==null?'—':indicator==='price'?relativeLabel(value):indicator==='oi'?`${value>0?'+':''}${value.toFixed(2)}%`:`${value>0?'+':''}${money(value)}`;
  const hasRecentQuote = chartLines.some(line => !line.stale && line.points.length > 0);
  const waitingForQuote = liveWindow && !hasRecentQuote && chartLines.some(line => line.points.length > 0);
  const connectionNote = {
    live: waitingForQuote ? t('报价通道已连接，等待所选项目的新报价', 'Connected · Waiting for fresh quotes for selected projects') : '',
    offline: t('网络离线', 'Network offline'),
    connecting: t('正在连接报价服务', 'Connecting to quotes'),
    reconnecting: t('报价连接中断，正在重连', 'Reconnecting to quotes'),
    syncing: t('正在同步最近报价', 'Resynchronizing recent quotes'),
  }[connection];
  const plotEnd = liveWindow || periodPrice ? now : end;
  const plotStart = liveWindow ? liveStart : periodStart;
  const canShowLive = indicator === 'price' && benchmark === 'absolute';
  const setWindow = (period: number) => { setMinutes(period); setHover(null); };
  const stale=!!data&&(Date.now()-data.end>10*60_000||!!error);
  return <div className="wo">
    <div className="wo-heading"><div><h1>{t('关注总览','Watchlist Overview')}</h1></div><div className="wo-actions"><span role="status">{loading?t('更新中…','Updating…'):data?<>{data.cache?.stale?'STALE · ':''}{t('截至','As of')} {new Date(data.end).toLocaleTimeString(zh?'zh-CN':'en-GB')}</>:'—'}</span><button onClick={()=>setRefresh(n=>n+1)} disabled={loading}>{t('刷新','Refresh')}</button><button onClick={()=>setFlowOpen(v=>!v)} aria-pressed={flowOpen}>{t('资金流','Flow')}</button><button onClick={()=>setCardsOpen(v=>!v)} aria-pressed={cardsOpen}>{t('流动卡','Cards')}</button>
      <button type="button" ref={enterFullscreen} disabled={!hasProjects} aria-controls={hasProjects ? panelId : undefined} aria-pressed={fullscreen} onClick={()=>setFullscreen(v=>!v)}>{t('全屏','Fullscreen')}</button>
      <button onClick={onManage}>{t('管理关注','Manage projects')}</button></div></div>
    {error&&<div className="wo-notice" role="alert">{t('更新失败，保留上次数据：','Update failed; retaining previous data: ')}{error}</div>}
    {stale&&<div className="wo-notice">{t('数据已延迟，请核对时间后使用。','Data delayed. Check timestamps before use.')}</div>}
    {!hasProjects?<div className="wo-empty"><h2>{t('先添加你的关注项目','Add your first project')}</h2><p>{t('总览只加载已添加的项目，不扫描全市场。','This overview only loads your projects.')}</p><button onClick={onManage}>{t('添加项目','Add project')}</button></div>:<>
    <div className="wo-ticker" aria-label={t('关注行情','Watchlist quotes')}>
      {rows.map(r=><button key={r.projectId} onClick={()=>onOpen(r.projectId)}><strong>{names.get(r.projectId)}</strong><span>{(live[r.projectId]?.price??r.candles.at(-1)?.close)?.toLocaleString(zh?'zh-CN':'en-US',{maximumSignificantDigits:7})??'—'} <small>{r.quote} · {live[r.projectId]?.stale?'STALE':watchStatus(r)}</small></span><b className={(live[r.projectId]?.change??performance(r.candles,end,1440)??0)>=0?'wo-up':'wo-down'}>{pct(live[r.projectId]?.change??performance(r.candles,end,1440))}</b></button>)}
    </div>
    <div className="wo-pulse"><span className="wo-scope">{t('关注范围','WATCHLIST')} <b>{rows.length}</b></span><span>{t('上涨','Advancing')} <b className="wo-up">▲ {gainers.length}</b></span><span>{t('下跌','Declining')} <b className="wo-down">▼ {losers.length}</b></span><span>{t('平均','Average')} <b className={(average??0)>=0?'wo-up':'wo-down'}>{relativeLabel(average)}</b></span><span>{t('有效样本','Valid samples')} <b>{valid.length}/{rows.length}</b></span><span className="wo-pulse-end">{windowLabel(minutes)} · {benchmark==='absolute'?t('绝对涨跌','Absolute'):benchmark.replace('USDT','')} · {liveWindow ? t('秒级报价','Live quotes') : periodPrice ? t('收盘价 + 最新报价','Closes + latest quotes') : t('5m 收盘','5m close')}</span></div>
    <section id={panelId} className={`wo-panel wo-main-panel ${fullscreen?'wo-fullscreen':''}`}>
      <div className="wo-panel-head"><h2><i>01</i>{t('相对强弱','Relative strength')}</h2>
        <div className="wo-controls">
          <select aria-label={t('指标','Indicator')} value={indicator} onChange={event => {
            const next = event.target.value as WatchIndicator;
            setIndicator(next);
            if (liveWindow && next !== 'price') setMinutes(5);
            setHover(null);
          }}>
            <option value="price">{t('价格强弱','Price strength')}</option><option value="cvd">CVD</option>
            <option value="flow">{t('主动净额','Flow Δ')}</option><option value="oi">{t('OI 变化','OI Δ')}</option>
          </select>
          <div className="wo-tabs">{windows.map(period => <button key={period}
            disabled={period === 1 && !canShowLive} aria-pressed={minutes === period}
            title={period === 1 ? t('自本次首笔报价起的涨跌幅', 'Return since the first quote in this session') : undefined}
            onClick={() => setWindow(period)}>{windowLabel(period)}</button>)}</div>
          <select aria-label={t('比较基准','Benchmark')} value={benchmark} onChange={event => {
            const next = event.target.value;
            setBenchmark(next);
            if (liveWindow && next !== 'absolute') setMinutes(5);
            setHover(null);
          }}>
            <option value="absolute">{t('绝对涨跌','Absolute return')}</option><option value="BTCUSDT">vs BTC</option><option value="ETHUSDT">vs ETH</option>
          </select>
        </div>
        {fullscreen && <button type="button" className="wo-exit-fullscreen" ref={exitFullscreen} onClick={()=>setFullscreen(false)}>
          {t('退出全屏','Exit fullscreen')}
        </button>}
      </div>
      <div className="wo-strength"><div className="wo-chart">
        <div className="wo-legend">{rows.map(row => {
          const line = chartLines.find(item => item.id === row.projectId);
          const value = !line ? null : hover !== null && hover >= plotStart && hover <= plotEnd
            ? periodPrice ? periodPriceValueAt(line.points, hover) : strengthValueAt(line.points, hover, liveWindow ? STRENGTH_GAP_MS : 0)
            : liveWindow ? relative(row) : periodPrice ? line.points.at(-1)?.value ?? null : strengthValueAt(line.points, plotEnd, 0);
          return <button key={row.projectId} aria-pressed={!!line} onClick={() => toggle(row.projectId)} style={{ color: line?.color }}>
            <span className="wo-dot"/>{names.get(row.projectId)} <b>{indicatorLabel(value)}</b>
          </button>;
        })}<small>{t('最多选 4 个','Up to 4')}</small></div>
        <StrengthPlot key={`${minutes}:${benchmark}:${indicator}`} live={liveWindow} updatingPeriod={periodPrice} lines={chartLines} start={plotStart} end={plotEnd} gapMs={liveWindow ? STRENGTH_GAP_MS : BUCKET}
          unit={unit} language={language} hoverTime={hover} onHoverTime={setHover}
          ariaLabel={liveWindow ? t('关注项目自本次首笔报价起的实时涨跌幅','Live watchlist returns since the first session quote') : t('所选周期内的关注项目指标走势','Watchlist indicator trends over the selected period')}
          emptyText={!chartRows.length ? t('选择标的以对比走势','Select projects to compare')
            : liveWindow ? t('等待实时报价…','Waiting for live quotes…')
            : t('所选标的暂无历史数据','No historical data for the selected projects')}/>
    <div className="wo-chart-foot"><span>{liveWindow ? (connectionNote || t('首笔报价归零 · 每秒更新 · 缺报时沿用上一笔报价','First quote rebased to zero · Updates every second · Holds the last quote during gaps')) : periodPrice ? t(`窗口起点归零 · 每 ${cadence / 1000} 秒刷新 · 末端含未收盘报价`, `Window baseline rebased to zero · Updates every ${cadence / 1000}s · Includes provisional quotes`) : indicator === 'flow' ? t('累计已观测的主动净额','Cumulative observed net flow') : t('各项目以期内首个有效样本归零','Each series starts at zero at its first observation')}</span><button onClick={()=>setTableOpen(!tableOpen)} aria-expanded={tableOpen}>{tableOpen?t('收起周期矩阵 ↑','Hide matrix ↑'):t('周期矩阵 ↓','Timeframe matrix ↓')}</button></div></div>
    <aside className="wo-leaders">{[{title:t('强势榜','Leaders'),items:gainers,positive:true},{title:t('弱势榜','Laggards'),items:losers,positive:false}].map(group=><div className="wo-leader-column" key={group.title}><h3 className={group.positive?'wo-up':'wo-down'}>{group.positive?'↗':'↘'} {group.title}<small>{benchmark === 'absolute' ? '%' : 'pp'}</small></h3>{group.items.slice(0,10).map((r,i)=><button className="wo-leader-row" key={r.projectId} onClick={()=>toggle(r.projectId)} aria-pressed={chartRows.some(c=>c.projectId===r.projectId)} title={t('点击加入或移出图表','Toggle chart comparison')}><em>{i+1}</em><strong>{names.get(r.projectId)}</strong><b className={group.positive?'wo-up':'wo-down'}>{relativeLabel(relative(r))}</b><span className={group.positive?'wo-meter wo-positive':'wo-meter wo-negative'} style={{width:`${Math.min(100,Math.abs(relative(r)??0)/Math.max(.01,...valid.map(Math.abs))*100)}%`}}/></button>)}{!group.items.length&&<div className="wo-small-empty">{t('暂无符合标的','No matching projects')}</div>}</div>)}</aside></div>
    <details className="wo-coverage wo-metric-coverage"><summary>{t('指标覆盖详情','Metric coverage')}</summary><div className="wo-metric-grid">{rows.map(r=><div key={r.projectId} className="wo-metric-row"><strong>{names.get(r.projectId)}</strong>{Object.entries(buildWatchMetrics(r)).map(([name,metric])=><span key={name} className={metric.state==='LIVE'?'ok':'off'} title={`${metric.state}${metric.at?` · ${new Date(metric.at).toLocaleTimeString()}`:''}${metric.error?` · ${metric.error}`:''}${metric.source?` · ${metric.source}`:''}`}>{name}</span>)}</div>)}</div></details>
    {tableOpen&&<div className="wo-table-scroll"><table><thead><tr><th>{t('标的 / 研究','Project / Research')}</th>{[15,60,240,1440].map(m=><th key={m}>{m<60?`${m}m`:`${m/60}h`}</th>)}</tr></thead><tbody>{sorted.map(r=><tr key={r.projectId}><td><button className="wo-link" onClick={()=>onOpen(r.projectId)}>{names.get(r.projectId)} ↗</button><small title={r.error??''}>{r.venue} · {r.marketType==='spot'?t('现货','Spot'):t('永续','Perp')}{r.error?' · !':''}</small></td>{[15,60,240,1440].map(m=>{const v=historicalReturn(r,m);return <td key={m} className={v===null?'':v>=0?'wo-up':'wo-down'}>{relativeLabel(v)}</td>;})}</tr>)}</tbody></table></div>}
    </section>
    <div className="wo-bottom wo-dock">
    {flowOpen&&<CapitalFlowVisual rows={chartRows.map(withLiveFlow)} names={names} colors={COLORS} language={language}/>}
    <LiveFlowEvents rows={rows} names={names} end={end} onOpen={onOpen} language={language}/>
    {cardsOpen&&<FlowCards rows={rows.map(withLiveFlow)} names={names} end={end} language={language}/>}
    <section className="wo-panel"><div className="wo-panel-head"><h2><i>02</i>{t('异动流','Anomaly flow')}</h2><span>{t('最近 24h','Last 24h')}</span></div><div className="wo-tabs wo-dock-tabs">{[['all',t('全部','All')],['up',t('急涨','Rising')],['down',t('急跌','Falling')],['volume',t('放量','Volume')]].map(([id,label])=><button key={id} aria-pressed={feedFilter===id} onClick={()=>setFeedFilter(id)}>{label}</button>)}</div>
    <div className="wo-feed">{visibleEvents.map(e=><button className="wo-event wo-tape-row" key={`${e.row.projectId}:${e.time}`} onClick={()=>onOpen(e.row.projectId)} title={`${e.row.venue} · ${e.row.symbol} · ${new Date(e.time).toLocaleString()}`}><time>{stamp(e.time)}</time><strong>{names.get(e.row.projectId)}</strong><span className={Math.abs(e.change)>=priceGate?(e.change>0?'wo-tag wo-up':'wo-tag wo-down'):'wo-tag'}>{Math.abs(e.change)>=priceGate?(e.change>0?t('急涨','Rise'):t('急跌','Fall')):t('放量','Volume')}</span><b className={e.change>=0?'wo-up':'wo-down'}>{pct(e.change)}</b><small>{e.ratio!==null&&e.ratio>=volumeGate?`${e.ratio.toFixed(1)}×`:''}</small></button>)}{!visibleEvents.length&&<div className="wo-empty">{t('暂无满足条件的观测','No matching observations')}</div>}</div>
    <details className="wo-method"><summary>{t('阈值与口径 · 5m 已收盘','Thresholds · Closed 5m candles')}</summary><div className="wo-thresholds"><label>{t('涨跌 ≥','Move ≥')}<input type="number" min="0.1" step="0.1" max="100" value={priceGate} onChange={e=>setPriceGate(Math.min(100,Math.max(.1,Number(e.target.value)||.1)))}/>%</label><label>{t('放量 ≥','Volume ≥')}<input type="number" min="1" step="0.5" max="100" value={volumeGate} onChange={e=>setVolumeGate(Math.min(100,Math.max(1,Number(e.target.value)||1)))}/>×</label></div><p>{t('5m 成交额 / 前 12 根中位数；每根合并一条，最多 80 条。','5m turnover / prior 12-candle median. One observation per candle, latest 80.')}</p></details></section>
    <section className="wo-panel"><div className="wo-panel-head"><h2><i>03</i>{t('资金费率极值','Funding extremes')}</h2><span>{t('已结算 · 8h 折算','Settled · 8h equiv.')}</span></div><div className="wo-funding-pair">{[{positive:true,title:t('正费率','Positive')},{positive:false,title:t('负费率','Negative')}].map(group=>{const list=funding.filter(r=>group.positive?r.value>0:r.value<0).sort((a,b)=>group.positive?b.value-a.value:a.value-b.value);return <div key={group.title}><h3 className={group.positive?'wo-up':'wo-down'}>{group.title}<small>{list.length}</small></h3>{list.map(({row,value})=><button className="wo-funding-row" key={row.projectId} onClick={()=>onOpen(row.projectId)} title={`${row.venue} · ${row.symbol} · ${new Date(row.funding!.time).toLocaleString()}`}><strong>{names.get(row.projectId)}</strong><small>{row.funding!.hours}h</small><b className={group.positive?'wo-up':'wo-down'}>{pct(value)}</b></button>)}{!list.length&&<div className="wo-small-empty">{t('暂无有效样本','No valid samples')}</div>}</div>;})}</div><details className="wo-method"><summary>{t('费率口径与结算时间','Funding methodology & timestamps')}</summary><p>{t('最近一期已结算费率，按观测结算间隔折算至 8h；非预测费率。周期未知或结算超过 24h 不排名。','Latest settled funding normalized to 8h using observed interval; not a forecast. Unknown intervals or settlements older than 24h excluded.')}</p>{funding.map(({row})=><p key={row.projectId}>{names.get(row.projectId)} · {row.venue} · {new Date(row.funding!.time).toLocaleString()}</p>)}</details></section>
    <section className="wo-panel"><div className="wo-panel-head"><h2><i>04</i>{t('成交活跃度','Volume activity')}</h2><select aria-label={t('市场类型','Market type')} value={market} onChange={e=>setMarket(e.target.value)}><option value="perpetual">{t('永续','Perpetual')}</option><option value="spot">{t('现货','Spot')}</option></select></div><div className="wo-tabs wo-dock-tabs">{[['surge',t('5m 放量倍数','5m volume spike')],['volume',t('24h 成交额','24h turnover')]].map(([id,label])=><button key={id} aria-pressed={rank===id} onClick={()=>setRank(id)}>{label}</button>)}</div><div className="wo-feed">{ranked.map(({row,value},i)=><button className="wo-volume-row" key={row.projectId} onClick={()=>onOpen(row.projectId)}><em>{String(i+1).padStart(2,'0')}</em><div><strong>{names.get(row.projectId)}</strong><small>{row.venue} · {row.symbol}</small></div><b>{rank==='surge'?`${value.toFixed(2)}×`:`${money(value)} USDT`}</b><span className="wo-volume-meter" style={{width:`${Math.min(100,value/Math.max(.01,ranked[0]?.value??1)*100)}%`}}/></button>)}{!ranked.length&&<div className="wo-empty">{t('暂无满足口径的有效样本','No comparable samples available')}</div>}</div><details className="wo-method"><summary>{t('仅 USDT · 查看统计口径','USDT only · Methodology')}</summary><p>{t('同市场类型比较；历史缺口及过期样本不排名。5m 放量以此前 12 根中位数为基准，24h 成交额为完整窗口求和。','Compared within the same market type. Gaps and stale candles excluded. Spike uses the prior 12-candle median; 24h turnover uses a complete window.')}</p></details></section></div>
    {rows.some(r=>r.error)&&<details className="wo-coverage"><summary>{t('查看数据覆盖与限制','Data coverage & limitations')}</summary>{rows.filter(r=>r.error).map(r=><p key={r.projectId}>{names.get(r.projectId)} · {r.venue} · {r.error}</p>)}</details>}
    </>}
  </div>;
}
