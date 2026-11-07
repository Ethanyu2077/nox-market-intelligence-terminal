import assert from 'node:assert/strict';
import test from 'node:test';
import { isCcxtVenue, resolveCcxtConfig } from '../server/ccxt/config.ts';
import { ccxtInstruments, ccxtSnapshot, normalizeCcxtSnapshot, normalizeOpenInterest, resolveCcxtMarket, toInstrument } from '../server/ccxt/adapter.ts';
import type { CcxtExchangeLike, CcxtMarket } from '../server/ccxt/types.ts';
import type { ProjectMarket } from '../shared/types.ts';

const market: ProjectMarket = {
  id: 'htx:perpetual:DOODUSDT',
  exchange: 'htx',
  marketType: 'perpetual',
  symbol: 'DOODUSDT',
  base: 'DOOD',
  quote: 'USDT',
  status: 'trading',
};

const swap: CcxtMarket = { id: 'DOODUSDT', symbol: 'DOOD/USDT:USDT', swap: true, base: 'DOOD', quote: 'USDT', settle: 'USDT', active: true, contractSize: 10 };
const spot: CcxtMarket = { id: 'DOODUSDT', symbol: 'DOOD/USDT', spot: true, base: 'DOOD', quote: 'USDT', active: true };

function fakeExchange(overrides: Partial<CcxtExchangeLike> = {}): CcxtExchangeLike {
  return {
    id: 'htx',
    version: '4.5.92',
    markets: { 'DOOD/USDT:USDT': swap, 'DOOD/USDT': spot },
    markets_by_id: { DOODUSDT: [swap, spot] },
    loadMarkets: async () => ({ 'DOOD/USDT:USDT': swap }),
    fetchTicker: async () => ({
      symbol: 'DOOD/USDT:USDT', timestamp: 1_700_000_000_000, last: 0.0017, markPrice: 0.00171,
      percentage: -1.2, baseVolume: 1_000_000, quoteVolume: 1_700, bid: 0.00169, ask: 0.00171,
    }),
    fetchOpenInterest: async () => ({ openInterestAmount: 500_000, timestamp: 1_700_000_000_000 }),
    fetchFundingRate: async () => ({ fundingRate: 0.0001, nextFundingTimestamp: 1_700_028_800_000 }),
    ...overrides,
  };
}

test('CCXT config parses venues, ignores unknown names and honours the disable switch', () => {
  const config = resolveCcxtConfig({ NOX_CCXT_VENUES: 'htx, bingx, not-a-venue', NOX_CCXT_TIMEOUT_MS: '999999' } as NodeJS.ProcessEnv);
  assert.deepEqual(config.venues, ['htx', 'bingx']);
  assert.deepEqual(config.ignored, ['not-a-venue']);
  assert.equal(config.fallback, true);
  assert.equal(config.timeoutMs, 60_000);
  const disabled = resolveCcxtConfig({ NOX_CCXT_ENABLED: 'false', NOX_CCXT_VENUES: 'htx' } as NodeJS.ProcessEnv);
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.venues, []);
  assert.equal(isCcxtVenue('htx', disabled), false);
  assert.equal(isCcxtVenue('binance', config), false);
});

test('market resolution prefers the requested market type', () => {
  const exchange = fakeExchange();
  assert.equal(resolveCcxtMarket(exchange, market)?.symbol, 'DOOD/USDT:USDT');
  assert.equal(resolveCcxtMarket(exchange, { ...market, marketType: 'spot' })?.symbol, 'DOOD/USDT');
  assert.equal(resolveCcxtMarket(fakeExchange({ markets_by_id: {}, markets: {} }), market), null);
});

test('instrument mapping keeps only active USDT perpetuals', () => {
  assert.equal(toInstrument('htx', swap)?.id, 'htx:perpetual:DOODUSDT');
  assert.equal(toInstrument('htx', swap)?.contractMultiplier, 10);
  assert.equal(toInstrument('htx', spot), null);
  assert.equal(toInstrument('htx', { ...swap, active: false }), null);
  assert.equal(toInstrument('htx', { ...swap, inverse: true }), null);
  assert.equal(toInstrument('htx', { ...swap, quote: 'USD' }), null);
});

test('open interest prefers venue USD value and normalises contract size', () => {
  assert.deepEqual(normalizeOpenInterest(100, null, 5, 2), { oiBase: 500, oiUsd: 1000 });
  assert.deepEqual(normalizeOpenInterest(100, 777, 5, 2), { oiBase: 500, oiUsd: 777 });
  assert.deepEqual(normalizeOpenInterest(null, null, null, 2), { oiBase: null, oiUsd: null });
});

