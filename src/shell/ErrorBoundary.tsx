import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  language?: 'en' | 'zh';
  /** 'app' protects the whole shell; 'page' keeps the shell and only replaces content. */
  level?: 'app' | 'page';
  /** Changing this resets the boundary (e.g. the current page id). */
  resetKey?: string;
}

interface State {
  error: Error | null;
  info: string;
}

/**
 * Render-error containment. Without this, one bad snapshot field in any panel blanks the
 * entire terminal (a white screen with no way back). Page-level boundaries keep the shell
 * and navigation alive; the app-level one is the last resort.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component stack for the report; never include market data or credentials.
    this.setState({ info: (info.componentStack ?? '').slice(0, 1200) });
    console.error('[NOX] render error', error.message);
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null, info: '' });
  }

  private reset = () => this.setState({ error: null, info: '' });

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    const zh = this.props.language === 'zh';
    return (
      <section className={`error-boundary ${this.props.level ?? 'page'}`} role="alert">
        <AlertTriangle size={22} />
        <div className="error-boundary-copy">
          <strong>{zh ? '这个面板渲染失败' : 'This panel failed to render'}</strong>
          <p>{zh
            ? '其余终端功能仍然可用。可以先重试；如果反复出现，把下面的错误信息发给我们。不会提交任何数据。'
            : 'The rest of the terminal is still usable. Retry first; if it repeats, send us the message below. No data was submitted.'}</p>
          <code>{error.message}</code>
          {info && <details><summary>{zh ? '组件堆栈' : 'Component stack'}</summary><pre>{info}</pre></details>}
        </div>
        <div className="error-boundary-actions">
          <button onClick={this.reset}>{zh ? '重试这一页' : 'Retry'}</button>
          <button onClick={() => window.location.reload()}><RefreshCw size={12} />{zh ? '重新加载终端' : 'Reload terminal'}</button>
        </div>
      </section>
    );
  }
}
