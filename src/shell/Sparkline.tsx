/** 24h sparkline for watchlist rows. Kept dependency-free: one SVG polyline. */
export function Sparkline({ values, width = 84, height = 24 }: { values: number[] | null | undefined; width?: number; height?: number }) {
  if (!values || values.length < 2) return <svg className="wl-spark-empty" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((value, index) => `${(index * step).toFixed(2)},${(height - 2 - ((value - min) / span) * (height - 4)).toFixed(2)}`).join(' ');
  const rising = values[values.length - 1] >= values[0];
  const stroke = rising ? 'var(--up)' : 'var(--down)';
  const id = `spark-${rising ? 'up' : 'down'}`;
  return (
    <svg className="wl-spark" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`24h ${rising ? 'up' : 'down'} trend`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${points} ${width},${height}`} fill={`url(#${id})`} />
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
