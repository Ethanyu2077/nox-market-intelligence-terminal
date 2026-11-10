import { useState } from 'react';
import type { WatchRow } from '../shared/watch-overview';

const money = (value: number | null) => value == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value);

/**
 * Statistical aggressor-flow view. Lines encode buy/sell notional, never on-chain or
 * inter-exchange transfers. Projects without trade data show an explicit unavailable node.
 */
export function CapitalFlowVisual({ rows, names, colors, language }: {
  rows: WatchRow[]; names: Map<string, string>; colors: string[]; language: 'zh' | 'en';
}) {
  const zh = language === 'zh';
  const [expanded, setExpanded] = useState<string | null>(null);
  const scale = Math.max(1, ...rows.map((row) => Math.abs(row.flow?.delta ?? 0)));
  return (
    <section className="wo-panel cf-panel">
      <div className="wo-panel-head">
        <h2><i>02</i>{zh ? '资金流向' : 'Capital flow'}</h2>
        <span className="cf-legend">{zh ? '主动买入' : 'Aggressive buy'} <b className="cf-buy">●</b> · {zh ? '主动卖出' : 'Aggressive sell'} <b className="cf-sell">●</b> · {zh ? '线宽=名义成交' : 'width = notional'}</span>
      </div>
      <div className="cf-grid">
        {rows.map((row, index) => {
          const flow = row.flow;
          const color = colors[Math.max(0, index) % colors.length];
          const total = (flow?.buy ?? 0) + (flow?.sell ?? 0);
          const net = flow?.delta ?? null;
          return (
            <div className={`cf-node ${flow ? '' : 'cf-missing'}`} key={row.projectId} title={flow ? `${zh ? '买入' : 'buy'} ${money(flow.buy)} · ${zh ? '卖出' : 'sell'} ${money(flow.sell)} · ${zh ? '净额' : 'net'} ${money(net)} · ${zh ? '现货Δ' : 'spotΔ'} ${money(flow.spotDelta)} · ${zh ? '合约Δ' : 'perpΔ'} ${money(flow.perpDelta)} · source: orderflow` : (zh ? '无主动成交数据' : 'no aggressor-flow data')}>
              <div className="cf-head"><span className="cf-dot" style={{ background: color }} /><strong>{names.get(row.projectId)}</strong><span className={`cf-net ${net != null && net >= 0 ? 'cf-buy' : 'cf-sell'}`}>{net == null ? '—' : money(net)}</span>{flow && flow.venues.length > 0 && <button className="cf-expand" onClick={() => setExpanded(expanded === row.projectId ? null : row.projectId)} aria-expanded={expanded === row.projectId}>{expanded === row.projectId ? '−' : '+'}</button>}</div>
              {flow ? (
                <>
                  <div className="cf-bar"><span className="cf-sell-bar" style={{ width: `${flow.sell == null ? 0 : flow.sell / scale * 50}%` }} /><span className="cf-buy-bar" style={{ width: `${flow.buy == null ? 0 : flow.buy / scale * 50}%` }} /></div>
                  <div className="cf-meta"><span className="cf-buy">{money(flow.buy)}</span><span className="cf-sell">{money(flow.sell)}</span></div>
                  <div className="cf-foot"><span>{zh ? '现货' : 'spot'} {money(flow.spotDelta)}</span><span>{zh ? '合约' : 'perp'} {money(flow.perpDelta)}</span><span>{flow.covered}/{flow.requested} {zh ? '已覆盖' : 'covered'}</span></div>
                  <div className={`cf-stream ${net != null && net >= 0 ? 'cf-buy' : 'cf-sell'}`} style={{ width: `${Math.min(100, total / scale * 100)}%` }} />
                  {expanded === row.projectId && <div className="cf-venues">{flow.venues.map((venue) => <div key={`${venue.exchange}:${venue.marketType}`}><span>{venue.exchange} · {venue.marketType}</span><b className={(venue.delta ?? 0) >= 0 ? 'cf-buy' : 'cf-sell'}>{money(venue.delta)}</b><small>{money(venue.buy)} / {money(venue.sell)}</small></div>)}</div>}
                </>
              ) : <p className="cf-unavailable">{zh ? '主动买卖数据不可用' : 'Aggressor flow unavailable'}</p>}
            </div>
          );
        })}
      </div>
      <p className="cf-note">{zh ? '流线仅表示统计意义上的主动成交方向与规模，不代表链上转账或跨所资金移动。' : 'Streams show statistical aggressor direction and notional only; they are not on-chain transfers or cross-exchange fund movement.'}</p>
    </section>
  );
}
