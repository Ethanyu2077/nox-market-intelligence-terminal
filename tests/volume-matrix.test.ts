import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVolumeMatrix, krwLegFromSnapshot, normalizeSpotVolume, perpLegFromSnapshot, spotVolumeUrl } from '../server/volume-matrix.ts';
import type { ExchangeId, MarketProject, ProjectMarket, VenueMarketSnapshot } from '../shared/types.ts';
import type { VenueVolumeLeg } from '../shared/volume.ts';

const NOW = Date.now();

const market = (exchange: ExchangeId, marketType: 'spot' | 'perpetual', symbol: string, quote = 'USDT'): ProjectMarket => ({
  id: `${exchange}:${marketType}:${symbol}`, exchange, marketType, symbol, base: 'ARB', quote, status: marketType === 'spot' ? 'TRADING' : 'Open',
});

const leg = (exchange: ExchangeId, marketType: 'spot' | 'perpetual', usd: number | null, extra: Partial<VenueVolumeLeg> = {}): VenueVolumeLeg => ({
  exchange, marketType, symbols: [`${exchange}-${marketType}`], quote: 'USDT', price: 1, volume24hBase: usd, volume24hQuote: usd, volume24hUsd: usd,
  eventTime: NOW, fetchedAt: NOW, quality: 'live', source: 'fixture', unavailable: [], ...extra,
});

test('spot turnover normalizers use the verified venue field semantics', () => {
  const binance = normalizeSpotVolume('binance', market('binance', 'spot', 'ARBUSDT'), { symbol: 'ARBUSDT', lastPrice: '0.1667', volume: '58959329.8', quoteVolume: '9889597.26', closeTime: NOW });
  assert.equal(binance.volume24hBase, 58_959_329.8);
  assert.equal(binance.volume24hUsd, 9_889_597.26);
  assert.equal(binance.quality, 'live');

  const bybit = normalizeSpotVolume('bybit', market('bybit', 'spot', 'ARBUSDT'), { result: { list: [{ symbol: 'ARBUSDT', lastPrice: '0.16663', volume24h: '10613660.56', turnover24h: '1776690.46' }] }, time: NOW });
  assert.equal(bybit.volume24hBase, 10_613_660.56);
  assert.equal(bybit.volume24hUsd, 1_776_690.46);

  // OKX SPOT is the inverse of OKX SWAP: vol24h is base, volCcy24h is quote.
  const okx = normalizeSpotVolume('okx', market('okx', 'spot', 'ARB-USDT'), { data: [{ instId: 'ARB-USDT', last: '0.16661', vol24h: '20998302.5', volCcy24h: '3521441.6', ts: NOW }] });
  assert.equal(okx.volume24hBase, 20_998_302.5);
  assert.equal(okx.volume24hUsd, 3_521_441.6);

  const bitget = normalizeSpotVolume('bitget', market('bitget', 'spot', 'ARBUSDT'), { data: [{ symbol: 'ARBUSDT', lastPr: '0.16679', baseVolume: '2371030.35', quoteVolume: '397708.93', usdtVolume: '397708.92', ts: String(NOW) }] });
  assert.equal(bitget.volume24hUsd, 397_708.93);

  const gate = normalizeSpotVolume('gate', market('gate', 'spot', 'ARB_USDT'), [{ currency_pair: 'ARB_USDT', last: '0.16659', base_volume: '15992247', quote_volume: '2676676.82' }]);
  assert.equal(gate.volume24hUsd, 2_676_676.82);
  assert.equal(gate.eventTime, null);
  assert.equal(gate.quality, 'partial');
  assert.ok(gate.unavailable.some((item) => item.includes('eventTime')));

  const kucoin = normalizeSpotVolume('kucoin', market('kucoin', 'spot', 'ARB-USDT'), { data: { symbol: 'ARB-USDT', last: '0.1666', vol: '53752142.09', volValue: '9026548.7', time: NOW } });
  assert.equal(kucoin.volume24hUsd, 9_026_548.7);

  const mexc = normalizeSpotVolume('mexc', market('mexc', 'spot', 'ARBUSDT'), { symbol: 'ARBUSDT', lastPrice: '0.16661', volume: '1353319.07', quoteVolume: '227056.94', closeTime: NOW });
  assert.equal(mexc.volume24hUsd, 227_056.94);
});

