import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProviderChecks } from '../server/provider-crosscheck.ts';

const native = [
  { exchange: 'binance', symbol: 'BTCUSDT', oiUsd: 1000, fundingRate: 0.0001, source: 'Binance futures' },
  { exchange: 'bybit', symbol: 'BTCUSDT', oiUsd: 500, fundingRate: 0.0002, source: 'Bybit v5' },
];

test('agree, diverge, native-only and coinglass-only are distinguished', () => {
  const checks = buildProviderChecks('p1', native,
    [{ exchange: 'Binance', oiUsd: 1010 }, { exchange: 'OKX', oiUsd: 300 }],
    [{ exchange: 'binance', rateRaw: 0.0001 }, { exchange: 'bybit', rateRaw: 0.0006 }]);
  const binanceOi = checks.find((check) => check.exchange === 'binance' && check.field === 'oiUsd')!;
  assert.equal(binanceOi.status, 'agree');
  assert.equal(binanceOi.nativeSource, 'Binance futures');
  assert.equal(binanceOi.coinGlassSource, 'coinglass');
  const okx = checks.find((check) => check.exchange === 'okx' && check.field === 'oiUsd')!;
  assert.equal(okx.status, 'coinglass-only');
  assert.equal(okx.native, null);
  const bybitFunding = checks.find((check) => check.exchange === 'bybit' && check.field === 'fundingRate')!;
  assert.equal(bybitFunding.status, 'diverge');
  const nativeOnly = checks.find((check) => check.exchange === 'bybit' && check.field === 'oiUsd')!;
  assert.equal(nativeOnly.status, 'native-only');
});

test('missing values are never coerced to zero', () => {
  const checks = buildProviderChecks('p1', [{ exchange: 'gate', symbol: 'X', oiUsd: null, fundingRate: null }], null, null);
  assert.ok(checks.every((check) => check.status === 'unavailable'));
  assert.ok(checks.every((check) => check.native === null && check.coinGlass === null));
});
