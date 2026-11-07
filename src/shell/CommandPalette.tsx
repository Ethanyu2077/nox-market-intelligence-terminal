import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import type { MarketProject } from '../../shared/types';
import type { NavGroup } from './Sidebar';

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Option {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * ⌘K command palette: switch project, jump to a page, or run a terminal action without
 * hunting through the sidebar. Keyboard-first, no mouse required.
 */
export function CommandPalette({ open, onClose, projects, currentProjectId, onProject, groups, onPage, actions, language }: {
  open: boolean;
  onClose: () => void;
  projects: MarketProject[];
  currentProjectId: string | null;
  onProject: (id: string) => void;
  groups: NavGroup[];
  onPage: (id: string) => void;
  actions: PaletteAction[];
  language: 'en' | 'zh';
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const zh = language === 'zh';

  const options = useMemo<Option[]>(() => {
    const projectOptions: Option[] = projects.filter((project) => !project.archived).map((project) => ({
      id: `project:${project.id}`,
      group: zh ? '项目' : 'Projects',
      label: project.name,
      hint: project.markets.find((market) => market.id === project.primaryMarketId)?.symbol ?? project.tokenSymbol,
      run: () => onProject(project.id),
    }));
    const pageOptions: Option[] = groups.flatMap((group) => group.items.filter((item) => !item.disabled && item.id !== 'ai').map((item) => ({
      id: `page:${item.id}`,
      group: zh ? '页面' : 'Pages',
      label: item.label,
      hint: group.label,
      run: () => onPage(item.id),
    })));
    const actionOptions: Option[] = actions.map((action) => ({
      id: `action:${action.id}`,
      group: zh ? '操作' : 'Actions',
      label: action.label,
      hint: action.hint,
      run: action.run,
    }));
    return [...projectOptions, ...pageOptions, ...actionOptions];
  }, [projects, groups, actions, onProject, onPage, zh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => `${option.label} ${option.hint ?? ''} ${option.group}`.toLowerCase().includes(needle));
  }, [options, query]);

  useEffect(() => { if (open) { setQuery(''); setSelected(0); } }, [open]);
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => {
    if (!open) return;
    const node = list.current?.querySelector<HTMLElement>('.palette-item.selected');
    node?.scrollIntoView({ block: 'nearest' });
  }, [selected, open]);

  if (!open) return null;

  const runOption = (option: Option | undefined) => {
    if (!option) return;
    onClose();
    requestAnimationFrame(() => option.run());
  };

  let lastGroup = '';
  return (
    <div className="palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={zh ? '命令面板' : 'Command palette'}>
        <div className="palette-input">
          <Search size={15} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={zh ? '搜索项目、页面或操作…' : 'Search projects, pages or actions…'}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); onClose(); }
              if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => Math.min(value + 1, filtered.length - 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
              if (event.key === 'Enter') { event.preventDefault(); runOption(filtered[selected]); }
            }}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="palette-list" ref={list}>
          {filtered.length === 0 && <div className="palette-empty">{zh ? '没有匹配项' : 'No matches'}</div>}
          {filtered.map((option, index) => {
            const header = option.group !== lastGroup ? option.group : null;
            lastGroup = option.group;
            return (
              <div key={option.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  className={`palette-item${index === selected ? ' selected' : ''}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => runOption(option)}
                >
                  <span>{option.label}</span>
                  {option.id === `project:${currentProjectId}` ? <small>{zh ? '当前' : 'current'}</small> : option.hint && <small>{option.hint}</small>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><CornerDownLeft size={11} />{zh ? '执行' : 'run'}</span>
          <span>↑↓ {zh ? '选择' : 'navigate'}</span>
          <span>esc {zh ? '关闭' : 'close'}</span>
        </div>
      </div>
    </div>
  );
}
