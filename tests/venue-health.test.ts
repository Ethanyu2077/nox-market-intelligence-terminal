import assert from 'node:assert/strict';
import test from 'node:test';
import { VenueBreakers } from '../server/venue-health.ts';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test('breaker opens after three consecutive failures and blocks the venue', () => {
  const time = clock();
  const breakers = new VenueBreakers(time.now);
  assert.equal(breakers.allow('binance'), true);
  breakers.failure('binance', 'HTTP 429');
  breakers.failure('binance', 'HTTP 429');
  assert.equal(breakers.state('binance'), 'closed');
  breakers.failure('binance', 'HTTP 429');
  assert.equal(breakers.state('binance'), 'open');
  assert.equal(breakers.allow('binance'), false);
});

test('breaker half-opens after the cooldown, allows one probe, and closes on success', () => {
  const time = clock();
  const breakers = new VenueBreakers(time.now);
  for (let i = 0; i < 3; i += 1) breakers.failure('bybit', 'down');
  time.advance(60_000);
  assert.equal(breakers.state('bybit'), 'half-open');
  assert.equal(breakers.allow('bybit'), true, 'one probe is allowed');
  assert.equal(breakers.allow('bybit'), false, 'a second concurrent probe is not');
  breakers.success('bybit');
  assert.equal(breakers.state('bybit'), 'closed');
  assert.equal(breakers.allow('bybit'), true);
});

test('cooldown grows after a failed probe, capped', () => {
  const time = clock();
  const breakers = new VenueBreakers(time.now);
  for (let round = 0; round < 4; round += 1) {
    for (let i = 0; i < 3; i += 1) breakers.failure('okx', 'down');
    time.advance(10 * 60_000);
    breakers.allow('okx');
    breakers.failure('okx', 'still down');
    breakers.failure('okx', 'still down');
    breakers.failure('okx', 'still down');
  }
  const row = breakers.snapshot().find((item) => item.exchange === 'okx');
  assert.ok(row);
  assert.ok(row!.cooldownMs <= 10 * 60_000);
  assert.equal(row!.state, 'open');
  assert.ok((row!.failures ?? 0) >= 12);
});

test('a success resets the failure counter and snapshot exposes state', () => {
  const time = clock();
  const breakers = new VenueBreakers(time.now);
  breakers.failure('aster', 'timeout');
  breakers.failure('aster', 'timeout');
  breakers.success('aster');
  breakers.failure('aster', 'timeout');
  const row = breakers.snapshot().find((item) => item.exchange === 'aster')!;
  assert.equal(row.state, 'closed');
  assert.equal(row.consecutiveFailures, 1);
  assert.equal(row.successes, 1);
  assert.equal(row.lastError, 'timeout');
});
