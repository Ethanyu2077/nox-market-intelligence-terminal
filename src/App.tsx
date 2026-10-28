import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, Archive, ArrowDown, ArrowUp, BarChart3, Check, CheckCircle2, ChevronDown, Copy, Database, Edit3, FolderKanban, Gauge, Menu, Moon, Plus, RefreshCw, Search, Sun, Trash2, Waves, X } from 'lucide-react';
import type { CandlePoint, CvdPoint, ExchangeCapabilities, ExchangeSelection, LinePoint, MarketProject, MarketSeries, OiDeltaPoint, OnchainProjectSnapshot, Overview, PositionFlowSignal, ProjectDiscoveryResult, ProjectMarket, ProjectResearchContext, ProjectVenueResponse, VolumeFlowPoint } from '../shared/types';
import { ChartModeSwitcher, TradingViewChartPanel, type ChartMode } from './TradingViewChart';
import { ResearchWorkspace } from './ResearchWorkspace';
import { OrderFlowPage } from './OrderFlowPage';
import { AccessBar, CollectionPanel } from './Operations';
import {EventStudyPage} from './EventStudyPage';
import { RegimeV2Panel } from './RegimeV2Panel';
import {BinanceWeb3Panel,Web3ConnectionStatus} from './BinanceWeb3Panel';
import {ProviderSettings} from './ProviderSettings';
import {CoinGlassPanel} from './CoinGlassPanel';
import {KoreanSpotPanel} from './KoreanSpotPanel';
import {BinanceExchangePanel} from './BinanceExchangePanel';

type Page = 'projects' | 'overview' | 'structure' | 'positionFlow' | 'derivatives' | 'contribution' | 'crossExchange' | 'liquidity' | 'signals' | 'history' | 'settings' | 'research' | 'orderflow';
type Interval = '1m' | '5m' | '15m' | '1h' | '4h';
type ConnectionState = 'connecting' | 'live' | 'stale' | 'degraded';
type Language = 'en' | 'zh';
type Theme = 'dark' | 'light';
const API = '/api';
const EXCHANGES: Array<{ id: ExchangeSelection; label: string }> = [
  { id: 'aggregated', label: 'Aggregated' }, { id: 'binance', label: 'Binance' }, { id: 'bitget', label: 'Bitget' },
  { id: 'bybit', label: 'Bybit' }, { id: 'okx', label: 'OKX' }, { id: 'gate', label: 'Gate' }, { id: 'kucoin', label: 'KuCoin' }, { id: 'mexc', label: 'MEXC' }
];

const ZH: Record<string, string> = {
  'Research Workspace': '研究工作区',
  'Advanced Order Flow': '高级订单流',
  'WATCHLIST': '观察列表', 'PROJECT': '项目', 'SYSTEM': '系统', 'Project Watchlist': '项目观察列表', 'Market Overview': '市场概览',
  'Market Structure': '市场结构', 'Exchange Contribution': '交易所贡献', 'Cross-Exchange Analysis': '跨交易所分析', 'Liquidity Intelligence': '流动性情报',
  'Price / OI / CVD': '价格 / OI / CVD', 'Position Flow': '仓位资金流', 'Funding & Liquidations': '资金费率与清算',
  'Order Book & Liquidity': '订单簿与流动性', 'Signals & Alerts': '信号与提醒', 'Historical Analysis': '历史分析', 'Settings / Data Sources': '设置 / 数据源',
  'Intelligence': '市场情报', 'Select a project': '选择项目', 'PROJECT MODE': '项目模式', 'SELECTED MARKETS ONLY': '仅已选市场',
  'Manage projects': '管理项目', 'No primary market': '无主市场', 'markets': '个市场', 'Refresh': '刷新',
  'CUSTOM PROJECT MONITORING': '自定义项目监控', 'Add project': '添加项目', 'Create first project': '创建第一个项目', 'No default markets': '没有默认市场',
  'Monitoring projects': '监控项目', 'Project': '项目', 'Market mapping': '市场映射', 'Current price': '当前价格', '24H change': '24小时涨跌',
  'Volume': '成交量', 'Open interest': '持仓量', 'OI delta': 'OI 变化', 'Funding': '资金费率', 'Structure': '结构', 'Alerts': '提醒', 'Manage': '管理',
  '24H notional': '24小时名义金额', 'Load on select': '选择后加载', 'No active sample': '暂无有效样本', 'No active signal': '暂无信号', 'Idle': '空闲',
  'PROJECT MONITOR': '项目监控', 'Open synchronized analysis': '打开同步分析', 'Monitored markets': '已监控市场', 'Market state': '市场状态',
  'FLAGSHIP ANALYSIS': '核心分析', 'Price & volume': '价格与成交量', 'Observed evidence': '已观测证据', 'Counterevidence & limits': '反向证据与限制',
  'POSITION FLOW INTELLIGENCE': '仓位资金流情报', 'Price & candlesticks': '价格与K线', 'Historical signal replay': '历史信号回放',
  'Classification evidence': '分类证据', 'Historical reliability check': '历史可靠性检验', 'DERIVATIVES': '衍生品', 'Open interest history': '持仓量历史',
  'Funding settlement': '资金费率结算', 'Data sources & methodology': '数据源与计算方法', 'Calculation contract': '计算约定',
  'Known source limitations': '已知数据限制', 'Operational': '运行正常', 'Checking': '检查中', 'Retry': '重试', 'Live data unavailable': '实时数据不可用',
  'PUBLIC MARKET DATA': '公开市场数据', 'NO PROJECT SELECTED': '未选择项目', 'NO PRIMARY MARKET': '无主市场', 'Last stream event': '最近数据事件', 'waiting': '等待中',
  'NEW MONITORING PROJECT': '新建监控项目', 'Discover token markets': '发现代币市场', 'Token symbol or contract address': '代币符号或合约地址',
  'Search markets': '搜索市场', 'Cancel': '取消', 'Create project': '创建项目', 'Edit monitoring project': '编辑监控项目', 'Save changes': '保存更改',
  'Observed': '已观测', 'Signals': '信号', 'Price': '价格', 'Taker buy / sell': '主动买入 / 卖出', 'Volume delta': '成交量差',
  'Cumulative volume delta': '累计成交量差', 'Base quantity': '代币数量', 'Current rate': '当前费率', 'Next settlement': '下次结算',
  'Supporting evidence': '支持证据', 'Counterevidence / limits': '反向证据 / 限制',
  'Potential Long Build-up': '潜在多头建仓', 'Potential Short Build-up': '潜在空头建仓', 'Potential Long Liquidation': '潜在多头清算',
  'Potential Short Covering': '潜在空头回补', 'Market Absorption': '市场吸收', 'Price / OI / Delta Divergence': '价格 / OI / Delta 背离',
  'TradingView Advanced Chart': 'TradingView 高级图表', 'NOX Market Structure': 'NOX 市场结构',
  'On-chain liquidity context': '链上流动性上下文', 'Top liquidity pools': '主要流动性池', 'Research context': '研究上下文',
  'Token price':'代币价格','Token liquidity':'代币流动性','24H DEX volume':'24H DEX 成交额','Top-pool coverage':'主要池覆盖','DexPaprika token summary':'DexPaprika 代币汇总','Transactions':'交易笔数','Fee':'费率','Observed public data':'公开数据观测','Source':'来源','24H DEX buy (provider)':'24H DEX 买入（上游口径）','24H DEX sell (provider)':'24H DEX 卖出（上游口径）',
  'Copy research JSON': '复制研究 JSON', 'Copied': '已复制', 'Exchange capability matrix': '交易所能力矩阵',
  'LIVE': '实时', 'CONNECTING': '连接中', 'STALE': '已延迟', 'DEGRADED': '降级', 'now': '刚刚', 'unavailable': '不可用'
};

function translate(value: string, language: Language) {
  if (language === 'en') return value;
  if (ZH[value]) return ZH[value];
  const active = value.match(/^(\d+) active · (\d+) archived$/); if (active) return `${active[1]} 个启用 · ${active[2]} 个已归档`;
  if (value.endsWith(' structure')) return `${value.slice(0, -10)} 结构分析`;
  if (value.endsWith(' derivatives flow')) return `${value.slice(0, -17)} 衍生品资金流`;
  if (value.endsWith(' positioning')) return `${value.slice(0, -12)} 衍生品仓位`;
  return value;
}

const UiContext = createContext<{ language: Language; t: (value: string) => string }>({ language: 'en', t: (value) => value });
function useUi() { return useContext(UiContext); }

const NAV: Array<{ id: Page; label: string; icon: string; group?: string; phase?: string }> = [
  { id: 'projects', label: 'Project Watchlist', icon: '◎', group: 'WATCHLIST' },
  { id: 'overview', label: 'Market Overview', icon: '◫', group: 'PROJECT' },
  { id: 'structure', label: 'Market Structure', icon: '▥' },
  { id: 'contribution', label: 'Exchange Contribution', icon: '◩' },
  { id: 'crossExchange', label: 'Cross-Exchange Analysis', icon: '↕' },
  { id: 'liquidity', label: 'Liquidity Intelligence', icon: '⇄' },
  { id: 'research', label: 'Research Workspace', icon: '⊞' },
  { id: 'orderflow', label: 'Advanced Order Flow', icon: '≋' },
  { id: 'signals', label: 'Signals & Alerts', icon: '⌁' },
  { id: 'history', label: 'Historical Analysis', icon: '≡' },
  { id: 'settings', label: 'Settings / Data Sources', icon: '◉', group: 'SYSTEM' }
];

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const body = await response.json();
  if (!response.ok) { if (response.status === 401) window.dispatchEvent(new Event('nox:auth-required')); throw new Error(body?.error?.message ?? 'Request failed'); }
  return body;
}

function formatCompact(value: number | null | undefined, currency = false) {
  if (value == null || !Number.isFinite(value)) return '—';
  const prefix = currency ? '$' : '';
  return prefix + Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}
function formatPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : 6;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}
function signed(value: number, suffix = '%') { return `${value > 0 ? '+' : ''}${value.toFixed(2)}${suffix}`; }
function timeAgo(timestamp: number | null) {
  if (!timestamp) return 'unavailable';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return seconds < 4 ? 'now' : seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}
