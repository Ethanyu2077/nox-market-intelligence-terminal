export type NoxInterval = '1m' | '5m' | '15m' | '1h' | '4h';

export type TradingViewMarket = {
  exchange: string;
  marketType: 'spot' | 'perpetual';
  symbol: string;
};

export type TradingViewSymbolResolution = {
  available: boolean;
  symbol: string | null;
  exchange: string | null;
  marketType: TradingViewMarket['marketType'] | null;
  reason: string | null;
};

const TRADINGVIEW_EXCHANGES: Record<string, string> = { binance: 'BINANCE', bitget: 'BITGET', bybit: 'BYBIT', okx: 'OKX', gate: 'GATEIO', kucoin: 'KUCOIN', mexc: 'MEXC' };

function normalizeSymbol(market: TradingViewMarket) {
  let symbol = market.symbol.toUpperCase().replace(/[-_]/g, '');
  if (market.marketType === 'perpetual') symbol = symbol.replace(/SWAP$/, '').replace(/USDTM$/, 'USDT');
  return symbol;
}

export function resolveTradingViewSymbol(market: TradingViewMarket | null | undefined): TradingViewSymbolResolution {
  if (!market) return { available: false, symbol: null, exchange: null, marketType: null, reason: 'No primary market is selected.' };
  const exchange = TRADINGVIEW_EXCHANGES[market.exchange];
  if (!exchange) return { available: false, symbol: null, exchange: market.exchange.toUpperCase(), marketType: market.marketType, reason: `${market.exchange.toUpperCase()} is not mapped to TradingView yet.` };
  const suffix = market.marketType === 'perpetual' ? '.P' : '';
  return { available: true, symbol: `${exchange}:${normalizeSymbol(market)}${suffix}`, exchange, marketType: market.marketType, reason: null };
}

export function toTradingViewInterval(interval: NoxInterval): '1' | '5' | '15' | '60' | '240' {
  return ({ '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240' } as const)[interval];
}
