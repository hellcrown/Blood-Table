import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 渲染期异常兜底。React 18 下未捕获的渲染异常会卸载整棵组件树 —— 玩家只会看到一页空白，
 * 不知道该刷新。包住 App 后至少给出「出错了 + 刷新」的最小出口；对局状态在服务器，
 * 刷新重连后可回到座位，因此刷新是安全的恢复动作。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 留痕便于排查；不弹 toast（toast 体系本身可能就是出错源）
    console.error('[boundary] 渲染异常:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="overlay">
          <div className="panel">
            <h3>页面出错了</h3>
            <p className="hint">
              界面渲染发生异常。你的对局状态保存在服务器上，刷新页面重新连接即可回到座位。
            </p>
            <pre
              style={{ maxHeight: 120, overflow: 'auto', fontSize: 12, opacity: 0.7, whiteSpace: 'pre-wrap' }}
            >
              {String(this.state.error?.message ?? this.state.error)}
            </pre>
            <div className="panel-actions">
              <button className="btn primary" onClick={() => window.location.reload()}>
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