function countdown(timestamp: number | null | undefined) {
  if (!timestamp) return '—'; const ms = Math.max(0, timestamp - Date.now());
  const h = Math.floor(ms / 3_600_000); const m = Math.floor((ms % 3_600_000) / 60_000); const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function venueOverview(data: ProjectVenueResponse, selection: ExchangeSelection, project: MarketProject): Overview | null {
  if (selection === 'aggregated') {
    const row = data.aggregate; if (row.price == null) return null;
    return { symbol: `${project.tokenSymbol} · AGG`, price: row.price as number, markPrice: row.markPrice as number, change24hPct: row.change24hPct as number, volume24hBase: null as unknown as number, volume24hUsd: row.volume24hUsd as number, oiBase: row.oiBase as number, oiUsd: row.oiUsd as number, fundingRate: row.fundingRate as number, nextFundingTime: null as unknown as number, cvdWindowDelta: null, cvdWindowFrom: null, eventTime: row.eventTime ?? Date.now(), source: `Aggregated · ${row.coverage.successful}/${row.coverage.requested} venues`, quality: row.coverage.successful === row.coverage.requested ? 'live' : 'partial' };
  }
  const row = data.snapshots.find((item) => item.exchange === selection); if (!row) return null;
  return { symbol: row.symbol, price: row.price as number, markPrice: row.markPrice as number, change24hPct: row.change24hPct as number, volume24hBase: row.volume24hBase as number, volume24hUsd: row.volume24hUsd as number, oiBase: row.oiBase as number, oiUsd: row.oiUsd as number, fundingRate: row.fundingRate as number, nextFundingTime: row.nextFundingTime as number, cvdWindowDelta: row.cvd, cvdWindowFrom: null, eventTime: row.eventTime, source: row.source, quality: row.quality };
}
function intervalMs(interval: Interval) { const value = Number(interval.slice(0, -1)); return value * (interval.endsWith('m') ? 60_000 : 3_600_000); }
function appendAggregateTrade(current: MarketSeries, trade: { p: string; q: string; m: boolean; T: number }, interval: Interval): MarketSeries {
  const price = Number(trade.p), quantity = Number(trade.q), notional = price * quantity; const delta = trade.m ? -notional : notional; const time = Math.floor(trade.T / intervalMs(interval)) * intervalMs(interval);
  const candles = [...current.candles]; const candleIndex = candles.findIndex((point) => point.time === time);
  if (candleIndex >= 0) { const point = candles[candleIndex]; candles[candleIndex] = { ...point, high: Math.max(point.high, price), low: Math.min(point.low, price), close: price, volumeBase: point.volumeBase + quantity, volumeUsd: point.volumeUsd + notional }; }
  else if (!candles.length || time > candles.at(-1)!.time) { candles.push({ time, open: price, high: price, low: price, close: price, volumeBase: quantity, volumeUsd: notional }); if (candles.length > 120) candles.shift(); }
  const cvd = [...current.cvd]; const last = cvd.at(-1);
  if (!last || time > last.time) cvd.push({ time, value: (last?.value ?? 0) + delta, delta, buyNotional: delta >= 0 ? notional : 0, sellNotional: delta < 0 ? notional : 0 });
  else if (time === last.time) cvd[cvd.length - 1] = { ...last, value: last.value + delta, delta: last.delta + delta, buyNotional: last.buyNotional + (delta >= 0 ? notional : 0), sellNotional: last.sellNotional + (delta < 0 ? notional : 0) };
  const latest = cvd.at(-1); const volumeFlow = latest ? [...current.positionFlow.volumeFlow.filter((point) => point.time !== latest.time), { time: latest.time, value: latest.delta, buyNotional: latest.buyNotional, sellNotional: latest.sellNotional, deltaNotional: latest.delta, imbalancePct: latest.buyNotional + latest.sellNotional ? latest.delta / (latest.buyNotional + latest.sellNotional) * 100 : 0, deltaChangePct: null }] : current.positionFlow.volumeFlow;
  return { ...current, candles, cvd, positionFlow: { ...current.positionFlow, volumeFlow }, coverage: { ...current.coverage, tradeCount: current.coverage.tradeCount + 1 }, eventTime: trade.T };
}

export default function App() {
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem('nox-language') === 'zh' ? 'zh' : 'en');
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('nox-theme') === 'light' ? 'light' : 'dark');
  const [page, setPage] = useState<Page>('projects');
  const [interval, setIntervalValue] = useState<Interval>('5m');
  const [projects, setProjects] = useState<MarketProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [series, setSeries] = useState<MarketSeries | null>(null);
  const [venueData, setVenueData] = useState<ProjectVenueResponse | null>(null);
  const [exchange, setExchange] = useState<ExchangeSelection>('aggregated');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [lastStreamEvent, setLastStreamEvent] = useState(0);
  const lastTradeId = useRef<number | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedProjectId && !project.archived) ?? null, [projects, selectedProjectId]);
  const t = useCallback((value: string) => translate(value, language), [language]);
  const localizedSeries = useMemo(() => language === 'zh' && series ? { ...series, positionFlow: { ...series.positionFlow, signals: series.positionFlow.signals.map((signal) => ({ ...signal, label: translate(signal.label, language) })) } } : series, [language, series]);
  const primaryMarket = selectedProject?.markets.find((market) => market.id === selectedProject.primaryMarketId) ?? selectedProject?.markets.find((market) => market.marketType === 'perpetual') ?? null;
  const activeMarket = exchange === 'aggregated' ? primaryMarket : selectedProject?.markets.find((market) => market.exchange === exchange && market.marketType === 'perpetual') ?? null;
  const analyticsMarket = activeMarket?.exchange === 'binance' ? activeMarket : selectedProject?.markets.find((market) => market.exchange === 'binance' && market.marketType === 'perpetual') ?? null;
  const symbol = analyticsMarket?.symbol ?? '';

  const refreshProjects = useCallback(async (preferredId?: string) => {
    const response = await api<{ items: MarketProject[]; selectedProjectId: string | null }>('/projects');
    setProjects(response.items);
    const next = preferredId ?? response.selectedProjectId ?? response.items.find((project) => !project.archived)?.id ?? null;
    setSelectedProjectId(next);
    const project = response.items.find((item) => item.id === next);
    if (project) setIntervalValue(project.monitoring.defaultInterval);
    return response.items;
  }, []);

  useEffect(() => { void refreshProjects().catch((cause) => setError(cause instanceof Error ? cause.message : 'Project database unavailable')); }, [refreshProjects]);

  const load = useCallback(async (quiet = false) => {
    if (!selectedProject) { setOverview(null); setSeries(null); setVenueData(null); setLoading(false); return; }
    if (!quiet) setLoading(true); setError('');
    const requests: Array<Promise<unknown>> = [api<ProjectVenueResponse>(`/projects/${selectedProject.id}/venues`)];
    if (symbol) requests.push(api<MarketSeries>(`/market/${symbol}/series?interval=${interval}`));
    const [venues, nativeSeries] = await Promise.allSettled(requests);
    if (venues.status === 'fulfilled') { const data = venues.value as ProjectVenueResponse; setVenueData(data); setOverview(venueOverview(data, exchange, selectedProject)); }
    if (nativeSeries?.status === 'fulfilled') setSeries(nativeSeries.value as MarketSeries); else if (!symbol) setSeries(null);
    const failures = [venues, nativeSeries].filter((result) => result?.status === 'rejected') as PromiseRejectedResult[];
    if (failures.length) setError(`${requests.length - failures.length} of ${requests.length} selected-project datasets loaded; ${failures[0].reason instanceof Error ? failures[0].reason.message : 'an upstream request failed'}`);
    setLoading(false);
  }, [symbol, interval, selectedProject, exchange]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!symbol) return; const timer = setInterval(() => { void load(true); }, 60_000); return () => clearInterval(timer); }, [symbol, load]);
  useEffect(() => {
    if (!activeMarket || !selectedProject?.monitoring.streamingEnabled) { setConnection('stale'); return; }
    const events = new EventSource(`${API}/market/${activeMarket.exchange}/${activeMarket.symbol}/stream`);
    const connectionListener = (event: MessageEvent) => { const update = JSON.parse(event.data); setConnection(update.state); };
    const marketListener = (event: MessageEvent) => {
      const wrapper = JSON.parse(event.data); const data = wrapper.data ?? wrapper;
      setLastStreamEvent(Date.now());
      setConnection(wrapper.transport === 'rest-fallback' ? 'degraded' : 'live');
      if (data.e === '24hrTicker') setOverview((old) => old ? { ...old, price: Number(data.c), change24hPct: Number(data.P), volume24hBase: Number(data.v), volume24hUsd: Number(data.q), eventTime: data.E } : old);
      if (data.e === 'markPriceUpdate') setOverview((old) => old ? { ...old, markPrice: Number(data.p), fundingRate: Number(data.r), nextFundingTime: data.T, eventTime: data.E } : old);
      if (data.e === 'aggTrade' && Number.isFinite(Number(data.a)) && (lastTradeId.current == null || Number(data.a) > lastTradeId.current)) { lastTradeId.current = Number(data.a); setSeries((old) => old ? appendAggregateTrade(old, data, interval) : old); }
      if (data.kind === 'ticker') setOverview((old) => old ? { ...old, price: data.price ?? old.price, markPrice: data.markPrice ?? old.markPrice, change24hPct: data.change24hPct ?? old.change24hPct, volume24hBase: data.volumeBase ?? old.volume24hBase, volume24hUsd: data.volumeUsd ?? old.volume24hUsd, fundingRate: data.fundingRate ?? old.fundingRate, nextFundingTime: data.nextFundingTime ?? old.nextFundingTime, eventTime: data.eventTime ?? Date.now() } : old);
      if (data.kind === 'funding') setOverview((old) => old ? { ...old, fundingRate: data.fundingRate ?? old.fundingRate, nextFundingTime: data.nextFundingTime ?? old.nextFundingTime, eventTime: data.eventTime ?? Date.now() } : old);
      if (data.kind === 'openInterest') setOverview((old) => old ? { ...old, oiBase: data.oiBase ?? old.oiBase, oiUsd: data.oiUsd ?? old.oiUsd, eventTime: data.eventTime ?? Date.now() } : old);
    };
    events.addEventListener('connection', connectionListener as EventListener); events.addEventListener('market', marketListener as EventListener);
    events.onerror = () => setConnection('stale');
    return () => { lastTradeId.current = null; events.close(); };
  }, [activeMarket, interval, selectedProject?.monitoring.streamingEnabled]);
  useEffect(() => { const timer = setInterval(() => setConnection((s) => lastStreamEvent && Date.now() - lastStreamEvent > 20_000 ? 'stale' : s), 5_000); return () => clearInterval(timer); }, [lastStreamEvent]);
  useEffect(() => { localStorage.setItem('nox-language', language); document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; }, [language]);
  useEffect(() => { localStorage.setItem('nox-theme', theme); document.documentElement.style.colorScheme = theme; }, [theme]);

  const selectProject = async (id: string) => {
    const project = projects.find((item) => item.id === id);
    setSelectedProjectId(id); setOverview(null); setSeries(null); setLastStreamEvent(0);
    if (project) setIntervalValue(project.monitoring.defaultInterval);
    // Viewing another project is read-only; persist the preference only for signed-in operators.
    const status = await fetch('/api/auth/status').then(r => r.json()).catch(() => null);
    if (status?.user && status.user.role !== 'viewer') await api('/projects/selection', { method: 'POST', body: JSON.stringify({ id }) });
  };

  return <UiContext.Provider value={{ language, t }}><div className={`app-shell ${theme}`}>
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><img src="/nox.png" alt="NOX Ventures"/></div><div className="brand-copy"><strong>NOX Ventures</strong><span>MARKET INTELLIGENCE</span></div><button className="mobile-close" onClick={() => setMobileNav(false)}><X size={18}/></button></div>
      <nav>{NAV.map((item) => <div className="nav-entry" key={item.id}>{item.group && <div className="nav-label">{t(item.group)}</div>}<button className={page === item.id ? 'active' : ''} disabled={!selectedProject && item.id !== 'projects' && item.id !== 'settings'} onClick={() => { setPage(item.id); setMobileNav(false); }}><b className="nav-icon">{item.icon}</b><span>{t(item.label)}</span>{item.phase && <em>{item.phase}</em>}</button></div>)}</nav>
      <div className="sidebar-foot"><div className="operator"><span>N</span><div><strong>NOX Intelligence</strong><small><i/> {language === 'zh' ? '公开数据源运行正常' : 'Public feeds operational'}</small></div></div></div>
    </aside>
    {mobileNav && <button className="scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation"/>}
    <main>
      <Header page={page} projects={projects.filter((project) => !project.archived)} project={selectedProject} onProject={selectProject} onManage={() => setPage('projects')} interval={interval} onInterval={setIntervalValue} exchange={exchange} onExchange={setExchange} connection={connection} onMenu={() => setMobileNav(true)} onRefresh={() => load()} loading={loading} language={language} onLanguage={() => setLanguage((value) => value === 'en' ? 'zh' : 'en')} theme={theme} onTheme={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}/>
      {error && <div className="error-banner"><AlertTriangle size={16}/><div><strong>{t('Live data unavailable')}</strong><span>{error}. {language === 'zh' ? '系统不会使用模拟值替代真实数据。' : 'Values are not replaced with mock data.'}</span></div><button onClick={() => load()}>{t('Retry')}</button></div>}
      <div className="page-content">
        <AccessBar language={language}/>
        {page === 'projects' && <ProjectsPage projects={projects} selectedProjectId={selectedProjectId} overview={overview} series={localizedSeries} onRefresh={refreshProjects} onSelect={(id) => { void selectProject(id); setPage('overview'); }}/>} 
        {page === 'overview' && selectedProject && <><OverviewPage overview={overview} project={selectedProject} venueData={venueData} exchange={exchange} onExchange={setExchange} onAnalyze={() => setPage('structure')}/><KoreanSpotPanel project={selectedProject} language={language}/></>}
        {page === 'structure' && selectedProject && <StructurePage overview={overview} series={localizedSeries} interval={interval} onInterval={setIntervalValue} project={selectedProject} theme={theme} language={language}/>} 
        {page === 'contribution' && selectedProject && <ExchangeContributionPage project={selectedProject} data={venueData} selection={exchange} onSelect={setExchange}/>} 
        {page === 'crossExchange' && selectedProject && <><CrossExchangeAnalysisPage project={selectedProject} data={venueData} selection={exchange} onSelect={setExchange}/><KoreanSpotPanel project={selectedProject} language={language}/><CoinGlassPanel project={selectedProject} language={language} onSettings={()=>setPage('settings')}/></>}
        {page === 'positionFlow' && selectedProject && <PositionFlowPage overview={overview} series={localizedSeries} interval={interval}/>} 
        {page === 'derivatives' && selectedProject && <DerivativesPage overview={overview} series={localizedSeries}/>} 
        {page === 'liquidity' && selectedProject && <OnchainLiquidityPage project={selectedProject} interval={interval}/>} 
        {page === 'settings' && <><ProviderSettings language={language} hasProject={!!selectedProject} onOpenWeb3={()=>{setPage('liquidity');requestAnimationFrame(()=>document.getElementById('binance-web3-panel')?.scrollIntoView({block:'start'}));}} onOpenCoinGlass={()=>{setPage('crossExchange');requestAnimationFrame(()=>document.getElementById('coinglass-metrics')?.scrollIntoView({block:'start'}));}}/><CollectionPanel projects={projects} language={language} onRefresh={refreshProjects}/><SettingsPage/><Web3ConnectionStatus language={language}/></>}
        {page === 'research' && selectedProject && <ResearchWorkspace key={selectedProject.id} project={selectedProject} data={venueData} language={language} chart={<NOXMarketStructureChart overview={overview} series={localizedSeries} interval={interval}/>}/>}
        {page === 'orderflow' && selectedProject && <OrderFlowPage key={selectedProject.id} project={selectedProject} series={localizedSeries} venues={venueData} interval={interval} onInterval={setIntervalValue} language={language} selection={exchange}/>}
        {page === 'signals' && selectedProject && <RegimeV2Panel key={selectedProject.id} project={selectedProject} language={language} selection={exchange} interval={interval} onInterval={setIntervalValue}/>}
        {page === 'history' && selectedProject && <EventStudyPage key={selectedProject.id} project={selectedProject} language={language} selection={exchange} interval={interval}/>}
      </div>
      <footer><span>{selectedProject ? `${selectedProject.name.toUpperCase()} · ${primaryMarket?.symbol ?? t('NO PRIMARY MARKET')}` : t('NO PROJECT SELECTED')} · {t('PUBLIC MARKET DATA')}</span><span>{t('Last stream event')} {lastStreamEvent ? t(timeAgo(lastStreamEvent)) : t('waiting')} · UTC</span></footer>
    </main>
  </div></UiContext.Provider>;
}

