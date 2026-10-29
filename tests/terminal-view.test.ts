import test from 'node:test';
import assert from 'node:assert/strict';
import { coveredSegments, pointAtOrBefore, timelineX } from '../shared/terminal-view.ts';

test('all terminal panels map actual timestamps to the same domain, not point indices', () => {
  assert.equal(timelineX(50, 0, 100), 512.5);
  assert.equal(timelineX(0, 0, 100), 45);
  assert.equal(timelineX(100, 0, 100), 980);
  assert.equal(timelineX(-10, 0, 100), 45);
});

test('terminal readout never looks ahead to a later OI snapshot', () => {
  const points = [{ time: 0, value: 10 }, { time: 300, value: 20 }];
  assert.equal(pointAtOrBefore(points, 299)?.value, 10);
  assert.equal(pointAtOrBefore(points, -1), null);
});

test('missing, incomplete and gapped chart values are not zero-filled or connected', () => {
  const points = [{ time: 0, value: 10 }, { time: 1, value: 12 }, { time: 2, value: null }, { time: 3, value: 20 }, { time: 10, value: 21 }];
  const segments = coveredSegments(points, 2);
  assert.deepEqual(segments.map(s => s.length), [2, 1, 1]);
  assert.ok(!segments.flat().some(p => p.value === 0));
});
