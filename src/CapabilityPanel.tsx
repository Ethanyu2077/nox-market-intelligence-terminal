import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { CapabilityRegistry } from '../shared/capabilities';

/**
 * Venue × endpoint-family capability matrix backed by the server registry. This is the
 * operator view of "what can this deployment actually read right now", including live
 * breaker coverage, so nobody has to infer support from a blank panel.
 */
export function CapabilityPanel({ language, venue }: { venue?: string; language: 'en' | 'zh' }) {
  const zh = language === 'zh';
  const [registry, setRegistry] = useState<CapabilityRegistry | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/capabilities', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setRegistry(await response.json() as CapabilityRegistry);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Capability registry unavailable');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const venues = [...new Set((registry?.rows ?? []).filter(row=>!venue||row.venue===venue).map((row) => row.venue))];

  return (
    <section className="ops-panel capability-panel">
      <h2>{zh ? '数据能力与覆盖' : 'Data capability & coverage'}</h2>
      <p>{zh
        ? '每个端点是独立的能力单元：某个场所的盘口熔断不会影响它的快照。这里同时展示静态支持与当前熔断覆盖状态。'
        : 'Each endpoint family is an independent capability: a depth outage on one venue does not affect its snapshots. Static support and live breaker coverage are shown together.'}</p>
      {error && <p role="alert" className="alerts-error">{error}</p>}
      <div className="ops-controls">
        <button onClick={() => void load()} disabled={loading}><RefreshCw size={12} className={loading ? 'spin' : ''} />{zh ? '刷新' : 'Refresh'}</button>
        <span>{registry ? `${zh ? '生成于' : 'generated'} ${new Date(registry.generatedAt).toLocaleTimeString()}` : (zh ? '读取中…' : 'Loading…')}</span>
      </div>
      {registry && (
        <div className="table-wrap">
          <table className="capability-table">
            <thead>
              <tr>
                <th>{zh ? '场所' : 'Venue'}</th>
                {registry.families.map((family) => <th key={family}>{family}</th>)}
              </tr>
            </thead>
            <tbody>
              {venues.map((venue) => {
                const transport = registry.rows.find((row) => row.venue === venue)?.transport;
                return (
                  <tr key={venue}>
                    <td><strong>{venue.toUpperCase()}</strong><small>{transport ?? '—'}</small></td>
                    {registry.families.map((family) => {
                      const row = registry.rows.find((item) => item.venue === venue && item.family === family);
                      if (!row || !row.supported) return <td key={family} title={row?.coverage.lastError ?? 'Not implemented'}><span className="cap-none">—</span></td>;
                      return (
                        <td key={family}>
                          <span className={`cap-state ${row.coverage.state}`} title={row.coverage.lastError ?? row.notes.join(' ')}>
                            {row.coverage.state === 'live' ? 'live' : row.coverage.state === 'unknown' ? 'idle' : row.coverage.state}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="alerts-hint">{zh
        ? 'live = 最近一次调用成功；degraded = 最近失败或半开；unavailable = 熔断打开或未实现；idle = 尚无调用。悬停可看到具体错误。'
        : 'live = last call succeeded; degraded = recent failure or half-open; unavailable = breaker open or unsupported; idle = not called yet. Hover for the exact error.'}</p>
    </section>
  );
}
