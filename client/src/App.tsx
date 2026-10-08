import { useEffect, useRef, useState } from 'react';
import { playSfx } from './audio/sound';
import { net } from './net/socket';
import { Lobby } from './pages/Lobby';
import { Room } from './pages/Room';
import { Table } from './pages/Table';
import { BloodTable } from './pages/BloodTable';
import { MinesTable } from './pages/MinesTable';
import type { AnyView } from './net/socket';

export default function App() {
  const [view, setView] = useState<AnyView | null>(net.view);
  const [status, setStatus] = useState(net.status);
  const [toast, setToast] = useState<string | null>(null);
  // toast 定时器互覆问题：两条错误相隔较短时，第一条的定时器会把第二条提前清掉
  const toastTimer = useRef<number | null>(null);
  /**
   * 断线遮罩：连接断开或重连中时屏蔽操作。
   * 此前只有顶部一条 28px 的横幅提示，牌桌/操作栏照常可点 —— 玩家点了「确认出牌」以为生效，
   * 实际 send 在未连接时发不出去（现已在 socket 层给提示，但更需要一开始就点不动）。
   * 延迟 1.5 秒再出现，避免网络抖动时闪一下；被顶号（replaced）不遮：那时玩家需要点「重新连接」。
   */
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (status === 'open' || status === 'replaced') {
      setOffline(false);
      return;
    }
    const t = window.setTimeout(() => setOffline(true), 1500);
    return () => window.clearTimeout(t);
  }, [status]);

  useEffect(() => {
    const offV = net.onView(setView);
    const offS = net.onStatus(setStatus);
    const offE = net.onError((_code, msg) => {
      setToast(msg);
      playSfx('error');
      if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(null), 2600);
    });
    net.start();
    return () => {
      offV();
      offS();
      offE();
      if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  let page;
  if (!view) page = <Lobby connected={status === 'open'} status={status} />;
  else if (view.kind === 'blood') page = <BloodTable view={view} />;
  else if (view.kind === 'mines') page = <MinesTable view={view} />;
  else if (view.phase === 'waiting') page = <Room view={view} />;
  else page = <Table view={view} />;

  return (
    <div className="app">
      {status !== 'open' && (
        <div className="conn-banner">
          {status === 'connecting'
            ? '连接服务器中…'
            : status === 'replaced'
              ? '本房间已在其他窗口打开，此窗口已退回大厅'
              : '连接断开，正在重连…'}
        </div>
      )}
      {page}
      {offline && (
        <div className="offline-veil">
          <div className="offline-card">
            <b>{status === 'connecting' ? '正在连接服务器…' : '连接已断开，正在重连…'}</b>
            <span className="hint">连接恢复后会自动回到你的座位与手牌</span>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
