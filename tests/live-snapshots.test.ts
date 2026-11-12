import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { LiveSnapshots } from '../server/live-snapshots.ts';

class Viewer extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = false;
  frames: string[] = [];
  write(frame: string) { this.frames.push(frame); return true; }
  end() { this.writableEnded = true; this.emit('close'); }
}

test('two subscribers and HTTP reads share each server-sampled snapshot', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const cache = new LiveSnapshots<{ sequence: number }>('book', 250);
  t.after(() => cache.close());
  let opens = 0, samples = 0, releases = 0;
  const create = () => {
    opens += 1;
    return { sample: () => ({ sequence: ++samples }), release: () => { releases += 1; } };
  };
  const first = new Viewer();
  const second = new Viewer();
  cache.subscribe('market', create, first);
  t.mock.timers.tick(125);
  cache.subscribe('market', create, second);
  assert.equal(opens, 1);
  assert.deepEqual(first.frames, second.frames);

  t.mock.timers.tick(125);
  assert.deepEqual(first.frames, second.frames);
  assert.equal(samples, 2);
  assert.deepEqual(cache.read('market', create), { sequence: 2 });

  second.writableNeedDrain = true;
  t.mock.timers.tick(250);
  assert.equal(second.frames.length, 2);
  second.writableNeedDrain = false;
  t.mock.timers.tick(250);
  assert.equal(second.frames.at(-1), first.frames.at(-1));

  first.end();
  second.end();
  t.mock.timers.tick(10_000);
  assert.equal(releases, 1);
});

test('WebSocket and SSE consumers share the same depth sample and release on the last unsubscribe', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const cache = new LiveSnapshots<number>('book', 250, value => ({ sequence: value }));
  t.after(() => cache.close());
  let samples = 0, releases = 0;
  const create = () => ({ sample: () => ++samples, release: () => { releases++; } });
  const received: unknown[] = [], legacy = new Viewer();
  const stop = cache.listen('market', create, value => received.push(value), () => assert.fail('unexpected close'));
  cache.subscribe('market', create, legacy);
  t.mock.timers.tick(250);
  assert.deepEqual(received, [{ sequence: 1 }, { sequence: 2 }]);
  assert.match(legacy.frames[1], /"sequence":2/);
  legacy.end();
  assert.equal(releases, 0);
  stop();
  stop();
  t.mock.timers.tick(250);
  assert.equal(samples, 2);
  assert.equal(releases, 1);
});

test('stopped monitoring terminates WebSocket snapshot listeners without sending stale data', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cache = new LiveSnapshots<number>('orderflow', 1000);
  let paused = false, ended = 0, released = 0;
  const values: unknown[] = [];
  const stop = cache.listen('project', () => ({ sample: () => paused ? null : 1, release: () => { released++; } }),
    value => values.push(value), () => { ended++; });
  paused = true;
  t.mock.timers.tick(1000);
  stop();
  assert.deepEqual(values, [1]);
  assert.equal(ended, 1);
  assert.equal(released, 1);
});
