import { Component, lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Maximize2, Minimize2, RefreshCw } from 'lucide-react';
import type { ProjectMarket } from '../shared/types';
import { resolveTradingViewSymbol, toTradingViewInterval, type NoxInterval } from '../shared/tradingview';

export type ChartMode = 'nox' | 'tradingview';

const LazyAdvancedRealTimeChart = lazy(async () => {
  const module = await import('react-ts-tradingview-widgets');
  return { default: module.AdvancedRealTimeChart };
});

const COPYRIGHT_STYLES = {
  parent: { fontSize: '10px', lineHeight: '28px', textAlign: 'right' as const, paddingRight: '12px' },
  link: { textDecoration: 'none' },
  span: { color: '#2fd47c' }
};

export function ChartModeSwitcher({ mode, onChange, language }: { mode: ChartMode; onChange: (mode: ChartMode) => void; language: 'en' | 'zh' }) {
  return <div className="chart-mode-switcher" role="group" aria-label={language === 'zh' ? '图表模式' : 'Chart mode'}>
    <span>{language === 'zh' ? '图表模式' : 'CHART MODE'}</span>
    <button className={mode === 'nox' ? 'active' : ''} onClick={() => onChange('nox')}>{language === 'zh' ? 'NOX 市场结构' : 'NOX Market Structure'}</button>
    <button className={mode === 'tradingview' ? 'active' : ''} onClick={() => onChange('tradingview')}>TradingView</button>
  </div>;
}

export function ChartTimeframeSelector({ interval, onChange }: { interval: NoxInterval; onChange: (interval: NoxInterval) => void }) {
  return <div className="tv-timeframes" role="group" aria-label="Chart timeframe">{(['1m', '5m', '15m', '1h', '4h'] as NoxInterval[]).map((value) => <button key={value} className={interval === value ? 'active' : ''} onClick={() => onChange(value)}>{value.toUpperCase()}</button>)}</div>;
}

export function ChartErrorFallback({ message, onRetry, language }: { message: string; onRetry?: () => void; language: 'en' | 'zh' }) {
  return <div className="tv-chart-fallback"><AlertTriangle size={22}/><strong>{language === 'zh' ? 'TradingView 图表不可用' : 'TradingView chart unavailable'}</strong><p>{message}</p>{onRetry && <button onClick={onRetry}><RefreshCw size={14}/>{language === 'zh' ? '重试' : 'Retry'}</button>}<small>{language === 'zh' ? 'NOX 原生图表及衍生品分析仍可正常使用。' : 'NOX native charts and derivatives analytics remain available.'}</small></div>;
}

class TradingViewErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.error('TradingView widget failed to render', error); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function TradingViewChartPanelComponent({ market, interval, onInterval, theme, language }: { market: ProjectMarket | null | undefined; interval: NoxInterval; onInterval: (interval: NoxInterval) => void; theme: 'dark' | 'light'; language: 'en' | 'zh' }) {
  const resolution = useMemo(() => resolveTradingViewSymbol(market), [market]);
  const [fullscreen, setFullscreen] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const containerId = useMemo(() => `nox_tv_${(market?.id ?? 'unavailable').replace(/[^a-zA-Z0-9_]/g, '_')}_${retryKey}`, [market?.id, retryKey]);

  useEffect(() => {
    setLoaded(false);
    if (!resolution.available) return;
    const host = hostRef.current;
    if (!host) return;
    const detectFrame = () => { if (host.querySelector('iframe')) setLoaded(true); };
    const observer = new MutationObserver(detectFrame);
    observer.observe(host, { childList: true, subtree: true });
    detectFrame();
    return () => observer.disconnect();
  }, [containerId, resolution.available]);

  useEffect(() => {
    if (!fullscreen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [fullscreen]);

  if (!resolution.available || !resolution.symbol) return <section className="panel tv-chart-panel"><ChartErrorFallback message={resolution.reason ?? 'The selected market could not be resolved.'} language={language}/></section>;
  const retry = () => setRetryKey((value) => value + 1);
  const fallback = <ChartErrorFallback message={language === 'zh' ? '无法加载 TradingView 组件。请检查网络或内容拦截设置。' : 'The TradingView component could not load. Check the network or content-blocking settings.'} onRetry={retry} language={language}/>;

  return <section className={`panel tv-chart-panel ${fullscreen ? 'fullscreen' : ''}`}>
    <div className="tv-chart-head">
      <div><span>TRADINGVIEW ADVANCED CHART</span><strong>{resolution.symbol}</strong><small>{resolution.exchange} · {resolution.marketType?.toUpperCase()} · {language === 'zh' ? '第三方市场数据' : 'third-party market data'}</small></div>
      <ChartTimeframeSelector interval={interval} onChange={onInterval}/>
      <button className="tv-fullscreen" onClick={() => setFullscreen((value) => !value)} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>{fullscreen ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}<span>{language === 'zh' ? (fullscreen ? '退出全屏' : '全屏') : (fullscreen ? 'Exit' : 'Full screen')}</span></button>
    </div>
    <div className="tv-chart-host" ref={hostRef}>
      {!loaded && <div className="tv-chart-loading"><i/><span>{language === 'zh' ? '正在连接 TradingView…' : 'Connecting to TradingView…'}</span></div>}
      <TradingViewErrorBoundary key={retryKey} fallback={fallback}>
        <Suspense fallback={fallback}>
          <LazyAdvancedRealTimeChart
            key={`${resolution.symbol}-${interval}-${theme}-${retryKey}`}
            autosize
            symbol={resolution.symbol}
            interval={toTradingViewInterval(interval)}
            timezone="Etc/UTC"
            theme={theme}
            locale={language === 'zh' ? 'zh_CN' : 'en'}
            style="1"
            toolbar_bg={theme === 'dark' ? '#09141a' : '#ffffff'}
            backgroundColor={theme === 'dark' ? '#05090d' : '#ffffff'}
            enable_publishing={false}
            withdateranges
            hide_top_toolbar={false}
            hide_side_toolbar={false}
            allow_symbol_change={false}
            save_image
            details={false}
            container_id={containerId}
            copyrightStyles={COPYRIGHT_STYLES}
          />
        </Suspense>
      </TradingViewErrorBoundary>
    </div>
    <div className="tv-chart-note"><span>{language === 'zh' ? 'TradingView 内嵌组件不接收 NOX 私有数据，也不与外部 OI/CVD 面板共享十字线。' : 'The embedded widget does not receive NOX private data or share a crosshair with external OI/CVD panels.'}</span><a href={`https://www.tradingview.com/symbols/${resolution.symbol.replace(':', '-')}/`} target="_blank" rel="noreferrer">{language === 'zh' ? '在 TradingView 查看' : 'View on TradingView'}</a></div>
  </section>;
}

export const TradingViewChartPanel = memo(TradingViewChartPanelComponent);
