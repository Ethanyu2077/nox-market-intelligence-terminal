import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectMarket } from '../shared/types.ts';
import { resolveTradingViewSymbol, toTradingViewInterval } from '../shared/tradingview.ts';

const perpetual: ProjectMarket = { id: 'binance-perp-JCTUSDT', exchange: 'binance', marketType: 'perpetual', symbol: 'JCTUSDT', base: 'JCT', quote: 'USDT', status: 'TRADING' };

test('TradingView resolver maps Binance perpetuals without hardcoded project symbols', () => {
  assert.deepEqual(resolveTradingViewSymbol(perpetual), { available: true, symbol: 'BINANCE:JCTUSDT.P', exchange: 'BINANCE', marketType: 'perpetual', reason: null });
  assert.equal(resolveTradingViewSymbol({ ...perpetual, marketType: 'spot' }).symbol, 'BINANCE:JCTUSDT');
});

test('TradingView interval mapping preserves NOX workspace timeframes', () => {
  assert.deepEqual(['1m', '5m', '15m', '1h', '4h'].map((value) => toTradingViewInterval(value as '1m' | '5m' | '15m' | '1h' | '4h')), ['1', '5', '15', '60', '240']);
});
