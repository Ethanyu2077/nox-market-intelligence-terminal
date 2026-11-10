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
