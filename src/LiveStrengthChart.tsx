import { memo, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { liveTimeTicks, observedStrengthGap, spreadLabels, strengthDomain, strengthPath } from '../shared/strength-geometry';
import { strengthValueAt, type StrengthReturnPoint } from '../shared/strength-history';
import { periodPriceValueAt } from '../shared/period-strength';
import { LiveStrengthTrace } from './LiveStrengthTrace';
import './live-strength.css';

type Language = 'zh' | 'en';
type Unit = '%' | 'pp' | 'USDT';
type StrengthLine = {
  id: string;
  name: string;
  color: string;
  points: readonly StrengthReturnPoint[];
  stale?: boolean;
};
type PlotProps = {
  lines: readonly StrengthLine[];
  start: number;
  end: number;
  live: boolean;
  updatingPeriod?: boolean;
  gapMs: number;
  unit: Unit;
  language: Language;
  emptyText: string;
  ariaLabel?: string;
  hoverTime?: number | null;
  onHoverTime?: (time: number | null) => void;
};

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const calendar = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit' });
const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });

function formatValue(value: number, unit: Unit, digits: number) {
  if (unit === 'USDT') return `${value > 0 ? '+' : ''}${compactNumber.format(value)} USDT`;
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}${unit === 'pp' ? ' pp' : '%'}`;
}

function cursorGapLabel(lines: readonly StrengthLine[], time: number, tolerance: number, language: Language) {
  const gaps = lines.flatMap(line => {
    const last = line.points.at(-1);
    if (last && time - last.t > tolerance) return [{ name: line.name, from: last.t, to: time, trailing: true }];
    const interval = observedStrengthGap(line.points, time);
    return interval ? [{ name: line.name, ...interval, trailing: false }] : [];
  });
  if (!gaps.length) return '';
  // Every interval contains the cursor. Their intersection is the observed shared gap.
  const from = Math.max(...gaps.map(gap => gap.from));
  const to = Math.min(...gaps.map(gap => gap.to));
  const seconds = Number(((to - from) / 1000).toFixed(1));
  if (gaps.length === 1 && gaps[0].trailing) return language === 'zh'
    ? `${gaps[0].name} 沿用 ${clock.format(from)} 报价` : `${gaps[0].name} · Holding ${clock.format(from)} quote`;
  if (gaps.length === 1) return language === 'zh'
    ? `${gaps[0].name} 报价间隔 ${seconds} 秒` : `${gaps[0].name} · ${seconds}s between quotes`;
  return language === 'zh'
    ? `${gaps.length} 个项目同时缺报 ${seconds} 秒` : `${gaps.length} projects · ${seconds}s quote gap`;
}

type LiveSeriesProps = Omit<ComponentProps<typeof LiveStrengthTrace>, 'path' | 'last' | 'previous'> & {
  points: readonly StrengthReturnPoint[];
  x: (time: number) => number;
  y: (value: number) => number;
  gapMs: number;
};

const LiveSeries = memo(function LiveSeries({ points, x, y, gapMs, ...trace }: LiveSeriesProps) {
  const projected = useMemo(() => points.map(point => ({ ...point, x: x(point.t), y: y(point.value) })), [points, x, y]);
  const path = useMemo(() => strengthPath(projected, gapMs, trace.tipX), [projected, gapMs, trace.tipX]);
  const last = projected.at(-1);
  return last && <LiveStrengthTrace {...trace} path={path} last={last} previous={projected.at(-2)} />;
});

export function StrengthPlot({ lines, start, end, live, updatingPeriod = false, gapMs, unit, language, ariaLabel, emptyText, hoverTime = null, onHoverTime }: PlotProps) {
  const streaming = live || updatingPeriod;
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const ranked = lines.flatMap(line => {
    const last = line.points.at(-1);
    return last ? [{ ...line, last }] : [];
  }).sort((a, b) => b.last.value - a.last.value || a.id.localeCompare(b.id));
  let low = 0, high = 0;
  for (const line of ranked) for (const { value } of line.points) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const { width, height } = size;
  const duration = end - start;
  const timeLabel = (time: number) => live ? clock.format(time) : clock.format(time).slice(0, 5);
  const axisTimeLabel = (time: number) => live && new Date(time).toDateString() !== new Date(start).toDateString()
    ? `${calendar.format(time)} ${clock.format(time)}` : timeLabel(time);
  const drawingWidth = live ? width : Math.min(width, height * 820 / 370);
  const inset = (width - drawingWidth) / 2;
  const compact = drawingWidth < 540;
  const fontSize = compact ? 10 : 12;
  const gap = fontSize + 7;
  const top = 22, bottom = Math.max(top + 1, height - 28);
  const domain = strengthDomain(low, high, Math.max(3, Math.min(7, Math.floor((bottom - top) / 55))));
  const digits = Math.max(2, Math.min(8, Math.ceil(-Math.log10(domain.ticks[1] - domain.ticks[0])) + 1));
  const axisText = domain.ticks.map(v => formatValue(v, unit, digits));
  const left = live ? (compact ? 8 : 15) : inset + Math.max(...axisText.map(text => text.length)) * 6.2 + 13;
  // Reserve a stable rail so changing precision and trading rank never move the live edge.
  const railWidth = compact ? 107 : 161;
  const labels = ranked.map(line => {
    const value = formatValue(line.last.value, unit, digits);
    const maxChars = live ? Math.max(2, Math.floor((railWidth - 12) / (fontSize * .64)) - value.length - 1) : compact ? 7 : 13;
    const name = line.name.length > maxChars ? line.name.slice(0, maxChars - 1) + '…' : line.name;
    return `${name} ${value}`;
  });
  const labelWidth = live ? railWidth : Math.max(compact ? 76 : 100, ...labels.map(label => label.length * fontSize * .64 + 11));
  const labelX = inset + drawingWidth - labelWidth - 4;
  const gutter = live && !compact ? 75 : 18;
  const right = Math.max(left + 1, labelX - gutter);
  const x = useMemo(() => (t: number) => duration > 0 ? left + (t - start) / duration * (right - left) : left,
    [duration, left, start, right]);
  const liveEdgeX = streaming ? x(end) : undefined;
  const { min, max } = domain;
  const y = useMemo(() => (v: number) => bottom - (v - min) / (max - min) * (bottom - top), [bottom, top, min, max]);
  // During a feed pause the held lines keep their last visual emphasis. The labels show freshness.
  const candidates = streaming ? ranked : ranked.filter(line => !line.stale);
  const perSide = live ? 1 : candidates.length >= 8 ? 3 : candidates.length >= 4 ? 2 : 1;
  const highlighted = new Set([
    ...candidates.filter(line => line.last.value > 0).slice(0, perSide),
    ...candidates.filter(line => line.last.value < 0).slice(-perSide),
  ].map(line => line.id));
  const labelYs = spreadLabels(ranked.map(line => y(line.last.value)), top, bottom, gap);
  const traces = ranked.map((line, index) => ({
    line, label: labels[index], labelY: labelYs[index], strong: highlighted.has(line.id),
    tipX: liveEdgeX ?? x(line.last.t),
    path: streaming ? '' : strengthPath(line.points.map(point => ({ ...point, x: x(point.t), y: y(point.value) })), gapMs),
  }));
  const divisions = Math.max(1, Math.min(4, Math.floor((right - left) / 65)));
  const ticks = live ? liveTimeTicks(start, end, right - left)
    : Array.from({ length: divisions + 1 }, (_, i) => start + duration * i / divisions);
  const cursor = hoverTime !== null && hoverTime >= start && hoverTime <= end ? hoverTime : null;

  const gapNote = live && cursor !== null ? cursorGapLabel(ranked, cursor, gapMs, language) : '';

  return <div className={live ? 'strength-live-inline strength-session' : 'strength-live-inline'}>
    <div ref={viewport} className="strength-live-plot">
      {width > 0 && height > 0 && (live ? ranked.length > 0 && duration >= 0 : duration > 0) && <svg className="strength-svg" viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={ariaLabel ?? (language === 'zh' ? '关注项目相对强弱曲线' : 'Watchlist relative strength')}
        onPointerMove={onHoverTime && (event => {
          const rect = event.currentTarget.getBoundingClientRect();
          const px = (event.clientX - rect.left) * width / rect.width;
          if (px < left || px > right) { onHoverTime(null); return; }
          const time = start + (px - left) / (right - left) * duration;
          onHoverTime(streaming ? Math.round(time) : start + Math.round((time - start) / gapMs) * gapMs);
        })}
        onPointerLeave={onHoverTime && (() => onHoverTime(null))}>
        {domain.ticks.map((value, i) => <g key={value} className={value === 0 ? 'strength-grid strength-zero' : 'strength-grid'}>
          <line x1={left} x2={right} y1={y(value)} y2={y(value)}/>
          <text x={live ? compact ? left + 3 : right + 7 : left - 7} y={y(value) + (live && compact ? -4 : 3)}
            textAnchor={live ? 'start' : 'end'}>{axisText[i]}</text>
        </g>)}
        {ticks.map(t => <g key={t} className="strength-time">
          <line x1={x(t)} x2={x(t)} y1={top} y2={bottom + 4}/>
          <text x={live ? x(t) : Math.max(left + 18, Math.min(right - 18, x(t)))} y={height - 7}
            textAnchor={live && t === start ? 'start' : live && t === end ? 'end' : 'middle'}>{axisTimeLabel(t)}</text>
        </g>)}
        {[...traces].sort((a, b) => Number(a.strong) - Number(b.strong)).map(({ line, path, tipX, strong, label, labelY }) => streaming
          ? <LiveSeries key={line.id} points={line.points} x={x} y={y} gapMs={gapMs} tipX={tipX} color={line.color}
              strong={strong} stale={line.stale} label={label} title={`${line.name} ${formatValue(line.last.value, unit, digits)} · ${timeLabel(line.last.t)}${line.stale ? (language === 'zh' ? ' · 已延迟' : ' · Delayed') : ''}`}
              labelX={labelX} labelY={labelY} labelWidth={labelWidth} gap={gap} fontSize={fontSize} period={updatingPeriod} />
          : <g key={line.id} className="strength-trace-glow" color={line.color}>
            <path className="strength-curve" d={path} fill="none" stroke="currentColor"
              strokeWidth={strong ? 2.7 : 1.8} strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx={tipX} cy={y(line.last.value)} r={strong ? 4 : 2.8} fill="currentColor"/>
          </g>)}
        {!streaming && traces.map(({ line, label, labelY, tipX }) => <g key={line.id} color={line.color} opacity={line.stale ? .55 : 1}>
          <title>{line.name} {formatValue(line.last.value, unit, digits)} · {timeLabel(line.last.t)}{line.stale ? (language === 'zh' ? ' · 已延迟' : ' · Delayed') : ''}</title>
          <line x1={tipX + 3} y1={y(line.last.value)} x2={labelX - 3} y2={labelY} stroke="currentColor" opacity={.46}/>
          <rect x={labelX} y={labelY - gap / 2 + 1} width={labelWidth} height={gap - 2} rx={2} fill="currentColor" opacity={.12}/>
          <text className="strength-value" x={labelX + 5} y={labelY} dominantBaseline="central"
            style={{ fontSize, fill: 'currentColor' }}>{label}</text>
        </g>)}
        {cursor !== null && <g className="strength-cursor">
          <line className="wo-cursor" x1={x(cursor)} x2={x(cursor)} y1={top} y2={bottom}/>
          <text x={left} y={top - 7}>{timeLabel(cursor)}{gapNote && ` · ${gapNote}`}</text>
          {ranked.map(line => {
            const value = updatingPeriod ? periodPriceValueAt(line.points, cursor) : strengthValueAt(line.points, cursor, live ? gapMs : 0);
            return value == null ? null : <circle key={line.id} cx={x(cursor)} cy={y(value)} r="3" fill={line.color}/>;
          })}
        </g>}
      </svg>}
      {!ranked.length && <span className="strength-live-empty" role="status">{emptyText}</span>}
    </div>
  </div>;
}