test('non-USDT spot quotes never become USDT notional', () => {
  const usdc = normalizeSpotVolume('binance', market('binance', 'spot', 'ARBUSDC', 'USDC'), { symbol: 'ARBUSDC', lastPrice: '0.1667', volume: '1000', quoteVolume: '166.7', closeTime: NOW });
  assert.equal(usdc.volume24hQuote, 166.7);
  assert.equal(usdc.volume24hUsd, null);
  assert.ok(usdc.unavailable.some((item) => item.includes('non-USDT')));
});

test('spot identity mismatch is rejected instead of silently mislabelled', () => {
  assert.throws(() => normalizeSpotVolume('binance', market('binance', 'spot', 'ARBUSDT'), { symbol: 'BTCUSDT', lastPrice: '1', volume: '1', quoteVolume: '1', closeTime: NOW }), /identity mismatch/);
  assert.throws(() => normalizeSpotVolume('okx', market('okx', 'spot', 'ARB-USDT'), { data: [{ instId: 'BTC-USDT', last: '1', vol24h: '1', volCcy24h: '1', ts: NOW }] }), /identity mismatch/);
});

test('spot / perpetual matrix keeps legs separate and computes shares only over covered venues', () => {
  const project: MarketProject = {
    id: 'p1', name: 'ARB', tokenSymbol: 'ARB', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
    markets: [market('binance', 'spot', 'ARBUSDT'), market('binance', 'perpetual', 'ARBUSDT'), market('bybit', 'spot', 'ARBUSDT'), market('bybit', 'perpetual', 'ARBUSDT'), market('okx', 'perpetual', 'ARB-USDT-SWAP')],
    primaryMarketId: 'binance:perpetual:ARBUSDT', monitoring: { defaultInterval: '5m', streamingEnabled: true }, archived: false, order: 0, createdAt: NOW, updatedAt: NOW,
  };
  const spotLegs = [leg('binance', 'spot', 1_000), leg('bybit', 'spot', 3_000)];
  const perpLegs = [leg('binance', 'perpetual', 5_000), leg('bybit', 'perpetual', 5_000), leg('okx', 'perpetual', 10_000)];
  const matrix = buildVolumeMatrix(project, spotLegs, perpLegs, [], NOW, new Map([
    ['binance', { oiUsd: 100, fundingRate: 0.0001, nextFundingTime: NOW + 3_600_000 }],
    ['bybit', { oiUsd: 200, fundingRate: 0.0002, nextFundingTime: NOW + 3_600_000 }],
    ['okx', { oiUsd: 300, fundingRate: 0.0003, nextFundingTime: NOW + 3_600_000 }],
  ]));
  assert.equal(matrix.totals.spotUsd, 4_000);
  assert.equal(matrix.totals.perpetualUsd, 20_000);
  assert.equal(matrix.totals.spotPerpRatio, 0.2);
  const binance = matrix.rows.find((row) => row.exchange === 'binance')!;
  assert.equal(binance.spot?.volume24hUsd, 1_000);
  assert.equal(binance.perpetual?.volume24hUsd, 5_000);
  assert.equal(binance.spotSharePct, 25);
  assert.equal(binance.perpetualSharePct, 25);
  assert.equal(binance.spotPerpVolumeRatio, 0.2);
  // Basis uses the two leg prices; fixture legs both have price 1 → 0 bps.
  assert.equal(binance.spotPerpBasisBps, 0);
  assert.equal(binance.oiUsd, 100);
  const okx = matrix.rows.find((row) => row.exchange === 'okx')!;
  assert.equal(okx.spot, null);
  assert.equal(okx.spotSharePct, null);
  assert.equal(okx.spotPerpVolumeRatio, null);
  assert.equal(matrix.coverage.requestedVenues, 3);
  assert.equal(matrix.coverage.spotVenues, 2);
  assert.equal(matrix.coverage.perpetualVenues, 3);
  assert.equal(matrix.coverage.bothLegsVenues, 2);
  assert.equal(matrix.claimGate.state, 'available');
});

