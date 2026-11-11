import assert from 'node:assert/strict';
import test from 'node:test';
import { observedStrengthGap, spreadLabels, strengthDomain, strengthPath } from '../shared/strength-geometry.ts';

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
    assert.deepEqual(observedStrengthGap(points, t, 5000), { from: 3000, to: 13000 });
  }
  for (const t of [0, 2000, 2500, 3000, 13000, 14000, 15000, 30000]) {
    assert.equal(observedStrengthGap(points, t, 5000), null);
  }
  assert.equal(observedStrengthGap([], 12000, 5000), null);
});
