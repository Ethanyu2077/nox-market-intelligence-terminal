import assert from 'node:assert/strict';
import test from 'node:test';
import { getInstruments, marketSeries, overview, type AsterTransport } from '../server/aster.ts';

const symbol = {
  symbol: 'BTCUSDT', pair: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING',
  baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT',
  filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001' }],
};

const routes: Record<string, unknown> = {
  '/fapi/v1/exchangeInfo': { symbols: [symbol, { ...symbol, symbol: 'USD1USDT', quoteAsset: 'USD1' }, { ...symbol, symbol: 'OLDUSDT', status: 'SETTLING' }] },
  '/fapi/v1/ticker/24hr?symbol=BTCUSDT': { symbol: 'BTCUSDT', lastPrice: '76164.5', priceChangePercent: '0.100', volume: '4650.832', quoteVolume: '352329814.04', closeTime: 1_794_042_920_700 },
  '/fapi/v1/premiumIndex?symbol=BTCUSDT': { symbol: 'BTCUSDT', markPrice: '76164.50000000', lastFundingRate: '0.00003070', nextFundingTime: 1_794_067_200_000, time: 1_794_042_934_000 },
  '/fapi/v1/openInterest?symbol=BTCUSDT': { symbol: 'BTCUSDT', openInterest: '6325.243', time: 1_794_042_631_454 },
  '/fapi/v1/ticker/bookTicker?symbol=BTCUSDT': { symbol: 'BTCUSDT', bidPrice: '76124.5', askPrice: '76124.6' },
  '/fapi/v1/aggTrades?symbol=BTCUSDT&limit=1000': [
    { a: 1, p: '76164.5', q: '0.031', T: 1_794_042_920_700, m: false },
    { a: 2, p: '76164.5', q: '0.010', T: 1_794_042_926_000, m: true },
  ],
  '/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=2': [
    [1_794_042_600_000, '76120.8', '76164.6', '76113.0', '76164.5', '0.973', 1_794_042_899_999, '74083.77'],
    [1_794_042_900_000, '76164.6', '76164.6', '76164.5', '76164.5', '0.094', 1_794_043_199_999, '7159.46'],
  ],
};

const transport: AsterTransport = async (url) => {
  const path = new URL(url).pathname + (new URL(url).search || '');
  const body = routes[path];
  if (body == null) return new Response(JSON.stringify({ code: 'NOT_FOUND', msg: path }), { status: 404 });
  return new Response(JSON.stringify(body), { status: 200 });
};

test('Aster instruments keep only trading USDT perpetuals', async () => {
  const rows = await getInstruments(transport);
  assert.deepEqual(rows.map((row) => row.nativeSymbol), ['BTCUSDT']);
  assert.equal(rows[0].id, 'aster:perpetual:BTCUSDT');
  assert.equal(rows[0].venue, 'aster');
  assert.equal(rows[0].tickSize, 0.1);
  assert.equal(rows[0].stepSize, 0.001);
});

test('Aster overview maps price, mark, funding, OI and top of book', async () => {
  const row = await overview('BTCUSDT', transport);
  assert.equal(row.price, 76164.5);
  assert.equal(row.markPrice, 76164.5);
  assert.equal(row.oiBase, 6325.243);
  assert.ok(row.oiUsd != null && row.oiUsd > 0);
  assert.equal(row.fundingRate, 0.0000307);
  assert.equal(row.nextFundingTime, 1_794_067_200_000);
  assert.equal(row.bid, 76124.5);
  assert.equal(row.ask, 76124.6);
  assert.equal(row.quality, 'live');
  assert.equal(row.cvdWindowDelta, 0.031 * 76164.5 - 0.01 * 76164.5);
});

test('Aster series returns candles and flow but never invents OI history', async () => {
  const series = await marketSeries('BTCUSDT', '5m', 2, transport);
  assert.equal(series.candles.length, 2);
  assert.deepEqual(series.oiBase, []);
  assert.deepEqual(series.oiUsd, []);
  assert.ok(series.cvd.length >= 1);
  assert.equal(series.coverage.tradeCount, 2);
  assert.match(series.coverage.oiSource, /no openInterestHist/);
  assert.equal(series.positionFlow.signals.length, 0, 'OI-dependent labels must be withheld');
  assert.match(series.source, /Aster/);
});

test('Aster upstream failures surface as explicit errors', async () => {
  await assert.rejects(() => overview('NOPE', transport), /Aster 404/);
});