test('matrix is restricted and explicit when a leg is missing', () => {
  const project: MarketProject = {
    id: 'p2', name: 'ARB', tokenSymbol: 'ARB', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
    markets: [market('binance', 'perpetual', 'ARBUSDT')],
    primaryMarketId: 'binance:perpetual:ARBUSDT', monitoring: { defaultInterval: '5m', streamingEnabled: true }, archived: false, order: 0, createdAt: NOW, updatedAt: NOW,
  };
  const matrix = buildVolumeMatrix(project, [], [leg('binance', 'perpetual', 5_000)], [{ exchange: 'binance', marketType: 'spot', symbol: 'ARBUSDT', quote: 'USDT', message: 'not selected' }], NOW);
  assert.equal(matrix.claimGate.state, 'restricted');
  assert.ok(matrix.claimGate.reasons.some((reason) => reason.includes('no selected spot')));
  assert.equal(matrix.totals.spotUsd, null);
  assert.equal(matrix.rows[0].spot, null);
  assert.equal(matrix.failures.length, 1);
});

test('mixed quotes are not summed into a USDT total and are reported as a gate reason', () => {
  const project: MarketProject = {
    id: 'p3', name: 'ARB', tokenSymbol: 'ARB', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
    markets: [market('binance', 'spot', 'ARBUSDC', 'USDC'), market('binance', 'perpetual', 'ARBUSDT')],
    primaryMarketId: 'binance:perpetual:ARBUSDT', monitoring: { defaultInterval: '5m', streamingEnabled: true }, archived: false, order: 0, createdAt: NOW, updatedAt: NOW,
  };
  const usdcLeg = leg('binance', 'spot', null, { quote: 'USDC', volume24hQuote: 500, volume24hUsd: null });
  const matrix = buildVolumeMatrix(project, [usdcLeg], [leg('binance', 'perpetual', 5_000)], [], NOW);
  assert.equal(matrix.totals.spotUsd, null);
  assert.ok(matrix.claimGate.reasons.some((reason) => reason.includes('non-USDT')));
});

test('perpetual leg conversion keeps OI/funding metadata and never invents a spot leg', () => {
  const snapshot: VenueMarketSnapshot = {
    exchange: 'binance', symbol: 'ARBUSDT', marketType: 'perpetual', price: 0.166, markPrice: 0.166, change24hPct: -1, volume24hBase: 1_000, volume24hUsd: 2_000,
    takerBuyVolumeUsd: null, takerSellVolumeUsd: null, volumeDeltaUsd: null, cvd: null, oiBase: 10, oiUsd: 1.66, oiDeltaBase: null, oiDeltaUsd: null,
    fundingRate: 0.0001, nextFundingTime: NOW, bid: null, ask: null, spreadBps: null, eventTime: NOW, fetchedAt: NOW, quality: 'live', source: 'fixture', unavailable: [],
  };
  const perp = perpLegFromSnapshot(market('binance', 'perpetual', 'ARBUSDT'), snapshot);
  assert.equal(perp.marketType, 'perpetual');
  assert.equal(perp.volume24hUsd, 2_000);
  assert.equal(perp.quality, 'live');
  assert.equal(perp.quote, 'USDT');
});

test('unsupported spot venues (KRW) are explicit instead of guessed', () => {
  assert.equal(spotVolumeUrl('upbit', market('upbit', 'spot', 'KRW-ARB', 'KRW')), null);
  assert.equal(spotVolumeUrl('bithumb', market('bithumb', 'spot', 'KRW-ARB', 'KRW')), null);
  assert.throws(() => normalizeSpotVolume('upbit', market('upbit', 'spot', 'KRW-ARB', 'KRW'), {}), /no verified USDT spot volume adapter/);
});

