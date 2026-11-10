import type { WatchRow } from '../shared/watch-overview';
import { deriveFlowEvents } from './flow-events';

export function LiveFlowEvents({ rows, names, end, onOpen, language }: { rows: WatchRow[]; names: Map<string, string>; end: number; onOpen: (id: string) => void; language: 'zh' | 'en' }) {
  const zh = language === 'zh';
  const events = deriveFlowEvents(rows, end);
  return (
    <section className="wo-panel lfe-panel">
      <div className="wo-panel-head"><h2><i>04</i>{zh ? '实时异动' : 'Live flow events'}</h2><span>{zh ? '基于当前窗口的统计信号' : 'Window statistics, not advice'}</span></div>
      {events.length === 0 ? <p className="lfe-empty">{zh ? '当前窗口没有达到阈值的异动' : 'No threshold events in this window'}</p> : (
        <div className="lfe-list">{events.map((event) => (
          <button key={`${event.projectId}:${event.kind}:${event.time}`} className={`lfe-row ${event.tone}`} onClick={() => onOpen(event.projectId)}>
            <span className="lfe-kind">{event.kind}</span><strong>{names.get(event.projectId) ?? event.projectId}</strong>
            <span className="lfe-detail">{event.detail}</span>
            <time>{new Date(event.time).toLocaleTimeString(zh ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</time>
          </button>
        ))}</div>
      )}
    </section>
  );
}
