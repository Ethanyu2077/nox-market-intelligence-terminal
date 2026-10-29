import { useEffect, useState, type ReactNode } from 'react';
import { Mosaic, MosaicWindow, type MosaicNode } from 'react-mosaic-component';
import 'react-mosaic-component/react-mosaic-component.css';
import type { MarketProject, ProjectVenueResponse } from '../shared/types';
import type { ResearchReport, SignalEvent } from '../shared/research';
import { INITIAL_RESEARCH_LAYOUT as INITIAL, RESEARCH_PANELS as PANELS, validLayout, type ResearchPanel as Panel } from '../shared/research-layout';

export function ResearchWorkspace({ project, data, chart, language }: { project: MarketProject; data: ProjectVenueResponse | null; chart: ReactNode; language: 'en' | 'zh' }) {
  const zh = language === 'zh', key = `nox:research-layout:v1:${project.id}`;
  const readLayout = () => { try { const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); return validLayout(parsed) ? parsed : INITIAL; } catch { return INITIAL; } };
  const [layout, setLayout] = useState<MosaicNode<Panel> | null>(readLayout);
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [signals, setSignals] = useState<SignalEvent[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [question, setQuestion] = useState('Explain the observed market structure and data limitations.');
  const [palette, setPalette] = useState(false), [query, setQuery] = useState(''), [selected, setSelected] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const titles = { chart: zh ? '同步市场图表' : 'Synchronized market charts', research: zh ? '只读研究助手' : 'Read-only research assistant', sources: zh ? '来源与新鲜度' : 'Provenance & freshness', timeline: zh ? '内部信号时间线' : 'Internal signal timeline' };
  useEffect(() => { setLayout(readLayout()); setReport(null); setSignals([]); setError(''); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const controller = new AbortController(); void fetch(`/api/projects/${project.id}/signals`, { signal: controller.signal }).then(r => r.json()).then(result => setSignals(result.items ?? [])).catch(() => {}); return () => controller.abort(); }, [project.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPalette(v => !v); setQuery(''); setSelected(0); } if (event.key === 'Escape') setPalette(false); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  const changeLayout = (next: MosaicNode<Panel> | null) => { setLayout(next); if (next) { try { localStorage.setItem(key, JSON.stringify(next)); } catch { setError(zh ? '布局已更新，但浏览器无法保存。' : 'Layout updated, but browser storage is unavailable.'); } } };
  const request = async (kind: 'analysis' | 'signals', ai = false) => {
    setBusy(true); setError('');
    try {
      // Deterministic evidence report is a GET (anonymous read-only); AI hypotheses require the
      // authenticated POST route. Asking for the deterministic report must not fail for viewers.
      const url = `/api/projects/${project.id}/${kind === 'analysis' ? 'research/analysis' : 'signals/refresh'}`;
      const init: RequestInit = kind === 'signals'
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
        : ai ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) } : { method: 'GET' };
      const response = await fetch(url, init);
      const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? 'Request failed');
      if (kind === 'analysis') setReport(result); else setSignals(result.items);
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  };
  const actions = [
    { label: zh ? '恢复默认布局' : 'Restore default layout', run: () => changeLayout(INITIAL) },
    ...PANELS.map(id => ({ label: titles[id], run: () => changeLayout(id) })),
    { label: zh ? '分析公开市场证据（只读）' : 'Analyze public market evidence (read-only)', run: () => { void request('analysis'); } },
  ].filter(a => a.label.toLowerCase().includes(query.toLowerCase()));
  const body = (id: Panel) => {
    if (id === 'chart') return chart;
    if (id === 'sources') return <div className="research-sources">{data?.snapshots.map((s, i) => <article key={`${s.exchange}:${s.symbol}`}><strong>S{i + 1} · {s.exchange} · {s.symbol}</strong><span>{(now - s.eventTime > 60_000 ? 'stale' : s.eventTime > now + 5000 ? 'clock-skew' : s.quality).toUpperCase()} · {new Date(s.eventTime).toLocaleString()} · {Math.max(0, Math.floor((now - s.eventTime) / 1000))}s</span><small>{s.source}</small><small>{zh ? '不可用' : 'Unavailable'}: {s.unavailable.join(', ') || '—'}</small></article>)}{data?.failures.map(s => <p key={`${s.exchange}:${s.symbol}`}>{s.exchange}: {s.message}</p>)}{!data && <p>{zh ? '等待真实数据，无模拟值。' : 'Awaiting real data. No mock values.'}</p>}</div>;
    if (id === 'timeline') return <><button disabled={busy} onClick={() => void request('signals')}>{zh ? '刷新内部信号' : 'Refresh internal signals'}</button><p className="research-muted">{zh ? '外部发布关闭。只记录公开指标推断。' : 'External publishing OFF. Public-metric inferences only.'}</p>{signals.length ? [...signals].reverse().map(s => <article key={s.id}><strong>{s.category} · {s.venue}</strong><p>{new Date(s.timestamp).toLocaleString()} · {s.confidence} · {s.freshness}</p><small>{s.classification} · {s.id.slice(0, 12)}</small></article>) : <p>{zh ? '暂无符合条件的新鲜信号；不生成占位数据。' : 'No qualifying fresh signals. No placeholder events.'}</p>}</>;
    return <><div className="research-notice">{zh ? '只读分析 · 默认使用确定性证据模式。只有服务器显式启用 AI 后才会生成未验证假设。无交易和发布权限。' : 'Read-only analysis · deterministic evidence by default. AI hypotheses require explicit server configuration. No trading or publishing authority.'}</div>
      <label>{zh ? '研究问题' : 'Research question'}<textarea className="research-question" value={question} maxLength={1000} onChange={e => setQuestion(e.target.value)}/></label>
      <button disabled={busy} onClick={() => void request('analysis')}>{busy ? (zh ? '读取中…' : 'Reading…') : (zh ? '生成确定性证据报告（只读）' : 'Generate deterministic evidence report (read-only)')}</button>
      <button disabled={busy || !question.trim()} onClick={() => void request('analysis', true)}>{zh ? '请求 AI 假设（需登录）' : 'Request AI hypotheses (sign-in)'}</button>
      {report && <><p className="research-muted">{report.mode} · {new Date(report.generatedAt).toLocaleString()} · {report.tools.join(' / ')}</p>{(['observed', 'inferences', 'hypotheses', 'limitations'] as const).map((section, i) => <section key={section}><h3>{(zh ? ['已观测事实', '统计推断（未校准）', '待验证假设', '缺失或延迟数据'] : ['Observed facts', 'Statistical inferences (uncalibrated)', 'Hypotheses', 'Missing or stale data'])[i]}</h3>{report[section].length ? report[section].map((claim, n) => <p key={n}>{claim.text} <small>{claim.sources.join(' · ')}</small></p>) : <p>—</p>}</section>)}{report.metricDependencies?.length ? <section><h3>{zh ? '指标依赖（非独立确认）' : 'Metric dependencies (not independent confirmations)'}</h3>{report.metricDependencies.map((dependency) => <p key={dependency.metric}><strong>{dependency.metric}</strong> · {dependency.role} · {zh ? '依赖' : 'depends on'} {dependency.dependsOn.join(', ') || '—'}{dependency.duplicateOf.length ? ` · ${zh ? '同一数据族' : 'same family as'} ${dependency.duplicateOf.join(', ')}` : ''} <small>{dependency.caveat}</small></p>)}</section> : null}{report.nonIdentifiable?.length ? <section><h3>{zh ? '公共数据无法识别的现象' : 'Phenomena public data cannot identify'}</h3>{report.nonIdentifiable.map((item) => <p key={item}>{item}</p>)}</section> : null}</>}</>;
  };
  return <section className="research-workspace"><header className="research-toolbar"><div><h1>{zh ? '研究工作区' : 'Research workspace'}</h1><p>{project.name} · {zh ? '拖动标题停靠 / 拖动分隔线调整 / 自动保存' : 'Drag headers to dock / resize dividers / autosaved'}</p></div><button onClick={() => setPalette(true)}>⌘ / Ctrl K</button><button onClick={() => changeLayout(INITIAL)}>{zh ? '重置布局' : 'Reset layout'}</button></header>{error && <p role="alert">{error}</p>}<div className="research-mosaic"><Mosaic<Panel> value={layout} onChange={changeLayout} renderTile={(id, path) => <MosaicWindow<Panel> path={path} title={titles[id]} toolbarControls={[]}><div className="research-panel-body">{body(id)}</div></MosaicWindow>}/></div>{palette && <div className="research-palette-backdrop" onClick={() => setPalette(false)}><div role="dialog" aria-modal="true" aria-label={zh ? '工作区命令' : 'Workspace commands'} className="research-palette" onClick={e => e.stopPropagation()}><input autoFocus aria-label="Search workspace commands" value={query} onChange={e => { setQuery(e.target.value); setSelected(0); }} placeholder={zh ? '搜索命令…' : 'Search commands…'} onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(n => Math.min(n + 1, actions.length - 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(n => Math.max(0, n - 1)); } if (e.key === 'Enter' && actions[selected]) { actions[selected].run(); setPalette(false); } }}/>{actions.map((action, i) => <button className={i === selected ? 'selected' : ''} key={action.label} onClick={() => { action.run(); setPalette(false); }}>{action.label}</button>)}<button onClick={() => setPalette(false)}>Esc · {zh ? '关闭' : 'Close'}</button></div></div>}</section>;
}
