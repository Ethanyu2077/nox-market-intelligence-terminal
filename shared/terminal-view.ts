export function timelineX(time: number, start: number, end: number) {
  return 45 + Math.max(0, Math.min(1, (time - start) / Math.max(1, end - start))) * 935;
}

export function pointAtOrBefore<T extends { time: number }>(points: T[], time: number): T | null {
  let found: T | null = null;
  for (const point of points) if (point.time <= time && (!found || point.time > found.time)) found = point;
  return found;
}

/** Nulls and long gaps split the line; never connect missing coverage with a fabricated zero. */
export function coveredSegments(points: Array<{ time: number; value: number | null }>, maxGap: number) {
  const groups: Array<Array<{ time: number; value: number }>> = [];
  let current: Array<{ time: number; value: number }> = [];
  for (const point of points) {
    if (point.value == null || !Number.isFinite(point.value)) { if (current.length) groups.push(current); current = []; continue; }
    if (current.length && point.time - current[current.length - 1].time > maxGap) { groups.push(current); current = []; }
    current.push({ time: point.time, value: point.value });
  }
  if (current.length) groups.push(current);
  return groups;
}
