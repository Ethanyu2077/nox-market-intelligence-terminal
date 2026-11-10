import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, Menu, Moon, RefreshCw, Search, Sparkles, Sun, UserRound } from 'lucide-react';
import AuthDialog from '../AuthDialog';
import { connectionLabel, type ConnectionState } from './labels';
import type { AuthUser } from './useAuth';

export interface TopbarProps {
  pageLabel: string;
  projectName: string | null;
  onMenu: () => void;
  onOpenPalette: () => void;
  onOpenAi: () => void;
  connection: ConnectionState;
  language: 'en' | 'zh';
  onLanguage: () => void;
  theme: 'dark' | 'light';
  onTheme: () => void;
  onRefresh: () => void;
  loading: boolean;
  user: AuthUser | null;
  onSignOut: () => void | Promise<void>;
}

/**
 * Global chrome. Session state lives here (not in a page strip): a viewer should never
 * lose 40px of vertical space to a sign-in banner on every page.
 */
export function Topbar({ pageLabel, projectName, onMenu, onOpenPalette, onOpenAi, connection, language, onLanguage, theme, onTheme, onRefresh, loading, user, onSignOut }: TopbarProps) {
  const zh = language === 'zh';
  const [menu, setMenu] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [menu]);


  return (
    <>
      <header className="topbar">
        <button className="icon-button menu-button" onClick={onMenu} aria-label={zh ? '打开导航' : 'Open navigation'}><Menu size={16} /></button>
        <div className="crumbs">
          <button onClick={onOpenPalette}>{zh ? '情报' : 'Intelligence'}</button>
          <span>/</span>
          <b>{pageLabel}</b>
        </div>
        <button className="search-trigger" onClick={onOpenPalette} aria-label={zh ? '命令面板' : 'Command palette'}>
          <Search size={13} />
          <span>{projectName ? `${projectName} · ` : ''}{zh ? '搜索项目、页面或操作' : 'Search projects, pages, actions'}</span>
          <kbd>⌘K</kbd>
        </button>
        <div className="topbar-right">
          <button className="ghost-button ai" onClick={onOpenAi} title={zh ? 'DeepSeek 分析（⌘J）' : 'DeepSeek analyst (⌘J)'}>
            <Sparkles size={13} /><span>{zh ? 'AI 分析' : 'Ask AI'}</span>
          </button>
          <div className={`conn ${connection}`} title={zh ? '实时数据连接状态' : 'Live feed status'}><i />{connectionLabel(connection, zh)}</div>
          <div className="clock" title="Asia/Shanghai (UTC+8)"><span>UTC+8</span><Clock /></div>
          <button className="icon-button" onClick={onRefresh} aria-label={zh ? '刷新' : 'Refresh'} title={zh ? '刷新' : 'Refresh'}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
          <button className="icon-button" onClick={onTheme} aria-label={zh ? '切换主题' : 'Toggle theme'} title={zh ? '切换主题' : 'Toggle theme'}>{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}</button>
          <button className="ghost-button" onClick={onLanguage} aria-label={zh ? '切换英文' : '切换中文'} title={zh ? 'Switch to English' : '切换中文'}>{zh ? 'EN' : '中'}</button>
          <div className="account" ref={wrap}>
            <button className="account-trigger" onClick={() => setMenu((value) => !value)} aria-expanded={menu} aria-haspopup="menu">
              <span className="account-avatar">{user ? user.name.slice(0, 1).toUpperCase() : <UserRound size={12} />}</span>
              <span>{user ? (user.isSuperAdmin ? (zh ? '超级管理员' : 'Super administrator') : user.role) : zh ? '访客' : 'Guest'}</span>
              <ChevronDown size={11} />
            </button>
            {menu && (
              <div className="account-menu" role="menu">
                <header>
                  <strong>{user ? user.name : zh ? '只读访客' : 'Read-only guest'}</strong>
                  <small>{user ? (user.isSuperAdmin ? (zh ? '超级管理员' : 'Super administrator') : user.role.toUpperCase()) : zh ? '只读 · 修改需登录' : 'Read-only · sign in to mutate'}</small>
                </header>
                {user
                  ? <button role="menuitem" onClick={() => { setMenu(false); void onSignOut(); }}><LogOut size={13} />{zh ? '退出登录' : 'Sign out'}</button>
                  : <button role="menuitem" onClick={() => { setMenu(false); setAuthOpen(true); }}><UserRound size={13} />{zh ? '登录' : 'Sign in'}</button>}
                <p className="menu-note">{zh ? '项目、密钥与采集中断都可在「设置」中管理。' : 'Projects, credentials and collection are managed in Settings.'}</p>
              </div>
            )}
          </div>
        </div>
      </header>
      {authOpen && <AuthDialog language={language} onClose={() => setAuthOpen(false)} onSuccess={() => { setAuthOpen(false); window.dispatchEvent(new Event('nox:auth-changed')); }} />}
    </>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  return <>{new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now)}</>;
}