test('KRW legs stay in KRW and never enter USDT totals or shares', () => {
  const krwMarket = (exchange: 'upbit' | 'bithumb'): ProjectMarket => ({ id: `${exchange}:spot:KRW-ARB`, exchange, marketType: 'spot', symbol: 'KRW-ARB', base: 'ARB', quote: 'KRW', status: 'listed' });
  const project: MarketProject = {
    id: 'p-krw', name: 'ARB', tokenSymbol: 'ARB', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
    markets: [market('binance', 'perpetual', 'ARBUSDT'), krwMarket('upbit'), krwMarket('bithumb')],
    primaryMarketId: 'binance:perpetual:ARBUSDT', monitoring: { defaultInterval: '5m', streamingEnabled: true }, archived: false, order: 0, createdAt: NOW, updatedAt: NOW,
  };
  const krwLeg = (exchange: 'upbit' | 'bithumb', krw: number): VenueVolumeLeg => ({
    exchange, marketType: 'spot', symbols: ['KRW-ARB'], quote: 'KRW', price: 224, volume24hBase: 1000, volume24hQuote: krw, volume24hUsd: null,
    eventTime: NOW, fetchedAt: NOW, quality: 'live', source: 'fixture', unavailable: ['volume24hUsd (KRW quote; no FX conversion)'],
  });
  const matrix = buildVolumeMatrix(project, [krwLeg('upbit', 1_000_000), krwLeg('bithumb', 3_000_000)], [leg('binance', 'perpetual', 5_000)], [], NOW);
  // USDT block: only the perpetual venue; KRW venues never appear there.
  assert.deepEqual(matrix.rows.map((row) => row.exchange), ['binance']);
  assert.equal(matrix.totals.spotUsd, null);
  assert.equal(matrix.totals.perpetualUsd, 5_000);
  // KRW block: shares are computed inside the KRW set only and stay in KRW units.
  assert.equal(matrix.krw.rows.length, 2);
  assert.equal(matrix.krw.totals.spotKrw, 4_000_000);
  assert.equal(matrix.krw.rows.find((row) => row.exchange === 'upbit')?.spotSharePct, 25);
  assert.equal(matrix.krw.rows.find((row) => row.exchange === 'bithumb')?.spotSharePct, 75);
  assert.equal(matrix.krw.rows[0].spot?.volume24hUsd, null);
  assert.equal(matrix.krw.claimGate.state, 'available');
  assert.ok(matrix.krw.methodology.some((item) => item.includes('never converted to USD')));
});

test('KRW failures are reported in the KRW gate, not as USDT coverage failures', () => {
  const project: MarketProject = {
    id: 'p-krw2', name: 'ARB', tokenSymbol: 'ARB', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
    markets: [market('binance', 'perpetual', 'ARBUSDT'), market('upbit', 'spot', 'KRW-ARB', 'KRW')],
    primaryMarketId: 'binance:perpetual:ARBUSDT', monitoring: { defaultInterval: '5m', streamingEnabled: true }, archived: false, order: 0, createdAt: NOW, updatedAt: NOW,
  };
  const matrix = buildVolumeMatrix(project, [], [leg('binance', 'perpetual', 5_000)], [
    { exchange: 'upbit', marketType: 'spot', symbol: 'KRW-ARB', quote: 'KRW', message: 'rate-limited' },
  ], NOW);
  // No USDT spot leg was selected, so the USDT gate is restricted for that reason only.
  assert.equal(matrix.claimGate.state, 'restricted');
  assert.ok(matrix.claimGate.reasons.some((reason) => reason.includes('no selected spot market')));
  assert.ok(!matrix.claimGate.reasons.some((reason) => reason.includes('KRW request')));
  assert.ok(matrix.krw.claimGate.reasons.some((reason) => reason.includes('KRW request')));
});