function Header({ page, projects, project, onProject, onManage, interval, onInterval, exchange, onExchange, connection, onMenu, onRefresh, loading, language, onLanguage, theme, onTheme }: { page: Page; projects: MarketProject[]; project: MarketProject | null; onProject: (id: string) => void | Promise<void>; onManage: () => void; interval: Interval; onInterval: (i: Interval) => void; exchange: ExchangeSelection; onExchange: (exchange: ExchangeSelection) => void; connection: ConnectionState; onMenu: () => void; onRefresh: () => void; loading: boolean; language: Language; onLanguage: () => void; theme: Theme; onTheme: () => void }) {
  const { t } = useUi();
  const [open, setOpen] = useState(false);
  const primary = project?.markets.find((market) => market.id === project.primaryMarketId);
  const pageLabel = t(NAV.find((item) => item.id === page)?.label ?? 'Project Monitor');
  return <header className="topbar">
    <button className="menu-button" onClick={onMenu}><Menu size={19}/></button>
    <div className="crumb">{t('Intelligence')} / <b>{pageLabel}</b></div>
    <div className="project-selector">
      <button className="project-selector-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}><FolderKanban size={15}/><div><span>{t('PROJECT')}</span><strong>{project?.name ?? t('Select a project')}</strong></div>{primary && <em>{primary.symbol}</em>}<ChevronDown size={13}/></button>
      {open && <div className="project-selector-menu">{projects.map((item) => { const market = item.markets.find((candidate) => candidate.id === item.primaryMarketId); return <button key={item.id} className={item.id === project?.id ? 'active' : ''} onClick={() => { void onProject(item.id); setOpen(false); }}><span>{item.tokenSymbol.slice(0, 2)}</span><div><strong>{item.name}</strong><small>{market?.symbol ?? t('No primary market')} · {item.markets.length} {t('markets')}</small></div>{item.id === project?.id && <Check size={14}/>}</button>; })}<button className="manage-projects" onClick={() => { onManage(); setOpen(false); }}><Plus size={13}/>{t('Manage projects')}</button></div>}
    </div>
    <label className="exchange-selector"><span>EXCHANGE</span><select value={exchange} onChange={(event) => onExchange(event.target.value as ExchangeSelection)}>{EXCHANGES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    <div className="venue-pill">{exchange.toUpperCase()} <span>{primary ? `${primary.marketType.toUpperCase()} · ${primary.quote}` : 'SELECTED MARKETS ONLY'}</span></div>
    <div className="intervals">{(['1m', '5m', '15m', '1h', '4h'] as Interval[]).map((i) => <button key={i} className={interval === i ? 'active' : ''} onClick={() => onInterval(i)}>{i.toUpperCase()}</button>)}</div>
    <div className={`connection ${connection}`}><i/>{t(connection === 'live' ? 'LIVE' : connection.toUpperCase())}</div>
    <button className="icon-button" onClick={onRefresh} aria-label={t('Refresh')} title={t('Refresh')}><RefreshCw size={16} className={loading ? 'spin' : ''}/></button>
    <button className="icon-button" onClick={onTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={theme === 'dark' ? (language === 'zh' ? '切换浅色' : 'Light theme') : (language === 'zh' ? '切换深色' : 'Dark theme')}>{theme === 'dark' ? <Sun size={16}/> : <Moon size={16}/>}</button>
    <button className="language-button" onClick={onLanguage} aria-label={language === 'en' ? '切换中文' : 'Switch to English'} title={language === 'en' ? '切换中文' : 'Switch to English'}>{language === 'en' ? '中' : 'EN'}</button>
  </header>;
}

function ProjectsPage({ projects, selectedProjectId, overview, series, onRefresh, onSelect }: { projects: MarketProject[]; selectedProjectId: string | null; overview: Overview | null; series: MarketSeries | null; onRefresh: (preferredId?: string) => Promise<MarketProject[]>; onSelect: (id: string) => void }) {
  const { language, t } = useUi();
  const [editor, setEditor] = useState<MarketProject | 'new' | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const ordered = [...projects].sort((a, b) => a.order - b.order);
  const update = async (id: string, body: object) => { await api(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); await onRefresh(); };
  const move = async (id: string, direction: -1 | 1) => {
    const index = ordered.findIndex((project) => project.id === id); const next = index + direction;
    if (next < 0 || next >= ordered.length) return;
    const ids = ordered.map((project) => project.id); [ids[index], ids[next]] = [ids[next], ids[index]];
    await api('/projects/reorder', { method: 'POST', body: JSON.stringify({ ids }) }); await onRefresh();
  };
  const remove = async (id: string) => { await api(`/projects/${id}`, { method: 'DELETE' }); setRemoveId(null); await onRefresh(); };
  return <>
    <PageHead eyebrow="CUSTOM PROJECT MONITORING" title="Project Watchlist" detail="Only selected projects are monitored. Confirm token identity and markets before enabling collection." right={<button className="primary-button" onClick={() => setEditor('new')}><Plus size={14}/> {t('Add project')}</button>}/>
    {!projects.length && !editor && <section className="project-onboarding panel"><FolderKanban size={27}/><strong>{t('No default markets')}</strong><p>{language === 'zh' ? '添加代币符号或合约地址。NOX 会先发现支持的 Binance 现货与 USDT-M 永续市场，再启动高频数据采集。' : 'Add a token symbol or contract address. NOX will discover supported Binance Spot and USDT-M perpetual markets before any high-frequency collection starts.'}</p><button className="primary-button" onClick={() => setEditor('new')}><Plus size={14}/> {t('Create first project')}</button></section>}
    {!!projects.length && <section className="panel projects-panel"><PanelHead title="Monitoring projects" meta={`${projects.filter((project) => !project.archived).length} active · ${projects.filter((project) => project.archived).length} archived`}/><div className="table-wrap project-watch-table"><table><thead><tr>{['Project','Market mapping','Current price','24H change','Volume','Open interest','OI delta','Funding','Structure','Alerts','Manage'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead><tbody>{ordered.map((project, index) => { const primary = project.markets.find((market) => market.id === project.primaryMarketId); const active = project.id === selectedProjectId; const latestOi = active ? series?.positionFlow.oiDelta.at(-1) : null; const latestSignal = active ? series?.positionFlow.signals.at(-1) : null; return <tr key={project.id} className={`${project.archived ? 'archived' : ''} ${active ? 'selected' : ''}`}><td><button className="project-cell" disabled={project.archived} onClick={() => onSelect(project.id)}><span>{project.tokenSymbol.slice(0,2)}</span><div><strong>{project.name}</strong><small>{project.tokenSymbol} · {project.archived ? (language === 'zh' ? '已归档' : 'ARCHIVED') : active ? (language === 'zh' ? '已选择' : 'SELECTED') : (language === 'zh' ? '监控中' : 'MONITORING')}</small></div></button></td><td><strong>{primary?.symbol ?? (language === 'zh' ? '无主数据源' : 'No primary feed')}</strong><small>{project.markets.length} {language === 'zh' ? '个交易对' : 'pairs'} · {new Set(project.markets.map(market=>market.exchange)).size} {language === 'zh' ? '家交易所' : 'venues'}</small></td><td>{active ? formatPrice(overview?.price) : '—'}</td><td className={active && (overview?.change24hPct ?? 0) >= 0 ? 'positive' : active ? 'negative' : ''}>{active && overview ? signed(overview.change24hPct) : '—'}</td><td>{active ? formatCompact(overview?.volume24hUsd, true) : '—'}<small>{t(active ? '24H notional' : 'Load on select')}</small></td><td>{active ? formatCompact(overview?.oiUsd, true) : '—'}<small>{active ? `${formatCompact(overview?.oiBase)} ${language === 'zh' ? '代币' : 'base'}` : t('Load on select')}</small></td><td className={(latestOi?.deltaUsd ?? 0) >= 0 ? 'positive' : 'negative'}>{latestOi ? formatCompact(latestOi.deltaUsd, true) : '—'}<small>{latestOi ? signed(latestOi.pctUsd) : t('No active sample')}</small></td><td className={active && (overview?.fundingRate ?? 0) >= 0 ? 'positive' : active ? 'negative' : ''}>{active && overview ? signed(overview.fundingRate * 100) : '—'}</td><td><span className="structure-tag">{latestSignal?.label ?? t(active ? 'No active signal' : 'Idle')}</span></td><td>{active ? series?.positionFlow.signals.length ?? 0 : '—'}</td><td><div className="project-actions"><button onClick={() => void move(project.id, -1)} disabled={index === 0} aria-label={`Move ${project.name} up`}><ArrowUp size={12}/></button><button onClick={() => void move(project.id, 1)} disabled={index === ordered.length - 1} aria-label={`Move ${project.name} down`}><ArrowDown size={12}/></button><button onClick={() => setEditor(project)} aria-label={`Edit ${project.name}`}><Edit3 size={12}/></button><button onClick={() => void update(project.id, { archived: !project.archived })} aria-label={`${project.archived ? 'Restore' : 'Archive'} ${project.name}`}><Archive size={12}/></button><button className="danger" onClick={() => setRemoveId(project.id)} aria-label={`Remove ${project.name}`}><Trash2 size={12}/></button></div>{removeId === project.id && <div className="remove-confirm"><span>{language === 'zh' ? '删除此项目及其监控偏好？' : 'Remove this project and its monitoring preferences?'}</span><button onClick={() => void remove(project.id)}>{language === 'zh' ? '确认删除' : 'Confirm remove'}</button><button onClick={() => setRemoveId(null)}>{t('Cancel')}</button></div>}</td></tr>; })}</tbody></table></div><div className="table-foot">{language === 'zh' ? '后台采集由各项目的 Active / Standard / Paused 模式控制；在设置 / 数据源中调整。' : 'Background collection follows the Active / Standard / Paused mode of each project. Configure it in Settings / Data Sources.'}</div></section>}
    {editor && <ProjectEditor project={editor === 'new' ? null : editor} onClose={() => setEditor(null)} onSaved={async (project) => { await onRefresh(project.id); setEditor(null); onSelect(project.id); }}/>} 
  </>;
}

function ProjectEditor({ project, onClose, onSaved }: { project: MarketProject | null; onClose: () => void; onSaved: (project: MarketProject) => void | Promise<void> }) {
  const { language, t } = useUi();
  const initialMarkets = project?.markets ?? [];
  const [query, setQuery] = useState(project?.contractAddress ?? project?.tokenSymbol ?? '');
  const [discovery, setDiscovery] = useState<ProjectDiscoveryResult | null>(project ? { query: project.tokenSymbol, identity: { symbol: project.tokenSymbol, name: project.name, contractAddress: project.contractAddress, network: project.identityNetwork, source: project.identitySource }, markets: initialMarkets, warnings: [] } : null);
  const [name, setName] = useState(project?.name ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>(initialMarkets.map((market) => market.id));
  const [primaryId, setPrimaryId] = useState(project?.primaryMarketId ?? '');
  const [interval, setInterval] = useState<Interval>(project?.monitoring.defaultInterval ?? '5m');
  const [streaming, setStreaming] = useState(project?.monitoring.streamingEnabled ?? true);
  const [confirmed, setConfirmed] = useState(Boolean(project));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const closeEditor = useRef(onClose); closeEditor.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (document.querySelector('.auth-dialog-backdrop')) return;
      if (event.key === 'Escape') { closeEditor.current(); return; }
      if (event.key !== 'Tab') return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length-1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keyboard); previousFocus?.focus(); };
  }, []);
  const primaryEligible = Boolean(discovery?.markets.some(market => selectedIds.includes(market.id) && market.id === primaryId && market.marketType === 'perpetual' && market.quote === 'USDT'));
  const discover = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setConfirmed(false);
    try {
      const result = await api<ProjectDiscoveryResult>('/projects/discover', { method: 'POST', body: JSON.stringify({ query }) });
      setDiscovery(result); setName(result.identity.name ?? result.identity.symbol); const defaults = result.markets.filter((market) => market.marketType === 'perpetual' && market.quote === 'USDT').slice(0, 1).map((market) => market.id); setSelectedIds(defaults); setPrimaryId(defaults[0] ?? '');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Market discovery failed'); }
    finally { setBusy(false); }
  };
  const toggleMarket = (market: ProjectMarket) => {
    const selected = selectedIds.includes(market.id); const next = selected ? selectedIds.filter((id) => id !== market.id) : [...selectedIds, market.id]; setSelectedIds(next);
    if (selected && primaryId === market.id) setPrimaryId('');
    if (!selected && market.marketType === 'perpetual' && !primaryId) setPrimaryId(market.id);
  };
  const save = async () => {
    if (!discovery || !confirmed) { setError(language === 'zh' ? '请先确认代币身份。' : 'Confirm the token identity before saving.'); return; }
    const markets = discovery.markets.filter((market) => selectedIds.includes(market.id));
    if (!primaryEligible) { setError(language === 'zh' ? '请选择已匹配的 USDT 永续市场作为主数据源。' : 'Select a matched USDT perpetual as the primary analytics feed.'); return; }
    setBusy(true); setError('');
    const body = { name, tokenSymbol: discovery.identity.symbol, contractAddress: discovery.identity.contractAddress, identitySource: discovery.identity.source, identityNetwork: discovery.identity.network, markets, primaryMarketId: primaryId, monitoring: { defaultInterval: interval, streamingEnabled: streaming } };
    try { const saved = await api<MarketProject>(project ? `/projects/${project.id}` : '/projects', { method: project ? 'PATCH' : 'POST', body: JSON.stringify(body) }); await onSaved(saved); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Project save failed'); setBusy(false); }
  };
  return <div className="project-editor-backdrop"><section className="project-editor panel" ref={dialogRef} role="dialog" aria-modal="true" aria-label={project ? 'Edit project' : 'Add project'}><div className="editor-head"><div><span>{project ? (language === 'zh' ? '编辑监控项目' : 'EDIT MONITORING PROJECT') : t('NEW MONITORING PROJECT')}</span><h2>{project ? project.name : t('Discover token markets')}</h2></div><button onClick={onClose} aria-label={language === 'zh' ? '关闭项目编辑器' : 'Close project editor'}><X size={17}/></button></div><form className="project-search" onSubmit={discover}><label>{t('Token symbol or contract address')}<div><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. ARB or 0x…"/><button type="submit" disabled={busy}>{busy ? (language === 'zh' ? '搜索中…' : 'Searching…') : project ? (language === 'zh' ? '刷新匹配' : 'Refresh matches') : t('Search markets')}</button></div></label></form>{error && <div className="editor-error"><AlertTriangle size={13}/>{error}</div>}{discovery && <div className="editor-content"><div className="identity-card"><div className="identity-mark">{discovery.identity.symbol.slice(0, 2)}</div><div><span>{language === 'zh' ? '已解析代币身份' : 'RESOLVED TOKEN IDENTITY'}</span><strong>{discovery.identity.name ?? discovery.identity.symbol} · {discovery.identity.symbol}</strong><small>{discovery.identity.contractAddress ? `${discovery.identity.network ?? (language === 'zh' ? '未知网络' : 'Unknown network')} · ${discovery.identity.contractAddress}` : (language === 'zh' ? '基于符号的身份，请仔细核对交易对' : 'Symbol-based identity · verify market pairs carefully')}</small></div><label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}/>{language === 'zh' ? '我确认此代币身份' : 'I confirm this token identity'}</label></div>{discovery.warnings.map((warning) => <p className="identity-warning" key={warning}>{warning}</p>)}<label className="editor-field">{language === 'zh' ? '项目名称' : 'Project name'}<input value={name} onChange={(event) => setName(event.target.value)}/></label><div className="market-picker"><div><strong>{language === 'zh' ? '选择需要监控的市场' : 'Select markets to monitor'}</strong><span>{language === 'zh' ? '第一阶段需要至少一个 USDT 永续合约；原生同步历史图当前使用 Binance。' : 'Phase 1 requires at least one USDT perpetual; native synchronized history currently uses Binance.'}</span></div>{discovery.markets.map((market) => <label key={market.id} className={selectedIds.includes(market.id) ? 'selected' : ''}><input type="checkbox" checked={selectedIds.includes(market.id)} onChange={() => toggleMarket(market)}/><span className={`market-kind ${market.marketType}`}>{market.marketType === 'perpetual' ? 'PERP' : 'SPOT'}</span><div><strong>{market.base}/{market.quote}</strong><small>{market.exchange.toUpperCase()} · {market.symbol}</small></div>{market.marketType === 'perpetual' && selectedIds.includes(market.id) && <button type="button" className={primaryId === market.id ? 'primary' : ''} onClick={() => setPrimaryId(market.id)}>{primaryId === market.id ? (language === 'zh' ? '主数据源' : 'PRIMARY') : (language === 'zh' ? '设为主数据源' : 'Set primary')}</button>}</label>)}{!discovery.markets.length && <div className="empty compact-empty">{language === 'zh' ? '本次未返回匹配市场。部分交易所可能请求失败，请重试搜索；没有已验证的 USDT 永续市场时无法创建此类监控项目。' : 'No matching markets returned. Some venue requests may have failed; retry search. A verified USDT perpetual is required to create this monitoring project.'}</div>}</div><div className="monitoring-options"><label>{language === 'zh' ? '默认周期' : 'Default timeframe'}<select value={interval} onChange={(event) => setInterval(event.target.value as Interval)}>{(['1m','5m','15m','1h','4h'] as Interval[]).map((value) => <option value={value} key={value}>{value.toUpperCase()}</option>)}</select></label><label className="streaming-check"><input type="checkbox" checked={streaming} onChange={(event) => setStreaming(event.target.checked)}/>{language === 'zh' ? '启用实时数据流' : 'Enable real-time streaming'}</label></div></div>}<div className="editor-actions">{discovery && !primaryEligible && <span className="editor-save-hint">{language === 'zh' ? '请选择 USDT 永续主数据源' : 'Select a primary USDT perpetual'}</span>}<button onClick={onClose}>{t('Cancel')}</button><button className="save-project" disabled={!discovery || busy || !confirmed || !name.trim() || !primaryEligible} onClick={() => void save()}>{t(project ? 'Save changes' : 'Create project')}</button></div></section></div>;
}

function OverviewPage({ overview, project, venueData, exchange, onExchange, onAnalyze }: { overview: Overview | null; project: MarketProject; venueData: ProjectVenueResponse | null; exchange: ExchangeSelection; onExchange: (exchange: ExchangeSelection) => void; onAnalyze: () => void }) {
  const primary = project.markets.find((market) => market.id === project.primaryMarketId);
  const { t } = useUi(); const [copied, setCopied] = useState(false); const [copying, setCopying] = useState(false);
  const copyResearchContext = async () => {
    setCopying(true);
    try { const context = await api<ProjectResearchContext>(`/projects/${project.id}/research-context`); await navigator.clipboard.writeText(JSON.stringify(context, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    finally { setCopying(false); }
  };
  return <>
    <PageHead eyebrow="PROJECT MONITOR" title={project.name} detail={`${project.tokenSymbol} · ${project.markets.length} selected markets · high-frequency collection is limited to this project.`} right={<div className="page-actions"><button className="secondary-button" onClick={() => void copyResearchContext()} disabled={copying}>{copied ? <CheckCircle2 size={14}/> : <Copy size={14}/>} {t(copied ? 'Copied' : 'Copy research JSON')}</button><button className="primary-button" onClick={onAnalyze}><BarChart3 size={14}/> {t('Open synchronized analysis')}</button></div>}/>
    <KpiStrip overview={overview}/>
    <CrossExchangeComparison data={venueData} selection={exchange} onSelect={onExchange}/>
    <div className="overview-grid">
      <section className="panel project-markets"><PanelHead title="Monitored markets" meta="Explicitly selected during project identity confirmation"/>
        <div className="project-market-list">{project.markets.map((market) => <div key={market.id} className={market.id === project.primaryMarketId ? 'primary' : ''}><span className={`market-kind ${market.marketType}`}>{market.marketType === 'perpetual' ? 'PERP' : 'SPOT'}</span><div><strong>{market.base}/{market.quote}</strong><small>{market.exchange.toUpperCase()} · {market.symbol}</small></div>{market.id === project.primaryMarketId && <em>PRIMARY FEED</em>}<i className="quality live">{market.status}</i></div>)}</div>
        <div className="table-foot">Primary analytics feed: {primary?.symbol ?? 'not selected'}. Native synchronized history currently uses a selected Binance perpetual; other venues are explicit Phase 1 REST snapshots.</div>
      </section>
      <aside className="panel regime-panel"><PanelHead title="Market state" meta="Rule-based observations"/>
        <Observation icon={<Gauge size={17}/>} label="Selected project feed" value={overview?.change24hPct != null ? (overview.change24hPct > 2 ? 'Upward expansion' : overview.change24hPct < -2 ? 'Downward expansion' : 'Range / low conviction') : 'Awaiting data'} detail={overview?.change24hPct != null ? `${overview.symbol} · ${signed(overview.change24hPct)} price · funding ${overview.fundingRate == null ? 'unavailable' : signed(overview.fundingRate * 100, '%')}` : 'No inference without data'} tone={overview?.change24hPct != null && Math.abs(overview.change24hPct) > 2 ? 'attention' : 'neutral'}/>
        <Observation icon={<Activity size={17}/>} label="Derivatives posture" value={overview?.fundingRate != null && Math.abs(overview.fundingRate) > 0.0005 ? 'Elevated funding' : overview?.fundingRate == null ? 'Funding unavailable' : 'Funding contained'} detail="Directional intent is not inferred from OI alone." tone="neutral"/>
        <Observation icon={<Database size={17}/>} label="Data quality" value="Public venue feed" detail="Aggregate trade stream can omit or aggregate individual fills by venue rules." tone="good"/>
        <div className="method-note"><strong>Interpretation boundary</strong><p>Public data cannot identify counterparties, ownership, or “organic” liquidity. Signals describe patterns—not intent.</p></div>
      </aside>
    </div>
  </>;
}

function OnchainLiquidityPage({ project,interval }: { project: MarketProject;interval:Interval }) {
  const { language } = useUi(); const [data, setData] = useState<OnchainProjectSnapshot | null>(null); const [loading, setLoading] = useState(true);
  useEffect(() => { let active = true; setLoading(true);setData(null); const load=()=>api<OnchainProjectSnapshot>(`/projects/${project.id}/onchain`).then((value) => { if (active) setData(value); }).catch((error) => { if (active) setData({ status: 'unavailable', reason: error instanceof Error ? error.message : 'On-chain data unavailable', source: 'DexPaprika', network: project.identityNetwork, contractAddress: project.contractAddress, token: null, pools: [], coverage: { poolsReturned: 0, poolsWithLiquidity: 0, displayedLiquidityUsd: null, displayedVolume24hUsd: null }, fetchedAt: Date.now(), methodology: [] }); }).finally(() => { if (active) setLoading(false); });void load();const timer=setInterval(()=>void load(),60_000); return () => { active = false;clearInterval(timer); }; }, [project.id, project.contractAddress, project.identityNetwork]);
  const maxLiquidity = Math.max(1, ...(data?.pools.map((pool) => pool.liquidityUsd ?? 0) ?? []));
  return <><PageHead eyebrow={language==='zh'?'交易所行情与链上流动性':'EXCHANGE & ON-CHAIN MARKET CONTEXT'} title={language==='zh'?`${project.name} 交易所与链上情报`:`${project.name} exchange & on-chain intelligence`} detail={language==='zh'?'交易所价格、成交额、OI 与链上成交、DEX 池流动性和 DeFi TVL 分开显示。':'Exchange prices, volume and OI remain separate from on-chain activity, DEX pool liquidity and DeFi TVL.'}/>
    <BinanceExchangePanel key={`exchange:${project.id}`} project={project} language={language}/>
    <BinanceWeb3Panel key={project.id} project={project} language={language} interval={interval}/>
    <h2>{language==='zh'?'DexPaprika · 独立链上数据源':'DexPaprika · independent on-chain source'}</h2>
    {loading ? <section className="panel phase-card"><RefreshCw className="spin" size={24}/><strong>{language === 'zh' ? '正在读取链上数据' : 'Loading on-chain context'}</strong></section> : data?.status !== 'available' ? <section className="panel phase-card"><Waves size={28}/><strong>{language === 'zh' ? '链上上下文不可用' : 'On-chain context unavailable'}</strong><p>{data?.reason}</p><span>{language === 'zh' ? '请在项目设置中确认合约地址和网络' : 'Confirm a contract address and network in the project settings'}</span></section> : <>
      <section className="onchain-kpis"><MetricCard label="Token price" value={formatPrice(data.token?.priceUsd)} detail={`${data.network} · ${language==='zh'?'拉取于':'fetched'} ${new Date(data.fetchedAt).toLocaleTimeString()}`}/><MetricCard label="Token liquidity" value={formatCompact(data.token?.liquidityUsd, true)} detail="DexPaprika token summary"/><MetricCard label="24H DEX volume" value={formatCompact(data.token?.volume24hUsd, true)} detail={`${formatCompact(data.token?.transactions24h)} ${language==='zh'?'笔交易':'transactions'}`}/><MetricCard label="Top-pool coverage" value={`${data.coverage.poolsWithLiquidity}/${data.coverage.poolsReturned}`} detail={`${formatCompact(data.coverage.displayedLiquidityUsd, true)} ${language==='zh'?'已展示流动性':'displayed liquidity'}`}/></section>
      <div className="onchain-grid"><section className="panel pool-panel"><PanelHead title="Top liquidity pools" meta={`${data.network} · ${data.contractAddress}`}/><div className="pool-list">{data.pools.map((pool) => <article key={`${pool.dexId}:${pool.address}`}><div className="pool-title"><div><strong>{pool.pair}</strong><span>{pool.dexName}</span></div><em>{formatCompact(pool.liquidityUsd, true)}</em></div>{pool.liquidityUsd!=null&&<div className="pool-bar"><i style={{ width: `${Math.max(0, pool.liquidityUsd / maxLiquidity * 100)}%` }}/></div>}<dl><div><dt>{language==='zh'?'24H 成交额':'24H volume'}</dt><dd>{formatCompact(pool.volume24hUsd, true)}</dd></div><div><dt>{language==='zh'?'交易笔数':'Transactions'}</dt><dd>{formatCompact(pool.transactions24h)}</dd></div><div><dt>{language==='zh'?'24H 涨跌':'24H change'}</dt><dd className={pool.priceChange24hPct==null?'':pool.priceChange24hPct>=0?'positive':'negative'}>{pool.priceChange24hPct == null ? '—' : signed(pool.priceChange24hPct)}</dd></div><div><dt>{language==='zh'?'费率':'Fee'}</dt><dd>{pool.fee == null ? '—' : `${pool.fee}%`}</dd></div></dl></article>)}</div></section>
        <aside className="panel onchain-context"><PanelHead title="On-chain liquidity context" meta="Observed public data"/><div className="onchain-token"><span>{data.token?.symbol?.slice(0, 2) ?? project.tokenSymbol.slice(0, 2)}</span><div><strong>{data.token?.name ?? project.name}</strong><small>{data.token?.symbol} · {data.network}</small></div></div><dl><div><dt>FDV</dt><dd>{formatCompact(data.token?.fdvUsd, true)}</dd></div><div><dt>{language==='zh'?'24H DEX 买入（上游口径）':'24H DEX buy (provider)'}</dt><dd>{formatCompact(data.token?.buy24hUsd, true)}</dd></div><div><dt>{language==='zh'?'24H DEX 卖出（上游口径）':'24H DEX sell (provider)'}</dt><dd>{formatCompact(data.token?.sell24hUsd, true)}</dd></div><div><dt>{language==='zh'?'来源':'Source'}</dt><dd>{data.source}</dd></div></dl><div className="onchain-boundaries">{language==='zh'?<><p>代币总计与主要池子来自 DexPaprika 的独立公开数据；拉取时间不是链上事件时间。</p><p>展示的池子仅覆盖返回子集，不代表全市场总量。DEX 池流动性不等于 CEX 盘口深度。</p><p>买卖方向采用上游口径，不能识别钱包归属、仓位开平或直接累加成 CVD。</p></>:data.methodology.map((item) => <p key={item}>{item}</p>)}</div></aside>
      </div></>}
  </>;
}

function CrossExchangeComparison({ data, selection, onSelect }: { data: ProjectVenueResponse | null; selection: ExchangeSelection; onSelect: (exchange: ExchangeSelection) => void }) {
  const rows = data?.snapshots ?? [];
  return <section className="panel exchange-comparison"><PanelHead title="Cross-exchange comparison" meta={data ? `${data.aggregate.coverage.successful}/${data.aggregate.coverage.requested} selected perpetual venues · ${data.aggregate.coverage.fresh} fresh` : 'Loading selected venues'}/><div className="table-wrap"><table><thead><tr>{['Venue','Price','Mark','24H volume','Open interest','Funding','Spread','Freshness','Coverage'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{data && <tr className={selection === 'aggregated' ? 'selected' : ''} onClick={() => onSelect('aggregated')}><td><strong>Aggregated</strong><small>{data.aggregate.coverage.venues.map((venue) => venue.toUpperCase()).join(' · ') || 'No live venues'}</small></td><td>{formatPrice(data.aggregate.price)}</td><td>{formatPrice(data.aggregate.markPrice)}</td><td>{formatCompact(data.aggregate.volume24hUsd, true)}</td><td>{formatCompact(data.aggregate.oiUsd, true)}</td><td>{data.aggregate.fundingRate == null ? '—' : signed(data.aggregate.fundingRate * 100)}</td><td>{data.aggregate.spreadBps == null ? '—' : `${data.aggregate.spreadBps.toFixed(2)} bps`}</td><td>{data.aggregate.eventTime ? timeAgo(data.aggregate.eventTime) : '—'}</td><td><span className="coverage-badge">{data.aggregate.coverage.successful}/{data.aggregate.coverage.requested}</span></td></tr>}{rows.map((row) => <tr key={`${row.exchange}:${row.symbol}`} className={selection === row.exchange ? 'selected' : ''} onClick={() => onSelect(row.exchange)}><td><strong>{row.exchange.toUpperCase()}</strong><small>{row.symbol}</small></td><td>{formatPrice(row.price)}</td><td>{formatPrice(row.markPrice)}</td><td>{formatCompact(row.volume24hUsd, true)}</td><td>{formatCompact(row.oiUsd, true)}<small>{formatCompact(row.oiBase)} base</small></td><td>{row.fundingRate == null ? '—' : signed(row.fundingRate * 100)}</td><td>{row.spreadBps == null ? '—' : `${row.spreadBps.toFixed(2)} bps`}</td><td>{timeAgo(row.eventTime)}<small>{row.quality}</small></td><td><span className="coverage-badge">{9 - row.unavailable.length}/9</span></td></tr>)}</tbody></table></div>{data?.failures.length ? <div className="comparison-failures">Unavailable: {data.failures.map((failure) => `${failure.exchange.toUpperCase()} ${failure.symbol}`).join(' · ')}. Missing values are not replaced with zero.</div> : <div className="table-foot">Price is volume-weighted; funding is OI-notional-weighted; OI and volume are summed only after contract normalization. Aggregate CVD stays unavailable until compatible trades are aligned.</div>}</section>;
}

function ExchangeContributionPage({ project, data, selection, onSelect }: { project: MarketProject; data: ProjectVenueResponse | null; selection: ExchangeSelection; onSelect: (exchange: ExchangeSelection) => void }) {
  const { language } = useUi(); const [timeframe, setTimeframe] = useState('24h'); const contribution = data?.contribution;
  const volumeLeader = contribution?.rows.find((row) => row.volumeSharePct != null);
  const oiLeader = contribution ? [...contribution.rows].sort((a, b) => (b.oiSharePct ?? -1) - (a.oiSharePct ?? -1))[0] : null;
  return <><PageHead eyebrow="CROSS-VENUE COVERAGE" title={`${project.name} exchange contribution`} detail="Contribution across selected, successfully covered venues—not the entire global market." right={<div className="contribution-timeframes">{['5m','15m','1h','4h','24h'].map((item) => <button key={item} className={timeframe === item ? 'active' : ''} disabled={item !== '24h'} title={item === '24h' ? 'Live 24H snapshot' : 'Requires persistent historical sampling'} onClick={() => setTimeframe(item)}>{item.toUpperCase()}</button>)}</div>}/>
    <section className="contribution-kpis">
      <MetricCard label="Covered 24H volume" value={formatCompact(contribution?.totals.volume24hUsd, true)} detail={`${contribution?.coverage.volumeVenues ?? 0}/${contribution?.coverage.selectedVenues ?? 0} venues · leader ${volumeLeader ? `${volumeLeader.exchange.toUpperCase()} ${volumeLeader.volumeSharePct?.toFixed(1)}%` : '—'}`}/>
      <MetricCard label="Covered open interest" value={formatCompact(contribution?.totals.oiUsd, true)} detail={`${contribution?.coverage.oiVenues ?? 0}/${contribution?.coverage.selectedVenues ?? 0} venues · leader ${oiLeader ? `${oiLeader.exchange.toUpperCase()} ${oiLeader.oiSharePct?.toFixed(1)}%` : '—'}`}/>
      <MetricCard label="1H OI change coverage" value={`${contribution?.coverage.oiChange1hVenues ?? 0}/${contribution?.coverage.selectedVenues ?? 0}`} detail="Unavailable until venue history is time-aligned"/>
      <MetricCard label="Visible depth coverage" value={`${contribution?.coverage.depthVenues ?? 0}/${contribution?.coverage.selectedVenues ?? 0}`} detail="Sequence-correct L2 depth required"/>
    </section>
    <section className="panel contribution-panel"><PanelHead title="24H volume contribution" meta={`${contribution?.coverage.volumeVenues ?? 0}/${contribution?.coverage.selectedVenues ?? 0} selected perpetual venues · updated ${contribution?.updatedAt ? timeAgo(contribution.updatedAt) : '—'}`}/><ContributionBar rows={contribution?.rows ?? []} metric="volume" selection={selection} onSelect={onSelect}/><div className="contribution-legend">{contribution?.rows.filter((row) => row.volumeSharePct != null).map((row, index) => <button key={row.exchange} className={`venue-color venue-${index % 7} ${selection === row.exchange ? 'active' : ''}`} onClick={() => onSelect(row.exchange)}><i/><span>{row.exchange.toUpperCase()}</span><strong>{row.volumeSharePct!.toFixed(1)}%</strong></button>)}</div></section>
    <section className="panel contribution-panel"><PanelHead title="Open-interest contribution" meta="Normalized USD notional · venue-reported OI × contract specification × valuation price"/><ContributionBar rows={contribution?.rows ?? []} metric="oi" selection={selection} onSelect={onSelect}/></section>
    <section className="panel exchange-contribution-table"><PanelHead title="Contribution detail" meta="Unavailable fields remain blank; no zero substitution"/><div className="table-wrap"><table><thead><tr>{['Venue','24H volume','Volume share','Open interest','OI share','1H OI change','Net aggressive','Depth share','Funding','Freshness'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{contribution?.rows.map((row) => <tr key={row.exchange} className={selection === row.exchange ? 'selected' : ''} onClick={() => onSelect(row.exchange)}><td><strong>{row.exchange.toUpperCase()}</strong><small>{row.symbol}</small></td><td>{formatCompact(row.volume24hUsd, true)}</td><td>{row.volumeSharePct == null ? '—' : `${row.volumeSharePct.toFixed(2)}%`}</td><td>{formatCompact(row.oiUsd, true)}</td><td>{row.oiSharePct == null ? '—' : `${row.oiSharePct.toFixed(2)}%`}</td><td>{formatCompact(row.oiChange1hUsd, true)}</td><td>{formatCompact(row.netAggressiveVolumeUsd, true)}</td><td>{row.depthSharePct == null ? '—' : `${row.depthSharePct.toFixed(2)}%`}</td><td>{row.fundingRate == null ? '—' : signed(row.fundingRate * 100)}</td><td>{timeAgo(row.eventTime)}<small>{row.freshness}</small></td></tr>)}</tbody></table></div><div className="contribution-method">{contribution?.methodology.map((item) => <p key={item}>{item}</p>) ?? <p>Awaiting venue coverage.</p>}</div></section>
    <p className="coverage-disclaimer">{language === 'zh' ? '贡献率仅代表该项目已选择且成功覆盖的交易所，不代表整个全球市场。' : 'Contribution shares represent selected successfully covered venues only; they are not the entire global market.'}</p>
  </>;
}

function ContributionBar({ rows, metric, selection, onSelect }: { rows: NonNullable<ProjectVenueResponse['contribution']>['rows']; metric: 'volume' | 'oi'; selection: ExchangeSelection; onSelect: (exchange: ExchangeSelection) => void }) {
  const covered = rows.filter((row) => (metric === 'volume' ? row.volumeSharePct : row.oiSharePct) != null);
  if (!covered.length) return <div className="empty compact-empty">Contribution unavailable for the selected venue coverage.</div>;
  return <div className="stacked-contribution" aria-label={`${metric} contribution`}>{covered.map((row, index) => { const share = metric === 'volume' ? row.volumeSharePct! : row.oiSharePct!; return <button key={row.exchange} className={`venue-${index % 7} ${selection === row.exchange ? 'active' : ''}`} style={{ width: `${share}%` }} title={`${row.exchange.toUpperCase()} ${share.toFixed(2)}%`} onClick={() => onSelect(row.exchange)}><span>{share >= 8 ? `${row.exchange.toUpperCase()} ${share.toFixed(1)}%` : ''}</span></button>; })}</div>;
}

function CrossExchangeAnalysisPage({ project, data, selection, onSelect }: { project: MarketProject; data: ProjectVenueResponse | null; selection: ExchangeSelection; onSelect: (exchange: ExchangeSelection) => void }) {
  const insights = data?.insights ?? []; const contribution = data?.contribution;
  return <><PageHead eyebrow="CROSS-EXCHANGE POSITION FLOW" title={`${project.name} venue divergence`} detail="Observed cross-venue differences with explicit coverage and probabilistic interpretation boundaries."/>
    <section className="cross-flow-summary">
      <MetricCard label="Covered venues" value={`${data?.aggregate.coverage.successful ?? 0}/${data?.aggregate.coverage.requested ?? 0}`} detail={`${data?.aggregate.coverage.fresh ?? 0} fresh snapshots`}/>
      <MetricCard label="Detected structures" value={`${insights.length}`} detail="Concentration, funding and price dispersion"/>
      <MetricCard label="Aggressive-flow coverage" value={`${contribution?.coverage.aggressiveFlowVenues ?? 0}/${contribution?.coverage.selectedVenues ?? 0}`} detail="Requires time-aligned venue trades"/>
      <MetricCard label="Depth coverage" value={`${contribution?.coverage.depthVenues ?? 0}/${contribution?.coverage.selectedVenues ?? 0}`} detail="Requires sequence-correct L2 books"/>
    </section>
    <div className="cross-insight-grid"><section className="panel insight-list"><PanelHead title="Current cross-venue structures" meta={`${insights.length} evidence-based observations`}/>{insights.length ? insights.map((insight) => <article key={insight.id} onClick={() => insight.exchange && onSelect(insight.exchange)} className={selection === insight.exchange ? 'selected' : ''}><div><span className="signal-dot neutral"/><strong>{insight.label}</strong><em>{insight.confidence}%</em></div><p>{insight.observed.join(' · ')}</p><small>{insight.evidence.join(' · ')} · {timeAgo(insight.timestamp)}</small><blockquote>{insight.inferenceNotice}</blockquote></article>) : <div className="empty">No cross-venue pattern met the configured thresholds in the current covered snapshot.</div>}</section><section className="panel divergence-table"><PanelHead title="Funding & concentration" meta="Venue-specific rates are preserved; they are never summed"/><div>{contribution?.rows.map((row) => <button key={row.exchange} onClick={() => onSelect(row.exchange)} className={selection === row.exchange ? 'active' : ''}><span>{row.exchange.toUpperCase()}</span><div><i style={{ width: `${Math.max(1, row.oiSharePct ?? 0)}%` }}/></div><strong>{row.oiSharePct == null ? '—' : `${row.oiSharePct.toFixed(1)}% OI`}</strong><em>{row.fundingRate == null ? 'Funding —' : `${signed(row.fundingRate * 100)} funding`}</em></button>)}</div></section></div>
    <CrossExchangeComparison data={data} selection={selection} onSelect={onSelect}/>
  </>;
}

function KpiStrip({ overview }: { overview: Overview | null }) {
  const { language, t } = useUi();
  const kpis = [
    { label: language === 'zh' ? '最新价格' : 'Last price', value: formatPrice(overview?.price), sub: overview?.change24hPct == null ? '—' : signed(overview.change24hPct) + ' · 24H', dir: (overview?.change24hPct ?? 0) >= 0 ? 'up' : 'down' },
    { label: language === 'zh' ? '24小时成交量' : '24H volume', value: formatCompact(overview?.volume24hUsd, true), sub: `${formatCompact(overview?.volume24hBase)} ${language === 'zh' ? '代币' : 'base'}` },
    { label: t('Open interest'), value: formatCompact(overview?.oiUsd, true), sub: `${formatCompact(overview?.oiBase)} ${language === 'zh' ? '代币' : 'base'}` },
    { label: language === 'zh' ? '资金费率 / 周期' : 'Funding / interval', value: overview?.fundingRate == null ? '—' : signed(overview.fundingRate * 100, '%'), sub: `${language === 'zh' ? '下次' : 'Next'} ${countdown(overview?.nextFundingTime)}`, dir: (overview?.fundingRate ?? 0) >= 0 ? 'up' : 'down' },
    { label: language === 'zh' ? '近期合约 CVD' : 'Recent futures CVD', value: formatCompact(overview?.cvdWindowDelta, true), sub: overview?.cvdWindowFrom ? `${language === 'zh' ? '起始' : 'from'} ${new Date(overview.cvdWindowFrom).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : (language === 'zh' ? '覆盖范围不可用' : 'coverage unavailable'), dir: (overview?.cvdWindowDelta ?? 0) >= 0 ? 'up' : 'down' },
    { label: language === 'zh' ? '数据新鲜度' : 'Freshness', value: overview ? timeAgo(overview.eventTime) : '—', sub: overview?.source ?? `Public market data · UTC` }
  ];
  return <section className="kpi-strip">{kpis.map((k) => <div className="kpi" key={k.label}><span>{k.label}</span><strong className={k.dir}>{k.value}</strong><small>{k.sub}</small></div>)}</section>;
}

function StructurePage({ overview, series, interval, onInterval, project, theme, language }: { overview: Overview | null; series: MarketSeries | null; interval: Interval; onInterval: (interval: Interval) => void; project: MarketProject; theme: Theme; language: Language }) {
  const storageKey = `nox-chart-mode:${project.id}`;
  const [mode, setMode] = useState<ChartMode>(() => localStorage.getItem(storageKey) === 'tradingview' ? 'tradingview' : 'nox');
  const primary = project.markets.find((market) => market.id === project.primaryMarketId) ?? project.markets.find((market) => market.marketType === 'perpetual');
  useEffect(() => { setMode(localStorage.getItem(storageKey) === 'tradingview' ? 'tradingview' : 'nox'); }, [storageKey]);
  const changeMode = (nextMode: ChartMode) => { setMode(nextMode); localStorage.setItem(storageKey, nextMode); };
  return <><PageHead eyebrow="FLAGSHIP ANALYSIS" title={`${series?.symbol ?? primary?.symbol ?? 'Market'} structure`} detail="Synchronized price, volume, open interest and futures CVD. Move across any panel to inspect the same event time." right={<div className="provenance"><i/><span>{mode === 'nox' ? (series?.source ?? 'Awaiting source') : 'TradingView public widget'}</span></div>}/>
    <ChartModeSwitcher mode={mode} onChange={changeMode} language={language}/>
    {mode === 'nox' ? <NOXMarketStructureChart overview={overview} series={series} interval={interval}/> : <TradingViewChartPanel market={primary} interval={interval} onInterval={onInterval} theme={theme} language={language}/>} 
    <StructureEvidence overview={overview} series={series}/>
  </>;
}

function NOXMarketStructureChart({ overview, series, interval }: { overview: Overview | null; series: MarketSeries | null; interval: Interval }) {
  const [cursor, setCursor] = useState<number | null>(null); const points = series?.candles ?? [];
  return <>
    <div className="chart-toolbar"><div><span>Mode</span><button className="active">Observed</button><button disabled>Regime overlay · P2</button></div><div className="coverage"><span>CVD coverage</span><strong>{series?.coverage.tradeCount ?? 0} aggregate trades</strong><em>{series?.coverage.cvdFrom ? new Date(series.coverage.cvdFrom).toLocaleTimeString() : 'unavailable'}</em></div></div>
    <section className="chart-stack panel">
      <PanelHead title="Price & volume" meta={`${interval.toUpperCase()} candles · USDT per base · Binance`} action={overview ? `Mark ${formatPrice(overview.markPrice)}` : undefined}/>
      <CandleChart points={points} cursor={cursor} onCursor={setCursor}/>
      <div className="chart-divider"/>
      <ChartLabel title="Open interest" meta="Base quantity — not USD notional" current={formatCompact(series?.oiBase.at(-1)?.value)}/>
      <LineChart points={series?.oiBase ?? []} cursor={cursor} onCursor={setCursor} color="#b9c3ca" height={145}/>
      <div className="chart-divider"/>
      <ChartLabel title="Futures CVD" meta="Aggressor buy notional − aggressor sell notional · baseline reset at fetched window" current={formatCompact(series?.cvd.at(-1)?.value, true)}/>
      <LineChart points={series?.cvd ?? []} cursor={cursor} onCursor={setCursor} color="#54c9a8" baseline height={155}/>
      <div className="chart-foot"><span>{series?.coverage.cvdMethod}</span><span>Updated {series ? timeAgo(series.eventTime) : '—'}</span></div>
    </section>
  </>;
}

function StructureEvidence({ overview, series }: { overview: Overview | null; series: MarketSeries | null }) {
  return <section className="evidence-grid"><div className="panel"><PanelHead title="Observed evidence" meta="No actor-intent inference"/><ul className="evidence-list"><li><span>Price change</span><strong className={(overview?.change24hPct ?? 0) >= 0 ? 'positive' : 'negative'}>{overview ? signed(overview.change24hPct) : '—'}</strong></li><li><span>OI base / mark notional</span><strong>{formatCompact(overview?.oiBase)} / {formatCompact(overview?.oiUsd, true)}</strong></li><li><span>Funding</span><strong>{overview ? signed(overview.fundingRate * 100, '%') : '—'}</strong></li><li><span>CVD sample window</span><strong>{series?.coverage.tradeCount ?? 0} aggregate trades</strong></li></ul></div><div className="panel counter"><PanelHead title="Counterevidence & limits" meta="Required before any regime label"/><p>Open interest does not reveal whether longs or shorts initiated. CVD covers the returned aggregate-trade window, not the entire chart range when the 1,000-record limit is reached. USD OI includes mark-price effects.</p></div></section>;
}

const FLOW_INDICATORS = [
  ['price', 'Price'], ['oi', 'Open interest'], ['oiDelta', 'OI delta'], ['taker', 'Taker buy / sell'], ['volumeDelta', 'Volume delta'], ['cvd', 'CVD'], ['signals', 'Signals']
] as const;
type FlowIndicator = typeof FLOW_INDICATORS[number][0];

function PositionFlowPage({ overview, series, interval }: { overview: Overview | null; series: MarketSeries | null; interval: Interval }) {
  const { t } = useUi();
  const flow = series?.positionFlow;
  const [cursor, setCursor] = useState<number | null>(null);
  const [oiUnit, setOiUnit] = useState<'base' | 'usd'>('base');
  const [visible, setVisible] = useState<Record<FlowIndicator, boolean>>({ price: true, oi: true, oiDelta: true, taker: true, volumeDelta: true, cvd: true, signals: true });
  const [replay, setReplay] = useState<string | null>(null);
  const signals = flow?.signals ?? [];
  const selectedSignal = signals.find((signal) => signal.id === replay) ?? signals[0] ?? null;
  const oiPoints = oiUnit === 'base' ? series?.oiBase ?? [] : series?.oiUsd ?? [];
  const latestOiDelta = flow?.oiDelta.at(-1);
  const latestVolume = flow?.volumeFlow.at(-1);
  const toggle = (key: FlowIndicator) => setVisible((current) => ({ ...current, [key]: !current[key] }));
  const replaySignal = (signal: PositionFlowSignal) => { setReplay(signal.id); setCursor(signal.time); };
  return <>
    <PageHead eyebrow="POSITION FLOW INTELLIGENCE" title={`${series?.symbol ?? 'Market'} derivatives flow`} detail="Observed price, OI and aggressor flow stay separate; classifications are probabilistic and include counterevidence." right={<div className="provenance"><i/><span>{series?.source ?? 'Awaiting source'}</span></div>}/>
    <section className="flow-summary">
      <MetricCard label="Open interest" value={oiUnit === 'base' ? formatCompact(overview?.oiBase) : formatCompact(overview?.oiUsd, true)} detail={`${oiUnit === 'base' ? 'base quantity' : 'mark-price notional'} · ${flow?.oiInterval?.toUpperCase() ?? '—'} source`}/>
      <MetricCard label="Latest OI delta" value={latestOiDelta ? formatCompact(oiUnit === 'base' ? latestOiDelta.deltaBase : latestOiDelta.deltaUsd, oiUnit === 'usd') : '—'} detail={latestOiDelta ? `${signed(oiUnit === 'base' ? latestOiDelta.pctBase : latestOiDelta.pctUsd)} · score ${latestOiDelta.robustScore.toFixed(2)}` : 'Awaiting history'} tone={(latestOiDelta?.deltaBase ?? 0) >= 0 ? 'positive' : 'negative'}/>
      <MetricCard label="Latest volume delta" value={formatCompact(latestVolume?.deltaNotional, true)} detail={latestVolume ? `${signed(latestVolume.imbalancePct)} aggressor imbalance` : 'Recent aggregate trades unavailable'} tone={(latestVolume?.deltaNotional ?? 0) >= 0 ? 'positive' : 'negative'}/>
      <MetricCard label="Detected structures" value={String(signals.length)} detail={`${signals.filter((signal) => signal.freshness === 'live').length} fresh · replay enabled`}/>
    </section>
    {flow?.methodology.oneMinuteOiNotice && <div className="oi-notice"><AlertTriangle size={15}/><div><strong>Authoritative OI granularity</strong><span>{flow.methodology.oneMinuteOiNotice}</span></div></div>}
    <div className="flow-toolbar">
      <div className="indicator-toggles" aria-label="Indicator visibility">{FLOW_INDICATORS.map(([key, label]) => <button key={key} aria-pressed={visible[key]} className={visible[key] ? 'active' : ''} onClick={() => toggle(key)}><i/>{t(label)}</button>)}</div>
      <div className="unit-toggle"><span>OI unit</span><button className={oiUnit === 'base' ? 'active' : ''} onClick={() => setOiUnit('base')}>BASE</button><button className={oiUnit === 'usd' ? 'active' : ''} onClick={() => setOiUnit('usd')}>USD</button></div>
    </div>
    <section className="chart-stack panel flow-charts">
      {visible.price && <><PanelHead title="Price & candlesticks" meta={`${interval.toUpperCase()} · Binance USDT-M · shared UTC axis`} action={overview ? `Mark ${formatPrice(overview.markPrice)}` : undefined}/><CandleChart points={series?.candles ?? []} cursor={cursor} onCursor={setCursor}/></>}
      {visible.oi && <FlowPanel title="Open interest" meta={`${oiUnit === 'base' ? 'Venue sumOpenInterest base quantity' : 'Venue sumOpenInterestValue notional'} · raw value`} current={formatCompact(oiPoints.at(-1)?.value, oiUnit === 'usd')}><LineChart points={oiPoints} cursor={cursor} onCursor={setCursor} color="#b9c3ca" height={140}/></FlowPanel>}
      {visible.oiDelta && <FlowPanel title="Open interest delta" meta="Change in outstanding contracts — distinct from traded volume" current={latestOiDelta ? signed(oiUnit === 'base' ? latestOiDelta.pctBase : latestOiDelta.pctUsd) : '—'}><OiDeltaChart points={flow?.oiDelta ?? []} unit={oiUnit} cursor={cursor} onCursor={setCursor}/></FlowPanel>}
      {visible.taker && <FlowPanel title="Taker buy / sell volume" meta="Aggressor-side notional from Binance aggregate trades" current={latestVolume ? `B ${formatCompact(latestVolume.buyNotional, true)} / S ${formatCompact(latestVolume.sellNotional, true)}` : '—'}><TakerFlowChart points={flow?.volumeFlow ?? []} cursor={cursor} onCursor={setCursor}/></FlowPanel>}
      {visible.volumeDelta && <FlowPanel title="Volume delta" meta="Aggressor buy notional − aggressor sell notional — not OI delta" current={formatCompact(latestVolume?.deltaNotional, true)}><VolumeDeltaChart points={flow?.volumeFlow ?? []} cursor={cursor} onCursor={setCursor}/></FlowPanel>}
      {visible.cvd && <FlowPanel title="Cumulative volume delta" meta="Running sum inside the fetched aggregate-trade window" current={formatCompact(series?.cvd.at(-1)?.value, true)}><LineChart points={series?.cvd ?? []} cursor={cursor} onCursor={setCursor} color="#53c9a7" baseline height={150}/></FlowPanel>}
      <div className="chart-foot"><span>{series?.coverage.cvdMethod ?? 'Awaiting aggressor-flow coverage'}</span><span>Updated {series ? timeAgo(series.eventTime) : '—'}</span></div>
    </section>
    {visible.signals && <div className="signal-layout">
      <section className="panel signal-replay"><PanelHead title="Historical signal replay" meta={`${signals.length} classifications · select a timestamp to synchronize charts`}/>{signals.length ? <div className="signal-list">{signals.slice(0, 16).map((signal) => <button key={signal.id} className={selectedSignal?.id === signal.id ? 'active' : ''} onClick={() => replaySignal(signal)}><span className={`signal-dot ${signalTone(signal)}`}/><div><strong>{signal.label}</strong><small>{new Date(signal.time).toLocaleString()} · {signal.freshness}</small></div><em>{signal.confidence}%</em></button>)}</div> : <div className="empty">No position-flow pattern met the configured thresholds in this window.</div>}</section>
      <section className="panel signal-detail"><PanelHead title="Classification evidence" meta="Inferred structure, never an observed position opening" action={selectedSignal ? `${selectedSignal.confidence}% confidence` : undefined}/>{selectedSignal ? <div className="signal-body"><div className="signal-title"><span className={`signal-dot ${signalTone(selectedSignal)}`}/><div><strong>{selectedSignal.label}</strong><small>{new Date(selectedSignal.time).toLocaleString()} · {selectedSignal.freshness.toUpperCase()}</small></div></div><div className="observed-row">{selectedSignal.observed.map((item) => <span key={item}>{item}</span>)}</div><EvidenceGroup title="Supporting evidence" items={selectedSignal.evidence}/><EvidenceGroup title="Counterevidence / limits" items={selectedSignal.counterevidence}/><p className="inference-notice"><AlertTriangle size={13}/>{selectedSignal.inferenceNotice}</p></div> : <div className="empty">Select a detected signal to review its evidence.</div>}</section>
    </div>}
    <section className="panel backtest-panel"><PanelHead title="Historical reliability check" meta={`${flow?.methodology.forwardHorizonBars ?? 3}-bar forward outcome · fetched chart window · no fees or slippage`}/>{flow?.backtest.length ? <div className="backtest-grid">{flow.backtest.map((result) => <article key={result.type}><span>{result.label}</span><strong>{result.hitRate == null ? 'N/A' : `${result.hitRate.toFixed(1)}%`}</strong><small>{result.resolvedSamples}/{result.samples} resolved · avg {result.averageForwardReturnPct == null ? '—' : signed(result.averageForwardReturnPct)}</small><p>{result.caveat}</p></article>)}</div> : <div className="empty compact-empty">No resolved signal samples are available in this fetched window.</div>}</section>
    <section className="methodology-row"><div><strong>OI spike</strong><span>{flow?.methodology.oiSpikeRule ?? 'Robust median-deviation threshold'}</span></div><div><strong>Volume delta</strong><span>{flow?.methodology.volumeDeltaRule ?? 'Aggressor-side trade classification'}</span></div><div><strong>Classification boundary</strong><span>{flow?.methodology.classificationRule ?? 'Probabilistic evidence combination'}</span></div></section>
  </>;
}

function MetricCard({ label, value, detail, tone = '' }: { label: string; value: string; detail: string; tone?: string }) { const { t } = useUi(); return <div><span>{t(label)}</span><strong className={tone}>{value}</strong><small>{t(detail)}</small></div>; }
function FlowPanel({ title, meta, current, children }: { title: string; meta: string; current: string; children: React.ReactNode }) { return <><div className="chart-divider"/><ChartLabel title={title} meta={meta} current={current}/>{children}</>; }
function EvidenceGroup({ title, items }: { title: string; items: string[] }) { return <div className="evidence-group"><strong>{title}</strong><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>; }
function signalTone(signal: PositionFlowSignal) { return signal.type.includes('long_buildup') || signal.type.includes('short_covering') ? 'positive' : signal.type.includes('short_buildup') || signal.type.includes('long_liquidation') ? 'negative' : 'neutral'; }

function chartMouseIndex(event: React.MouseEvent<HTMLDivElement>, length: number, width = 1000) {
  const rect = event.currentTarget.getBoundingClientRect();
  return Math.max(0, Math.min(length - 1, Math.round(((event.clientX - rect.left) / rect.width * width - 45) / (width - 65) * (length - 1))));
}

function OiDeltaChart({ points, unit, cursor, onCursor }: { points: OiDeltaPoint[]; unit: 'base' | 'usd'; cursor: number | null; onCursor: (n: number | null) => void }) {
  const values = points.map((point) => unit === 'base' ? point.deltaBase : point.deltaUsd);
  return <SignedHistogram points={points} values={values} cursor={cursor} onCursor={onCursor} tooltip={(point) => <><strong>{new Date(point.time).toLocaleString()}</strong><span>Δ {formatCompact(unit === 'base' ? point.deltaBase : point.deltaUsd, unit === 'usd')}</span><span>{signed(unit === 'base' ? point.pctBase : point.pctUsd)}</span><span>OI {formatCompact(unit === 'base' ? point.baseValue : point.usdValue, unit === 'usd')}</span><span>Score {point.robustScore.toFixed(2)}{point.spike ? ' · SPIKE' : ''}</span></>}/>
}

function VolumeDeltaChart({ points, cursor, onCursor }: { points: VolumeFlowPoint[]; cursor: number | null; onCursor: (n: number | null) => void }) {
  return <SignedHistogram points={points} values={points.map((point) => point.deltaNotional)} cursor={cursor} onCursor={onCursor} tooltip={(point) => <><strong>{new Date(point.time).toLocaleString()}</strong><span>Δ {formatCompact(point.deltaNotional, true)}</span><span>Imbalance {signed(point.imbalancePct)}</span><span>Buy {formatCompact(point.buyNotional, true)}</span><span>Sell {formatCompact(point.sellNotional, true)}</span></>}/>
}

function SignedHistogram<T extends { time: number }>({ points, values, cursor, onCursor, tooltip }: { points: T[]; values: number[]; cursor: number | null; onCursor: (n: number | null) => void; tooltip: (point: T) => React.ReactNode }) {
  const width = 1000, height = 145, zero = height / 2, maxAbs = Math.max(1, ...values.map(Math.abs));
  if (!points.length) return <ChartEmpty/>;
  const x = (index: number) => 45 + index * (width - 65) / Math.max(points.length - 1, 1); const barWidth = Math.max(2, Math.min(10, (width - 65) / points.length * .7));
  const hover = cursor == null ? null : points[nearestIndex(points, cursor)];
  return <div className="chart line-chart histogram-chart" onMouseLeave={() => onCursor(null)} onMouseMove={(event) => onCursor(points[chartMouseIndex(event, points.length)].time)}><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><Grid width={width} height={height}/><line className="zero-line" x1="0" x2={width} y1={zero} y2={zero}/>{points.map((point, index) => { const value = values[index]; const barHeight = Math.max(1, Math.abs(value) / maxAbs * (height / 2 - 12)); return <rect key={point.time} className={value >= 0 ? 'hist-positive' : 'hist-negative'} x={x(index) - barWidth / 2} y={value >= 0 ? zero - barHeight : zero} width={barWidth} height={barHeight}/>; })}{cursor != null && <line className="crosshair" x1={x(nearestIndex(points, cursor))} x2={x(nearestIndex(points, cursor))} y1="0" y2={height}/>}</svg>{hover && <div className="chart-tooltip compact">{tooltip(hover)}</div>}</div>;
}

function TakerFlowChart({ points, cursor, onCursor }: { points: VolumeFlowPoint[]; cursor: number | null; onCursor: (n: number | null) => void }) {
  const width = 1000, height = 145, zero = height / 2, max = Math.max(1, ...points.flatMap((point) => [point.buyNotional, point.sellNotional]));
  if (!points.length) return <ChartEmpty/>;
  const x = (index: number) => 45 + index * (width - 65) / Math.max(points.length - 1, 1); const barWidth = Math.max(2, Math.min(8, (width - 65) / points.length * .35)); const hover = cursor == null ? null : points[nearestIndex(points, cursor)];
  return <div className="chart line-chart histogram-chart" onMouseLeave={() => onCursor(null)} onMouseMove={(event) => onCursor(points[chartMouseIndex(event, points.length)].time)}><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><Grid width={width} height={height}/><line className="zero-line" x1="0" x2={width} y1={zero} y2={zero}/>{points.map((point, index) => { const buyHeight = Math.max(1, point.buyNotional / max * (height / 2 - 12)); const sellHeight = Math.max(1, point.sellNotional / max * (height / 2 - 12)); return <g key={point.time}><rect className="hist-positive" x={x(index) - barWidth - 1} y={zero - buyHeight} width={barWidth} height={buyHeight}/><rect className="hist-negative" x={x(index) + 1} y={zero} width={barWidth} height={sellHeight}/></g>; })}{cursor != null && <line className="crosshair" x1={x(nearestIndex(points, cursor))} x2={x(nearestIndex(points, cursor))} y1="0" y2={height}/>}</svg>{hover && <div className="chart-tooltip compact"><strong>{new Date(hover.time).toLocaleString()}</strong><span>Buy {formatCompact(hover.buyNotional, true)}</span><span>Sell {formatCompact(hover.sellNotional, true)}</span><span>Δ {formatCompact(hover.deltaNotional, true)}</span><span>{signed(hover.imbalancePct)}</span></div>}</div>;
}

function CandleChart({ points, cursor, onCursor }: { points: CandlePoint[]; cursor: number | null; onCursor: (n: number | null) => void }) {
  const width = 1000, height = 300, top = 15, bottom = 58; const inner = height - top - bottom;
  if (!points.length) return <ChartEmpty/>;
  const high = Math.max(...points.map((p) => p.high)), low = Math.min(...points.map((p) => p.low)); const maxVol = Math.max(...points.map((p) => p.volumeUsd));
  const y = (v: number) => top + (high - v) / Math.max(high - low, 1e-9) * (inner - 64); const x = (i: number) => 45 + i * (width - 65) / Math.max(points.length - 1, 1); const candleWidth = Math.max(2, Math.min(7, (width - 65) / points.length * .65));
  const hover = cursor == null ? null : points.reduce((best, p) => Math.abs(p.time - cursor) < Math.abs(best.time - cursor) ? p : best, points[0]);
  return <div className="chart" onMouseLeave={() => onCursor(null)} onMouseMove={(e) => { const rect = e.currentTarget.getBoundingClientRect(); const i = Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - rect.left) / rect.width * width - 45) / (width - 65) * (points.length - 1)))); onCursor(points[i].time); }}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><Grid width={width} height={height}/>{points.map((p, i) => { const up = p.close >= p.open; const cx = x(i); return <g key={p.time} className={up ? 'candle-up' : 'candle-down'}><line x1={cx} x2={cx} y1={y(p.high)} y2={y(p.low)}/><rect x={cx - candleWidth / 2} y={Math.min(y(p.open), y(p.close))} width={candleWidth} height={Math.max(1.5, Math.abs(y(p.open) - y(p.close)))}/><rect className="volume" x={cx - candleWidth / 2} y={height - 13 - p.volumeUsd / maxVol * 42} width={candleWidth} height={p.volumeUsd / maxVol * 42}/></g>; })}{cursor && <line className="crosshair" x1={x(nearestIndex(points, cursor))} x2={x(nearestIndex(points, cursor))} y1="0" y2={height}/>}</svg>
    {hover && <div className="chart-tooltip"><strong>{new Date(hover.time).toLocaleString()}</strong><span>O {formatPrice(hover.open)}</span><span>H {formatPrice(hover.high)}</span><span>L {formatPrice(hover.low)}</span><span>C {formatPrice(hover.close)}</span><span>Vol {formatCompact(hover.volumeUsd, true)}</span></div>}
  </div>;
}

function LineChart({ points, cursor, onCursor, color, height = 140, baseline = false }: { points: LinePoint[] | CvdPoint[]; cursor: number | null; onCursor: (n: number | null) => void; color: string; height?: number; baseline?: boolean }) {
  const width = 1000; if (!points.length) return <ChartEmpty/>; const max = Math.max(...points.map((p) => p.value)), min = Math.min(...points.map((p) => p.value)); const pad = Math.max((max - min) * .12, 1); const y = (v: number) => 12 + (max + pad - v) / (max - min + pad * 2) * (height - 28); const x = (i: number) => 45 + i * (width - 65) / Math.max(points.length - 1, 1); const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join(' '); const hover = cursor == null ? null : points[nearestIndex(points, cursor)];
  return <div className="chart line-chart" onMouseLeave={() => onCursor(null)} onMouseMove={(e) => { const rect = e.currentTarget.getBoundingClientRect(); const i = Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - rect.left) / rect.width * width - 45) / (width - 65) * (points.length - 1)))); onCursor(points[i].time); }}><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><Grid width={width} height={height}/>{baseline && min < 0 && max > 0 && <line className="zero-line" x1="0" x2={width} y1={y(0)} y2={y(0)}/>}<path d={path} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"/>{cursor && <line className="crosshair" x1={x(nearestIndex(points, cursor))} x2={x(nearestIndex(points, cursor))} y1="0" y2={height}/>}</svg>{hover && <div className="chart-tooltip compact"><strong>{new Date(hover.time).toLocaleString()}</strong><span>{formatCompact(hover.value, baseline)}</span>{'delta' in hover && <span>Δ {formatCompact((hover as CvdPoint).delta, true)}</span>}</div>}</div>;
}
function Grid({ width, height }: { width: number; height: number }) { return <g className="grid-lines">{[.2,.4,.6,.8].map((n) => <line key={`h${n}`} x1="0" x2={width} y1={height*n} y2={height*n}/>)}{[.2,.4,.6,.8].map((n) => <line key={`v${n}`} y1="0" y2={height} x1={width*n} x2={width*n}/>)}</g>; }
function nearestIndex(points: Array<{ time: number }>, time: number) { let best = 0; for (let i=1;i<points.length;i++) if (Math.abs(points[i].time-time) < Math.abs(points[best].time-time)) best=i; return best; }
function ChartEmpty() { return <div className="chart-empty"><Activity size={20}/><span>Series unavailable from the venue</span></div>; }
function ChartLabel({ title, meta, current }: { title: string; meta: string; current: string }) { const { t } = useUi(); return <div className="chart-label"><div><strong>{t(title)}</strong><span>{t(meta)}</span></div><em>{current}</em></div>; }

function DerivativesPage({ overview, series }: { overview: Overview | null; series: MarketSeries | null }) { return <><PageHead eyebrow="DERIVATIVES" title={`${overview?.symbol ?? 'Market'} positioning`} detail="Venue-reported OI and funding, with base units kept distinct from price-sensitive USD notional."/><KpiStrip overview={overview}/><div className="two-column"><section className="panel padded"><PanelHead title="Open interest history" meta="Base quantity"/><LineChart points={series?.oiBase ?? []} cursor={null} onCursor={() => {}} color="#c7d0d5" height={240}/></section><section className="panel padded"><PanelHead title="Funding settlement" meta="Authoritative nextFundingTime"/><div className="funding-focus"><span>Current rate</span><strong className={(overview?.fundingRate ?? 0) >= 0 ? 'positive' : 'negative'}>{overview ? signed(overview.fundingRate * 100, '%') : '—'}</strong><span>Next settlement</span><em>{countdown(overview?.nextFundingTime)}</em><small>{overview?.nextFundingTime ? new Date(overview.nextFundingTime).toLocaleString() : 'Unavailable'}</small></div><div className="method-note"><strong>Interpretation boundary</strong><p>Funding can reflect demand imbalance, but is not proof of a crowded trade or future price direction.</p></div></section></div></>; }

function SettingsPage() { const [health, setHealth] = useState<{ status: string; latencyMs: number; checkedAt: number } | null>(null); const [capabilities, setCapabilities] = useState<ExchangeCapabilities[]>([]); useEffect(() => { api<typeof health>('/data-health').then(setHealth).catch(() => setHealth(null)); api<{ items: ExchangeCapabilities[] }>('/exchanges').then((value) => setCapabilities(value.items)).catch(() => setCapabilities([])); }, []); return <><PageHead eyebrow="SYSTEM" title="Data sources & methodology" detail="Connection state, provenance and quantitative definitions for project-scoped collection."/><div className="two-column"><section className="panel source-card"><PanelHead title="Market data fabric" meta="Public, unauthenticated sources"/><div className="source-status"><i className={health?.status === 'live' ? 'live' : ''}/><div><strong>{health?.status === 'live' ? 'Operational' : 'Checking'}</strong><span>{health ? `${health.latencyMs} ms Binance REST probe · ${timeAgo(health.checkedAt)}` : 'Awaiting health probe'}</span></div></div><dl><div><dt>CEX adapters</dt><dd>9 native adapters · venue-specific REST / WebSocket</dd></div><div><dt>On-chain</dt><dd>DexPaprika contract-scoped context</dd></div><div><dt>Scope</dt><dd>Selected project markets only</dd></div><div><dt>Credentials</dt><dd>None required for current sources</dd></div></dl></section><section className="panel source-card"><PanelHead title="Calculation contract" meta="Unified model"/><dl><div><dt>CVD</dt><dd>Σ aggressor-signed price × quantity</dd></div><div><dt>OI USD</dt><dd>Normalized base OI × mark price</dd></div><div><dt>Volume</dt><dd>Venue 24H quote notional</dd></div><div><dt>Freshness</dt><dd>Event time, never silent zero</dd></div></dl></section></div><section className="panel capability-panel"><PanelHead title="Exchange capability matrix" meta="Runtime source registry · unsupported fields stay unavailable"/><div className="table-wrap"><table><thead><tr>{['Exchange','Discovery','Snapshot','Ticker WS','Trades WS','History','Open interest','Funding','Order book','Liquidations'].map((item) => <th key={item}>{item}</th>)}</tr></thead><tbody>{capabilities.map((item) => <tr key={item.exchange}><td><strong>{item.label}</strong><small>{item.notes[0]}</small></td>{[item.restDiscovery,item.restSnapshot,item.websocketTicker,item.websocketTrades,item.historicalSeries,item.openInterest,item.funding,item.websocketOrderBook,item.liquidations].map((enabled, index) => <td key={index}><span className={`capability-state ${enabled ? 'enabled' : 'disabled'}`}>{enabled ? 'YES' : 'N/A'}</span></td>)}</tr>)}</tbody></table></div></section><section className="panel limitations"><PanelHead title="Known source limitations" meta="Visible by design"/><div><p><strong>Aggregate trades</strong> can combine fills by venue rules. Native historical CVD is currently Binance-only.</p><p><strong>DEX liquidity</strong> is not CEX order-book depth. Top-pool totals cover returned pools only.</p><p><strong>AI research context</strong> exports observed data, inferences and nulls separately; it is not an execution recommendation.</p></div></section></>; }

function PageHead({ eyebrow, title, detail, right }: { eyebrow: string; title: string; detail: string; right?: React.ReactNode }) { const { t } = useUi(); return <div className="page-head"><div><span>{t(eyebrow)}</span><h1>{t(title)}</h1><p>{t(detail)}</p></div>{right}</div>; }
function PanelHead({ title, meta, action }: { title: string; meta?: string; action?: string }) { const { t } = useUi(); return <div className="panel-head"><div><strong>{t(title)}</strong>{meta && <span>{t(meta)}</span>}</div>{action && <button>{t(action)}</button>}</div>; }
function Observation({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: string }) { const { t } = useUi(); return <div className={`observation ${tone}`}><div className="observation-icon">{icon}</div><div><span>{t(label)}</span><strong>{t(value)}</strong><p>{t(detail)}</p></div></div>; }
