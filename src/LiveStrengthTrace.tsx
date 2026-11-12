import { useLayoutEffect, useMemo, useRef } from 'react';
import { movingStrengthTail } from '../shared/strength-geometry';

type Quote = { t: number; x: number; y: number; value?: number; compactedBefore?: true };
type TraceProps = {
  path: string;
  last: Quote;
  previous?: Quote;
  tipX: number;
  color: string;
  strong: boolean;
  stale?: boolean;
  label: string;
  title: string;
  labelX: number;
  labelY: number;
  labelWidth: number;
  gap: number;
  fontSize: number;
};

const duration = 300;
const mix = (a: number, b: number, amount: number) => a + (b - a) * amount;

export function LiveStrengthTrace({ path, last, previous, tipX, color, strong, stale, label, title,
  labelX, labelY, labelWidth, gap, fontSize }: TraceProps) {
  const curve = useRef<SVGPathElement>(null);
  const tail = useRef<SVGPathElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  const leader = useRef<SVGLineElement>(null);
  const badge = useRef<SVGGElement>(null);
  const displayed = useRef<{ time: number; value?: number; tip: number; label: number; moving: boolean }>();
  const lastY = last.y, time = last.t, value = last.value;
  const beforeTime = previous?.t, beforeY = previous?.y;
  const geometry = useMemo(() => movingStrengthTail(path, previous, last, tipX), [path, previous, last, tipX]);

  useLayoutEffect(() => {
    const body = curve.current!, end = tail.current!, marker = dot.current!, line = leader.current!, group = badge.current!;
    const prior = displayed.current;
    const newQuote = prior && (time > prior.time || (time === prior.time && value !== prior.value));
    const fromTip = geometry && prior && (newQuote || prior.moving) && time >= prior.time
      ? (beforeTime === prior.time && !prior.moving ? beforeY! : prior.tip) : lastY;
    const fromLabel = prior && time >= prior.time ? prior.label : labelY;
    const moveQuote = !!geometry && Math.abs(fromTip - lastY) > .01;
    const state = { time, value, tip: lastY, label: labelY, moving: false };
    displayed.current = state;

    function draw(progress: number) {
      state.moving = moveQuote && progress < 1;
      state.tip = mix(fromTip, lastY, progress);
      state.label = mix(fromLabel, labelY, progress);
      if (state.moving && geometry) {
        end.setAttribute('d', geometry.frame(fromTip, progress, state.tip));
      }
      marker.setAttribute('cy', String(state.tip));
      line.setAttribute('y1', String(state.tip));
      line.setAttribute('y2', String(state.label));
      group.setAttribute('transform', 'translate(0 ' + state.label + ')');
    }

    // React sets final coordinates on render. Restore them explicitly if a
    // previous animation had temporarily replaced them before this update.
    const finish = () => {
      draw(1);
      if (end.hasAttribute('d')) {
        body.setAttribute('d', path);
        end.removeAttribute('d');
      }
    };
    if (!prior || (!moveQuote && Math.abs(fromLabel - labelY) <= .01) || document.hidden) {
      finish();
      return;
    }
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (preference.matches) { finish(); return; }
    if (moveQuote) body.setAttribute('d', geometry!.prefix);
    // A label-only transition may follow an interrupted curve transition.
    else if (end.hasAttribute('d')) { body.setAttribute('d', path); end.removeAttribute('d'); }
    draw(0);
    const began = performance.now();
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', visibility);
      preference.removeEventListener('change', motion);
    };
    const settle = () => { stop(); finish(); };
    const visibility = () => { if (document.hidden) settle(); };
    const motion = () => { if (preference.matches) settle(); };
    const animate = (now: number) => {
      const fraction = Math.min(1, Math.max(0, (now - began) / duration));
      if (fraction === 1) { settle(); return; }
      draw(1 - (1 - fraction) ** 3);
      frame = requestAnimationFrame(animate);
    };
    document.addEventListener('visibilitychange', visibility);
    preference.addEventListener('change', motion);
    frame = requestAnimationFrame(animate);
    return stop;
  }, [path, geometry, time, value, lastY, tipX, beforeTime, beforeY, labelY]);

  const badgeWidth = Math.min(labelWidth, Math.ceil(label.length * fontSize * .64 + 11));
  return <g className={'strength-live-trace' + (strong ? ' strength-strong' : '')} color={color}>
    <title>{title}</title>
    <g className="strength-trace-glow" fill="none" stroke="currentColor"
      strokeWidth={strong ? 3 : 1.7} strokeLinecap="round" strokeLinejoin="round">
      <path ref={curve} className="strength-curve" d={path}/>
      <path ref={tail} aria-hidden="true"/>
      <circle ref={dot} cx={tipX} cy={lastY} r={strong ? 4 : 2.8} stroke="none" fill="currentColor"/>
    </g>
    <g opacity={stale ? .55 : 1}>
      <line ref={leader} className="strength-leader" x1={tipX + 3} y1={lastY} x2={labelX - 3} y2={labelY} stroke="currentColor" opacity={.46}/>
      <g ref={badge} className="strength-live-label" transform={'translate(0 ' + labelY + ')'}>
        <rect x={labelX} y={1 - gap / 2} width={badgeWidth} height={gap - 2} rx={2} fill="currentColor" opacity={strong ? .92 : .065}/>
        <text className="strength-value" x={labelX + 5} y={0} dominantBaseline="central"
          style={{ fontSize, fill: strong ? 'var(--surface)' : 'currentColor' }}>{label}</text>
      </g>
    </g>
  </g>;
}
