import assert from 'node:assert/strict';
import test from 'node:test';
import { BinanceCooldownError, createBinanceGovernor, familyOf } from '../server/binance-governor.ts';

const ok = (body: unknown = { ok: true }) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body }) as Response;
const rate = (status: number, retryAfter?: string) => ({ ok: false, status, headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}), json: async () => ({}) }) as Response;

test('family detection covers the hot Binance endpoints', () => {
  assert.equal(familyOf('https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT'), 'aggTrades');
  assert.equal(familyOf('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT'), 'kline');
  assert.equal(familyOf('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT'), 'depth');
  assert.equal(familyOf('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'), 'premiumIndex');
});

test('418 opens a cooldown and blocks further requests until Retry-After', async () => {
  let now = 1_000_000;
  let calls = 0;
  const governor = createBinanceGovernor({ now: () => now, fetchImpl: async () => { calls += 1; return rate(418, '120'); } });
  await assert.rejects(() => governor.json('https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT'), (error: unknown) => error instanceof BinanceCooldownError);
  assert.equal(calls, 1);
  await assert.rejects(() => governor.json('https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT'), (error: unknown) => error instanceof BinanceCooldownError);
  assert.equal(calls, 1, 'no request during cooldown');
  now += 121_000;
  const success = createBinanceGovernor({ now: () => now, fetchImpl: async () => { calls += 1; return ok({ pong: true }); } });
  assert.deepEqual(await success.json('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'), { pong: true });
});

test('429 without Retry-After uses conservative backoff', async () => {
  const now = 2_000_000;
  const governor = createBinanceGovernor({ now: () => now, fetchImpl: async () => rate(429) });
  await assert.rejects(() => governor.json('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT'));
  const status = governor.status();
  assert.ok(status.bannedUntil && status.bannedUntil > now);
  assert.match(status.banReason ?? '', /429/);
});

test('concurrent identical requests share one fetch', async () => {
  let calls = 0;
  let release: (value: Response) => void = () => undefined;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  const governor = createBinanceGovernor({ fetchImpl: async () => { calls += 1; return pending; } });
  const first = governor.json('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
  const second = governor.json('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
  release(ok({ markPrice: '1' }));
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, { markPrice: '1' });
  assert.deepEqual(b, { markPrice: '1' });
  assert.equal(calls, 1);
});

test('cache suppresses repeated reads within its window', async () => {
  let calls = 0; let now = 3_000_000;
  const governor = createBinanceGovernor({ now: () => now, fetchImpl: async () => { calls += 1; return ok({ symbol: 'BTCUSDT' }); } });
  await governor.json('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', { cacheMs: 1_000 });
  now += 500;
  await governor.json('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', { cacheMs: 1_000 });
  assert.equal(calls, 1);
  now += 1_000;
  await governor.json('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', { cacheMs: 1_000 });
  assert.equal(calls, 2);
});
