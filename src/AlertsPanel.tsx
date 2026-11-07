import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Bell, BellOff, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { AlertRule } from '../shared/types';
import type { AlertMetric, AlertsStatus } from '../shared/alerts';
import { ALERT_METRICS } from '../shared/alerts';
import { api } from './api';

const METRIC_UNITS: Record<AlertMetric, { en: string; zh: string; placeholder: string }> = {
  price_change_24h: { en: 'percent, e.g. 5 for +5%', zh: '百分比，例如 5 表示 +5%', placeholder: '5' },
  funding_rate: { en: 'decimal per interval, e.g. 0.0005', zh: '每次结算的小数，例如 0.0005', placeholder: '0.0005' },
  volume_24h_usd: { en: 'USDT notional, e.g. 10000000', zh: 'USDT 名义金额，例如 10000000', placeholder: '10000000' },
};

function formatValue(metric: AlertMetric, value: number): string {
  if (metric === 'price_change_24h') return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  if (metric === 'funding_rate') return `${(value * 100).toFixed(4)}%`;
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

export function AlertsPanel({ language }: { language: 'en' | 'zh' }) {
  const zh = language === 'zh';
  const [status, setStatus] = useState<AlertsStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [symbol, setSymbol] = useState('');
  const [metric, setMetric] = useState<AlertMetric>('price_change_24h');
  const [operator, setOperator] = useState<'gt' | 'lt'>('gt');
  const [threshold, setThreshold] = useState('');

  const load = useCallback(async () => {
    try {
      setStatus(await api<AlertsStatus>('/alerts/status'));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Alerts unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const evaluations = useMemo(() => new Map((status?.evaluations ?? []).map((item) => [item.ruleId, item])), [status]);

  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed'); }
    finally { setBusy(false); }
  };

  const add = () => {
    const value = Number(threshold);
    if (!symbol.trim() || !Number.isFinite(value)) { setError(zh ? '请填写交易对和阈值' : 'Symbol and threshold are required'); return; }
    void mutate(async () => {
      await api('/alerts/rules', { method: 'POST', body: JSON.stringify({ symbol: symbol.trim(), metric, operator, threshold: value, enabled: true }) });
      setSymbol(''); setThreshold('');
    });
  };

  const toggle = (rule: AlertRule) => void mutate(() => api(`/alerts/rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled }) }));
  const remove = (rule: AlertRule) => void mutate(() => api(`/alerts/rules/${rule.id}`, { method: 'DELETE' }));
  const evaluate = () => void mutate(() => api('/alerts/evaluate', { method: 'POST', body: '{}' }));
  const clear = () => void mutate(() => api('/alerts/events/clear', { method: 'POST', body: '{}' }));

  const metricLabel = (id: AlertMetric) => ALERT_METRICS.find((item) => item.id === id)?.[zh ? 'label' : 'label'] ?? id;
  const lastEvaluated = status?.lastEvaluatedAt;

  return (
    <section className="panel alerts-panel">
      <div className="panel-head">
        <div>
          <strong>{zh ? '告警规则与触发记录' : 'Alert rules & triggered events'}</strong>
          <span>
            {zh ? '服务端每 30 秒评估一次，越过阈值时触发一次；同一规则 15 分钟内不重复。' : 'Evaluated server-side every 30s; fires once per crossing, with a 15-minute cooldown.'}
          </span>
        </div>
        <div className="alerts-actions">
          <button onClick={evaluate} disabled={busy} title={zh ? '立即评估' : 'Evaluate now'}><RefreshCw size={12} />{zh ? '立即评估' : 'Evaluate'}</button>
        </div>
      </div>

      <div className="alerts-meta">
        <span><Bell size={12} />{status?.rules.filter((rule) => rule.enabled).length ?? 0} {zh ? '条启用' : 'enabled'}</span>
        <span><Activity size={12} />{lastEvaluated ? `${zh ? '上次评估' : 'last'} ${new Date(lastEvaluated).toLocaleTimeString()}` : (zh ? '尚未评估' : 'not evaluated yet')}</span>
        <span>{status?.events.length ?? 0} {zh ? '条触发记录' : 'events'}</span>
      </div>

      <div className="alerts-form">
        <label>{zh ? '交易对' : 'Symbol'}
          <input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="DOODUSDT" maxLength={30} />
        </label>
        <label>{zh ? '指标' : 'Metric'}
          <select value={metric} onChange={(event) => setMetric(event.target.value as AlertMetric)}>
            {ALERT_METRICS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label>{zh ? '条件' : 'Condition'}
          <select value={operator} onChange={(event) => setOperator(event.target.value as 'gt' | 'lt')}>
            <option value="gt">&gt;</option>
            <option value="lt">&lt;</option>
          </select>
        </label>
        <label>{zh ? '阈值' : 'Threshold'}
          <input value={threshold} onChange={(event) => setThreshold(event.target.value)} placeholder={METRIC_UNITS[metric].placeholder} inputMode="decimal" />
        </label>
        <button className="primary-button" onClick={add} disabled={busy}><Plus size={13} />{zh ? '添加' : 'Add'}</button>
      </div>
      <p className="alerts-hint">{METRIC_UNITS[metric][zh ? 'zh' : 'en']}</p>
      {error && <p role="alert" className="alerts-error">{error}</p>}

      <div className="table-wrap">
        <table className="alerts-table">
          <thead>
            <tr>
              <th>{zh ? '交易对' : 'Symbol'}</th>
              <th>{zh ? '条件' : 'Condition'}</th>
              <th>{zh ? '当前值' : 'Current'}</th>
              <th>{zh ? '状态' : 'Status'}</th>
              <th>{zh ? '最近触发' : 'Last fired'}</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {(status?.rules ?? []).map((rule) => {
              const evaluation = evaluations.get(rule.id);
              const fired = status?.events.find((event) => event.ruleId === rule.id);
              return (
                <tr key={rule.id} className={rule.enabled ? '' : 'disabled'}>
                  <td><strong>{rule.symbol}</strong><small>{metricLabel(rule.metric)}</small></td>
                  <td><span className="mono">{rule.operator === 'gt' ? '>' : '<'} {rule.metric === 'funding_rate' ? `${(rule.threshold * 100).toFixed(4)}%` : rule.threshold}</span></td>
                  <td>{evaluation?.value == null ? '—' : formatValue(rule.metric, evaluation.value)}</td>
                  <td>
                    <span className={`alert-state ${!rule.enabled ? 'off' : evaluation?.state ?? 'ok'}`}>
                      {!rule.enabled ? (zh ? '已停用' : 'disabled') : evaluation?.state === 'unavailable' ? (zh ? '数据不可用' : 'unavailable') : evaluation?.state === 'suppressed' ? (zh ? '已抑制' : 'suppressed') : (zh ? '监控中' : 'armed')}
                    </span>
                    {evaluation?.reason && <small>{evaluation.reason}</small>}
                  </td>
                  <td>{fired ? `${new Date(fired.triggeredAt).toLocaleString()} · ${formatValue(fired.metric, fired.value)}` : '—'}</td>
                  <td>
                    <div className="alerts-row-actions">
                      <button onClick={() => toggle(rule)} disabled={busy} title={rule.enabled ? (zh ? '停用' : 'Disable') : (zh ? '启用' : 'Enable')}>{rule.enabled ? <BellOff size={12} /> : <Bell size={12} />}</button>
                      <button className="danger" onClick={() => remove(rule)} disabled={busy} title={zh ? '删除' : 'Delete'}><Trash2 size={12} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {status && !status.rules.length && (
              <tr><td colSpan={6} className="alerts-empty">{zh ? '还没有规则。添加一条：例如 DOODUSDT 的 24h 涨跌幅 > 5%。' : 'No rules yet. Add one, e.g. DOODUSDT 24h change > 5%.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="alerts-events">
        <div className="alerts-events-head">
          <strong>{zh ? '触发记录（最近 20 条）' : 'Triggered events (latest 20)'}</strong>
          {!!status?.events.length && <button onClick={clear} disabled={busy}>{zh ? '清空' : 'Clear'}</button>}
        </div>
        {(status?.events ?? []).slice(0, 20).map((event) => (
          <article key={event.id}>
            <span className="alert-dot" />
            <div>
              <strong>{event.symbol} · {metricLabel(event.metric)} {event.operator === 'gt' ? '>' : '<'} {event.threshold}</strong>
              <small>{new Date(event.triggeredAt).toLocaleString()} · {formatValue(event.metric, event.value)} · {event.source}</small>
            </div>
          </article>
        ))}
        {status && !status.events.length && <p className="alerts-empty">{zh ? '暂无触发。缺失指标不会被当作 0 处理。' : 'No events yet. Missing metrics are never treated as zero.'}</p>}
      </div>
    </section>
  );
}
