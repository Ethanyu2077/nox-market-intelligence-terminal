import assert from 'node:assert/strict';
import test from 'node:test';
import { liveTimeTicks, movingStrengthTail, observedStrengthGap, spreadLabels, strengthDomain, strengthPath } from '../shared/strength-geometry.ts';

function pathCommands(path: string) {
  return Array.from(path.matchAll(/([MLC])([^MLC]+)/g), ([, command, coords]) => ({
    command, coords: coords.trim().split(/[ ,]+/).map(Number),
  }));
}

function cubicAt(start: number, control1: number, control2: number, end: number, t: number) {
  const u = 1 - t;
  return u ** 3 * start + 3 * u ** 2 * t * control1 + 3 * u * t ** 2 * control2 + t ** 3 * end;
}

test('strength axis includes zero and every excursion with headroom at flat and tiny spreads', () => {
  for (const [low, high] of [[0, 0], [0, 1.17], [-0.23, 0], [-0.27, 1.17], [0, 1.2e-8]]) {
    const { min, max, ticks } = strengthDomain(low, high, 6);
    assert.ok(min < low && max > high);
    assert.equal(min, ticks[0]);
    assert.equal(max, ticks.at(-1));
    assert.ok(ticks.includes(0));
    assert.ok(ticks.length >= 4 && ticks.length <= 12);
    assert.ok(ticks.every((tick, i) => Number.isFinite(tick) && (i === 0 || tick > ticks[i - 1])));
  }
});

test('crowded and tied labels stay ordered, balanced, and inside the rail', () => {
  assert.deepEqual(spreadLabels([], 0, 100, 14), []);
  assert.deepEqual(spreadLabels([45, 45, 45], 0, 100, 10), [35, 45, 55]);
  assert.deepEqual(spreadLabels([0, 1, 40, 99, 100], 10, 90, 12), [10, 22, 40, 78, 90]);
  assert.deepEqual(spreadLabels([0, 0, 0, 0], 10, 40, 20), [10, 20, 30, 40]);
});

test('the curve bridges consecutive gaps with straight lines between observed endpoints', () => {
  const times = [0, 1000, 6500, 12000, 13000];
  const values = [1, 3, 12, 4, -3];
  const points = times.map((t, i) => ({ x: t / 1000, y: values[i], t }));
  assert.equal(strengthPath(points, 5000), 'M0,1L1,3L6.5,12L12,4L13,-3');
  assert.equal(strengthPath(points.slice(1, 2), 5000), 'M1,3h0');
  assert.equal(strengthPath([], 5000), '');
});

test('live two-quote moves visibly bend away from the chord despite jitter or sparse observations', () => {
  const first = { t: 1999, x: 10, y: 8 };
  // 1002 ms crosses two second buckets. Five seconds is still in the normal drawing interval.
  for (const elapsed of [1002, 3000, 5000]) for (const change of [-12, 12]) {
    const next = { t: first.t + elapsed, x: 50, y: first.y + change };
    const commands = pathCommands(strengthPath([first, next], 5000, next.x));
    assert.deepEqual(commands.map(part => part.command), ['M', 'C']);
    const [cx1, cy1, cx2, cy2, endX, endY] = commands[1].coords;
    assert.deepEqual([cy1, cy2, endX, endY], [first.y, next.y, next.x, next.y]);
    for (const t of [.25, .75]) {
      const x = cubicAt(first.x, cx1, cx2, endX, t);
      const y = cubicAt(first.y, cy1, cy2, endY, t);
      const chordFraction = (x - first.x) / (next.x - first.x);
      const curveFraction = (y - first.y) / change;
      assert.ok(t < .5 ? curveFraction < chordFraction - .03 : curveFraction > chordFraction + .03);
    }
  }
});

test('a long outage holds the last level and rounds only the final gap interval into the recovered quote', () => {
  const first = { t: 1000, x: 1, y: 8 };
  const second = { t: 2000, x: 2, y: 4 };
  assert.equal(strengthPath([], 5000, 90), '');
  assert.equal(strengthPath([first], 5000, 90), 'M1,8L90,8');
  assert.ok(strengthPath([first, second], 5000, 90).endsWith('L90,4'));

  const recovered = { t: 91_000, x: 91, y: 1 };
  const commands = pathCommands(strengthPath([first, second, recovered], 5000, 92));
  assert.deepEqual(commands.map(part => part.coords.slice(-2)), [[1, 8], [2, 4], [86, 4], [91, 1], [92, 1]]);
  assert.deepEqual(commands.slice(-3).map(part => part.command), ['L', 'C', 'L']);

  const compacted = pathCommands(strengthPath([first, { ...recovered, compactedBefore: true }], 5000, 92));
  assert.deepEqual(compacted.map(part => part.command), ['M', 'C', 'L']);
  assert.deepEqual(compacted[1].coords.slice(-2), [91, 1]);
});

test('live axis retains its exact origin and advancing clock with a width-limited number of labels', () => {
  const start = 1_734_000_000_120, width = 430;
  for (const duration of [1000, 61_000, 621_000, 87_000_000, 360 * 86_400_000]) {
    const end = start + duration;
    const ticks = liveTimeTicks(start, end, width);
    assert.equal(ticks[0], start);
    assert.equal(ticks.at(-1), end);
    assert.ok(ticks.length <= Math.floor(width / 85) + 1);
    assert.ok(ticks.every((tick, i) => i === 0 || (tick - ticks[i - 1]) / duration * width >= 84.99));
  }
  assert.deepEqual(liveTimeTicks(start, start + 61_000, 40), [start, start + 61_000]);
});

