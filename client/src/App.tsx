import { useEffect, useState } from 'react';
import { playSfx } from './audio/sound';
import { net } from './net/socket';
import { Lobby } from './pages/Lobby';
import { Room } from './pages/Room';
import { Table } from './pages/Table';
import { BloodTable } from './pages/BloodTable';
import type { AnyView } from './net/socket';

export default function App() {
  const [view, setView] = useState<AnyView | null>(net.view);
  const [status, setStatus] = useState(net.status);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const offV = net.onView(setView);
    const offS = net.onStatus(setStatus);
    const offE = net.onError((_code, msg) => {
      setToast(msg);
      playSfx('error');
      window.setTimeout(() => setToast(null), 2600);
    });
    net.start();
    return () => {
      offV();
      offS();
      offE();
    };
  }, []);

  let page;
  if (!view) page = <Lobby connected={status === 'open'} />;
  else if (view.kind === 'blood') page = <BloodTable view={view} />;
  else if (view.phase === 'waiting') page = <Room view={view} />;
  else page = <Table view={view} />;

  return (
    <div className="app">
      {status !== 'open' && (
        <div className="conn-banner">{status === 'connecting' ? '连接服务器中…' : '连接断开，正在重连…'}</div>
      )}
      {page}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
