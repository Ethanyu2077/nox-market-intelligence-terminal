import { useEffect, useState, type ReactNode } from 'react';
import { Mosaic, MosaicWindow, type MosaicNode } from 'react-mosaic-component';
import 'react-mosaic-component/react-mosaic-component.css';
import type { MarketProject, ProjectVenueResponse } from '../shared/types';
import type { SignalEvent } from '../shared/research';
import { INITIAL_RESEARCH_LAYOUT as INITIAL, RESEARCH_PANELS as PANELS, validLayout, type ResearchPanel as Panel } from '../shared/research-layout';
import { ResearchAssistantPanel } from './ai/ResearchAssistantPanel';
import { CrossExchangePanel } from './CrossExchangePanel';

/**
 * Draggable research workspace. Panels share one project context; the assistant panel is
 * the DeepSeek surface and the timeline panel stays deterministic.
 */
export function ResearchWorkspace({ project, data, chart, language }: { project: MarketProject; data: ProjectVenueResponse | null; chart: ReactNode; language: 'en' | 'zh' }) {
  const zh = language === 'zh';
  const storageKey = `nox:research-layout:v1:${project.id}`;
  const readLayout = () => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      return validLayout(parsed) ? parsed : INITIAL;
    } catch { return INITIAL; }
  };
  const [layout, setLayout] = useState<MosaicNode<Panel> | null>(readLayout);
  const [signals, setSignals] = useState<SignalEvent[]>([]);
  const [signalsBusy, setSignalsBusy] = useState(false);
  const [error, setError] = useState('');
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [now, setNow] = useState(Date.now());
  // Mosaic drag/dock is unusable on touch; below 860px the same panels stack instead.
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 860px)');
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const titles: Record<Panel, string> = {
    chart: zh ? '同步市场图表' : 'Synchronized market charts',
    research: zh ? 'DeepSeek 研究助手' : 'DeepSeek research assistant',
    sources: zh ? '来源与新鲜度' : 'Provenance & freshness',
    timeline: zh ? '内部信号时间线' : 'Internal signal timeline',
  };

  useEffect(() => { setLayout(readLayout()); setSignals([]); setError(''); }, [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/projects/${project.id}/signals`, { signal: controller.signal })
      .then((response) => response.json())
      .then((result) => setSignals(result.items ?? []))
      .catch(() => undefined);
    return () => controller.abort();
  }, [project.id]);
  const changeLayout = (next: MosaicNode<Panel> | null) => {
    setLayout(next);
    if (!next) return;
    try { localStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { setError(zh ? '布局已更新，但浏览器无法保存。' : 'Layout updated, but browser storage is unavailable.'); }
  };

  const refreshSignals = async () => {
    setSignalsBusy(true); setError('');
    try {
      const response = await fetch(`/api/projects/${project.id}/signals/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message ?? 'Signal refresh failed');
      setSignals(result.items ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Signal refresh failed'); }
    finally { setSignalsBusy(false); }
  };

  const actions = [
    { label: zh ? '恢复默认布局' : 'Restore default layout', run: () => changeLayout(INITIAL) },
    ...PANELS.map((id) => ({ label: titles[id], run: () => changeLayout(id) })),
    { label: zh ? '刷新内部信号（确定性）' : 'Refresh internal signals (deterministic)', run: () => void refreshSignals() },
  ].filter((action) => action.label.toLowerCase().includes(query.toLowerCase()));

  const sourceBody = (
    <div className="research-sources">
      {data?.snapshots.map((snapshot, index) => (
        <article key={`${snapshot.exchange}:${snapshot.symbol}`}>
          <strong>S{index + 1} · {snapshot.exchange} · {snapshot.symbol}</strong>
          <span>{(now - snapshot.eventTime > 60_000 ? 'stale' : snapshot.eventTime > now + 5000 ? 'clock-skew' : snapshot.quality).toUpperCase()} · {new Date(snapshot.eventTime).toLocaleString()} · {Math.max(0, Math.floor((now - snapshot.eventTime) / 1000))}s</span>
          <small>{snapshot.source}</small>
          <small>{zh ? '不可用' : 'Unavailable'}: {snapshot.unavailable.join(', ') || '—'}</small>
        </article>
      ))}
      {data?.failures.map((failure) => <p key={`${failure.exchange}:${failure.symbol}`}>{failure.exchange}: {failure.message}</p>)}
      {!data && <p>{zh ? '等待真实数据，无模拟值。' : 'Awaiting real data. No mock values.'}</p>}
    </div>
  );

  const timelineBody = (
    <>
      <button disabled={signalsBusy} onClick={() => void refreshSignals()}>{signalsBusy ? (zh ? '刷新中…' : 'Refreshing…') : (zh ? '刷新内部信号' : 'Refresh internal signals')}</button>
      <p className="research-muted">{zh ? '外部发布关闭。只记录公开指标推断。' : 'External publishing OFF. Public-metric inferences only.'}</p>
      {signals.length
        ? [...signals].reverse().map((signal) => (
          <article key={signal.id}>
            <strong>{signal.category} · {signal.venue}</strong>
            <p>{new Date(signal.timestamp).toLocaleString()} · {signal.confidence} · {signal.freshness}</p>
            <small>{signal.classification} · {signal.id.slice(0, 12)}</small>
          </article>
        ))
        : <p>{zh ? '暂无符合条件的新鲜信号；不生成占位数据。' : 'No qualifying fresh signals. No placeholder events.'}</p>}
    </>
  );

  const body = (id: Panel) => {
    if (id === 'chart') return chart;
    if (id === 'sources') return sourceBody;
    if (id === 'timeline') return timelineBody;
    return <ResearchAssistantPanel project={project} language={language} />;
  };

  return (
    <section className="research-workspace">
      <header className="research-toolbar">
        <div><h1>{zh ? '研究工作区' : 'Research workspace'}</h1></div>
        <button onClick={() => setPalette(true)}>⌘ / Ctrl K</button>
        <button onClick={() => changeLayout(INITIAL)}>{zh ? '重置布局' : 'Reset layout'}</button>
      </header>
      {error && <p role="alert" className="research-error">{error}</p>}
      {narrow ? (
        <div className="research-stack">
          {PANELS.map((id) => (
            <section className={`panel research-stack-panel ${id}`} key={id}>
              <header className="research-stack-head"><strong>{titles[id]}</strong></header>
              <div className={id === 'research' ? 'research-panel-host' : 'research-panel-body'}>{body(id)}</div>
            </section>
          ))}
        </div>
      ) : (
      <div className="research-mosaic">
        <Mosaic<Panel>
          value={layout}
          onChange={changeLayout}
          renderTile={(id, path) => (
            <MosaicWindow<Panel> path={path} title={titles[id]} toolbarControls={[]}>
              <div className={id === 'research' ? 'research-panel-host' : 'research-panel-body'}>{body(id)}</div>
            </MosaicWindow>
          )}
        />
      </div>
      )}
      {palette && (
        <div className="research-palette-backdrop" onClick={() => setPalette(false)}>
          <div role="dialog" aria-modal="true" aria-label={zh ? '工作区命令' : 'Workspace commands'} className="research-palette" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus
              aria-label="Search workspace commands"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
              placeholder={zh ? '搜索命令…' : 'Search commands…'}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => Math.min(value + 1, actions.length - 1)); }
                if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
                if (event.key === 'Enter' && actions[selected]) { actions[selected].run(); setPalette(false); }
              }}
            />
            {actions.map((action, index) => (
              <button className={index === selected ? 'selected' : ''} key={action.label} onClick={() => { action.run(); setPalette(false); }}>{action.label}</button>
            ))}
            <button onClick={() => setPalette(false)}>Esc · {zh ? '关闭' : 'Close'}</button>
          </div>
        </div>
      )}
      <CrossExchangePanel project={project} language={language} />
    </section>
  );
}
