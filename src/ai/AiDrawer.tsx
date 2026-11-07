import { useEffect } from 'react';
import type { MarketProject } from '../../shared/types';
import { AiAssistant } from './AiAssistant';

/** Right-hand analyst drawer available from every page (⌘J). */
export function AiDrawer({ open, project, language, onClose, onExpand }: {
  open: boolean;
  project: MarketProject | null;
  language: 'en' | 'zh';
  onClose: () => void;
  onExpand: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="ai-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ai-drawer" role="dialog" aria-modal="true" aria-label={language === 'zh' ? 'DeepSeek 分析' : 'DeepSeek analyst'}>
        <AiAssistant project={project} language={language} variant="drawer" onClose={onClose} onExpand={onExpand} />
      </div>
    </div>
  );
}
