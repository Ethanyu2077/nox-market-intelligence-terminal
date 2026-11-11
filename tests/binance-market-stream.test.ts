import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { type TestContext } from 'node:test';
import WebSocket from 'ws';
import { openMarketStream } from '../server/binance.ts';

class Socket extends EventEmitter {
  readyState: WebSocket['readyState'] = WebSocket.OPEN;
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  terminate() { this.close(); }
  frame(data: Record<string, unknown>) { this.emit('message', Buffer.from(JSON.stringify({ data }))); }
  price() { this.frame({ e: 'aggTrade', T: Date.now(), p: '101' }); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(t: TestContext, read: (path: string) => Promise<unknown>) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const sockets: Socket[] = [];
  const events: unknown[] = [];
  const paths: string[] = [];
  const states: string[] = [];
  const stop = openMarketStream('btcusdt', value => events.push(value), state => states.push(state), {
    socket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    json: async <T>(path: string) => { paths.push(path); return await read(path) as T; },
  });
  t.after(stop);
  const advance = async (seconds: number) => {
    for (let i = 0; i < seconds; i++) { t.mock.timers.tick(1000); await flush(); }
  };
  return { sockets, paths, states, events, stop, advance };
}
const ticker = () => ({ closeTime: Date.now(), lastPrice: '99', priceChangePercent: '2' });
const mark = () => ({ time: Date.now(), markPrice: '98', lastFundingRate: '0.001' });

test('the same Binance contract falls back on cold start, later price silence, and reconnect', async t => {
  const feed = harness(t, async path => path.includes('ticker') ? ticker() : mark());
  await feed.advance(5);
  assert.deepEqual(feed.paths, ['/fapi/v1/ticker/24hr?symbol=BTCUSDT', '/fapi/v1/premiumIndex?symbol=BTCUSDT']);
  assert.deepEqual(feed.events[0], { stream: 'btcusdt@ticker', transport: 'rest-fallback',
    data: { e: '24hrTicker', E: 105_000, c: '99', P: '2', v: undefined, q: undefined } });
  feed.sockets[0].price();
  await feed.advance(4);
  assert.equal(feed.paths.length, 2);
  feed.sockets[0].frame({ e: 'markPriceUpdate', E: Date.now(), p: '140' });
  await feed.advance(1);
  assert.equal(feed.paths.length, 4, 'mark prices cannot suppress last-price fallback');
  await feed.advance(3);
  assert.equal(feed.paths.length, 6);
  feed.sockets[0].price();
  feed.sockets[0].close();
  await feed.advance(3);
  assert.equal(feed.sockets.length, 2);
  assert.equal(feed.paths.length, 8, 'fallback keeps running through reconnect without waiting for frames');
  feed.sockets[1].price();
  assert.equal(feed.states.at(-1), 'live');
  feed.stop();
  await feed.advance(20);
  assert.equal(feed.paths.length, 8);
});

test('a delayed REST response cannot overwrite recovered websocket prices or fire after cleanup', async t => {
  let respond: (value: unknown) => void = () => {};
  const feed = harness(t, path => path.includes('ticker')
    ? new Promise(resolve => { respond = resolve; }) : Promise.resolve(mark()));
  await feed.advance(12);
  assert.equal(feed.paths.filter(path => path.includes('ticker')).length, 1, 'only one ticker request in flight');
  feed.sockets[0].price();
  let count = feed.events.length;
  respond(ticker());
  await flush();
  assert.equal(feed.events.length, count, 'discard quote from the previous fallback period');
  await feed.advance(5);
  assert.equal(feed.paths.filter(path => path.includes('ticker')).length, 2, 'fallback can restart after recovery');
  feed.stop();
  count = feed.events.length;
  respond(ticker());
  await flush();
  assert.equal(feed.events.length, count);
});

test('a fully silent socket reconnects and failed premium data does not discard real ticker observations', async t => {
  const feed = harness(t, async path => {
    if (path.includes('ticker')) return ticker();
    throw new Error('funding delayed');
  });
  await feed.advance(16);
  assert.equal(feed.sockets.length, 2);
  assert.ok(feed.events.length >= 3);
  for (const event of feed.events) assert.equal((event as { stream: string }).stream, 'btcusdt@ticker');
});

test('stalled funding cannot starve ticker polling or create duplicate premium requests', async t => {
  let release: (value: unknown) => void = () => {};
  const feed = harness(t, path => path.includes('ticker')
    ? Promise.resolve(ticker()) : new Promise(resolve => { release = resolve; }));
  await feed.advance(14);
  assert.equal(feed.paths.filter(path => path.includes('premium')).length, 1);
  assert.equal(feed.events.length, 4, 'ticker delivered at 5, 8, 11, and 14 seconds');
  feed.stop();
  release(mark());
  await flush();
  assert.equal(feed.events.length, 4);
});
