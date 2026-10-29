import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, ArrowRight, Clock3, ShieldCheck } from 'lucide-react';
import type { CandlePoint, ExchangeSelection, MarketProject, MarketSeries, PositionFlowSignal, ProjectVenueResponse } from '../shared/types';
import { coveredSegments, pointAtOrBefore, timelineX } from '../shared/terminal-view';
import './research-terminal.css';

const number = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '—' : new Intl.NumberFormat('en', { maximumSignificantDigits: 9 }).format(n);
const stamp = (n: number) => new Date(n).toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
type Point = { time: number; value: number | null };

export function ResearchTerminal({ project, series, venues, language, interval, kpis, exchange, onExchange, onDetail }: {
  project: MarketProject; series: MarketSeries | null; venues: ProjectVenueResponse | null;
  language: 'zh' | 'en'; interval: string; kpis: ReactNode; exchange: ExchangeSelection; onExchange: (venue: ExchangeSelection) => void; onDetail: () => void;
}) {
  const zh = language === 'zh';
  const text = (cn: string, en: string) => zh ? cn : en;
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const workbench = useRef<HTMLDivElement>(null);
  const [panels, setPanels] = useState({ oi: true, oiDelta: true, delta: true, cvd: true });
  const signals = series?.positionFlow.signals ?? [];
  const signal = signals.find(s => s.id === selected) ?? signals[0] ?? null;
  const candles = series?.candles ?? [];
  const start = candles[0]?.time ?? 0, end = candles.at(-1)?.time ?? 1;
  const step = candles.length > 1 ? candles[1].time - start : 300_000;
  const domain = { start, end, step };
  const oiStep = series?.positionFlow.oiInterval === '5m' ? 300_000 : step;
  const oi = series?.oiBase ?? [];
  const oiDelta = series?.positionFlow.oiDelta.map(p => ({ time: p.time, value: p.deltaBase })) ?? [];
  const delta = series?.positionFlow.volumeFlow.map(p => ({ time: p.time, value: p.complete ? p.deltaNotional : null })) ?? [];
  const cvd = series?.cvd.map(p => ({ time: p.time, value: p.complete ? p.value : null })) ?? [];
  const choose = (s: PositionFlowSignal) => { setSelected(s.id); setCursor(s.time); workbench.current?.scrollIntoView({ block: 'start', behavior: 'auto' }); };
  const valid = signals.filter(s => s.status === 'hypothesis').length;
  const hasNativeMarket = project.markets.some(market => market.exchange === 'binance' && market.marketType === 'perpetual');
  return <div className="research-terminal">
    <div className="terminal-heading"><div><span><Activity size={14}/>{text('项目研究总览', 'Project research terminal')}</span><h1>{project.name}<small>{project.tokenSymbol}</small></h1></div><button onClick={onDetail}>{text('详细仓位资金流', 'Detailed position flow')}<ArrowRight size={14}/></button></div>
    {kpis}
    <div className="terminal-workbench" ref={workbench}>
      <section className="terminal-analysis panel" aria-label={text('同步分析图', 'Synchronized analytical charts')}>
        <header className="terminal-section-head"><div><strong>{text('同步市场结构', 'Synchronized market structure')}</strong><small>{series?.symbol ?? '—'} · Binance · {interval.toUpperCase()} · UTC</small></div><span>{cursor == null ? text('移动查看 / 点击事件定位', 'Hover to inspect / select an event') : stamp(cursor)}</span></header>
        <div className="terminal-indicators">{(Object.keys(panels) as Array<keyof typeof panels>).map(key => <button key={key} aria-pressed={panels[key]} onClick={() => setPanels(old => ({ ...old, [key]: !old[key] }))}>{({ oi: 'OI', oiDelta: 'OI Δ', delta: 'Volume Δ', cvd: 'CVD' })[key]}</button>)}</div>
        <div className="terminal-chart-body">
          {!hasNativeMarket ? <div className="terminal-empty">{text('此项目未选择 Binance 永续市场，原生同步图不可用。下方仍展示已选场所数据。', 'No Binance perpetual is selected for this project. Native synchronized charts are unavailable; selected-venue snapshots remain below.')}</div> : <>
          <TerminalPrice candles={candles} domain={domain} cursor={cursor} onCursor={setCursor} label={text('价格 / 成交量', 'Price / volume')}/>
          {panels.oi && <TerminalPlot title={`${text('持仓量 · 基础币', 'Open interest · base')} · ${series?.positionFlow.oiInterval.toUpperCase() ?? '—'}`} points={oi} domain={domain} cursor={cursor} onCursor={setCursor} maxGap={oiStep * 1.5}/>}
          {panels.oiDelta && <TerminalPlot title={`${text('OI 变化 · 基础币', 'OI delta · base')} · ${series?.positionFlow.oiInterval.toUpperCase() ?? '—'}`} points={oiDelta} histogram domain={domain} cursor={cursor} onCursor={setCursor} maxGap={oiStep * 1.5}/>}
          {panels.delta && <TerminalPlot title={text('成交量差 · USDT · 仅完整桶', 'Volume delta · USDT · complete buckets')} points={delta} histogram domain={domain} cursor={cursor} onCursor={setCursor} maxGap={step * 1.5}/>}
          {panels.cvd && <TerminalPlot title={text('合约 CVD · USDT · 窗口内累计', 'Perp CVD · USDT · window cumulative')} points={cvd} domain={domain} cursor={cursor} onCursor={setCursor} maxGap={step * 1.5}/>}
          </>}
        </div>
        <div className="terminal-axis"><span>{start ? stamp(start) : '—'}</span><span>{end > 1 ? stamp(end) : '—'}</span></div>
        <p className="terminal-source-note">{text('原生图表仅使用已选 Binance 永续主源，不是跨所聚合。OI 保留原始采样时间；CVD 仅覆盖返回成交带，缺口不补零。', 'Native charts use the selected Binance perpetual feed, not a cross-venue aggregate. OI retains native timestamps. CVD covers the returned tape only; gaps are not zero-filled.')}</p>
      </section>
      <aside className="terminal-context">
        <section className="panel terminal-quality"><header className="terminal-section-head"><strong><ShieldCheck size={15}/>{text('数据与证据', 'Data & evidence')}</strong></header><dl>
          <div><dt>{text('永续场所覆盖', 'Perpetual venue coverage')}</dt><dd>{venues ? `${venues.aggregate.coverage.successful}/${venues.aggregate.coverage.requested}` : '—'}</dd></div>
          <div><dt>{text('新鲜场所', 'Fresh venues')}</dt><dd>{venues?.aggregate.coverage.fresh ?? '—'}</dd></div>
          <div><dt>{text('成交带样本', 'Trade tape samples')}</dt><dd>{series?.coverage.tradeCount ?? '—'}</dd></div>
          <div><dt>{text('假设 / 证据不足', 'Hypotheses / withheld')}</dt><dd>{valid} / {signals.length - valid}</dd></div>
        </dl><small>{series ? `${text('图表更新', 'Chart update')}: ${stamp(series.eventTime)}` : text('等待主数据源', 'Awaiting primary source')}</small></section>
        <section className="panel terminal-evidence"><header className="terminal-section-head"><strong>{text('结构证据', 'Structure evidence')}</strong><span>{signal ? signal.status === 'withheld' ? text('证据不足', 'Withheld') : text('待验证假设', 'Hypothesis') : '—'}</span></header>
          {signal ? <div className="terminal-evidence-body"><h2>{signal.label}</h2><small>{stamp(signal.time)} · {text('规则分数', 'Rule score')} {signal.confidence} · {text('非概率', 'not probability')}</small>
            <EvidenceBlock title={text('直接观测', 'Observed facts')} items={signal.observed}/>
            <EvidenceBlock title={text('支持证据', 'Supporting evidence')} items={signal.evidence}/>
            {signal.missing.length > 0 && <EvidenceBlock title={text('缺失数据 / 限制', 'Missing data / limits')} items={signal.missing}/>}
            <details><summary>{text('反证与替代解释', 'Counterevidence & alternatives')}</summary><EvidenceBlock title={text('反证', 'Counterevidence')} items={signal.counterevidence}/><EvidenceBlock title={text('其他解释', 'Alternatives')} items={signal.alternatives}/></details>
            <p className="terminal-inference">{text('这是市场结构推断，不代表直接观察到开仓、平仓或清算。', 'This is a market-structure inference, not directly observed opening, closing or liquidation.')}</p>
          </div> : <div className="terminal-empty">{text('当前覆盖下没有满足规则的结构。数据不足不会生成方向判断。', 'No structure meets the rules under current coverage. Missing data does not generate a directional claim.')}</div>}
        </section>
      </aside>
    </div>
    <section className="terminal-venues panel"><header className="terminal-section-head"><div><strong>{text('跨交易所研究矩阵', 'Cross-venue research matrix')}</strong><small>{text('仅已选永续市场 · Delta 保留各源窗口，未作同窗口聚合', 'Selected perpetual markets only · deltas retain source windows, not time-aligned aggregation')}</small></div><button aria-pressed={exchange === 'aggregated'} onClick={() => onExchange('aggregated')}>{text('聚合概览', 'Aggregated overview')}</button></header><div className="table-wrap"><table><thead><tr>{(zh ? ['场所 / 交易对', '价格 USDT', 'OI USDT', 'OI Δ 基础币', '成交 Δ USDT', '资金费率', '价差 bps', 'L2 深度 USDT', '数据状态'] : ['Venue / pair', 'Price USDT', 'OI USDT', 'OI Δ base', 'Volume Δ USDT', 'Funding', 'Spread bps', 'L2 depth USDT', 'Data state']).map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{venues?.snapshots.filter(row => row.marketType === 'perpetual').map(row => {
      const depth = venues.contribution.rows.find(item => item.exchange === row.exchange && item.symbol === row.symbol)?.totalDepthUsd;
      return <tr key={`${row.exchange}:${row.symbol}`} className={exchange === row.exchange ? 'selected' : ''}><td><button aria-pressed={exchange === row.exchange} onClick={() => onExchange(row.exchange)}>{row.exchange.toUpperCase()}</button><small>{row.symbol}</small></td>{[row.price, row.oiUsd, row.oiDeltaBase, row.volumeDeltaUsd, row.fundingRate == null ? null : row.fundingRate * 100, row.spreadBps, depth].map((value, i) => <td key={i} title={value == null ? text('不可用', 'Unavailable') : String(value)}>{value == null ? '—' : i === 4 ? `${number(value)}%` : i === 0 ? number(value) : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 3 }).format(value)}</td>)}<td>{row.quality}<small>{stamp(row.eventTime)}</small></td></tr>;
    })}{!venues?.snapshots.length && <tr><td colSpan={9}>{text('等待所选项目的真实市场数据', 'Awaiting real data for the selected project')}</td></tr>}</tbody></table></div><p className="terminal-source-note">{text('— 表示不可用，不是 0。OI Δ 与成交 Δ 不同；L2 深度不能用最优买卖价快照代替。', '— means unavailable, not zero. OI delta differs from volume delta; best-bid/ask snapshots are not L2 depth.')}{venues?.failures.length ? ` ${text('不可用场所', 'Unavailable venues')}: ${venues.failures.map(f => `${f.exchange.toUpperCase()} ${f.symbol}`).join(' · ')}` : ''}</p></section>
    <div className="terminal-bottom">
      <section className="panel terminal-events"><header className="terminal-section-head"><strong><Clock3 size={15}/>{text('信号事件回放', 'Signal event replay')}</strong><span>{text('最近 20 条 · 非完整历史', 'Latest 20 · not full history')}</span></header><div className="terminal-event-list">{signals.slice(0, 20).map(s => <button key={s.id} className={signal?.id === s.id ? 'selected' : ''} onClick={() => choose(s)}><time>{stamp(s.time)}</time><strong>{s.label}</strong><span>{s.status === 'withheld' ? text('证据不足', 'Withheld') : text('假设', 'Hypothesis')}</span></button>)}{!signals.length && <p className="terminal-empty">{text('尚无事件。等待真实数据与完整覆盖。', 'No events yet. Awaiting real data and sufficient coverage.')}</p>}</div></section>
      <section className="panel terminal-validation"><header className="terminal-section-head"><strong>{text('验证边界', 'Validation boundaries')}</strong></header><p>{text('规则分数不等于胜率。历史相关性不等于可交易优势；费用、资金费、延迟与样本覆盖需要单独验证。事件定位仅移动游标，不是严格的历史可知数据重建。', 'Rule scores are not win probabilities. Historical association is not a tradable edge; costs, funding, latency and coverage require separate validation. Event selection locates a cursor; it is not a point-in-time reconstruction.')}</p><button onClick={onDetail}>{text('打开账本场景与完整方法', 'Open ledger scenarios & methodology')}<ArrowRight size={14}/></button></section>
    </div>
  </div>;
}

