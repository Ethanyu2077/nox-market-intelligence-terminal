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

type QuoteTime = { t: number; compactedBefore?: true };

export function hasMissingQuoteSeconds(before: QuoteTime, after: QuoteTime) {
  return !after.compactedBefore && Math.floor(after.t / 1000) - Math.floor(before.t / 1000) > 1;
}

/** Only report a gap when observations on both sides establish its duration. */
export function observedStrengthGap(points: readonly QuoteTime[], time: number) {
  const next = points.findIndex(point => point.t >= time);
  if (next <= 0 || points[next].t === time) return null;
  const before = points[next - 1], after = points[next];
  return hasMissingQuoteSeconds(before, after) ? { from: before.t, to: after.t } : null;
}

/** Show the exact session boundaries and leave enough space for intermediate clock labels. */
export function liveTimeTicks(start: number, end: number, width: number) {
  if (end <= start) return [start];
  const intervals = Math.max(1, Math.floor(width / 85));
  const minStep = (end - start) / intervals;
  const seconds = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400];
  const step = (seconds.find(value => value * 1000 >= minStep) ?? Math.ceil(minStep / 86_400_000) * 86_400) * 1000;
  const ticks = [start];
  for (let t = start + step; t <= end - minStep; t += step) ticks.push(t);
  ticks.push(end);
  return ticks;
}

type ProjectedPoint = QuoteTime & { x: number; y: number };
const coord = (x: number, y: number) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
const slope = (a: ProjectedPoint, b: ProjectedPoint) => (b.y - a.y) / (b.x - a.x);

// This tangent gives both adjacent segments a common slope, bounded by the shallower secant.
function tangent(left: number, right: number) {
  if (Math.sign(left) !== Math.sign(right)) return 0;
  return Math.sign(left) * Math.min(Math.abs(left), Math.abs(right));
}

export function strengthPath(points: readonly ProjectedPoint[], gapMs: number, liveEdgeX?: number): string {
  const commands: string[] = [];
  let start = 0;
  while (start < points.length) {
    let end = start;
    while (end + 1 < points.length) {
      const a = points[end], b = points[end + 1];
      const gap = liveEdgeX === undefined ? b.t - a.t > gapMs : hasMissingQuoteSeconds(a, b);
      if (gap || b.x <= a.x) break;
      end++;
    }
    const first = points[start];
    if (start > 0 && liveEdgeX !== undefined) {
      // Keep the last known price until the next observed quote changes it.
      commands.push('L' + coord(first.x, points[start - 1].y));
    }
    commands.push((start === 0 ? 'M' : 'L') + coord(first.x, first.y));
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
  const last = points.at(-1);
  if (last && liveEdgeX !== undefined && liveEdgeX > last.x) commands.push('L' + coord(liveEdgeX, last.y));
  else if (points.length === 1) commands.push('h0');
  return commands.join('');
}

// strengthPath emits one L or C for the newest observation plus an optional
// flat extension. Walk back only those commands; retain all earlier tangents.
function segmentStart(path: string, end: number) {
  for (let i = end - 1; i >= 0; i--) if (path[i] === 'L' || path[i] === 'C') return i;
  return -1;
}

export function movingStrengthTail(path: string, previous: ProjectedPoint | undefined, last: ProjectedPoint, tipX: number) {
  if (!previous) return null;
  const held = tipX > last.x;
  const end = held ? segmentStart(path, path.length) : path.length;
  const begin = segmentStart(path, end);
  if (begin < 0) return null;
  const startX = hasMissingQuoteSeconds(previous, last) || last.x <= previous.x ? last.x : previous.x;
  const start = 'M' + coord(startX, previous.y) + path[begin];
  const coords = path.slice(begin + 1, end).split(/[ ,]/).map(Number);
  return {
    prefix: path.slice(0, begin),
    frame(fromY: number, progress: number, tipY: number) {
      const parts: string[] = [];
      for (let i = 0; i < coords.length; i += 2) {
        const initial = previous.y + (fromY - previous.y) * ((i + 2) / coords.length);
        parts.push(coord(coords[i], initial + (coords[i + 1] - initial) * progress));
      }
      return start + parts.join(' ') + (held ? 'L' + coord(tipX, tipY) : '');
    },
  };
}
