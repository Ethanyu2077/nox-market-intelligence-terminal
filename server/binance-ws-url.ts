/** USDⓈ-M market streams accept raw and combined subscriptions under /market. */
export function binanceMarketWsBase(configured = process.env.BINANCE_WS_BASE ?? 'wss://fstream.binance.com') {
  const base = configured.replace(/\/+$/, '');
  return base.endsWith('/market') ? base : base + '/market';
}
