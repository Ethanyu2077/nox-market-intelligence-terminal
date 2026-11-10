import type { WatchRow } from '../shared/watch-overview';
import { buildWatchMetrics } from '../shared/watch-overview';

const money = (value: number | null) => value == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
const pct = (value: number | null) => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

export function FlowCards({ rows, names, end, language }: { rows: WatchRow[]; names: Map<string, string>; end: number; language: 'zh' | 'en' }) {
  const zh = language === 'zh';
  return (
    <section className="wo-panel fc-panel">
      <div className="wo-panel-head"><h2><i>03</i>{zh ? '项目流动' : 'Project flow'}</h2><span>{zh ? '真实主动成交与 OI 变化' : 'Real aggressor flow and OI change'}</span></div>
      <div className="fc-grid">
        {rows.map((row) => {
          const oi = row.oiSeries?.filter((point) => point.time >= end - 3600_000) ?? [];
          const oiChange = oi.length > 1 && oi[0].oiUsd > 0 ? (oi.at(-1)!.oiUsd / oi[0].oiUsd - 1) * 100 : null;
          const price = row.candles.length > 1 ? (row.candles.at(-1)!.close / row.candles[0].close - 1) * 100 : null;
          const flow = row.flow;
          const funded = row.funding ? row.funding.rate * 100 * 8 / row.funding.hours : null;
          return (
            <article className="fc-card" key={row.projectId}>
              <header><strong>{names.get(row.projectId)}</strong><span>{row.symbol} · {row.venue}</span></header>
              <dl>
                <div><dt>{zh ? '价格' : 'Price'}</dt><dd className={(price ?? 0) >= 0 ? 'up' : 'down'}>{pct(price)}</dd></div>
                <div><dt>OI Δ 1h</dt><dd className={(oiChange ?? 0) >= 0 ? 'up' : 'down'}>{pct(oiChange)}</dd></div>
                <div><dt>Funding</dt><dd>{funded == null ? '—' : `${funded.toFixed(4)}%`}</dd></div>
                <div><dt>{zh ? '现货 Δ' : 'Spot Δ'}</dt><dd>{money(flow?.spotDelta ?? null)}</dd></div>
                <div><dt>{zh ? '合约 Δ' : 'Perp Δ'}</dt><dd>{money(flow?.perpDelta ?? null)}</dd></div>
                <div><dt>CVD</dt><dd>{money(flow?.cvd ?? null)}</dd></div>
              </dl>
              <footer className={flow ? '' : 'muted'}>{flow ? `${flow.covered}/${flow.requested} ${zh ? '覆盖' : 'covered'}` : (zh ? '主动成交不可用' : 'Aggressor flow unavailable')}</footer>
              <div className="fc-metrics">{Object.entries(buildWatchMetrics(row)).map(([name, metric]) => <span key={name} className={metric.state === 'LIVE' ? 'ok' : 'off'} title={`${name} · ${metric.state}${metric.at ? ` · ${new Date(metric.at).toLocaleTimeString()}` : ''}${metric.error ? ` · ${metric.error}` : ''}${metric.source ? ` · ${metric.source}` : ''}`}>{name}</span>)}</div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
