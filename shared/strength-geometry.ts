export function strengthDomain(min: number, max: number, targetIntervals: number) {
  const low = Math.min(0, min);
  const high = Math.max(0, max);
  const span = high - low;
  const paddedMin = span ? low - span * 0.045 : -0.01;
  const paddedMax = span ? high + span * 0.045 : 0.01;
  const intervals = Math.min(12, Math.max(2, Math.round(targetIntervals)));
  const rawStep = (paddedMax - paddedMin) / intervals;
  const unit = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].reduce((best, multiple) =>
    Math.abs(multiple * unit - rawStep) < Math.abs(best * unit - rawStep) ? multiple : best
  ) * unit;
  const first = Math.floor(paddedMin / step);
  const last = Math.ceil(paddedMax / step);
  const ticks = Array.from({ length: last - first + 1 }, (_, i) => Number(((first + i) * step).toPrecision(14)));
  return { min: ticks[0], max: ticks[ticks.length - 1], ticks };
}

/** Place sorted endpoint labels with the smallest total squared displacement from the traces. */
export function spreadLabels(targets: readonly number[], top: number, bottom: number, gap: number): number[] {
  if (!targets.length) return [];
  const spacing = targets.length === 1 ? 0 : Math.min(gap, (bottom - top) / (targets.length - 1));
  const ceiling = bottom - (targets.length - 1) * spacing;
  // Subtract the mandatory spacing, then pool adjacent groups whose mean positions cross.
  const groups: Array<{ sum: number; count: number }> = [];
  targets.forEach((target, i) => {
    const group = { sum: target - i * spacing, count: 1 };
    let previous = groups.at(-1);
    while (previous && previous.sum / previous.count > group.sum / group.count) {
      group.sum += previous.sum;
      group.count += previous.count;
      groups.pop();
      previous = groups.at(-1);
    }
    groups.push(group);
  });

  const positions: number[] = [];
  for (const group of groups) {
    const center = Math.max(top, Math.min(ceiling, group.sum / group.count));
    for (let i = 0; i < group.count; i++) positions.push(center + positions.length * spacing);
  }
  return positions;
}

/** Only report a gap when observations on both sides establish its duration. */
export function observedStrengthGap(points: readonly { t: number }[], time: number, tolerance: number) {
  const next = points.findIndex(point => point.t >= time);
  if (next <= 0 || points[next].t === time) return null;
  const from = points[next - 1].t;
  return time - from > tolerance ? { from, to: points[next].t } : null;
}

type ProjectedPoint = { x: number; y: number; t: number };
const coord = (x: number, y: number) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
const slope = (a: ProjectedPoint, b: ProjectedPoint) => (b.y - a.y) / (b.x - a.x);

// This tangent gives both adjacent segments a common slope, bounded by the shallower secant.
function tangent(left: number, right: number) {
  if (Math.sign(left) !== Math.sign(right)) return 0;
  return Math.sign(left) * Math.min(Math.abs(left), Math.abs(right));
}

export function strengthPath(points: readonly ProjectedPoint[], gapMs: number): string {
  const commands: string[] = [];
  let start = 0;
  while (start < points.length) {
    let end = start;
    while (end + 1 < points.length && points[end + 1].t - points[end].t <= gapMs && points[end + 1].x > points[end].x) end++;
    const first = points[start];
    commands.push('M' + coord(first.x, first.y));
    if (end === start) commands.push('h0');
    let leftSlope = start < end ? slope(first, points[start + 1]) : 0;
    for (let i = start; i < end; i++) {
      const a = points[i], b = points[i + 1];
      const secant = slope(a, b);
      const rightSlope = i + 1 === end ? secant : tangent(secant, slope(b, points[i + 2]));
      if (leftSlope === secant && rightSlope === secant) {
        commands.push('L' + coord(b.x, b.y));
      } else {
        const dx = (b.x - a.x) / 3;
        commands.push(`C${coord(a.x + dx, a.y + dx * leftSlope)} ${coord(b.x - dx, b.y - dx * rightSlope)} ${coord(b.x, b.y)}`);
      }
      leftSlope = rightSlope;
    }
    start = end + 1;
  }
  return commands.join('');
}
