import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

interface Health {
  enabled: boolean;
  venues: string[];
  ignored: string[];
  exchanges: Array<{
    id: string;
    enabled: boolean;
    loaded: boolean;
    markets: number;
    perpetuals: number;
    latencyMs: number | null;
    error: string | null;
    checkedAt: number | null;
  }>;
}

/**
 * CCXT diagnostics for the settings page.
 *
 * CCXT is a fallback/coverage layer, so operators need to see which venues are enabled,
 * whether their catalogues loaded, and why a request failed — without reading server logs.
 */
export function CcxtPanel({ language }: { language: 'en' | 'zh' }) {
  const zh = language === 'zh';
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (probe = false) => {
    if (probe) setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/ccxt/health${probe ? '?probe=1' : ''}`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setHealth(await response.json() as Health);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'CCXT status unavailable');
    } finally { if (probe) setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="ops-panel ccxt-panel">
      <h2>{zh ? 'CCXT · 行情覆盖与回退' : 'CCXT · market coverage & fallback'}</h2>
      <p>{zh
        ? 'CCXT 作为补充层：为额外交易所提供永续行情，并在原生适配器失败时作为带标记的回退。它不替代原生 WebSocket、成交带或主动买卖量；这些字段在 CCXT 行中保持不可用。'
        : 'CCXT is a coverage and resilience layer: it serves extra perpetual venues and acts as a labelled fallback when a native adapter fails. It never replaces native WebSocket tapes or aggressor flow; those fields stay unavailable on CCXT rows.'}</p>

      {!health && !error && <p className="ops-status">{zh ? '读取中…' : 'Loading…'}</p>}
      {error && <p role="alert" className="research-error">{error}</p>}

      {health && (
        <>
          <p className="ops-status">
            {zh ? '状态' : 'Status'}: {health.enabled ? 'enabled' : 'disabled'} · {zh ? '启用场所' : 'venues'}: {health.venues.length ? health.venues.join(' · ') : (zh ? '无（NOX_CCXT_VENUES 为空）' : 'none (NOX_CCXT_VENUES empty)')}
            {health.ignored.length > 0 && <><br />{zh ? '忽略的未知场所' : 'Ignored unknown venues'}: {health.ignored.join(', ')}</>}
          </p>
          {health.exchanges.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{zh ? '场所' : 'Venue'}</th>
                    <th>{zh ? '目录' : 'Catalog'}</th>
                    <th>{zh ? '合约数' : 'Markets'}</th>
                    <th>{zh ? 'USDT 永续' : 'USDT perps'}</th>
                    <th>{zh ? '延迟' : 'Latency'}</th>
                    <th>{zh ? '最近检查' : 'Checked'}</th>
                    <th>{zh ? '错误' : 'Error'}</th>
                  </tr>
                </thead>
                <tbody>
                  {health.exchanges.map((row) => (
                    <tr key={row.id}>
                      <td><strong>{row.id}</strong></td>
                      <td>{row.loaded ? (zh ? '已加载' : 'loaded') : (zh ? '未加载' : 'not loaded')}</td>
                      <td>{row.markets}</td>
                      <td>{row.perpetuals}</td>
                      <td>{row.latencyMs == null ? '—' : `${row.latencyMs} ms`}</td>
                      <td>{row.checkedAt ? new Date(row.checkedAt).toLocaleTimeString() : '—'}</td>
                      <td className={row.error ? 'negative' : ''}>{row.error ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="ops-controls">
            <button disabled={busy || !health.enabled} onClick={() => void load(true)}>
              {busy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
              {zh ? '加载 / 刷新交易目录' : 'Load / refresh catalogues'}
            </button>
            <span>{zh ? '启用方式：NOX_CCXT_VENUES=htx,bingx' : 'Enable with NOX_CCXT_VENUES=htx,bingx'}</span>
          </div>
        </>
      )}
    </section>
  );
}
