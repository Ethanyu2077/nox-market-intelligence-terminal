import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBybitLiquidation, normalizeGateLiquidation, normalizeLiquidation, normalizeOkxLiquidation } from '../server/orderflow-adapters.ts';

test('Binance forceOrder keeps the order-side convention', () => {
  const event = normalizeLiquidation({ e: 'forceOrder', o: { s: 'BTCUSDT', S: 'SELL', ap: '60000', z: '0.5', T: 1_700_000_000_000 } }, 'BTCUSDT');
  assert.ok(event);
  assert.equal(event!.orderSide, 'sell');
  assert.equal(event!.liquidatedSide, 'long');
  assert.equal(event!.notional, 30_000);
  assert.equal(normalizeLiquidation({ e: 'forceOrder', o: { s: 'ETHUSDT', S: 'SELL', ap: '1', z: '1', T: 1_700_000_000_000 } }, 'BTCUSDT'), null);
});

test('Bybit allLiquidation is normalised and filtered by symbol', () => {
  const event = normalizeBybitLiquidation({ topic: 'allLiquidation.BTCUSDT', data: [{ T: 1_700_000_000_000, s: 'BTCUSDT', S: 'Buy', v: '0.5', p: '60000' }] }, 'BTCUSDT');
  assert.ok(event);
  assert.equal(event!.exchange, 'bybit');
  assert.equal(event!.orderSide, 'buy');
  assert.equal(event!.liquidatedSide, 'short');
  assert.equal(event!.quantity, 0.5);
  assert.equal(normalizeBybitLiquidation({ topic: 'allLiquidation.ETHUSDT', data: [{ T: 1, s: 'ETHUSDT', S: 'Buy', v: '1', p: '1' }] }, 'BTCUSDT'), null);
});

test('OKX liquidation-orders uses posSide and the contract multiplier', () => {
  const event = normalizeOkxLiquidation({
    arg: { channel: 'liquidation-orders', instType: 'SWAP' },
    data: [{ instId: 'BTC-USDT-SWAP', details: [{ side: 'sell', posSide: 'long', sz: '10', bkPx: '60000', ts: '1700000000000' }] }],
  }, 'BTC-USDT-SWAP', 0.01);
  assert.ok(event);
  assert.equal(event!.orderSide, 'sell');
  assert.equal(event!.liquidatedSide, 'long');
  assert.equal(event!.quantity, 0.1);
  assert.equal(event!.notional, 6_000);
});

test('Gate futures.liquidates converts seconds and signs the position size', () => {
  const event = normalizeGateLiquidation({
    channel: 'futures.liquidates', event: 'update',
    result: { contract: 'BTC_USDT', size: -20, liq_price: 60000, time: 1_700_000_000 },
  }, 'BTC_USDT', 0.0001);
  assert.ok(event);
  assert.equal(event!.orderSide, 'buy', 'a short position is closed by a buy');
  assert.equal(event!.liquidatedSide, 'short');
  assert.equal(event!.quantity, 0.002);
  assert.equal(event!.time, 1_700_000_000_000);
  assert.equal(normalizeGateLiquidation({ channel: 'futures.trades', event: 'update', result: {} }, 'BTC_USDT'), null);
});
