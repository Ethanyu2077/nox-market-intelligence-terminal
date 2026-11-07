import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { ExchangeSelection, MarketProject } from '../shared/types';
import type { OrderBookSnapshot } from '../shared/orderbook';
import type { L2Metrics, L2Snapshot } from '../shared/l2';

/**
 * Depth panel.
 *
 * The venue is chosen explicitly: depth is never aggregated across venues, because a
 * snapshot from one book cannot be summed with another book's snapshot.
 */
export function OrderBookPanel({ project, exchange, language }: {
  project: MarketProject;
  exchange: ExchangeSelection;
  language: 'en' | 'zh';
}) {
  const zh = language === 'zh';
  const venue = exchange === 'aggregated' ? null : exchange;
  const market = useMemo(() => {
    if (venue) return project.markets.find((item) => item.exchange === venue && item.marketType === 'perpetual') ?? null;
    const primary = project.markets.find((item) => item.id === project.primaryMarketId);
    if (primary && (primary.exchange === 'binance' || primary.exchange === 'aster')) return primary;
    return project.markets.find((item) => item.marketType === 'perpetual' && (item.exchange === 'binance' || item.exchange === 'aster')) ?? null;
  }, [project, venue]);

  const [book, setBook] = useState<OrderBookSnapshot | null>(null);
  const [l2, setL2] = useState<{ snapshot: L2Snapshot; metrics: L2Metrics | null } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const unsupported = Boolean(venue) && venue !== 'binance' && venue !== 'aster';

  const load = useCallback(async () => {
    if (!market || unsupported) { setBook(null); return; }
    setLoading(true);
    try {
      const response = await fetch(`/api/market/${market.exchange}/${encodeURIComponent(market.symbol)}/depth?limit=20`, { headers: { Accept: 'application/json' } });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      setBook(body as OrderBookSnapshot);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Depth unavailable');
    } finally { setLoading(false); }
  }, [market, unsupported]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 4_000);
    return () => clearInterval(timer);
  }, [load]);

  // Continuous sequence-validated book (separate from the REST snapshot above).
  useEffect(() => {
    if (!market || !['binance', 'bybit', 'okx'].includes(market.exchange)) { setL2(null); return; }
    const events = new EventSource(`/api/market/${market.exchange}/${encodeURIComponent(market.symbol)}/book/stream`);
    const onBook = (event: MessageEvent) => {
      try { setL2(JSON.parse(event.data) as { snapshot: L2Snapshot; metrics: L2Metrics | null }); } catch { /* ignore malformed frame */ }
    };
    events.addEventListener('book', onBook as EventListener);
    return () => events.close();
  }, [market]);

  const maxNotional = Math.max(1, ...(book?.bids ?? []).map((level) => level.notional), ...(book?.asks ?? []).map((level) => level.notional));
  const age = book ? Math.max(0, Math.round((Date.now() - book.eventTime) / 1000)) : null;

  return (
    <section className="panel orderbook-panel">
      <div className="panel-head">
        <div>
          <strong>{zh ? '盘口深度（快照）' : 'Order book depth (snapshot)'}</strong>
          <span>{market ? `${market.exchange.toUpperCase()} · ${market.symbol}` : (zh ? '未选择可用的永续市场' : 'No supported perpetual market')} · {zh ? '每个场所独立，不跨所相加' : 'per venue, never summed across venues'}</span>
        </div>
        <div className="ob-head-actions">
          {book && <span className="ob-age">{age == null ? '—' : `${age}s`}</span>}
          <button onClick={() => void load()} disabled={loading} title={zh ? '刷新' : 'Refresh'}><RefreshCw size={12} className={loading ? 'spin' : ''} /></button>
        </div>
      </div>

      {unsupported ? (
        <p className="ob-empty">{zh ? '该交易所没有经过验证的公开深度接口；深度不会用最优买卖价伪造。' : 'This venue has no verified public depth endpoint; depth is not faked from best bid/ask.'}</p>
      ) : !market ? (
        <p className="ob-empty">{zh ? '当前项目没有 Binance / Aster 永续市场，无法读取盘口。' : 'This project has no Binance or Aster perpetual market, so no book can be read.'}</p>
      ) : (
        <>
          <div className="ob-summary">
            <div><span>{zh ? '中间价' : 'Mid'}</span><strong>{book?.midPrice == null ? '—' : book.midPrice.toLocaleString('en-US', { maximumFractionDigits: 6 })}</strong></div>
            <div><span>{zh ? '价差' : 'Spread'}</span><strong>{book?.spreadBps == null ? '—' : `${book.spreadBps.toFixed(2)} bps`}</strong></div>
            <div><span>{zh ? '买盘深度' : 'Bid depth'}</span><strong className="up">{fmt(book?.bidDepthUsd)}</strong></div>
            <div><span>{zh ? '卖盘深度' : 'Ask depth'}</span><strong className="down">{fmt(book?.askDepthUsd)}</strong></div>
            <div><span>{zh ? '不平衡' : 'Imbalance'}</span><strong className={(book?.imbalancePct ?? 0) >= 0 ? 'up' : 'down'}>{book?.imbalancePct == null ? '—' : `${book.imbalancePct > 0 ? '+' : ''}${book.imbalancePct.toFixed(1)}%`}</strong></div>
          </div>

          {error && <p role="alert" className="ob-error"><AlertTriangle size={12} />{error}</p>}

          {l2 && (
            <div className="ob-l2">
              <span className={`l2-state ${l2.snapshot.state}`}>{l2.snapshot.state}</span>
              <span>seq {l2.snapshot.sequence.last ?? '—'}</span>
              <span>gaps {l2.snapshot.gaps}</span>
              <span>resyncs {l2.snapshot.resyncs}</span>
              <span>{zh ? '失衡' : 'imbalance'} {l2.metrics?.imbalancePct == null ? '—' : `${l2.metrics.imbalancePct.toFixed(1)}%`}</span>
              <span>{zh ? '买盘撤出' : 'bid withdrawal'} {l2.metrics?.bidWithdrawalPct == null ? '—' : `${l2.metrics.bidWithdrawalPct.toFixed(1)}%`}</span>
              <span>{zh ? '卖盘撤出' : 'ask withdrawal'} {l2.metrics?.askWithdrawalPct == null ? '—' : `${l2.metrics.askWithdrawalPct.toFixed(1)}%`}</span>
              <span className="l2-integrity">{zh ? '完整性' : 'integrity'} {l2.snapshot.integrity}</span>
            </div>
          )}

          {book && (
            <div className="ob-ladder">
              <div className="ob-side asks">
                <header><span>{zh ? '价格' : 'Price'}</span><span>{zh ? '数量' : 'Size'}</span><span>{zh ? '名义' : 'Notional'}</span></header>
                {[...book.asks].slice(0, 10).reverse().map((level) => (
                  <div className="ob-row" key={`a-${level.price}`}>
                    <i style={{ width: `${Math.max(2, level.notional / maxNotional * 100)}%` }} />
                    <span className="px down">{level.price}</span>
                    <span>{level.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>
                    <span>{fmt(level.notional)}</span>
                  </div>
                ))}
              </div>
              <div className="ob-side bids">
                <header><span>{zh ? '价格' : 'Price'}</span><span>{zh ? '数量' : 'Size'}</span><span>{zh ? '名义' : 'Notional'}</span></header>
                {book.bids.slice(0, 10).map((level) => (
                  <div className="ob-row" key={`b-${level.price}`}>
                    <i style={{ width: `${Math.max(2, level.notional / maxNotional * 100)}%` }} />
                    <span className="px up">{level.price}</span>
                    <span>{level.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>
                    <span>{fmt(level.notional)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="ob-foot">
            {zh
              ? `单次 REST 快照（limit 20，更新号 ${book?.lastUpdateId ?? '—'}）。不是带序列号的 L2 数据流，无法检测丢包，也看不到隐藏/冰山挂单；USD 深度是每一档价格 × 挂单量，不等于大单可成交规模。`
              : `One REST snapshot (limit 20, update ${book?.lastUpdateId ?? '—'}). Not a sequenced L2 feed: missed updates cannot be detected and hidden/iceberg size is invisible. USD depth is price × resting size per level, not executable size for a large order.`}
          </p>
        </>
      )}
    </section>
  );
}

function fmt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `$${Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value)}`;
}
