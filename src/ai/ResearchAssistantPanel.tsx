import { useState } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import type { MarketProject } from '../../shared/types';
import type { ResearchReport } from '../../shared/research';
import { AiAssistant } from './AiAssistant';

/**
 * Research panel: DeepSeek conversation on the left tab, the deterministic evidence
 * report on the right. The report is a plain GET and never depends on the model, so the
 * numbers a user checks are always the server's.
 */
export function ResearchAssistantPanel({ project, language }: { project: MarketProject; language: 'en' | 'zh' }) {
  const zh = language === 'zh';
  const [tab, setTab] = useState<'ai' | 'evidence'>('ai');
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadReport = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/projects/${project.id}/research/analysis`);
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? 'Evidence report failed');
      setReport(body as ResearchReport);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Evidence report failed');
    } finally { setBusy(false); }
  };

  return (
    <div className="research-panel">
      <div className="research-panel-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'ai'} className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}><Sparkles size={12} />DeepSeek</button>
        <button role="tab" aria-selected={tab === 'evidence'} className={tab === 'evidence' ? 'active' : ''} onClick={() => setTab('evidence')}><FileText size={12} />{zh ? '证据报告' : 'Evidence'}</button>
      </div>
      {tab === 'ai' ? (
        <div className="research-ai-host"><AiAssistant project={project} language={language} variant="panel" /></div>
      ) : (
        <div className="research-evidence">
          <button className="evidence-load" disabled={busy} onClick={() => void loadReport()}>{busy ? (zh ? '读取中…' : 'Reading…') : (zh ? '生成确定性证据报告（只读）' : 'Generate deterministic evidence report')}</button>
          {error && <p role="alert" className="research-error">{error}</p>}
          {!report && !busy && <p className="research-muted">{zh ? '证据报告由服务端确定性工具生成，不调用任何模型。' : 'The evidence report is produced by deterministic server tools. No model is called.'}</p>}
          {report && (
            <>
              <p className="research-muted">{report.mode} · {new Date(report.generatedAt).toLocaleString()} · {report.tools.join(' / ')}</p>
              {(['observed', 'inferences', 'hypotheses', 'limitations'] as const).map((section) => (
                <section key={section}>
                  <h3>{(zh ? ['已观测事实', '统计推断（未校准）', '待验证假设', '缺失或延迟数据'] : ['Observed facts', 'Statistical inferences (uncalibrated)', 'Hypotheses', 'Missing or stale data'])[['observed', 'inferences', 'hypotheses', 'limitations'].indexOf(section)]}</h3>
                  {report[section].length
                    ? report[section].map((claim, index) => <p key={index}>{claim.text} {claim.sources.length > 0 && <small>{claim.sources.join(' · ')}</small>}</p>)
                    : <p>—</p>}
                </section>
              ))}
              {report.metricDependencies?.length > 0 && (
                <section>
                  <h3>{zh ? '指标依赖（非独立确认）' : 'Metric dependencies (not independent confirmations)'}</h3>
                  {report.metricDependencies.map((dependency) => (
                    <p key={dependency.metric}><strong>{dependency.metric}</strong> · {dependency.role} · {zh ? '依赖' : 'depends on'} {dependency.dependsOn.join(', ') || '—'} <small>{dependency.caveat}</small></p>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