test('Korean snapshot legs preserve KRW turnover and reject USD conversion', () => {
  const snapshot = {
    market: market('upbit', 'spot', 'KRW-ARB', 'KRW'), quote: 'KRW' as const, priceKrw: 224, changeFromPreviousClosePct: 0.44,
    volume24hBase: 1_000, turnover24hKrw: 224_000, bidKrw: 223.9, askKrw: 224.1, spreadBps: 8.9,
    sourceTime: NOW, rawSourceTime: NOW, timestampIssue: null, lastTradeTime: NOW, bookTime: NOW, fetchedAt: NOW,
    quality: 'live' as const, bookState: 'available' as const, source: 'fixture',
  };
  const krwLeg = krwLegFromSnapshot(snapshot);
  assert.equal(krwLeg.quote, 'KRW');
  assert.equal(krwLeg.volume24hQuote, 224_000);
  assert.equal(krwLeg.volume24hUsd, null);
  assert.equal(krwLeg.quality, 'live');
  assert.equal(krwLeg.exchange, 'upbit');
});

test('quality flags are heuristic and only fire with enough covered venues', () => {
  const project: MarketProject = {
    id: 'p-flags', name: 'ARB', tokenSymbol: 'ARB', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
    markets: [market('binance', 'perpetual', 'ARBUSDT'), market('bybit', 'perpetual', 'ARBUSDT'), market('okx', 'perpetual', 'ARB-USDT-SWAP')],
    primaryMarketId: 'binance:perpetual:ARBUSDT', monitoring: { defaultInterval: '5m', streamingEnabled: true }, archived: false, order: 0, createdAt: NOW, updatedAt: NOW,
  };
  const stalePerp = leg('okx', 'perpetual', 5_000, { quality: 'stale' });
  const matrix = buildVolumeMatrix(project, [], [leg('binance', 'perpetual', 5_000), leg('bybit', 'perpetual', 5_000), stalePerp], [], NOW, new Map([
    ['binance', { oiUsd: 1_000, fundingRate: 0, nextFundingTime: NOW }],
    ['bybit', { oiUsd: 100, fundingRate: 0, nextFundingTime: NOW }],
    ['okx', { oiUsd: 5_000, fundingRate: 0, nextFundingTime: NOW }],
  ]));
  const binance = matrix.rows.find((row) => row.exchange === 'binance')!;
  const bybit = matrix.rows.find((row) => row.exchange === 'bybit')!;
  const okx = matrix.rows.find((row) => row.exchange === 'okx')!;
  // turnover = 5, 50, 1; covered-venue median = 5 → 50 is high, 1 is low.
  assert.equal(binance.volumeOiTurnover, 5);
  assert.equal(bybit.volumeOiTurnover, 50);
  assert.ok(bybit.qualityFlags.includes('volume-oi-outlier-high'));
  assert.ok(okx.qualityFlags.includes('volume-oi-outlier-low'));
  assert.ok(okx.qualityFlags.includes('stale-leg'));
  assert.ok(!binance.qualityFlags.includes('volume-oi-outlier-high'));
});

test('quality flags do not invent outliers without a comparable median', () => {
  const project: MarketProject = {
    id: 'p-flags2', name: 'ARB', tokenSymbol: 'ARB', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
    markets: [market('binance', 'perpetual', 'ARBUSDT')],
    primaryMarketId: 'binance:perpetual:ARBUSDT', monitoring: { defaultInterval: '5m', streamingEnabled: true }, archived: false, order: 0, createdAt: NOW, updatedAt: NOW,
  };
  const matrix = buildVolumeMatrix(project, [], [leg('binance', 'perpetual', 5_000)], [], NOW, new Map([['binance', { oiUsd: 10, fundingRate: 0, nextFundingTime: NOW }]]));
  assert.deepEqual(matrix.rows[0].qualityFlags.filter((flag) => flag.startsWith('volume-oi')), []);
});