function EvidenceBlock({ title, items }: { title: string; items: string[] }) { return <div className="terminal-evidence-block"><h3>{title}</h3><ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul></div>; }
type Domain = { start: number; end: number; step: number };

function ChartSurface({ domain, cursor, onCursor, children, height, label }: { domain: Domain; cursor: number | null; onCursor: (time: number) => void; children: ReactNode; height: number; label: string }) {
  const at = (ratio: number) => domain.start + Math.max(0, Math.min(1, (ratio * 1000 - 45) / 935)) * (domain.end - domain.start);
  return <div className="terminal-chart" style={{ height }} role="img" aria-label={label} onMouseMove={e => { const rect = e.currentTarget.getBoundingClientRect(); onCursor(at((e.clientX - rect.left) / rect.width)); }} onTouchMove={e => { const touch = e.touches[0]; const rect = e.currentTarget.getBoundingClientRect(); onCursor(at((touch.clientX - rect.left) / rect.width)); }}><svg viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none"><g className="terminal-grid">{[.25, .5, .75].map(n => <line key={n} x1="45" x2="980" y1={height * n} y2={height * n}/>)}</g>{children}{cursor != null && cursor >= domain.start && cursor <= domain.end && <line className="terminal-crosshair" x1={timelineX(cursor, domain.start, domain.end)} x2={timelineX(cursor, domain.start, domain.end)} y1="0" y2={height}/>}</svg></div>;
}