test('smooth turns pass through all samples without overshooting steep moves and plateaus', () => {
  const times = [0, 900, 2000, 4900, 7050, 7790, 8580, 9010];
  const points = [2, 1, 8, 8, 2, 3, 6, 12].map((y, i) => ({ x: times[i] / 100, y, t: times[i] }));
  for (const liveEdge of [undefined, points.at(-1)!.x]) {
    const segments = pathCommands(strengthPath(points, 5000, liveEdge)).slice(1);
    assert.equal(segments.length, points.length - 1);
    assert.ok(segments.some(({ command }) => command === 'C'));
    segments.forEach(({ command, coords }, i) => {
      const a = points[i], b = points[i + 1];
      assert.deepEqual(coords.slice(-2), [b.x, b.y]);
      for (let j = 0; j < coords.length; j += 2) {
        assert.ok(coords[j] >= a.x && coords[j] <= b.x);
        assert.ok(coords[j + 1] >= Math.min(a.y, b.y) && coords[j + 1] <= Math.max(a.y, b.y));
      }
      if (command === 'C' && [1, 4].includes(i)) {
        assert.equal(coords[1], a.y, 'leave the trough with a horizontal tangent');
      }
    });
    if (liveEdge !== undefined) {
      // The same-direction climb through point 5 should flow through, with a shared nonzero tangent.
      const incoming = segments[4].coords, outgoing = segments[5].coords;
      assert.equal(segments[4].command, 'C');
      assert.equal(segments[5].command, 'C');
      const knot = points[5];
      const incomingSlope = (knot.y - incoming[3]) / (knot.x - incoming[2]);
      const outgoingSlope = (outgoing[1] - knot.y) / (outgoing[0] - knot.x);
      assert.ok(incomingSlope > 0 && Math.abs(incomingSlope - outgoingSlope) < .01);
    }
  }
});

test('cursor identifies the entire confirmed gap but never its observed endpoints', () => {
  const points = [2000, 3000, 13000, 15000].map(t => ({ t }));
  for (const t of [3001, 8000, 8001, 12999]) {
    assert.deepEqual(observedStrengthGap(points, t), { from: 3000, to: 13000 });
  }
  assert.deepEqual(observedStrengthGap(points, 14000), { from: 13000, to: 15000 });
  assert.equal(observedStrengthGap([{ t: 1000 }, { t: 14000, compactedBefore: true }], 8000), null);
  for (const t of [0, 2000, 2500, 3000, 13000, 15000, 30000]) {
    assert.equal(observedStrengthGap(points, t), null);
  }
  assert.equal(observedStrengthGap([], 12000), null);
});

test('an animated recovery starts where the held segment ends and settles exactly on the spline', () => {
  const before = { t: 1000, x: 2, y: 8 }, after = { t: 7000, x: 14, y: 2 }, edge = 18;
  const path = strengthPath([before, after], 5000, edge);
  const tail = movingStrengthTail(path, before, after, edge)!;
  const start = pathCommands(tail.prefix).at(-1)!.coords.slice(-2);
  assert.deepEqual(start, [4, 8]);
  for (const progress of [0, .5, 1]) {
    const tipY = before.y + progress * (after.y - before.y);
    const commands = pathCommands(tail.frame(before.y, progress, tipY));
    assert.deepEqual(commands.map(part => part.command), ['M', 'C', 'L']);
    assert.deepEqual(commands[0].coords, start);
    assert.deepEqual(commands[1].coords.slice(-2), [after.x, tipY]);
    assert.deepEqual(commands[2].coords, [edge, tipY]);
    if (progress === 0) assert.deepEqual(commands[1].coords.filter((_, i) => i % 2 === 1), [8, 8, 8]);
  }
  assert.deepEqual([...pathCommands(tail.prefix), ...pathCommands(tail.frame(8, 1, 2)).slice(1)], pathCommands(path));
});

test('animating an ordinary cubic retains its preceding turn', () => {
  const points = [20, 18, 3].map((y, i) => ({ x: i * 3, t: i * 1000, y }));
  const path = strengthPath(points, 5000, 6);
  const tail = movingStrengthTail(path, points[1], points[2], 6)!;
  assert.deepEqual(pathCommands(tail.prefix), pathCommands(path).slice(0, -1));
  const mid = pathCommands(tail.frame(18, .5, 10.5));
  assert.deepEqual(mid.map(({ command }) => command), ['M', 'C']);
  assert.deepEqual(mid[0].coords, [3, 18]);
  assert.deepEqual(mid[1].coords.slice(-2), [6, 10.5]);
  assert.deepEqual([...pathCommands(tail.prefix), ...pathCommands(tail.frame(18, 1, 3)).slice(1)], pathCommands(path));
});

test('the first quote has no moving segment; coincident positions stay finite and flat quotes stay flat', () => {
  const first = {t:1000, x:2, y:4};
  assert.equal(movingStrengthTail(strengthPath([first], 5000, 9), undefined, first, 9), null);
  const repeated = {...first, y:6};
  const vertical = movingStrengthTail(strengthPath([first, repeated], 5000, 2), first, repeated, 2)!;
  assert.equal(vertical.frame(4, .5, 5), 'M2,4L2,5');
  const unchanged = {t:2000, x:3, y:4};
  const flat = movingStrengthTail(strengthPath([first, unchanged], 5000, 9), first, unchanged, 9)!;
  for (const progress of [0, .5, 1]) assert.equal(flat.frame(4, progress, 4), 'M2,4L3,4L9,4');
});
