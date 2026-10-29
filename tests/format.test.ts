import assert from 'node:assert/strict';
import test from 'node:test';
import { timeAgo } from '../src/format.ts';

const NOW = 1_793_200_000_000;

test('relative time is localized for en and zh without English leakage', () => {
  assert.equal(timeAgo(NOW, 'en', NOW), 'now');
  assert.equal(timeAgo(NOW, 'zh', NOW), '刚刚');
  assert.equal(timeAgo(NOW - 12_000, 'en', NOW), '12s ago');
  assert.equal(timeAgo(NOW - 12_000, 'zh', NOW), '12 秒前');
  assert.equal(timeAgo(NOW - 120_000, 'en', NOW), '2m ago');
  assert.equal(timeAgo(NOW - 120_000, 'zh', NOW), '2 分钟前');
  assert.equal(timeAgo(NOW - 3 * 3_600_000, 'zh', NOW), '3 小时前');
  assert.equal(timeAgo(null, 'zh'), '不可用');
  assert.equal(timeAgo(0, 'en'), 'unavailable');
});
