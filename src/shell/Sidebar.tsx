import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { connectionLabel, type ConnectionState } from './labels';

export interface NavItem {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: string;
  disabled?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export function Sidebar({
  groups,
  page,
  onNavigate,
  mobileOpen,
  onCloseMobile,
  connection,
  projectCount,
  language,
}: {
  groups: NavGroup[];
  page: string;
  onNavigate: (id: string) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  connection: ConnectionState;
  projectCount: number;
  language: 'en' | 'zh';
}) {
  const zh = language === 'zh';
  return (
    <aside className={`sidebar${mobileOpen ? ' mobile-open' : ''}`} aria-label={zh ? '主导航' : 'Primary navigation'}>
      <div className="brand">
        <div className="brand-mark"><img src="/nox.png" alt="NOX Ventures" /></div>
        <div className="brand-copy"><strong>NOX VENTURES</strong><span>MARKET INTELLIGENCE</span></div>
        <button className="mobile-close" onClick={onCloseMobile} aria-label={zh ? '关闭导航' : 'Close navigation'}><X size={16} /></button>
      </div>
      <nav>
        {groups.map((group) => (
          <div className="nav-group" key={group.label}>
            <span className="nav-label">{group.label}</span>
            {group.items.map((item) => (
              <button
                key={item.id}
                className={`nav-item${page === item.id ? ' active' : ''}`}
                disabled={item.disabled}
                onClick={() => { onNavigate(item.id); onCloseMobile(); }}
                aria-current={page === item.id ? 'page' : undefined}
                title={item.label}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.badge != null && <em className="nav-badge">{item.badge}</em>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className={`sidebar-status ${connection === 'live' || connection === 'polling' ? '' : 'degraded'}`}>
          <i />{connectionLabel(connection, zh)}
        </div>
        <div className="sidebar-meta"><span>{projectCount} {zh ? '个项目' : 'PROJECTS'}</span><span>v0.2</span></div>
      </div>
    </aside>
  );
}
