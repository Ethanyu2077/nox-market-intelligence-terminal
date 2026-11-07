import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ExchangeSelection, MarketProject, Overview, ProjectMarket } from '../../shared/types';

const EXCHANGES: Array<{ id: ExchangeSelection; label: string }> = [
  { id: 'aggregated', label: 'Aggregated' },
  { id: 'binance', label: 'Binance' },
  { id: 'bitget', label: 'Bitget' },
  { id: 'bybit', label: 'Bybit' },
  { id: 'okx', label: 'OKX' },
  { id: 'gate', label: 'Gate' },
  { id: 'kucoin', label: 'KuCoin' },
  { id: 'mexc', label: 'MEXC' },
];

const INTERVALS = ['1m', '5m', '15m', '1h', '4h'] as const;

function price(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 5 : 7;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

function compact(value: number | null | undefined, prefix = ''): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return prefix + Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/**
 * The market strip is the terminal's persistent context: whatever page you are on, the
 * instrument, price, funding and freshness stay visible and the timeframe is one click away.
 */
export function MarketBar({ project, primary, overview, coverage, exchange, onExchange, interval, onInterval, lastEvent, language, onSwitchProject }: {
  project: MarketProject | null;
  primary: ProjectMarket | null;
  overview: Overview | null;
  coverage: { successful: number; requested: number } | null;
  exchange: ExchangeSelection;
  onExchange: (value: ExchangeSelection) => void;
  interval: string;
  onInterval: (value: '1m' | '5m' | '15m' | '1h' | '4h') => void;
  lastEvent: number;
  language: 'en' | 'zh';
  onSwitchProject: () => void;
}) {
  const zh = language === 'zh';
  const change = overview?.change24hPct ?? null;
  const tone = change == null ? '' : change >= 0 ? 'up' : 'down';
  const stale = lastEvent > 0 && Date.now() - lastEvent > 60_000;
  const age = overview?.eventTime ? Math.max(0, Math.round((Date.now() - overview.eventTime) / 1000)) : null;

  return (
    <div className="marketbar" role="region" aria-label={zh ? '行情概览' : 'Market context'}>
      <button className="mb-instrument" onClick={onSwitchProject} title={zh ? '切换项目（⌘K）' : 'Switch project (⌘K)'} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit' }}>
        <span className="mb-symbol">{primary?.symbol ?? project?.tokenSymbol ?? (zh ? '未选择' : 'NO PROJECT')}</span>
        <span className="mb-venue">{primary ? `${primary.exchange.toUpperCase()} · ${primary.marketType === 'perpetual' ? 'PERP' : 'SPOT'}` : '—'}</span>
        {project && <span className="mb-project" style={{ font: '10px var(--mono)', color: 'var(--muted)' }}>{project.name}</span>}
        <ChevronDown size={11} style={{ color: 'var(--faint)' }} />
      </button>

      <div className="mb-stat pnl">
        <span>{zh ? '最新价' : 'Last'}</span>
        <strong className={tone}>{price(overview?.price)}</strong>
        <small className={tone}>{pct(change)}</small>
      </div>
      <div className="mb-stat">
        <span>{zh ? '24H 成交' : '24H Vol'}</span>
        <strong>{compact(overview?.volume24hUsd, '$')}</strong>
        <small>{overview?.volume24hBase ? `${compact(overview.volume24hBase)} ${primary?.base ?? ''}` : '—'}</small>
      </div>
      <div className="mb-stat">
        <span>{zh ? '持仓量' : 'Open interest'}</span>
        <strong>{compact(overview?.oiUsd, '$')}</strong>
        <small>{overview?.oiBase ? `${compact(overview.oiBase)} ${primary?.base ?? ''}` : '—'}</small>
      </div>
      <div className="mb-stat nn pnl">
        <span>{zh ? '资金费率' : 'Funding'}</span>
        <strong className={overview?.fundingRate == null ? '' : overview.fundingRate >= 0 ? 'up' : 'down'}>{overview?.fundingRate == null ? '—' : `${overview.fundingRate > 0 ? '+' : ''}${(overview.fundingRate * 100).toFixed(4)}%`}</strong>
        <small><Countdown target={overview?.nextFundingTime} language={language} /></small>
      </div>
      <div className="mb-stat nn">
        <span>{zh ? '标记价' : 'Mark'}</span>
        <strong>{price(overview?.markPrice)}</strong>
        <small>{overview?.markPrice && overview?.price ? `${(((overview.markPrice - overview.price) / overview.price) * 10_000).toFixed(1)} bps` : '—'}</small>
      </div>

      <div className="mb-spacer" />

      <div className="mb-controls">
        <span className={`wl-tag ${coverage && coverage.successful < coverage.requested ? 'partial' : 'live'}`} title={zh ? '覆盖的交易场所' : 'Venue coverage'}>
          {coverage ? `${coverage.successful}/${coverage.requested} ${zh ? '场所' : 'venues'}` : '—'}
        </span>
        <span className={`wl-tag ${stale ? 'stale' : 'live'}`} title={zh ? '数据新鲜度' : 'Data freshness'}>{age == null ? '—' : stale ? `${Math.round(age / 60)}m` : `${age}s`}</span>
        <div className="mb-select">
          <select value={exchange} onChange={(event) => onExchange(event.target.value as ExchangeSelection)} aria-label={zh ? '交易所' : 'Exchange'}>
            {EXCHANGES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
        <div className="segmented" role="group" aria-label={zh ? '时间周期' : 'Timeframe'}>
          {INTERVALS.map((value) => (
            <button key={value} className={interval === value ? 'active' : ''} onClick={() => onInterval(value)}>{value.toUpperCase()}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Countdown({ target, language }: { target: number | null | undefined; language: 'en' | 'zh' }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  if (!target) return <>{language === 'zh' ? '下次 —' : 'next —'}</>;
  const remaining = Math.max(0, target - now);
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return <>{language === 'zh' ? '倒计时 ' : 'in '}{String(hours).padStart(2, '0')}:{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}</>;
}
