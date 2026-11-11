import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { duplexPair } from 'node:stream';
import test from 'node:test';
import WebSocket, { type RawData } from 'ws';
import { createLiveHub, type LiveTick } from '../server/live-hub.ts';
import { QuoteReplay } from '../server/quote-replay.ts';
import type { MarketProject } from '../shared/types.ts';
import type { StrengthPoint } from '../shared/strength-history.ts';

test('replay retains one observed close per source second and expires it at the rolling cutoff', () => {
  const replay = new QuoteReplay();
  for (let t = 1_000; t <= 180_000; t += 1_000) replay.record(t, t, t);
  replay.record(1, 179_990, 180_000);
  replay.record(2, 179_975, 180_000);
  replay.record(0, 179_995, 180_000);
  replay.record(7, 186_000, 180_000);
  const points = replay.window(180_000);
  assert.equal(points.length, 61);
  assert.deepEqual(points[0], { t: 120_000, p: 120_000 });
  assert.deepEqual(points.at(-2), { t: 179_990, p: 1 });
  assert.deepEqual(replay.window(240_000), [{ t: 180_000, p: 180_000 }]);
  assert.deepEqual(replay.window(240_001), []);
});

interface Frame {
  type: string;
  channel: string;
  replay?: Array<{ projectId: string; marketKey: string; points: StrengthPoint[] }>;
  ticks?: LiveTick[];
}

async function connect(server: Server) {
  // Exercise the full HTTP upgrade / WS framing with paired streams, no network listener.
  const [clientSide, serverSide] = duplexPair();
  server.emit('connection', serverSide);
  const client = new WebSocket('ws://localhost/ws/live', { createConnection: () => clientSide as Socket });
  await once(client, 'open');
  return client;
}

function frame(client: WebSocket, type: string, channel: string) {
  return new Promise<Frame>(resolve => {
    const onMessage = (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as Frame;
      if (message.type !== type || message.channel !== channel) return;
      client.off('message', onMessage);
      resolve(message);
    };
    client.on('message', onMessage);
  });
}

async function disconnect(client: WebSocket) {
  const closed = once(client, 'close');
  client.close();
  await closed;
  await new Promise(resolve => setImmediate(resolve));
}

test('quotes reconnect and resync replay observed prices, isolate markets, and release idle streams', { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 123_000 });
  const project: MarketProject = {
    id: 'p', name: 'Asset', tokenSymbol: 'A', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
    markets: [{ id: 'm', exchange: 'binance', marketType: 'perpetual', symbol: 'AUSDT', base: 'A', quote: 'USDT', status: 'TRADING' }],
    primaryMarketId: 'm', monitoring: { defaultInterval: '5m', streamingEnabled: true }, archived: false, order: 0, createdAt: 0, updatedAt: 0,
  };
  const server = createServer();
  const sources: Array<(payload: unknown) => void> = [];
  let stops = 0;
  const stop = createLiveHub(server, () => [project], {
    intervalMs: 10,
    openPerpetualStream: (_venue, _symbol, publish) => { sources.push(publish); return () => { stops++; }; },
  });
  t.after(stop);
  const subscribe = JSON.stringify({ op: 'subscribe', projects: ['p'], channels: ['quotes', 'flow', 'edge'] });
  const initial = await connect(server);
  const frames = ['quotes', 'flow', 'edge'].map(channel => frame(initial, 'snapshot', channel));
  initial.send(subscribe);
  const [quoteFrame, flowFrame, edgeFrame] = await Promise.all(frames);
  assert.deepEqual(quoteFrame.replay?.[0].points, []);
  assert.ok(!('replay' in flowFrame) && !('replay' in edgeFrame));
  const trade = (p: number, at: number) => sources[0]({ data: { e: 'aggTrade', T: at, p } });
  trade(100, 122_900);
  const live = await frame(initial, 'tick', 'quotes');
  assert.ok(!('replay' in live));
  assert.equal(live.ticks?.[0].price, 100);
  await disconnect(initial);
  assert.equal(stops, 0);
  t.mock.timers.tick(3_000);
  trade(101, 124_100);
  trade(102, 124_200);
  trade(103, 125_100);
  trade(99, 123_500); // Out-of-order source data while no browser is connected.
  const reconnected = await connect(server);
  const restored = frame(reconnected, 'snapshot', 'quotes');
  reconnected.send(subscribe);
  const restarted = await restored;
  assert.equal(sources.length, 1);
  assert.equal(restarted.ticks?.[0].price, 103);
  assert.deepEqual(restarted.replay, [{
    projectId: 'p', marketKey: 'binance:perpetual:AUSDT',
    points: [{ t: 122_900, p: 100 }, { t: 123_500, p: 99 }, { t: 124_200, p: 102 }, { t: 125_100, p: 103 }],
  }]);
  const synced = frame(reconnected, 'snapshot', 'quotes');
  reconnected.send(JSON.stringify({ op: 'resync', channel: 'quotes' }));
  assert.deepEqual((await synced).replay, restarted.replay);
  project.markets[0].symbol = 'BUSDT';
  const changed = frame(reconnected, 'snapshot', 'quotes');
  reconnected.send(JSON.stringify({ op: 'resync', channel: 'quotes' }));
  assert.deepEqual((await changed).replay, [{ projectId: 'p', marketKey: 'binance:perpetual:BUSDT', points: [] }]);
  assert.equal(stops, 1);
  await disconnect(reconnected);
  t.mock.timers.tick(59_999);
  assert.equal(stops, 1);
  t.mock.timers.tick(1);
  assert.equal(stops, 2);
});