function TerminalPrice({ candles, domain, cursor, onCursor, label }: { candles: CandlePoint[]; domain: Domain; cursor: number | null; onCursor: (time: number) => void; label: string }) {
  if (!candles.length) return <div className="terminal-empty">{label} —</div>;
  const low = Math.min(...candles.map(p => p.low)), high = Math.max(...candles.map(p => p.high));
  const y = (value: number) => 12 + (high - value) / Math.max(high - low, 1e-12) * 145;
  const maxVolume = Math.max(1, ...candles.map(p => p.volumeUsd));
  const current = cursor == null ? candles.at(-1)! : pointAtOrBefore(candles, cursor);
  return <div className="terminal-price"><div className="terminal-chart-label"><strong>{label}</strong><span>{current ? `O ${number(current.open)} · H ${number(current.high)} · L ${number(current.low)} · C ${number(current.close)} · V ${number(current.volumeUsd)}` : '—'}</span></div><ChartSurface label={label} domain={domain} cursor={cursor} onCursor={onCursor} height={205}>{candles.map(p => { const x = timelineX(p.time, domain.start, domain.end), color = p.close >= p.open ? 'var(--green)' : 'var(--red)'; return <g key={p.time} stroke={color} fill={color}><line x1={x} x2={x} y1={y(p.high)} y2={y(p.low)}/><rect x={x - 2} y={Math.min(y(p.open), y(p.close))} width="4" height={Math.max(1, Math.abs(y(p.open) - y(p.close)))}/><rect opacity=".35" stroke="none" x={x - 2} y={200 - p.volumeUsd / maxVolume * 30} width="4" height={p.volumeUsd / maxVolume * 30}/></g>; })}</ChartSurface></div>;
}

