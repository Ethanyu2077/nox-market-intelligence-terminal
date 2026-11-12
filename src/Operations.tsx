import { useCallback, useEffect, useState } from 'react';
import AuthDialog from './AuthDialog';
import type { MarketProject } from '../shared/types';
import type { RegimeSignal } from '../server/regime';
import type { DataCoverageResponse, VenueCoverageResponse } from '../shared/coverage';

function signalText(value: string, zh: boolean) {
  if (!zh) return value;
  const dictionary: Record<string,string> = {
    'Insufficient evidence':'证据不足', 'Mixed / neutral':'混合 / 中性', 'Potential long build-up':'潜在多头建仓', 'Potential short build-up':'潜在空头建仓', 'Potential deleveraging':'潜在去杠杆', 'Potential short covering':'潜在空头回补', 'Potential absorption':'潜在市场吸收',
    'OI does not identify the owners or opening/closing side of individual positions.':'OI 无法识别持仓归属，也无法直接判断单笔仓位的开仓或平仓方向。',
    'Heuristic score is not a calibrated probability; no execution recommendation.':'启发式评分不是校准概率，不提供执行建议。',
    'Repeated evaluations overlap; samples are not independent.':'重复评价的观察窗口重叠，样本并非相互独立。',
    'Perpetual snapshot within 90s before the closed 5m boundary':'已闭合5分钟窗口边界之前90秒内的永续快照',
    'Fresh perpetual snapshot (<90s)':'90秒内的永续快照',
    'Same-venue 5-minute baseline (maximum 90s timing tolerance)':'同一交易场所的5分钟基线（最多90秒时间容差）',
    'Comparable price':'可比较的价格', 'Comparable token-quantity OI':'可比较的代币数量 OI',
    'Complete aligned 5-minute aggressor flow':'完整且对齐的5分钟主动成交数据', 'Complete selected-spot flow':'已选现货市场的完整主动成交数据',
    'Historical depth/basis and complete liquidation coverage are not available to this rule version':'此规则版本尚无历史深度 / 基差和完整清算覆盖',
    'Spot and perpetual aggressive flow disagree.':'现货与永续主动成交方向相互矛盾。',
    'Liquidation cascade is NOT confirmed by this classification.':'此分类不代表已确认发生清算瀑布。',
  };
  if (dictionary[value]) return dictionary[value];
  return value.replace('Closed analytical window ends ', '已闭合分析窗口结束于 ').replace('; snapshots have up to 90s boundary tolerance.', '；快照边界允许最多90秒容差。').replace('Same-venue price change ', '同场所价格变化 ').replace('Token OI change ', '代币数量 OI 变化 ').replace(' (not USD revaluation)', '（不是美元估值变化）').replace('Closed 5m aggressor volume delta ', '已闭合5分钟主动成交量差 ');
}

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? 'Request failed'); return data;
}
export function AccessBar({ language, onRoleChange }: { language: string; onRoleChange?: (role: string | null) => void }) {
  const zh = language === 'zh';
  const [status, setStatus] = useState<{ user: { name: string; role: string; isSuperAdmin:boolean } | null } | null>(null);
  const [error,setError] = useState('');
  const [open,setOpen] = useState(false);
  const refresh = useCallback(() => { void request<typeof status>('/auth/status').then(value=>{setStatus(value);onRoleChange?.(value?.user?.role??null);setError('');window.dispatchEvent(new Event('nox:auth-changed'));}).catch(() => {onRoleChange?.(null);setError(zh ? '认证状态不可用' : 'Authentication unavailable');}); }, [zh,onRoleChange]);
  useEffect(() => {
    refresh();
    const login=()=>{setOpen(true);};
    window.addEventListener('nox:auth-required',login);
    return()=>window.removeEventListener('nox:auth-required',login);
  },[refresh]);
  return <section className="ops-access"><div><span>{status?.user ? `${status.user.name} · ${status.user.isSuperAdmin?(zh?'超级管理员':'Super administrator'):status.user.role}` : zh ? '只读访问 · 修改项目需要登录' : 'Read-only · sign in to change projects'}</span>
    <button onClick={()=>status?.user?void request('/auth/logout',{}).then(refresh).catch(()=>setError(zh?'退出失败，请重试':'Sign out failed; please retry')):setOpen(true)}>{status?.user?(zh?'退出':'Sign out'):(zh?'登录':'Sign in')}</button>
    </div>{error&&<p role="alert">{error}</p>}{open&&<AuthDialog language={language} onClose={()=>setOpen(false)} onSuccess={refresh}/>}
  </section>;
}

