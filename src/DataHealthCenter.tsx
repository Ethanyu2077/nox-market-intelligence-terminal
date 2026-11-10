import { useCallback, useEffect, useState } from 'react';
import type { DataHealthReport, HealthState } from '../shared/data-health';
import type { ProviderCheck } from '../shared/provider-crosscheck';

const stateClass = (state: HealthState | string) => state.toLowerCase().replace(/[^a-z]/g, '');

/** Read-only Data Health Center; every field is backed by the health API. */
export function DataHealthCenter() {
  const [report, setReport] = useState<DataHealthReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checks, setChecks] = useState<ProviderCheck[]>([]);
  const [checkProject, setCheckProject] = useState('');
  const [checkBusy, setCheckBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/data-health/center', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setReport(await response.json() as DataHealthReport);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Data health unavailable');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const selectedProject = checkProject || report?.projects[0]?.projectId || '';
  useEffect(() => {
    if (!selectedProject) return;
    let active = true;
    setCheckBusy(true);
    fetch(`/api/projects/${selectedProject}/provider-crosscheck`, { headers: { Accept: 'application/json' } })
      .then((response) => response.ok ? response.json() as Promise<{ checks: ProviderCheck[] }> : null)
      .then((payload) => { if (active) setChecks(payload?.checks ?? []); })
      .catch(() => { if (active) setChecks([]); })
      .finally(() => { if (active) setCheckBusy(false); });
    return () => { active = false; };
  }, [selectedProject]);

  const overall = report?.overall;
  return (
    <section className="panel dh-panel">
      <div className="panel-head">
        <div>
          <h3>Data health center</h3>
          <p>Collector freshness, coverage, gaps, breakers, storage and L2 in one read-only view. Missing data stays unavailable, never zero.</p>
        </div>
        <span className={`dh-state ${stateClass(overall?.state ?? 'notverified')}`}>{overall?.state ?? 'NOT VERIFIED'}</span>
      </div>
      {error && <p role="alert" className="alerts-error">{error}</p>}
      <div className="dh-controls">
        <button onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        <span>{report ? `generated ${new Date(report.generatedAt).toLocaleTimeString()}` : 'Loading…'}</span>
      </div>
      {report && (
        <>
          <div className="dh-grid">
            <div className="dh-card"><span>LIVE</span><strong>{report.overall.live}</strong></div>
            <div className="dh-card"><span>PARTIAL</span><strong>{report.overall.partial}</strong></div>
            <div className="dh-card"><span>STALE</span><strong>{report.overall.stale}</strong></div>
            <div className="dh-card"><span>UNAVAILABLE</span><strong>{report.overall.unavailable}</strong></div>
            <div className="dh-card"><span>Storage</span><strong>{report.storage.state}</strong><small>{report.storage.connected ? `${report.storage.rows ?? '—'} rows` : report.storage.mode}</small></div>
            <div className="dh-card"><span>L2 feeds</span><strong>{report.l2.activeFeeds}</strong><small>{report.l2.sampled} samples · {report.l2.state}</small></div>
            {report.providers?.map((provider) => (
              <div className="dh-card" key={provider.provider}><span>{provider.provider}</span><strong>{provider.state}</strong><small>{provider.configured ? `${provider.lastLatencyMs ?? '—'} ms` : 'not configured'}</small></div>
            ))}
          </div>

          {report.l2.feeds.length > 0 && (
            <div className="dh-section">
              <h4>L2 feeds <small>{report.l2.state}</small></h4>
              <div className="table-wrap"><table className="dh-table"><thead><tr><th>Venue</th><th>Symbol</th><th>State</th><th>Sequence</th><th>Epoch</th><th>Verified</th><th>Integrity</th><th>Gaps</th><th>Resyncs</th></tr></thead><tbody>
                {report.l2.feeds.map((feed) => (
                  <tr key={`${feed.venue}:${feed.symbol}`}>
                    <td>{feed.venue}</td><td>{feed.symbol}</td>
                    <td><span className={`dh-state ${stateClass(feed.state)}`}>{feed.state}</span></td>
                    <td>{feed.sequence ?? '—'}</td><td>{feed.epoch ?? '—'}</td>
                    <td>{feed.verified ? 'yes' : 'no'}</td><td>{feed.integrity}</td>
                    <td>{feed.gaps}</td><td>{feed.resyncs}</td>
                  </tr>
                ))}
              </tbody></table></div>
            </div>
          )}
          <div className="dh-section">
            <h4>Project coverage</h4>
            <div className="table-wrap"><table className="dh-table"><thead><tr><th>Project</th><th>Mode</th><th>Cadence</th><th>Kinds</th><th>Notes</th></tr></thead><tbody>
              {report.projects.map((project) => (
                <tr key={project.projectId}>
                  <td>{project.projectName}</td>
                  <td>{project.mode}</td>
                  <td>{project.cadenceMs ? `${Math.round(project.cadenceMs / 1000)}s` : '—'}</td>
                  <td>{project.kinds.length ? project.kinds.map((kind) => `${kind.kind}:${kind.state}${kind.gaps ? `(${kind.gaps}g)` : ''}`).join(' · ') : '—'}</td>
                  <td>{project.notes.join('; ') || '—'}</td>
                </tr>
              ))}
            </tbody></table></div>
          </div>

          <div className="dh-section">
            <h4>Exchange sources <small>{report.sources.length} venues</small></h4>
            <div className="table-wrap dh-scroll"><table className="dh-table"><thead><tr><th>Project</th><th>Exchange</th><th>Symbol</th><th>Type</th><th>State</th><th>Delay</th><th>Evidence</th></tr></thead><tbody>
              {report.sources.map((source) => (
                <tr key={`${source.projectId}:${source.exchange}:${source.symbol}`}>
                  <td>{source.projectName}</td>
                  <td>{source.exchange}</td>
                  <td>{source.symbol}</td>
                  <td>{source.marketType}</td>
                  <td><span className={`dh-state ${stateClass(source.state)}`}>{source.state}</span></td>
                  <td>{source.delayMs == null ? '—' : `${Math.round(source.delayMs / 1000)}s`}</td>
                  <td className="dh-evidence">{source.evidence.join(' · ')}</td>
                </tr>
              ))}
            </tbody></table></div>
          </div>

          <div className="dh-section">
            <h4>Native vs CoinGlass <small>{checkBusy ? 'loading…' : `${checks.filter((check) => check.status === 'diverge').length} divergences`}</small></h4>
            <div className="dh-controls dh-inline">
              <label>Project
                <select value={selectedProject} onChange={(event) => setCheckProject(event.target.value)}>
                  {report.projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.projectName}</option>)}
                </select>
              </label>
              <span>Native values stay authoritative; CoinGlass is shown for comparison only.</span>
            </div>
            {checks.length === 0 ? <p className="dh-empty">No overlapping native/CoinGlass field for this project.</p> : (
              <div className="table-wrap dh-scroll"><table className="dh-table"><thead><tr><th>Exchange</th><th>Field</th><th>Native</th><th>CoinGlass</th><th>Divergence</th><th>Status</th><th>Native source</th></tr></thead><tbody>
                {checks.map((check) => (
                  <tr key={`${check.exchange}:${check.field}`} className={check.status === 'diverge' ? 'dh-diverge' : ''}>
                    <td>{check.exchange}</td>
                    <td>{check.field}</td>
                    <td>{check.native == null ? '—' : check.native.toFixed(6)}</td>
                    <td>{check.coinGlass == null ? '—' : check.coinGlass.toFixed(6)}</td>
                    <td>{check.divergencePct == null ? '—' : `${check.divergencePct}%`}</td>
                    <td><span className={`dh-state ${check.status === 'agree' ? 'live' : check.status === 'diverge' ? 'stale' : 'notverified'}`}>{check.status}</span></td>
                    <td className="dh-evidence">{check.nativeSource ?? '—'} → {check.coinGlassSource}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </div>

          <div className="dh-section">
            <h4>Diagnostics <small>{report.issues.length} issues</small></h4>
            {report.issues.length === 0 ? <p className="dh-empty">No active issue from the checked sources.</p> : (
              <div className="table-wrap"><table className="dh-table"><thead><tr><th>Severity</th><th>Category</th><th>Source</th><th>Detail</th><th>Last seen</th></tr></thead><tbody>
                {report.issues.slice(0, 50).map((issue, index) => (
                  <tr key={`${issue.category}:${issue.source}:${index}`}>
                    <td><span className={`dh-sev ${issue.severity}`}>{issue.severity}</span></td>
                    <td>{issue.category}</td>
                    <td>{issue.source}</td>
                    <td>{issue.detail}</td>
                    <td>{new Date(issue.lastSeen).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </div>
          <p className="dh-footnote">Collector modes: {report.collectors.map((item) => `${item.projectId.slice(0, 6)}=${item.mode}`).join(' · ') || 'none'}. L2 requires an Active project with a supported Binance/Bybit/OKX market.</p>
        </>
      )}
    </section>
  );
}
