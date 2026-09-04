import { useEffect, useState } from 'react';
import { net } from '../net/socket';
import { AdminPanel } from '../components/AdminPanel';

export function Lobby({ connected }: { connected: boolean }) {
  const [name, setName] = useState(net.loadName());
  const [code, setCode] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(2);
  const [mode, setMode] = useState<'blood' | 'classic'>('blood');
  const [adminOpen, setAdminOpen] = useState(false);

  const nameOk = name.trim().length > 0;

  /** 粘贴识别：支持直接粘贴邀请文本（网址 — 血色牌局房间码：XXXX），自动提取房间码 */
  const applyCode = (raw: string): void => {
    const m = /房间码\s*[：:]\s*([A-Z0-9]{4})/i.exec(raw);
    if (m) {
      setCode(m[1].toUpperCase());
      return;
    }
    setCode(raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4));
  };

  // 深链支持：?room=CODE 或 /CODE 直接预填房间码
  useEffect(() => {
    const m = /[?&]room=([A-Za-z0-9]{4})/.exec(location.search) ?? /^\/([A-Za-z0-9]{4})\/?$/.exec(location.pathname);
    if (m) setCode(m[1].toUpperCase());
  }, []);

  const create = () => {
    net.saveName(name.trim());
    net.send({ t: 'create', name: name.trim(), maxPlayers, mode });
  };
  const join = () => {
    net.saveName(name.trim());
    net.send({ t: 'join', name: name.trim(), code: code.trim().toUpperCase() });
  };

  return (
    <div className="lobby">
      <div className="lobby-card">
        <h1 className="title">
          血色牌局<span className="title-dot">·</span>
          <small>德州扑克联机</small>
        </h1>
        <p className="subtitle">2-4 人 · 建房后把房间码告诉朋友即可开局</p>

        <label className="field">
          <span>你的昵称</span>
          <input
            value={name}
            maxLength={12}
            placeholder="给自己起个名字"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="lobby-actions">
          <div className="create-box">
            <div className="box-title">创建房间</div>
            <div className="row">
              <select value={mode} onChange={(e) => setMode(e.target.value as 'blood' | 'classic')}>
                <option value="blood">血色牌局（卡片对决）</option>
                <option value="classic">经典德州扑克</option>
              </select>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <select value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))}>
                <option value={2}>2 人局</option>
                <option value={3}>3 人局</option>
                <option value={4}>4 人局</option>
              </select>
              <button className="btn primary" disabled={!nameOk || !connected} onClick={create}>
                创建
              </button>
            </div>
          </div>

          <div className="join-box">
            <div className="box-title">加入房间</div>
            <div className="row">
              <input
                className="code-input"
                value={code}
                maxLength={64}
                placeholder="房间码（可粘贴邀请文本）"
                onChange={(e) => applyCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nameOk && code.length === 4) join();
                }}
              />
              <button className="btn" disabled={!nameOk || code.length !== 4 || !connected} onClick={join}>
                加入
              </button>
            </div>
          </div>
        </div>

        {!connected && <p className="hint">正在连接服务器…</p>}

        <div className="rules-hint">
          <div className="box-title">玩法速览</div>
          <ul>
            <li>血色牌局：每人一副 54 张牌，暗扣 5 张同时亮牌比牌型，黑市购芯片强化手牌，集齐目标车票获胜</li>
            <li>经典德州扑克：两张底牌 + 五张公共牌组成最佳牌型，筹码打光即出局</li>
            <li>所有阶段 60 秒超时托管，断线重连自动恢复座位与手牌</li>
            <li>支持 2/3/4 人局（血色模式 2 人目标 24 车票、3 人 20、4 人 16）</li>
          </ul>
        </div>
      </div>
      <button className="admin-link" onClick={() => setAdminOpen(true)}>
        管理员
      </button>
      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
    </div>
  );
}
