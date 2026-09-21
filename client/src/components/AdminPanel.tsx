import { useCallback, useEffect, useState } from 'react';

/** 管理员会话 token 存 sessionStorage（关浏览器即失效） */
const TOKEN_KEY = 'blood-admin-token';

const PHASE_CN: Record<string, string> = {
  waiting: '等待中',
  pick: '选将',
  setup: '构筑',
  draw: '抽牌',
  swap: '换牌',
  play: '出牌',
  reveal: '对决',
  settle: '结算',
  buy: '购买',
  remove: '删牌',
  reorg: '重整',
  gameover: '已结束',
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
  result: '结算',
  showdown: '摊牌',
};

interface RoomInfo {
  code: string;
  mode: string;
  phase: string;
  players: number;
  host: string;
}

interface FeedbackInfo {
  t: number;
  room?: string;
  name?: string;
  text: string;
  contact?: string;
  ip?: string;
}

/**
 * 管理员面板：输入管理密码登录后可查看所有房间并执行管理操作（如一键清空）。
 * 管理密码由服务器环境变量 ADMIN_KEY 配置（仅开发者可见，玩家端不展示任何细节）。
 */
export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [rooms, setRooms] = useState<RoomInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackInfo[] | null>(null);
  const [feedbackError, setFeedbackError] = useState('');

  const clearFeedback = useCallback(async (t: string) => {
    try {
      const r = await fetch('/api/admin/feedback/clear', {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}` },
      });
      if (r.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setError('登录已过期，请重新输入密码');
        return;
      }
      setFeedback([]);
      setFeedbackError('');
    } catch {
      setFeedbackError('清空失败，请重试');
    }
  }, []);

  const loadFeedback = useCallback(async (t: string) => {
    try {
      const r = await fetch('/api/admin/feedback', { headers: { Authorization: `Bearer ${t}` } });
      if (r.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setError('登录已过期，请重新输入密码');
        return;
      }
      const data = (await r.json()) as { feedback?: FeedbackInfo[] };
      setFeedback(data.feedback ?? []);
      setFeedbackError('');
    } catch {
      setFeedbackError('加载反馈失败，请重试');
    }
  }, []);

  useEffect(() => {
    if (token) void loadFeedback(token);
  }, [token, loadFeedback]);

  const loadRooms = useCallback(async (t: string) => {
    const r = await fetch('/api/admin/rooms', { headers: { Authorization: `Bearer ${t}` } });
    if (r.status === 401) {
      sessionStorage.removeItem(TOKEN_KEY);
      setToken(null);
      setError('登录已过期，请重新输入密码');
      return;
    }
    const data = (await r.json()) as { rooms?: RoomInfo[] };
    setRooms(data.rooms ?? []);
  }, []);

  useEffect(() => {
    if (token) void loadRooms(token);
  }, [token, loadRooms]);

  const login = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: password }),
      });
      const data = (await r.json()) as { ok?: boolean; token?: string; msg?: string };
      if (!r.ok || !data.ok || !data.token) {
        setError(data.msg ?? '登录失败');
        return;
      }
      sessionStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const clearRooms = async () => {
    if (token == null || !window.confirm('确定清空所有房间？所有在线玩家将被请回大厅，进行中的牌局作废。')) return;
    setBusy(true);
    try {
      const r = await fetch('/api/admin/rooms/clear', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await r.json()) as { ok?: boolean; cleared?: number; msg?: string };
      if (r.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setError(data.msg ?? '登录已过期');
        return;
      }
      window.alert(`已清空 ${data.cleared ?? 0} 个房间`);
      await loadRooms(token);
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setRooms(null);
  };

  return (
    <div className="overlay admin-overlay" onClick={onClose}>
      <div className="panel admin-panel" onClick={(e) => e.stopPropagation()}>
        <h3>🛠️ 管理员</h3>
        {token == null ? (
          <>
            <p className="hint">请输入管理密码登录</p>
            <div className="admin-login-row">
              <input
                type="password"
                value={password}
                placeholder="管理密码"
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && password) void login();
                }}
              />
              <button className="btn primary" disabled={!password || busy} onClick={() => void login()}>
                登录
              </button>
            </div>
            {error && <p className="admin-error">{error}</p>}
          </>
        ) : (
          <>
            <div className="admin-rooms">
              {rooms == null && <p className="hint">加载中…</p>}
              {rooms != null && rooms.length === 0 && <p className="hint">当前没有房间</p>}
              {rooms != null && rooms.length > 0 && (
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>房间码</th>
                      <th>模式</th>
                      <th>阶段</th>
                      <th>人数</th>
                      <th>房主</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rooms.map((r) => (
                      <tr key={r.code}>
                        <td>
                          <b>{r.code}</b>
                        </td>
                        <td>{r.mode === 'blood' ? '血色牌局' : '德州扑克'}</td>
                        <td>{PHASE_CN[r.phase] ?? r.phase}</td>
                        <td>{r.players}</td>
                        <td>{r.host || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="admin-feedback">
              <div className="admin-feedback-head">
                <b>📨 玩家反馈</b>
                <span className="spacer" />
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => token && void loadFeedback(token)}
                >
                  刷新反馈
                </button>
                <button
                  className="btn small danger"
                  disabled={busy || !feedback || feedback.length === 0}
                  onClick={() => {
                    if (window.confirm('确定清空全部玩家反馈？此操作不可恢复')) {
                      if (token) void clearFeedback(token);
                    }
                  }}
                >
                  清空反馈
                </button>
              </div>
              {feedbackError && <p className="admin-error">{feedbackError}</p>}
              {feedback == null && <p className="hint">点击「刷新反馈」加载</p>}
              {feedback != null && feedback.length === 0 && <p className="hint">暂无反馈</p>}
              {feedback != null && feedback.length > 0 && (
                <div className="feedback-list">
                  {feedback
                    .slice()
                    .reverse()
                    .map((f) => (
                      <div key={f.t} className="feedback-item">
                        <div className="feedback-item-meta">
                          {new Date(f.t).toLocaleString('zh-CN', { hour12: false })}
                          {f.room ? ` · 房间 ${f.room}` : ''}
                          {f.name ? ` · ${f.name}` : ''}
                          {f.contact ? ` · 联系：${f.contact}` : ''}
                          {f.ip ? ` · IP ${f.ip}` : ''}
                        </div>
                        <div className="feedback-item-text">{f.text}</div>
                      </div>
                    ))}
                </div>
              )}
            </div>
            {(error || '') && <p className="admin-error">{error}</p>}
            <div className="admin-actions">
              <button className="btn" disabled={busy} onClick={() => token && void loadRooms(token)}>
                刷新列表
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void clearRooms()}>
                一键清空所有房间
              </button>
              <span className="spacer" />
              <button className="btn ghost" onClick={logout}>
                退出登录
              </button>
            </div>
          </>
        )}
        <div className="admin-close">
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