type Operations = { storage: { mode: string; connected: boolean; error: string | null; databaseRowsAcknowledged: number }; archiveError: string | null; collectors: { projectId: string; mode: string; checkedAt: number | null; error: string | null }[] };
export function CollectionPanel({ projects, language, onRefresh }: { projects: MarketProject[]; language: string; onRefresh: () => void }) {
  const zh = language === 'zh', [data, setData] = useState<Operations | null>(null), [error, setError] = useState('');
  useEffect(() => { const load = () => void request<Operations>('/operations').then(setData).catch(e => setError(String(e))); load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, []);
  const change = async (project: MarketProject, mode: string) => {
    try { const response = await fetch(`/api/projects/${project.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monitoring: { collectionMode: mode, streamingEnabled: mode !== 'paused' } }) }); const body = await response.json(); if (!response.ok) { if (response.status === 401) window.dispatchEvent(new Event('nox:auth-required')); throw new Error(body.error?.message); } onRefresh(); setError(''); } catch (e) { setError(String(e)); }
  };
  return <section className="ops-panel"><h2>{zh ? '后台采集与历史存储' : 'Background collection & historical storage'}</h2><p>{zh ? 'Active：持续订单流 + 每30秒快照。Standard：每5分钟快照，订单流按页面需求订阅。Paused：停止后台采集。重启后自动恢复；服务进程必须保持运行。' : 'Active: continuous order flow + 30s snapshots. Standard: 5m snapshots; order flow on page demand. Paused: background collection off. Restored after restart; the server process must remain running.'}</p><div className="ops-status">{data?.storage.mode ?? '…'} · {data?.storage.connected ? 'TimescaleDB connected' : zh ? '本地持久化（未验证数据库连接）' : 'Local persistence (database not connected)'}<br/>{data?.storage.error}{data?.archiveError}</div>
    <div className="table-wrap"><table><thead><tr><th>{zh ? '项目' : 'Project'}</th><th>{zh ? '采集模式' : 'Collection mode'}</th><th>{zh ? '最近快照' : 'Last snapshot'}</th><th>{zh ? '状态' : 'Status'}</th></tr></thead><tbody>{projects.filter(p => !p.archived).map(project => { const state = data?.collectors.find(c => c.projectId === project.id); return <tr key={project.id}><td>{project.name}</td><td><select aria-label={`${project.name} collection mode`} value={project.monitoring.streamingEnabled ? project.monitoring.collectionMode ?? 'standard' : 'paused'} onChange={e => void change(project, e.target.value)}>{['active','standard','paused'].map(mode => <option key={mode} value={mode}>{mode === 'active' ? 'Active' : mode === 'standard' ? 'Standard' : 'Paused'}</option>)}</select></td><td>{state?.checkedAt ? new Date(state.checkedAt).toLocaleString(zh ? 'zh-CN' : 'en') : '—'}</td><td>{state?.error ?? (state?.mode === 'paused' ? zh ? '已暂停' : 'Paused' : zh ? '仅已选市场' : 'Selected markets only')}</td></tr>; })}</tbody></table></div>{error && <p role="alert">{error}</p>}<p>{zh ? '历史深度、完整清算和未支持的源仍标为不可用。系统按保留期限和容量上限清理本地历史日志。需要长期留存的记录请单独备份。' : 'Historical depth, complete liquidations and unsupported sources remain unavailable. Local history journals are pruned by age and size. Back up records that require longer retention.'}</p></section>;
}

export function DataCoveragePanel({ projects, language }: { projects: MarketProject[]; language: string }) {
  const zh = language === 'zh';
  const [rows, setRows] = useState<Array<{ project: MarketProject; coverage: DataCoverageResponse }>>([]);
  useEffect(() => {
    let active = true;
    const load = () => {
      const targets = projects.filter((project) => !project.archived).slice(0, 5);
      void Promise.allSettled(targets.map((project) => request<DataCoverageResponse>(`/projects/${project.id}/data-coverage`).then((coverage) => ({ project, coverage })))).then((results) => {
        if (!active) return;
        setRows(results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []));
      });
    };
    load(); const timer = setInterval(load, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [projects]);
  return <section className="ops-panel"><h2>{zh ? '本地采集覆盖' : 'Local collection coverage'}</h2>
    <p>{zh ? '根据最近的历史记录检查快照、成交量矩阵和周期一致性判断的采集情况。开启逐笔成交归档后也会检查成交记录。缺口表示该时段的采集连续性尚未验证。' : 'Coverage uses recent snapshots, volume records and alignment decisions. Trade records are checked when raw trade archiving is enabled. Gaps indicate periods of unverified collection.'}</p>
    <div className="table-wrap"><table><thead><tr>{['Project', 'Stream', 'Sampled', 'Last ingest', 'Gaps', 'State'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>
      {rows.flatMap(({ project, coverage }) => coverage.kinds.map((kind) => <tr key={`${project.id}:${kind.kind}`}>
        <td>{project.name}<small>{coverage.mode}</small></td>
        <td>{kind.kind}</td>
        <td>{kind.state === 'disabled' ? '—' : kind.sampledEvents}</td>
        <td>{kind.lastIngestAgeMs == null ? '—' : `${Math.round(kind.lastIngestAgeMs / 1000)}s`}</td>
        <td>{kind.state === 'disabled' ? '—' : kind.gaps}</td>
        <td><span className={`coverage-badge ${kind.state}`}>{kind.state === 'disabled' ? (zh ? '归档已关闭' : 'Archive off') : kind.state}</span></td>
      </tr>))}
      {!rows.length && <tr><td colSpan={6}>{zh ? '等待本地采集数据。' : 'Awaiting local collection data.'}</td></tr>}
    </tbody></table></div>
    <p>{rows.flatMap(({ coverage }) => coverage.summary.notes).filter(Boolean).join(' · ') || (zh ? '所有必需事件流均有本地样本。' : 'All required streams have local samples.')}</p>
  </section>;
}

export function VenueCoveragePanel({ projects, language }: { projects: MarketProject[]; language: string }) {
  const zh = language === 'zh';
  const [rows, setRows] = useState<Array<{ project: MarketProject; coverage: VenueCoverageResponse }>>([]);
  useEffect(() => {
    let active = true;
    const load = () => {
      const targets = projects.filter((project) => !project.archived).slice(0, 5);
      void Promise.allSettled(targets.map((project) => request<VenueCoverageResponse>(`/projects/${project.id}/venue-coverage`).then((coverage) => ({ project, coverage })))).then((results) => {
        if (!active) return;
        setRows(results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []));
      });
    };
    load(); const timer = setInterval(load, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [projects]);
  return <section className="ops-panel"><h2>{zh ? '交易所采集覆盖（本地记录）' : 'Venue coverage (local records)'}</h2>
    <p>{zh ? '从本地 volume 记录检查每个所选交易所是否真的返回了现货/永续腿、最后质量与失败次数；缺失腿显式标注，不填零。' : 'Reads persisted volume records to show whether each selected venue actually returned spot/perpetual legs, the last quality and failure count. Missing legs stay explicit, never zero-filled.'}</p>
    <div className="table-wrap"><table><thead><tr>{['Project', 'Venue', 'Spot', 'Perp', 'Failures', 'State'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>
      {rows.flatMap(({ project, coverage }) => coverage.venues.map((venue) => <tr key={`${project.id}:${venue.exchange}`}>
        <td>{project.name}<small>{coverage.points} {zh ? '个样本' : 'records'}</small></td>
        <td><strong>{venue.exchange.toUpperCase()}</strong></td>
        <td>{venue.expectedSpot ? `${venue.spotSamples}${venue.spotQuality ? ` · ${venue.spotQuality}` : ''}` : '—'}</td>
        <td>{venue.expectedPerp ? `${venue.perpSamples}${venue.perpQuality ? ` · ${venue.perpQuality}` : ''}` : '—'}</td>
        <td>{coverage.failures.filter((failure) => failure.exchange === venue.exchange).reduce((sum, failure) => sum + failure.count, 0)}</td>
        <td><span className={`coverage-badge ${venue.state === 'both' ? 'live' : venue.state === 'missing' ? 'empty' : 'partial'}`}>{venue.state}</span></td>
      </tr>))}
      {!rows.length && <tr><td colSpan={6}>{zh ? '等待本地 volume 记录。' : 'Awaiting local volume records.'}</td></tr>}
    </tbody></table></div>
    <p>{rows.flatMap(({ coverage }) => coverage.summary.missingLegs).filter(Boolean).join(' · ') || (zh ? '所有所选交易所至少各条腿都有本地样本。' : 'Every selected venue has at least one sample for each expected leg.')}</p>
  </section>;
}

type Lab = { rows: { id: string; timestamp: number; label: string; complete: boolean; priceReturnPct: number | null; researchDirectionalReturnAfterCostsPct: number | null; sampledMfePct: number | null; sampledMaePct: number | null; samples: number; cohort: string }[]; coverage: { recorded: number; evaluated: number }; methodology: string[] };
export function SignalLabPage({ project, language, historical }: { project: MarketProject; language: string; historical: boolean }) {
  const zh = language === 'zh', [signals, setSignals] = useState<RegimeSignal[]>([]), [lab, setLab] = useState<Lab | null>(null), [horizon, setHorizon] = useState(60), [cost, setCost] = useState(10), [error, setError] = useState('');
  useEffect(() => { const load = () => { void Promise.all([request<{ items: RegimeSignal[] }>(`/projects/${project.id}/regimes`), request<Lab>(`/projects/${project.id}/signal-lab?horizon=${horizon}&costBps=${cost}`)]).then(([s,l]) => { setSignals(s.items); setLab(l); setError(''); }).catch(e => setError(String(e))); }; load(); const timer = setInterval(load, 15_000); return () => clearInterval(timer); }, [project.id,horizon,cost]);
  const latest = signals.at(-1), n = (v: number | null | undefined) => v == null ? '—' : `${v.toFixed(3)}%`;
  return <section className="ops-panel"><h1>{historical ? 'Signal Lab' : zh ? '市场结构信号' : 'Market structure signals'}</h1><p>{zh ? '已记录事实与统计推断严格区分。置信度是启发式评分，不是已校准概率，不构成交易建议。' : 'Observed inputs and statistical inferences are distinct. Confidence is a heuristic, not a calibrated probability or trading advice.'}</p>{!historical && <p>{zh ? '此页显示历史 v1 规则引擎记录，用于回放；它不经过 Position Flow 的证据门槛（完整主动成交覆盖 / 逐事件爆仓 / L2 深度）。带“证据不足·已抑制”的 Position Flow 标签才是当前研究口径。' : 'This page replays legacy v1 rule-engine records. They do NOT pass the Position Flow evidence gates (complete aggressor-flow coverage / per-event liquidations / L2 depth). Position Flow labels marked withheld are the current research contract.'}</p>}{error && <p role="alert">{error}</p>}
    {!historical && <>{latest ? <><h2>{signalText(latest.label, zh)}</h2><p>{zh ? '启发式置信度' : 'Heuristic confidence'}: {latest.heuristicConfidence == null ? '—' : `${Math.round(latest.heuristicConfidence*100)} / 100`} · {new Date(latest.timestamp).toLocaleString()} · {latest.venue ?? '—'}</p><div className="ops-evidence"><article><h3>{zh ? '已观测输入' : 'Observed inputs'}</h3>{latest.evidence.map(s => <p key={s}>{signalText(s, zh)}</p>)}</article><article><h3>{zh ? '反向证据与边界' : 'Counterevidence & boundaries'}</h3>{latest.counterevidence.map(s => <p key={s}>{signalText(s, zh)}</p>)}</article><article><h3>{zh ? '缺失或不完整数据' : 'Missing / incomplete data'}</h3>{latest.missing.map(s => <p key={s}>{signalText(s, zh)}</p>)}</article></div></> : <p>{zh ? '等待真实采集样本，不生成演示信号。' : 'Waiting for real collection samples. No demo signals.'}</p>}</>}
    <div className="ops-controls"><label>{zh ? '观察周期' : 'Forward horizon'} <select value={horizon} onChange={e => setHorizon(Number(e.target.value))}>{[5,15,60,240,1440].map(m => <option key={m} value={m}>{m} min</option>)}</select></label><label>{zh ? '往返成本假设（bps）' : 'Round-trip cost assumption (bps)'} <input type="number" min="0" max="1000" value={cost} onChange={e => setCost(Math.max(0, Math.min(1000, Number(e.target.value))))}/></label><span>{zh ? '可评估 / 已记录' : 'Evaluated / recorded'}: {lab?.coverage.evaluated ?? '—'} / {lab?.coverage.recorded ?? '—'}</span></div>
    <div className="table-wrap"><table><thead><tr><th>{zh ? '记录时间' : 'Recorded at'}</th><th>{zh ? '推断' : 'Inference'}</th><th>{zh ? '价格收益' : 'Price return'}</th><th>{zh ? '方向情景净收益' : 'Directional scenario net'}</th><th>MFE / MAE*</th><th>{zh ? '样本 / 状态' : 'Samples / status'}</th></tr></thead><tbody>{lab?.rows.slice(-100).reverse().map(row => <tr key={row.id}><td>{new Date(row.timestamp).toLocaleString()}</td><td>{signalText(row.label, zh)}</td><td>{n(row.priceReturnPct)}</td><td>{n(row.researchDirectionalReturnAfterCostsPct)}</td><td>{n(row.sampledMfePct)} / {n(row.sampledMaePct)}</td><td>{row.samples} · {row.complete ? zh ? '路径合格' : 'Path eligible' : zh ? '未到期 / 数据不足' : 'Pending / insufficient'}</td></tr>)}</tbody></table></div><p>{zh ? '* MFE/MAE 仅基于快照采样，不是真实逐笔极值。最近7天标记为时间留出候选，不代表已通过样本外验证。只使用截止时点之前已入库的数据；历史不足时保持空值。' : '* MFE/MAE are snapshot-sampled, not tick extremes. Last 7 days are temporal holdout candidates, not validated out-of-sample results. Only data ingested by the cutoff are eligible; insufficient history stays null.'}</p></section>;
}
