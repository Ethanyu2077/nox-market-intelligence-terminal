import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { ConnectionState } from '../shared/watchlist.ts';
import { connectWatchLive, type WatchLiveFrame, type WatchLiveState } from '../src/watch-live-connection.ts';

type Command = { op: string; channel?: string; projects?: string[]; channels?: string[]; transient?: boolean };

function setup(t: TestContext, mode?: 'board') {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100_000 });
  const sockets: Socket[] = [];
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = Socket.CONNECTING;
    sent: Command[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;

    constructor(readonly url: string) { sockets.push(this); }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    close() {
      if (this.readyState === Socket.CLOSED) return;
      this.readyState = Socket.CLOSED;
      this.onclose?.();
    }
    send(raw: string) {
      assert.equal(this.readyState, Socket.OPEN);
      this.sent.push(JSON.parse(raw));
    }
    frame(channel: string, seq: number, type = 'tick', extra = {}) {
      const body = { type, channel, seq, asOf: Date.now(), ...extra };
      this.onmessage?.({ data: JSON.stringify(body) });
    }
  }

  const network = { onLine: true };
  const location = { protocol: 'https:', host: 'ans.y2k.ventures' };
  const document = Object.assign(new EventTarget(), { hidden: false, visibilityState: 'visible' });
  const window = Object.assign(new EventTarget(), {
    document, location, navigator: network, WebSocket: Socket, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const restoreGlobals: (() => void)[] = [];
  for (const [name, value] of Object.entries({ window, document, navigator: network, location, WebSocket: Socket })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restoreGlobals.push(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const frames: WatchLiveFrame[] = [], states: WatchLiveState[] = [], health: ConnectionState[] = [];
  const stop = connectWatchLive(['arb', 'wif'], frame => frames.push(frame), state => states.push(state), {mode,
    marketKeys: new Map([['arb','binance:perpetual:ARBUSDT'],['wif','binance:perpetual:WIFUSDT']]), onConnectionChange: state => health.push(state)});
  t.after(() => {
    try { stop(); } finally { for (const restore of restoreGlobals) restore(); }
  });
  const elapse = (seconds: number) => {
    for (let i = 0; i < seconds; i++) t.mock.timers.tick(1000);
  };
  const first = sockets[0];
  assert.equal(first.url, 'wss://ans.y2k.ventures/ws/live');
  first.open();
  return { first, sockets, frames, states, health, stop, elapse, document, window, network };
}

test('subscribes to watchlist channels and requests a replay on a sequence gap in that channel', t => {
  const { first, states, frames } = setup(t);
  assert.deepEqual(first.sent[0], { op: 'subscribe', projects: ['arb', 'wif'], channels: ['quotes', 'edge', 'flow'] });
  const replay = [{ projectId: 'arb', marketKey: 'binance:perpetual:ARBUSDT', points: [{ t: 99_000, p: 2 }] }];
  first.frame('quotes', 1, 'snapshot', { ticks: [], replay });
  first.frame('flow', 1, 'snapshot', { flows: [] });
  first.frame('flow', 3, 'tick', { flows: [] });
  assert.deepEqual(first.sent.slice(1), [{ op: 'resync', channel: 'flow' }]);
  first.frame('quotes', 3, 'tick', { ticks: [] });
  assert.deepEqual(first.sent.at(-1), { op: 'resync', channel: 'quotes' });
  first.frame('quotes', 4, 'snapshot', { replay, ticks: [] });
  assert.deepEqual(frames.at(-1)?.replay, replay);
  assert.equal(states.at(-1), 'live');
});

test('stale market prices on a healthy quotes channel do not trigger transport recovery', t => {
  const { first, sockets, states, elapse } = setup(t);
  const ticks = [{ projectId: 'arb', price: 1, priceAt: 1, stale: true }];
  first.frame('quotes', 1, 'snapshot', { ticks });
  for (let seq = 2; seq <= 22; seq++) {
    elapse(1);
    first.frame('quotes', seq, 'tick', { ticks });
  }
  assert.equal(sockets.length, 1);
  assert.equal(states.at(-1), 'live');
  assert.equal(first.sent.length, 1);
});

test('missing quote frames trigger resync then replacement even while flow frames still arrive', t => {
  const { first, sockets, states, elapse, frames } = setup(t);
  first.frame('quotes', 1, 'snapshot', { ticks: [] });
  const obsoleteMessage = first.onmessage;
  for (let second = 1; second <= 7; second++) {
    elapse(1);
    first.frame('flow', second, 'tick', { flows: [] });
  }
  assert.deepEqual(first.sent.filter(cmd => cmd.op === 'resync'), [{ op: 'resync', channel: 'quotes' }]);
  assert.equal(states.at(-1), 'syncing');
  elapse(8);
  assert.equal(first.readyState, 3);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].frame('quotes', 1, 'snapshot', { ticks: [] });
  const received = frames.length;
  obsoleteMessage?.({ data: JSON.stringify({ type: 'tick', channel: 'quotes', seq: 100, ticks: [] }) });
  assert.equal(frames.length, received);
  assert.equal(states.at(-1), 'live');
});

test('offline, online and foreground recovery preserve a single subscription and clean up timers', t => {
  const { first, sockets, states, elapse, document, window, network, stop } = setup(t);
  first.frame('quotes', 1, 'snapshot', { ticks: [] });
  network.onLine = false;
  window.dispatchEvent(new Event('offline'));
  elapse(20);
  assert.equal(states.at(-1), 'offline');
  assert.equal(sockets.length, 1);
  network.onLine = true;
  window.dispatchEvent(new Event('online'));
  elapse(1);
  assert.equal(sockets.length, 2);
  const second = sockets[1];
  second.open();
  second.frame('quotes', 1, 'snapshot', { ticks: [] });
  document.hidden = true;
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  elapse(3);
  document.hidden = false;
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(second.sent.at(-1), { op: 'resync', channel: 'quotes' });
  assert.equal(sockets.length, 2);
  stop();
  elapse(30);
  window.dispatchEvent(new Event('online'));
  document.dispatchEvent(new Event('visibilitychange'));
  elapse(30);
  assert.equal(sockets.length, 2);
});

test('a replay received during a silent connection recovers without a second socket', t => {
  const { first, sockets, states, frames, elapse } = setup(t);
  first.frame('quotes', 1, 'snapshot', { ticks: [] });
  elapse(7);
  assert.equal(states.at(-1), 'syncing');
  const replay = [{ projectId: 'wif', marketKey: 'binance:perpetual:WIFUSDT', points: [{ t: 102_300, p: 1 }] }];
  first.frame('quotes', 2, 'snapshot', { ticks: [], replay });
  for (let seq = 3; seq < 15; seq++) {
    elapse(1);
    first.frame('quotes', seq, 'tick', { ticks: [] });
  }
  assert.deepEqual(frames.find(frame => frame.replay)?.replay, replay);
  assert.equal(states.at(-1), 'live');
  assert.equal(sockets.length, 1);
  assert.equal(first.sent.filter(cmd => cmd.op === 'resync').length, 1);
});

test('consecutive sequence numbers can still hide a publisher pause; late frames do not rewind the live state', t => {
  const { first, frames, states } = setup(t);
  first.frame('quotes', 11, 'snapshot', { ticks: [], asOf: 87_000 });
  first.frame('quotes', 12, 'tick', { ticks: [], asOf: 99_000 });
  first.frame('quotes', 13, 'tick', { ticks: [], asOf: 100_000 });
  assert.deepEqual(first.sent.slice(1), [{ op: 'resync', channel: 'quotes' }]);
  assert.equal(states.at(-1), 'syncing');
  first.frame('quotes', 15, 'snapshot', { ticks: [], replay: [] });
  first.frame('quotes', 14, 'tick', { ticks: [] });
  assert.deepEqual(frames.map(frame => frame.seq), [11, 12, 13, 15]);
  assert.equal(states.at(-1), 'live');
});

test('repeated early closes back off and the next healthy quote restores the initial retry delay', t => {
  const { first, sockets, states, elapse } = setup(t);
  first.close();
  assert.equal(states.at(-1), 'reconnecting');
  elapse(1);
  assert.equal(sockets.length, 2);
  sockets[1].close();
  elapse(1);
  assert.equal(sockets.length, 2);
  elapse(1);
  assert.equal(sockets.length, 3);
  sockets[2].open();
  sockets[2].frame('quotes', 1, 'snapshot', { ticks: [] });
  sockets[2].close();
  elapse(1);
  assert.equal(sockets.length, 4);
});

test('the project board requests only transient quotes and ignores other channels', t => {
  const { first, frames } = setup(t, 'board');
  assert.deepEqual(first.sent, [{op: 'subscribe', projects: ['arb','wif'], channels: ['quotes'], transient: true}]);
  first.frame('flow', 1, 'snapshot', {flows: []});
  assert.equal(frames.length, 0);
  first.frame('quotes', 1, 'snapshot', {ticks: []});
  assert.equal(frames.length, 1);
});

test('socket heartbeats, cached replay, another market and expired observations cannot make the price board LIVE', t => {
  const {first, health, elapse, states, window, network} = setup(t, 'board');
  const at = Date.now();
  const arb = {projectId:'arb', marketKey:'binance:perpetual:ARBUSDT', price:1, priceAt:at, stale:false};
  const wif = {projectId:'wif', marketKey:'binance:perpetual:WIFUSDT', price:2, priceAt:at, stale:false};
  first.frame('quotes', 1, 'snapshot', {ticks: [], replay: [{projectId:'arb', points:[{t:at,p:1}]}]});
  assert.equal(states.at(-1),'live');
  assert.equal(health.at(-1),'stale');
  first.frame('quotes', 2, 'tick', {ticks:[{...arb,marketKey:'bybit:perpetual:ARBUSDT'}]});
  assert.equal(health.at(-1),'stale');
  first.frame('quotes', 3, 'tick', {ticks:[arb,{...wif,stale:true}]});
  assert.equal(health.at(-1),'degraded');
  first.frame('quotes', 4, 'tick', {ticks:[arb,wif]});
  assert.equal(health.at(-1),'live');
  elapse(4);
  first.frame('quotes', 5, 'tick', {ticks:[arb,wif]});
  elapse(2);
  assert.equal(health.at(-1),'stale');
  network.onLine=false;
  window.dispatchEvent(new Event('offline'));
  assert.equal(health.at(-1),'stale');
});