function TerminalPlot({ title, points, domain, cursor, onCursor, histogram = false, maxGap }: { title: string; points: Point[]; domain: Domain; cursor: number | null; onCursor: (time: number) => void; histogram?: boolean; maxGap: number }) {
  const inside = points.filter(p => p.time >= domain.start && p.time <= domain.end);
  const values = inside.flatMap(p => p.value == null || !Number.isFinite(p.value) ? [] : [p.value]);
  const low = histogram ? Math.min(0, ...values) : Math.min(...values), high = histogram ? Math.max(0, ...values) : Math.max(...values);
  const scale = Math.max(high - low, 1e-12), y = (value: number) => high === low ? 40 : 8 + (high - value) / scale * 64;
  const current = pointAtOrBefore(inside, cursor ?? domain.end);
  const currentValid = current && ((cursor ?? domain.end) - current.time <= maxGap) ? current : null;
  return <div className="terminal-plot"><div className="terminal-chart-label"><strong>{title}</strong><span>{number(currentValid?.value)}{currentValid ? ` · ${stamp(currentValid.time)}` : ''}</span></div>{values.length ? <ChartSurface label={title} domain={domain} cursor={cursor} onCursor={onCursor} height={82}>{histogram ? inside.map(p => p.value == null ? null : <rect key={p.time} x={timelineX(p.time, domain.start, domain.end) - 2} y={Math.min(y(0), y(p.value))} width="4" height={Math.max(1, Math.abs(y(0) - y(p.value)))} fill={p.value >= 0 ? 'var(--green)' : 'var(--red)'}/>) : coveredSegments(inside, maxGap).map((segment, i) => <polyline key={i} points={segment.map(p => `${timelineX(p.time, domain.start, domain.end)},${y(p.value)}`).join(' ')} fill="none" stroke="var(--text-2)" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/>)}</ChartSurface> : <div className="terminal-plot-empty">—</div>}</div>;
}
