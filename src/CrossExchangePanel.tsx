import { useEffect, useState } from 'react';
import type { FactorEvidence } from '../shared/crossfactor';
import type { MarketProject } from '../shared/types';

const FACTORS = [
  { id: 'oi_level', label: 'OI Level', zh: 'OI 水平' },
  { id: 'oi_delta', label: 'OI Delta', zh: 'OI 变化' },
  { id: 'funding_basis', label: 'Funding / Basis', zh: '资金费 / 基差' },
  { id: 'depth_change', label: 'Depth Change', zh: '深度变化' },
  { id: 'spot_volume_delta', label: 'Spot Volume Delta', zh: '现货主动买卖差' },
  { id: 'perp_volume_delta', label: 'Perp Volume Delta', zh: '合约主动买卖差' },
  { id: 'cvd_divergence', label: 'CVD Divergence', zh: 'CVD 背离' },
] as const;

const TIMEFRAMES = ['1m', '5m', '15m', '1h'] as const;

/**
 * Cross-exchange evidence, backed by the real research endpoint. Correlation is never
 * rendered as a win rate; OOS stays `NOT VERIFIED` until a frozen historical dataset is
 * actually replayed.
 */
export function CrossExchangePanel({ project, language }: { project: MarketProject; language: 'en' | 'zh' }) {
  const zh = language === 'zh';
  const [factor, setFactor] = useState<(typeof FACTORS)[number]['id']>('oi_delta');
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>('5m');
  const [lookback, setLookback] = useState<'6h' | '24h' | '7d' | '30d'>('24h');
  const [minCoverage, setMinCoverage] = useState(0);
  const [sort, setSort] = useState<'samples' | 'correlation' | 'lag'>('samples');
  const [pairFilter, setPairFilter] = useState('all');
  const [report, setReport] = useState<FactorEvidence | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    const lookbackMs = { '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 }[lookback];
    // The interactive panel must not hang on a slow research query (the deployed API can
    // exceed the proxy timeout); abort after 20s and show an explicit error.
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    setLoading(true);
    fetch(`/api/projects/${project.id}/research/cross-factor?factor=${factor}&timeframe=${timeframe}&start=${Date.now() - lookbackMs}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json().catch(() => { throw new Error('Invalid research response'); }) as Promise<FactorEvidence>;
      })
      .then((payload) => { setReport(payload); setError(''); setSelected(payload.pairs?.[0]?.venues.join('→') ?? null); setPairFilter('all'); })
      .catch((cause) => {
        if (controller.signal.aborted && !timedOut) return; // component unmount
        setError(timedOut ? 'Research request timed out; try a shorter lookback' : cause instanceof Error ? cause.message : 'Request failed');
      })
      .finally(() => { clearTimeout(timer); setLoading(false); });
    return () => { clearTimeout(timer); controller.abort(); };
  }, [project.id, factor, timeframe, lookback]);

  const venueCoverage = new Map((report?.venues ?? []).map((venue) => [venue.venue, venue.coveragePct]));
  const pairCoverage = (venues: [string, string]) => Math.min(venueCoverage.get(venues[0]) ?? 0, venueCoverage.get(venues[1]) ?? 0);
  const visiblePairs = (report?.pairs ?? [])
    .filter((item) => pairFilter === 'all' || item.venues.join('→') === pairFilter)
    .filter((item) => pairCoverage(item.venues) >= minCoverage)
    .sort((left, right) => sort === 'correlation'
      ? Math.abs(right.correlation ?? 0) - Math.abs(left.correlation ?? 0)
      : sort === 'lag' ? (right.lagMs ?? -1) - (left.lagMs ?? -1) : right.samples - left.samples);
  const pair = visiblePairs.find((item) => item.venues.join('→') === selected) ?? visiblePairs[0] ?? null;
  const status = loading ? 'Loading' : report == null ? 'Unavailable' : !report.comparable ? (report.verdict === 'insufficient' ? 'Insufficient' : 'Unavailable') : report.verdict === 'descriptive' ? 'Descriptive' : report.verdict === 'insufficient' ? 'Insufficient' : 'Unavailable';

  return (
    <section className="panel cx-panel">
      <div className="panel-head">
        <div><h3>{zh ? '跨交易所证据' : 'Cross-exchange evidence'}</h3><p>{zh ? '相关性是描述性统计，不是胜率；样本外状态在真实冻结数据复现前保持 NOT VERIFIED。' : 'Correlation is descriptive, not a win rate. OOS stays NOT VERIFIED until a frozen dataset is replayed.'}</p></div>
        <span className={`cx-status ${status.toLowerCase()}`}>{status}</span>
      </div>
      <div className="cx-controls">
        <label>{zh ? '因子' : 'Factor'}<select value={factor} onChange={(event) => setFactor(event.target.value as typeof factor)}>{FACTORS.map((item) => <option key={item.id} value={item.id}>{zh ? item.zh : item.label}</option>)}</select></label>
        <label>{zh ? '周期' : 'Timeframe'}<select value={timeframe} onChange={(event) => setTimeframe(event.target.value as typeof timeframe)}>{TIMEFRAMES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>{zh ? '回看' : 'Lookback'}<select value={lookback} onChange={(event) => setLookback(event.target.value as typeof lookback)}>{['6h', '24h', '7d', '30d'].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>{zh ? '组合' : 'Pair'}<select value={pairFilter} onChange={(event) => { setPairFilter(event.target.value); setSelected(event.target.value === 'all' ? null : event.target.value); }}><option value="all">{zh ? '全部' : 'All'}</option>{(report?.pairs ?? []).map((item) => <option key={item.venues.join('→')} value={item.venues.join('→')}>{item.venues.join(' / ')}</option>)}</select></label>
        <label>{zh ? '最低覆盖' : 'Min coverage'}<select value={minCoverage} onChange={(event) => setMinCoverage(Number(event.target.value))}>{[0, 50, 80].map((item) => <option key={item} value={item}>{item}%</option>)}</select></label>
        <label>{zh ? '排序' : 'Sort'}<select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="samples">{zh ? '样本' : 'Samples'}</option><option value="correlation">{zh ? '相关' : 'Correlation'}</option><option value="lag">Lag</option></select></label>
        <span className="cx-meta">{loading ? (zh ? '读取中…' : 'Loading…') : report ? `${report.venues.length} ${zh ? '个交易所' : 'venues'} · ${report.hypothesesTested} ${zh ? '个假设' : 'hypotheses'}${report.partial ? ' · PARTIAL' : ''}` : '—'}</span>
      </div>
      {error && <p className="alerts-error" role="alert">{error}</p>}
      {report && !report.comparable && (
        <div className="cx-empty"><strong>{zh ? '不可比 / 不可用' : 'Not comparable / unavailable'}</strong><ul>{report.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>
      )}
      {report && report.comparable && (
        <>
          <div className="table-wrap"><table className="cx-table"><thead><tr>
            <th>{zh ? '组合' : 'Pair'}</th><th>{zh ? '领先' : 'Leader'}</th><th>Lag</th><th>Corr</th><th>{zh ? '样本' : 'Samples'}</th><th>OOS</th>
          </tr></thead><tbody>
            {visiblePairs.map((item) => {
              const key = item.venues.join('→');
              return <tr key={key} className={selected === key ? 'selected' : ''} onClick={() => setSelected(key)}>
                <td>{item.venues.join(' / ')}</td>
                <td>{item.leader ?? '—'}{item.follower ? ` → ${item.follower}` : ''}</td>
                <td>{item.lagMs == null ? '—' : `${Math.round(item.lagMs / 1000)}s`}</td>
                <td>{item.correlation == null ? '—' : item.correlation.toFixed(3)}</td>
                <td>{item.samples}</td>
                <td>{pairCoverage(item.venues)}%</td>
                <td><span className="cx-oos">NOT VERIFIED</span></td>
              </tr>;
            })}
          </tbody></table></div>
          {pair && (
            <div className="cx-detail">
              <div className="cx-detail-head"><strong>{pair.venues.join(' / ')}</strong><span>{pair.verdict}</span></div>
              <table><thead><tr><th>{zh ? '方向' : 'Direction'}</th><th>Lag</th><th>Corr</th><th>{zh ? '样本' : 'Samples'}</th></tr></thead><tbody>
                {pair.directions.map((direction) => <tr key={`${direction.from}-${direction.lagMs}`} className={direction.selected ? 'selected' : ''}><td>{direction.from} → {direction.to}</td><td>{Math.round(direction.lagMs / 1000)}s</td><td>{direction.correlation == null ? '—' : direction.correlation.toFixed(3)}</td><td>{direction.samples}</td></tr>)}
              </tbody></table>
              <div className="cx-columns">
                <div><h4>{zh ? '覆盖' : 'Coverage'}</h4><ul>{report.venues.map((venue) => <li key={venue.venue}>{venue.venue}: {venue.samples} · {venue.coveragePct}% · {venue.gaps} gaps</li>)}</ul></div>
                <div><h4>{zh ? '反面证据' : 'Contradicting evidence'}</h4><ul>{(pair.leader ? report.counterEvidence : ['Direction not identifiable']).map((item) => <li key={item}>{item}</li>)}</ul></div>
              </div>
              <p className="cx-note">{report.notes.join(' ')}</p>
              <p className="cx-note">{zh ? '数据窗口' : 'Data window'}: {report.dataWindow.start ? new Date(report.dataWindow.start).toLocaleString() : '—'} → {report.dataWindow.end ? new Date(report.dataWindow.end).toLocaleString() : '—'} · {report.dataWindow.bucketMs / 60_000}m · {zh ? '排除样本' : 'excluded'} {report.excludedSamples} · {zh ? '缺口' : 'gaps'} {report.missingWindows}{report.partial ? ` · ${zh ? '历史被截断，结论可能不完整' : 'history truncated, conclusions may be partial'}` : ''}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
