import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeLiveChannel } from '../src/live-channel.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createLiveHub } from '../server/live-hub.ts';
import type { LiveSource } from '../shared/live-channel.ts';

test('browser subscriptions share one WS, reconnect on dropped transport, and release when hidden', {timeout:8000}, async t => {
  const server = createServer();
  const physical: import('node:net').Socket[] = [];
  server.on('upgrade', (_request, socket) => physical.push(socket as import('node:net').Socket));
  let started = 0, stopped = 0;
  const source: LiveSource = (_params, emit) => { emit(++started); return () => { stopped++; }; };
  const closeHub = createLiveHub(server, () => [], {streams:{market:source,book:source}});
  server.listen(0, '127.0.0.1'); await once(server,'listening');
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const document = Object.assign(new EventTarget(), {hidden:false});
  const window = Object.assign(new EventTarget(), {location:{host:'127.0.0.1:' + addr.port,protocol:'http:'}, setTimeout, clearTimeout, setInterval, clearInterval});
  for (const [name,value] of Object.entries({WebSocket,window,document,navigator:{onLine:true}})) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable:true, value});
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  let closeMarket = () => {}, closeBook = () => {};
  const signal = new EventTarget();
  const seen: number[] = [];
  const ingest = (v: number) => {seen.push(v); signal.dispatchEvent(new Event('data'));};
  const waitFor = async (condition: () => boolean) => {
    while (!condition()) await new Promise<void>(resolve => signal.addEventListener('data', () => resolve(), {once:true}));
  };
  try {
    closeMarket = subscribeLiveChannel('market',{},ingest);
    closeBook = subscribeLiveChannel('book',{},ingest);
    await waitFor(() => seen.length === 2);
    assert.equal(physical.length,1);
    physical[0].destroy();
    await waitFor(() => seen.length === 4);
    assert.equal(physical.length,2);
    assert.equal(stopped,2);
    closeMarket();
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    await once(physical[1], 'close');
    assert.equal(stopped,4);
    document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => seen.length === 5);
    assert.equal(physical.length,3);
    assert.equal(started,5);
  } finally {
    closeMarket(); closeBook(); closeHub(); server.close();
  }
});
