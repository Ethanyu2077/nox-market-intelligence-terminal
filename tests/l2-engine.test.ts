import assert from 'node:assert/strict';
import test from 'node:test';
import { L2Book, okxChecksum } from '../server/l2/engine.ts';
import { L2Feed } from '../server/l2/feed.ts';
import { binanceGovernor, BinanceCooldownError } from '../server/binance-governor.ts';

const snap = (last: number) => ({
  bids: [['100', '2'], ['99', '1']] as Array<[string, string]>,
  asks: [['101', '1.5'], ['102', '1']] as Array<[string, string]>,
  sequence: { first: null, last },
  eventTime: 1_000,
});

test('Binance: deltas apply in order, stale ones are dropped', () => {
  const book = new L2Book('binance', 'BTCUSDT', () => 2_000);
  book.applySnapshot({ ...snap(100), eventTime: 2_000 });
  assert.equal(book.state, 'live');
  assert.equal(book.applyDelta({ bids: [['100.5', '1']], asks: [], first: 101, last: 102, previous: null, eventTime: 2_000 }).reason, 'ok');
  assert.equal(book.applyDelta({ bids: [], asks: [['101', '0']], first: 90, last: 101, previous: null, eventTime: 2_000 }).reason, 'stale');
  const s = book.snapshot(2_000);
  assert.equal(s.bestBid, 100.5);
  assert.equal(s.bestAsk, 101, 'the stale delta (which would have removed 101) must not apply');
});

test('Binance: a U beyond last+1 is a gap and blocks the book until a snapshot', () => {
  const book = new L2Book('binance', 'BTCUSDT', () => 2_000);
  book.applySnapshot({ ...snap(100), eventTime: 2_000 });
  const gap = book.applyDelta({ bids: [['99.5', '1']], asks: [], first: 105, last: 106, previous: null, eventTime: 2_000 });
  assert.equal(gap.reason, 'gap');
  assert.equal(book.state, 'resyncing');
  assert.equal(book.snapshot(2_000).gaps, 1);
  assert.equal(book.applyDelta({ bids: [['99.5', '1']], asks: [], first: 107, last: 108, previous: null, eventTime: 2_000 }).reason, 'not-synced');
  book.applySnapshot({ ...snap(200), eventTime: 2_000 });
  assert.equal(book.state, 'live');
  assert.equal(book.applyDelta({ bids: [], asks: [['102', '0']], first: 201, last: 202, previous: null, eventTime: 2_000 }).reason, 'ok');
});

test('Bybit: update ids are monotonic without gap inference; duplicates are dropped', () => {
  const book = new L2Book('bybit', 'BTCUSDT', () => 2_000);
  book.applySnapshot({ ...snap(10), eventTime: 2_000 });
  assert.equal(book.applyDelta({ bids: [], asks: [['102', '0']], first: 11, last: 11, previous: null, eventTime: 2_000 }).reason, 'ok');
  assert.equal(book.applyDelta({ bids: [], asks: [], first: 11, last: 11, previous: null, eventTime: 2_000 }).reason, 'duplicate');
  assert.equal(book.applyDelta({ bids: [], asks: [], first: 15, last: 15, previous: null, eventTime: 2_000 }).reason, 'ok');
  assert.equal(book.state, 'live');
});

test('OKX: prevSeqId must match the last applied seqId', () => {
  const book = new L2Book('okx', 'BTC-USDT-SWAP', () => 2_000);
  book.applySnapshot({ ...snap(50), eventTime: 2_000 });
  assert.equal(book.applyDelta({ bids: [['100', '3']], asks: [], first: null, last: 51, previous: 50, eventTime: 2_000 }).reason, 'ok');
  const gap = book.applyDelta({ bids: [], asks: [], first: null, last: 60, previous: 59, eventTime: 2_000 });
  assert.equal(gap.reason, 'gap');
  assert.equal(book.snapshot(2_000).integrity, 'gap');
});

test('metrics: spread, 25bps depth, imbalance and withdrawal', () => {
  let clock = 1_000;
  const book = new L2Book('binance', 'BTCUSDT', () => clock);
  // Tight book around mid 100.5: 100.4/100.3 and 100.6/100.7 are inside 25bps, 99/101 are not.
  book.applySnapshot({ bids: [['100.4', '10'], ['100.3', '10'], ['99', '10']], asks: [['100.6', '5'], ['100.7', '5'], ['101', '5']], sequence: { first: null, last: 1 }, eventTime: 1_000 });
  clock = 1_000;
  const first = book.metrics(1_000);
  assert.ok(first.spreadBps != null && first.spreadBps > 0);
  assert.equal(first.bidDepthUsd, 100.4 * 10 + 100.3 * 10, '99 is outside 25bps of the mid');
  assert.equal(first.askDepthUsd, 100.6 * 5 + 100.7 * 5, '101 is outside 25bps of the mid');
  assert.ok(first.imbalancePct != null && first.imbalancePct > 0);
  assert.equal(first.bidWithdrawalPct, null, 'first sample has no baseline');

  clock = 2_000;
  book.applyDelta({ bids: [['100.4', '0'], ['100.3', '0']], asks: [], first: 2, last: 2, previous: null, eventTime: 2_000 });
  const second = book.metrics(2_000);
  assert.equal(second.bidDepthUsd, 0);
  assert.equal(second.bidWithdrawalPct, 100);
  assert.equal(book.metricHistory().length, 2);
});

