import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityRegistry } from '../server/capability-registry.ts';
import { exchangeCapabilities } from '../server/exchanges.ts';
import { DATA_FAMILIES } from '../shared/capabilities.ts';
import { isSeriesStale } from '../server/calculations.ts';

const registry = capabilityRegistry(1_700_000_000_000, {} as NodeJS.ProcessEnv);

test('every enabled venue exposes exactly one row per data family', () => {
  const enabled = exchangeCapabilities().filter((row) => row.enabled).map((row) => row.exchange);
  assert.equal(registry.rows.length, enabled.length * DATA_FAMILIES.length);
  for (const venue of enabled) {
    for (const family of DATA_FAMILIES) {
      assert.ok(registry.rows.some((row) => row.venue === venue && row.family === family), `${venue}/${family} missing`);
    }
  }
});

test('depth is only claimed for binance and aster', () => {
  const depth = registry.rows.filter((row) => row.family === 'depth' && row.supported).map((row) => row.venue).sort();
  assert.deepEqual(depth, ['aster', 'binance']);
});

test('liquidation is only claimed for binance, bybit and okx', () => {
  const liquidation = registry.rows.filter((row) => row.family === 'liquidation' && row.supported).map((row) => row.venue).sort();
  assert.deepEqual(liquidation, ['binance', 'bybit', 'okx']);
});

test('aggressor flow is withheld for mexc and aster', () => {
  const flow = registry.rows.filter((row) => row.family === 'flow');
  for (const venue of ['mexc', 'aster'] as const) {
    assert.equal(flow.find((row) => row.venue === venue)?.supported, false, `${venue} must not claim flow`);
    assert.equal(flow.find((row) => row.venue === venue)?.coverage.state, 'unavailable');
  }
});

test('unsupported families report an explicit reason, not a zero', () => {
  for (const row of registry.rows.filter((item) => !item.supported)) {
    assert.equal(row.coverage.state, 'unavailable');
    assert.ok(row.coverage.lastError);
  }
});

test('stale series are detected per interval with a 15 minute floor', () => {
  const now = 1_700_000_000_000;
  assert.equal(isSeriesStale(now - 14 * 60_000, '5m', now), false);
  assert.equal(isSeriesStale(now - 16 * 60_000, '5m', now), true);
  assert.equal(isSeriesStale(now - 20 * 60_000, '4h', now), false, '4h allows 12h');
  assert.equal(isSeriesStale(null, '5m', now), true);
});
