import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { ExchangeSelection, MarketProject } from '../shared/types';
import type { OrderBookSnapshot } from '../shared/orderbook';
import { subscribeLiveChannel } from './live-channel';
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
    const supported = ['binance', 'bybit', 'okx', 'aster'];
    if (primary?.marketType === 'perpetual' && supported.includes(primary.exchange)) return primary;
    return project.markets.find((item) => item.marketType === 'perpetual' && supported.includes(item.exchange)) ?? null;
  }, [project, venue]);

  const [restBook, setRestBook] = useState<OrderBookSnapshot | null>(null);
  const [l2, setL2] = useState<{ snapshot: L2Snapshot; metrics: L2Metrics | null } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const streaming = project.monitoring.streamingEnabled && project.monitoring.collectionMode !== 'paused';
  const hasL2 = !!market && ['binance', 'bybit', 'okx'].includes(market.exchange);
  const hasRest = market?.exchange === 'binance' || market?.exchange === 'aster';
  const unsupported = !!market && !hasL2 && !hasRest;
  const snapshot = l2?.snapshot.venue === market?.exchange && l2?.snapshot.symbol === market?.symbol ? l2?.snapshot : null;
  const liveBook = streaming && snapshot?.state === 'live' ? snapshot : null;
  const book = liveBook ?? (restBook?.exchange === market?.exchange && restBook?.symbol === market?.symbol ? restBook : null);

  const load = useCallback(async () => {
    if (!market || (!hasRest && !hasL2) || request.current) return;
    const abort = new AbortController();
    request.current = abort;
    setLoading(true);
    try {
      const path = hasRest ? 'depth?limit=20' : 'book';
      const response = await fetch(`/api/market/${market.exchange}/${encodeURIComponent(market.symbol)}/${path}`, {signal: abort.signal});
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      if (abort.signal.aborted || !body) return;
      if (hasRest) setRestBook(body as OrderBookSnapshot);
      else setL2({ snapshot: body.snapshot, metrics: body.metrics.at(-1) ?? null });
      setError('');
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Depth unavailable');
    } finally {
      if (request.current === abort) { request.current = null; setLoading(false); }
    }
  }, [market, hasRest, hasL2]);

  useEffect(() => {
    setL2(null); setRestBook(null); setError(''); setLoading(false);
    return () => { request.current?.abort(); request.current = null; };
  }, [market]);

  useEffect(() => {
    if (!market || !hasL2 || !streaming) return;
    return subscribeLiveChannel<NonNullable<typeof l2>>('book', {projectId: project.id, venue: market.exchange, symbol: market.symbol}, frame => {
      if (frame.snapshot.venue === market.exchange && frame.snapshot.symbol === market.symbol) setL2(frame);
    }, state => {
      if (state === 'reconnecting' || state === 'offline' || state === 'unavailable') setL2(null);
    });
  }, [market, hasL2, streaming, project.id]);

  // Use the snapshot adapter while a continuous book is unavailable. A healthy feed owns the ladder.
  const live = !!liveBook;
  useEffect(() => {
    if (live || (!hasRest && streaming)) return;
    void load();
    if (!hasRest || !streaming) return;
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 4_000);
    return () => clearInterval(timer);
  }, [hasRest, streaming, live, load]);

  const maxNotional = Math.max(1, ...(book?.bids ?? []).map((level) => level.notional), ...(book?.asks ?? []).map((level) => level.notional));
  const age = book ? Math.max(0, Math.round((Date.now() - book.eventTime) / 1000)) : null;

  return (
    <section className="panel orderbook-panel">
      <div className="panel-head">
        <div>
          <strong>{live ? (zh ? '盘口深度（实时）' : 'Order book depth (live)') : (zh ? '盘口深度（快照）' : 'Order book depth (snapshot)')}</strong>
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
        <p className="ob-empty">{zh ? '当前项目没有可用的永续市场，无法读取盘口。' : 'This project has no supported perpetual market, so no book can be read.'}</p>
      ) : (
        <>
          <div className="ob-summary">
            <div><span>{zh ? '中间价' : 'Mid'}</span><strong>{book?.midPrice == null ? '—' : book.midPrice.toLocaleString('en-US', { maximumFractionDigits: 6 })}</strong></div>
            <div><span>{zh ? '价差' : 'Spread'}</span><strong>{book?.spreadBps == null ? '—' : `${book.spreadBps.toFixed(2)} bps`}</strong></div>
            <div><span>{zh ? '买盘深度' : 'Bid depth'}</span><strong className="up">{fmt(book?.bidDepthUsd)}</strong></div>
            <div><span>{zh ? '卖盘深度' : 'Ask depth'}</span><strong className="down">{fmt(book?.askDepthUsd)}</strong></div>
            <div><span>{zh ? '不平衡' : 'Imbalance'}</span><strong className={(book?.imbalancePct ?? 0) >= 0 ? 'up' : 'down'}>{book?.imbalancePct == null ? '—' : `${book.imbalancePct > 0 ? '+' : ''}${book.imbalancePct.toFixed(1)}%`}</strong></div>
          </div>

          {error && !live && <p role="alert" className="ob-error"><AlertTriangle size={12} />{error}</p>}

          {l2 && snapshot && (
            <div className="ob-l2">
              <span className={`l2-state ${l2.snapshot.state}`}>{l2.snapshot.state}{l2.snapshot.state === 'live' && !l2.snapshot.verified ? '*' : ''}</span>
              <span className={l2.snapshot.verified ? 'l2-verified' : 'l2-unverified'}>{l2.snapshot.verified ? (zh ? '已验证' : 'verified') : (zh ? '未验证' : 'unverified')}</span>
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
            {liveBook ? (zh ? '交易所 L2 实时盘口，数量和深度随增量更新。' : 'Exchange L2 book. Sizes and depth follow incremental updates.') : hasRest ? (zh
              ? `单次 REST 快照（limit 20，更新号 ${restBook?.lastUpdateId ?? '—'}）。不是带序列号的 L2 数据流，无法检测丢包，也看不到隐藏/冰山挂单；USD 深度是每一档价格 × 挂单量，不等于大单可成交规模。`
              : `One REST snapshot (limit 20, update ${restBook?.lastUpdateId ?? '—'}). Not a sequenced L2 feed: missed updates cannot be detected and hidden/iceberg size is invisible. USD depth is price × resting size per level, not executable size for a large order.`) : (zh ? '等待连续盘口完成同步。' : 'Waiting for a synchronized order book.')}
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