test('Binance: first delta must straddle lastUpdateId; pu must stay continuous', () => {
  const book = new L2Book('binance', 'BTCUSDT', () => 2_000);
  book.applySnapshot({ ...snap(100), eventTime: 2_000 });
  assert.equal(book.applyDelta({ bids: [], asks: [], first: 90, last: 100, previous: null, eventTime: 2_000 }).reason, 'stale', 'u <= lastUpdateId is a duplicate');
  assert.equal(book.applyDelta({ bids: [], asks: [], first: 101, last: 103, previous: null, previousLast: 100, eventTime: 2_000 }).reason, 'ok');
  assert.equal(book.applyDelta({ bids: [], asks: [], first: 104, last: 106, previous: null, previousLast: 103, eventTime: 2_000 }).reason, 'ok');
  assert.equal(book.applyDelta({ bids: [], asks: [], first: 107, last: 109, previous: null, previousLast: 105, eventTime: 2_000 }).reason, 'gap', 'pu mismatch reveals a missed update');
  assert.equal(book.snapshot(2_000).state, 'resyncing');
});

test('Binance: a live book is verified, and lastValidUpdate tracks the sequence', () => {
  const book = new L2Book('binance', 'BTCUSDT', () => 2_000);
  book.applySnapshot({ ...snap(100), eventTime: 2_000 });
  assert.equal(book.snapshot(2_000).verified, true);
  book.applyDelta({ bids: [], asks: [], first: 101, last: 102, previous: null, previousLast: 100, eventTime: 2_000 });
  assert.equal(book.snapshot(2_000).lastValidUpdate, 102);
});

test('OKX: checksum failure forces resync and unverifies the book', () => {
  const book = new L2Book('okx', 'BTC-USDT-SWAP', () => 2_000);
  book.applySnapshot({ bids: [['100', '1']], asks: [['101', '1']], sequence: { first: null, last: 50 }, eventTime: 2_000 });
  assert.equal(book.snapshot(2_000).verified, false, 'without a checksum OKX is not verified');
  const good = okxChecksum(book['bidText'], book['askText']);
  const first = book.applyDelta({ bids: [['100', '2']], asks: [], first: null, last: 51, previous: 50, checksum: null, eventTime: 2_000 });
  assert.equal(first.reason, 'ok');
  const expected = okxChecksum(book['bidText'], book['askText']);
  const bad = book.applyDelta({ bids: [['100', '3']], asks: [], first: null, last: 52, previous: 51, checksum: expected + 1, eventTime: 2_000 });
  assert.equal(bad.reason, 'checksum');
  assert.equal(book.snapshot(2_000).integrity, 'checksum-failed');
  assert.equal(book.snapshot(2_000).verified, false);
  void good;
});

test('Bybit: a fresh snapshot rebuilds the book and resets the sequence', () => {
  const book = new L2Book('bybit', 'BTCUSDT', () => 2_000);
  book.applySnapshot({ ...snap(10), eventTime: 2_000 });
  book.applyDelta({ bids: [['100', '5']], asks: [], first: 11, last: 11, previous: null, eventTime: 2_000 });
  book.applySnapshot({ bids: [['200', '1']], asks: [['201', '1']], sequence: { first: null, last: 20 }, eventTime: 2_000 });
  const s = book.snapshot(2_000);
  assert.equal(s.bestBid, 200);
  assert.equal(s.sequence.last, 20);
  assert.equal(s.state, 'live');
});

test('every snapshot rebuild advances the book epoch', () => {
  const book = new L2Book('binance', 'BTCUSDT', () => 2_000);
  book.applySnapshot({ ...snap(100), eventTime: 2_000 });
  assert.equal(book.snapshot(2_000).epoch, 1);
  book.applySnapshot({ ...snap(200), eventTime: 2_000 });
  assert.equal(book.snapshot(2_000).epoch, 2);
  assert.equal(book.snapshot(2_000).sequence.last, 200);
});

test('growing depth books remain bounded and resume verified sequences after a rebuild', () => {
  const book = new L2Book('binance', 'BTCUSDT');
  book.applySnapshot(snap(0));
  let rebuilds = 0;
  for (let sequence = 1; sequence <= 21_000; sequence++) {
    const delta = { first: sequence, last: sequence, previous: null, eventTime: sequence,
      bids: [], asks: [[String(1000 + sequence), '1']] as Array<[string, string]> };
    const result = book.applyDelta(delta);
    if (result.reason === 'depth-limit') {
      assert.equal(book.snapshot().verified, false);
      assert.equal(book.snapshot().sequence.last, sequence - 1);
      assert.equal(book.applyDelta(delta).reason, 'not-synced');
      book.applySnapshot(snap(sequence));
      rebuilds++;
    } else assert.equal(result.reason, 'ok');
    assert.ok(book['asks'].size <= 4096);
  }
  assert.ok(rebuilds >= 5);
  assert.equal(book['askText'].size, 0);
  assert.equal(book.snapshot().verified, true);
});

test('depth recovery drops an overflowed buffer and schedules one retry during an exchange cooldown', async t => {
  const feed = new L2Feed('binance', 'BTCUSDT');
  t.after(() => feed.stop());
  const delta = { bids: [], asks: [], first: 1, last: 1, previous: null, eventTime: 1 };
  for (let i = 0; i < 5000; i++) feed['bufferDelta'](delta, 8192);
  assert.equal(feed['bufferOverflow'], true);
  assert.equal(feed['bufferedBytes'], 0);
  assert.equal(feed['buffer'].length, 0);
  const request = t.mock.method(binanceGovernor, 'json', async () => { throw new BinanceCooldownError(60_000, 'HTTP 429'); });
  await feed['resync']();
  const retry = feed['retryTimer'];
  assert.ok(retry);
  for (let i = 0; i < 10_000; i++) await feed['resync']();
  assert.equal(request.mock.callCount(), 1);
  assert.equal(feed['retryTimer'], retry);
  assert.equal(feed['bufferOverflow'], false);
});