test('snapshot normalisation keeps every missing metric null and marks the row partial', () => {
  const now = Date.now();
  const snapshot = normalizeCcxtSnapshot('htx', market,
    { timestamp: 1_700_000_000_000, last: 0.0017, markPrice: 0.00171, percentage: -1.2, baseVolume: 1_000_000, bid: 0.00169, ask: 0.00171 },
    { openInterestAmount: 100, openInterestValue: 1_710_000 }, { fundingRate: 0.0002, nextFundingTimestamp: 1_700_028_800_000 },
    now, { version: '4.5.92', contractSize: 10 });
  assert.equal(snapshot.quality, 'partial');
  assert.equal(snapshot.price, 0.0017);
  assert.equal(snapshot.volume24hUsd, 1700); // derived from base × last
  assert.match(snapshot.source, /CCXT htx v4\.5\.92/);
  assert.equal(snapshot.oiBase, 1000);
  assert.equal(snapshot.oiUsd, 1_710_000);
  assert.equal(snapshot.cvd, null);
  assert.ok(snapshot.unavailable.includes('cvd'));
  assert.ok(snapshot.unavailable.includes('takerBuyVolumeUsd'));
  assert.equal(snapshot.spreadBps != null && snapshot.spreadBps > 0, true);
});

test('snapshot normalisation reports unavailable when no price exists', () => {
  const snapshot = normalizeCcxtSnapshot('htx', market, {}, null, null, Date.now());
  assert.equal(snapshot.quality, 'unavailable');
  assert.equal(snapshot.price, null);
  assert.equal(snapshot.oiUsd, null);
  assert.ok(snapshot.unavailable.includes('fundingRate'));
});

test('ccxtSnapshot fetches ticker, OI and funding and labels the source', async () => {
  const config = resolveCcxtConfig({ NOX_CCXT_VENUES: 'htx' } as NodeJS.ProcessEnv);
  const snapshot = await ccxtSnapshot(market, config, fakeExchange());
  assert.equal(snapshot.exchange, 'htx');
  assert.equal(snapshot.symbol, 'DOODUSDT');
  assert.equal(snapshot.price, 0.0017);
  assert.equal(snapshot.markPrice, 0.00171);
  assert.equal(snapshot.fundingRate, 0.0001);
  assert.equal(snapshot.nextFundingTime, 1_700_028_800_000);
  assert.equal(snapshot.oiBase, 5_000_000); // 500k contracts × contractSize 10
  assert.match(snapshot.source, /CCXT htx/);
});

test('ccxtSnapshot fails explicitly when the venue has no matching market', async () => {
  const config = resolveCcxtConfig({ NOX_CCXT_VENUES: 'htx' } as NodeJS.ProcessEnv);
  await assert.rejects(() => ccxtSnapshot(market, config, fakeExchange({ markets: {}, markets_by_id: {} })), /no perpetual market/);
});

test('catalogue mapping returns sorted USDT perpetual instruments only', async () => {
  const config = resolveCcxtConfig({ NOX_CCXT_VENUES: 'htx' } as NodeJS.ProcessEnv);
  const rows = await ccxtInstruments('htx', config, { ...fakeExchange(), loadMarkets: async () => ({ a: { ...swap, id: 'A', symbol: 'A/USDT:USDT' }, b: { ...swap, id: 'B', symbol: 'B/USDT:USDT' }, s: spot }) });
  assert.deepEqual(rows.map((row) => row.nativeSymbol), ['A', 'B']);
});

test('a CCXT venue with CCXT disabled fails explicitly instead of falling through to another exchange', async () => {
  // The module-level CCXT config is resolved without NOX_CCXT_VENUES in this process, so
  // the CCXT branch is inactive and the native router must reject the venue before any
  // other venue's endpoint is called.
  const { marketSnapshot } = await import('../server/exchanges.ts');
  await assert.rejects(() => marketSnapshot(market), /no native snapshot adapter|CCXT/);
});

test('active venues exclude disabled CCXT exchanges and keep the native nine', async () => {
  const { activeExchangeIds } = await import('../server/exchanges.ts');
  const ids = activeExchangeIds();
  for (const native of ['binance', 'bybit', 'okx', 'upbit', 'bithumb']) assert.ok(ids.includes(native as never), `${native} must stay active`);
  for (const ccxtOnly of ['htx', 'bingx', 'phemex', 'bitfinex']) {
    if (process.env.NOX_CCXT_VENUES?.includes(ccxtOnly)) continue;
    assert.equal(ids.includes(ccxtOnly as never), false, `${ccxtOnly} must be inert unless enabled`);
  }
});
