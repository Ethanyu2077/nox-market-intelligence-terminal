import assert from 'node:assert/strict';
import test from 'node:test';
import { liveTimeTicks, movingStrengthTail, observedStrengthGap, spreadLabels, strengthDomain, strengthPath } from '../shared/strength-geometry.ts';

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

test('live holds the last observed level all the way to the clock and changes at the recovery quote', () => {
  const first = { t: 1000, x: 1, y: 8 };
  const second = { t: 2000, x: 2, y: 4 };
  assert.equal(strengthPath([], 5000, 90), '');
  assert.equal(strengthPath([first], 5000, 90), 'M1,8L90,8');
  assert.equal(strengthPath([first, second], 5000, 90), 'M1,8L2,4L90,4');
  const recovered = { t: 91_000, x: 91, y: 1 };
  assert.equal(strengthPath([first, second, recovered], 5000, 92), 'M1,8L2,4L91,4L91,1L92,1');
  const shortGap = { t: 4000, x: 4, y: 5 };
  assert.equal(strengthPath([second, shortGap], 5000, 4), 'M2,4L4,4L4,5');
  assert.equal(strengthPath([first, { ...recovered, compactedBefore: true }], 5000, 92), 'M1,8L91,1L92,1');
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
  const points = [2, 1, 8, 8, 2, 3, 6, 12].map((y, i) => ({ x: i * 2, y, t: i * 1000 }));
  const path = strengthPath(points, 5000);
  const segments = Array.from(path.matchAll(/([LC])([^MLC]+)/g));
  assert.equal(segments.length, points.length - 1);
  assert.ok(segments.some(([, command]) => command === 'C'));
  segments.forEach(([, , coords], i) => {
    const numbers = coords.trim().split(/[ ,]+/).map(Number);
    const a = points[i], b = points[i + 1];
    assert.deepEqual(numbers.slice(-2), [b.x, b.y]);
    for (let j = 0; j < numbers.length; j += 2) {
      assert.ok(numbers[j] >= a.x && numbers[j] <= b.x);
      assert.ok(numbers[j + 1] >= Math.min(a.y, b.y) && numbers[j + 1] <= Math.max(a.y, b.y));
    }
  });
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

test('an animated recovery stays at the held level until the precise recovery time', () => {
  const before = {t:1000, x:2, y:8}, after = {t:7000, x:14, y:2}, edge = 18;
  const path = strengthPath([before, after], 5000, edge);
  const tail = movingStrengthTail(path, before, after, edge)!;
  assert.equal(tail.prefix, 'M2,8L14,8');
  assert.equal(tail.frame(8, 0, 8), 'M14,8L14,8L18,8');
  assert.equal(tail.frame(8, .5, 5), 'M14,8L14,5L18,5');
  assert.equal(tail.prefix + tail.frame(8, 1, 2).slice('M14,8'.length), path);
});

test('animating the last ordinary cubic leaves its prefix intact and settles on the original spline', () => {
  const points = [20,18,3].map((y, i) => ({x:i*3, t:i*1000, y}));
  const path = strengthPath(points, 5000, 6);
  const tail = movingStrengthTail(path, points[1], points[2], 6)!;
  assert.equal(tail.prefix, 'M0,20L3,18');
  assert.equal(tail.frame(18, 0, 18), 'M3,18C4,18 5,18 6,18');
  const mid = tail.frame(18, .5, 10.5);
  assert.match(mid, /^M3,18C4,[\d.]+ 5,[\d.]+ 6,10\.5$/);
  assert.equal(tail.prefix + tail.frame(18, 1, 3).slice('M3,18'.length), path);
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
