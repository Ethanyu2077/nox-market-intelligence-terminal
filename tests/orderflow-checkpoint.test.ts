import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FlowTrade, LiquidationEvent } from '../shared/orderflow.ts';
import { OrderFlowCheckpoint } from '../server/orderflow-checkpoint.ts';

const trade = (n: number): FlowTrade => ({ id: String(n), exchange: 'binance', marketType: 'spot', symbol: 'TESTUSDT',
  price: 2, quantity: 10, notional: 20, side: 'buy', time: n, source: 'rest' });
const liquidation: LiquidationEvent = { id: 'liq', exchange: 'binance', symbol: 'TESTUSDT', time: 15,
  price: 3, quantity: 10, notional: 30, orderSide: 'sell', liquidatedSide: 'long' };

test('repeated checkpoints of an unchanged tape do not allocate deltas or replace its base', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-idle-checkpoint-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'market.json');
  const writer = new OrderFlowCheckpoint(file);
  const feed = { trades: [trade(1)], coverageFrom: 1, coverageTo: 1, gaps: [], liquidations: [] };
  await writer.save(feed);
  const base = await stat(file);
  for (let i = 0; i < 50; i++) await writer.save(feed);
  assert.deepEqual(await readdir(dir), ['market.json']);
  assert.equal((await stat(file)).ino, base.ino);
  assert.deepEqual(await new OrderFlowCheckpoint(file).load(), feed);
});

test('reads legacy order flow, checkpoints active tape incrementally and retries an interrupted delta', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-flow-checkpoint-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'market.json'), deltas = `${file}.d`;
  const writer = new OrderFlowCheckpoint(file);
  const trades = Array.from({ length: 10_000 }, (_, i) => trade(i));
  const legacy = { trades, gaps: [], coverageFrom: 1, coverageTo: 9999 };
  await writeFile(file, JSON.stringify(legacy));
  const first = await writer.load();
  assert.deepEqual(first, { ...legacy, liquidations: [] });
  await writer.save(first);
  const base = await stat(file);

  // Drop two expired prints, recover one in the middle of the recent tail, append a new one.
  const next = { trades: [...first.trades.slice(2, -1), trade(9998.5), first.trades.at(-1)!, trade(10000)],
    coverageFrom: 3, coverageTo: 10000, gaps: [{ from: 10, to: 20, reason: 'gap' }], liquidations: [liquidation] };
  await writer.save(next);
  const [segment] = await readdir(deltas);
  assert.ok((await stat(path.join(deltas, segment))).size < base.size / 100);
  assert.equal((await stat(file)).ino, base.ino);
  assert.deepEqual(await new OrderFlowCheckpoint(file).load(), next);

  // Simulate both an interrupted temp file and a failed write. Neither advances the committed sequence.
  const second = segment.replace('.01.json', '.02.json');
  await writeFile(path.join(deltas, `${second}.tmp`), '{');
  assert.deepEqual(await new OrderFlowCheckpoint(file).load(), next);
  await rm(path.join(deltas, `${second}.tmp`));
  await mkdir(path.join(deltas, `${second}.tmp`));
  const recovered = { ...next, trades: next.trades.slice(1), gaps: [], liquidations: [], coverageFrom: 4 };
  await assert.rejects(writer.save(recovered));
  assert.deepEqual(await new OrderFlowCheckpoint(file).load(), next);
  await rm(path.join(deltas, `${second}.tmp`), { recursive: true });
  // A failed rename also removes the fully written temp so a disk-full retry can reclaim its space.
  await mkdir(path.join(deltas, second));
  await assert.rejects(writer.save(recovered));
  await assert.rejects(stat(path.join(deltas, `${second}.tmp`)), { code: 'ENOENT' });
  await rm(path.join(deltas, second), { recursive: true });
  assert.deepEqual(await new OrderFlowCheckpoint(file).load(), next);
  await writer.save(recovered);
  assert.deepEqual(await new OrderFlowCheckpoint(file).load(), recovered);
});

test('compacts bounded deltas and ignores an old generation after an interrupted cleanup', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-flow-compact-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'market.json'), deltas = `${file}.d`;
  const writer = new OrderFlowCheckpoint(file);
  const feed = { trades: [trade(1)], coverageFrom: 1, coverageTo: 1, gaps: [], liquidations: [] };
  await writer.save(feed);
  feed.trades.push(trade(2));
  await writer.save(feed);
  const [oldName] = await readdir(deltas), oldData = await readFile(path.join(deltas, oldName));
  for (let n = 3; n <= 100; n++) {
    feed.trades.push(trade(n));
    feed.coverageTo = n;
    await writer.save(feed);
  }
  assert.ok((await readdir(deltas)).length <= 40);
  await writeFile(path.join(deltas, oldName), oldData);
  const restarted = new OrderFlowCheckpoint(file);
  assert.deepEqual(await restarted.load(), feed);
  assert.ok(!(await readdir(deltas)).includes(oldName));
});
