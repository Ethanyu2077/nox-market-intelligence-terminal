import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';
import { createCandleChannel } from '../server/native-candle-stream.ts';
import { createLiveHub } from '../server/live-hub.ts';
import type { NativeCandleFrame } from '../shared/native-candles.ts';
import { FLOW_INTERVALS } from '../shared/orderflow.ts';
import type { MarketProject } from '../shared/types.ts';

const now = 1_800_000_000_000;
const project = (): MarketProject => ({
  id: 'jct', name: 'JCT', tokenSymbol: 'JCT', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
  markets: (['binance', 'aster'] as const).map(exchange => ({ id: exchange, exchange, marketType: 'perpetual',
    symbol: 'JCTUSDT', base: 'JCT', quote: 'USDT', status: 'TRADING' })),
  primaryMarketId: 'binance', monitoring: { defaultInterval: '5m', streamingEnabled: true },
  archived: false, order: 0, createdAt: 0, updatedAt: 0,
});

class Socket extends EventEmitter {
  readyState: WebSocket['readyState'] = WebSocket.OPEN;
  terminate() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  ping() { this.emit('pong'); }
}

function fixture() {
  const p = project();
  const sockets: {url: string; socket: Socket}[] = [];
  const listen = createCandleChannel(() => [p], url => {
    const socket = new Socket();
    sockets.push({url, socket});
    return socket;
  });
  return { sockets, listen, p };
}

const params = {exchange: 'binance', symbol: 'JCTUSDT', marketType: 'perpetual', interval: '1m'};
function kline(time: number, eventTime: number, close: number, volume: number, closed = false, interval = '1m') {
  return JSON.stringify({e: 'kline', s: 'JCTUSDT', E: eventTime, k: {
    s: 'JCTUSDT', t: time, i: interval, x: closed, o: '100', c: String(close), l: '90', h: '110', v: String(volume), q: String(100 * volume),
  }});
}

test('one upstream per watched market and interval; in-second previews coalesce and retain the final close on rollover', t => {
  t.mock.timers.enable({apis: ['Date', 'setInterval', 'setTimeout'], now});
  const {listen, sockets} = fixture();
  const a: NativeCandleFrame[] = [], b: NativeCandleFrame[] = [];
  const first = listen(params, frame => a.push(frame as NativeCandleFrame), assert.fail);
  const second = listen(params, frame => b.push(frame as NativeCandleFrame), assert.fail);
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /\/market\/ws\/jctusdt@kline_1m$/);
  const ws = sockets[0].socket;
  ws.emit('open');
  ws.emit('message', kline(now-60_000, now-500, 101, 10));
  ws.emit('message', kline(now-60_000, now-1, 103, 12, true));
  ws.emit('message', kline(now, now, 100, 0));
  ws.emit('message', kline(now, now+30, 102, 2));
  ws.emit('message', kline(now, now+10, 101, 1));
  ws.emit('message', kline(now-60_000, now+40, 101, 13));
  assert.equal(a.length, 1);
  t.mock.timers.tick(1000);
  assert.deepEqual(a, b);
  assert.equal(a.length, 2);
  assert.deepEqual(a.at(-1)?.bars.map(({candle, closed}) => [candle.time, candle.close, candle.volumeBase, closed]),
    [[now-60_000, 103, 12, true], [now, 102, 2, false]]);
  let replay: unknown;
  const third = listen(params, frame => { replay = frame; }, assert.fail);
  assert.deepEqual(replay, a.at(-1));
  first(); second();
  assert.equal(ws.readyState, WebSocket.OPEN);
  third();
  assert.equal(ws.readyState, WebSocket.CLOSED);
  t.mock.timers.tick(40_000);
  assert.equal(sockets.length, 1);
});

test('each native timeframe consumes only its own venue and bar interval; pause and reconnect release correctly', t => {
  t.mock.timers.enable({apis: ['Date', 'setInterval', 'setTimeout'], now});
  const {listen, sockets, p} = fixture();
  for (const exchange of ['binance', 'aster']) {
    for (const [interval, duration] of Object.entries(FLOW_INTERVALS)) {
      const frames: NativeCandleFrame[] = [];
      let unavailable = 0;
      const stop = listen({...params, exchange, interval}, frame => frames.push(frame as NativeCandleFrame), () => unavailable++);
      const {socket, url} = sockets.at(-1)!;
      if (exchange === 'aster') assert.ok(url.endsWith('/ws/jctusdt@kline_' + interval) && !url.includes('/market/ws/'));
      socket.emit('open');
      const start = Math.floor(Date.now()/duration)*duration;
      socket.emit('message', kline(start, Date.now(), 108, 5, false, interval === '1m' ? '5m' : '1m'));
      socket.emit('message', kline(start, Date.now(), 109, 9, false, interval).replaceAll('JCTUSDT', 'OTHERUSDT'));
      socket.emit('message', kline(start, Date.now(), 103, 3, false, interval));
      t.mock.timers.tick(1000);
      assert.deepEqual(frames.at(-1)?.bars.map(item => item.candle.close), [103]);
      assert.equal(frames.at(-1)?.exchange, exchange);
      assert.equal(unavailable, 0);
      stop();
    }
  }
  let unavailable = 0;
  const stop = listen(params, () => {}, () => unavailable++);
  const before = sockets.length;
  sockets.at(-1)!.socket.terminate();
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, before+1);
  p.monitoring.collectionMode = 'paused';
  t.mock.timers.tick(1000);
  assert.equal(unavailable, 1);
  assert.equal(sockets.at(-1)!.socket.readyState, WebSocket.CLOSED);
  stop();
  listen(params, () => assert.fail('paused market emitted bars'), () => unavailable++);
  listen({...params, marketType: 'spot'}, () => assert.fail('spot emitted perpetual bars'), () => unavailable++);
  assert.equal(unavailable, 3);
  t.mock.timers.tick(40_000);
  assert.equal(sockets.length, before+1);
});

test('browser WebSocket receives current OHLCV over /ws/live and unsubscribing releases its venue socket', {timeout: 6000}, async t => {
  const {listen, sockets, p} = fixture();
  const server = createServer();
  const close = createLiveHub(server, () => [p], {streams: {candles: listen}});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws/live');
  t.after(() => { client.terminate(); close(); server.close(); });
  const frameWithBars = new Promise<NativeCandleFrame>((resolve) => {
    client.on('message', bytes => {
      const frame = JSON.parse(bytes.toString());
      if (frame.type !== 'data' || frame.id !== 'chart') return;
      if (frame.data.bars.length) { resolve(frame.data); return; }
      const at = Date.now(), time = Math.floor(at / 60_000) * 60_000;
      sockets[0].socket.emit('message', kline(time, at, 105, 3));
    });
  });
  await once(client, 'open');
  client.send(JSON.stringify({op:'listen', channel:'candles', id:'chart', params}));
  const received = await frameWithBars;
  assert.deepEqual([received.exchange, received.symbol, received.interval], ['binance','JCTUSDT','1m']);
  assert.deepEqual([received.bars[0].candle.close, received.bars[0].candle.volumeUsd, received.bars[0].closed], [105,300,false]);
  const released = once(sockets[0].socket, 'close');
  client.send(JSON.stringify({op:'unlisten', id:'chart'}));
  await released;
});
