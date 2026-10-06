import { useCallback, useEffect, useState } from 'react';
import { BLOOD_CHAR_BY_ID } from '@shared/bloodChars';
import { BLOOD_PHASE_LABELS, CLASSIC_PHASE_LABELS } from '@shared/bloodConstants';
import { net } from '../net/socket';

/** 管理员会话 token 存 sessionStorage（关浏览器即失效） */
const TOKEN_KEY = 'blood-admin-token';

// 阶段中文名取自 shared 的同一份清单（血色 14 阶段 + 经典 7 阶段），不再手抄：
// 原先这里漏了 crownBid/swapItem/revealPre，管理端对局列表会直接显示英文相位名。
// 顺序上血色表在后：两边都有 gameover，统一显示「已结束」。
const PHASE_CN: Record<string, string> = {
  ...CLASSIC_PHASE_LABELS,
  ...BLOOD_PHASE_LABELS, // 血色表在后：两边都有 gameover，管理端沿用「已结束」
  // 管理端自己的措辞，放在展开之后覆盖共享表（不动共享表，免得改到牌桌顶栏文案）
  waiting: '等待中',
  showdown: '摊牌', // 历史遗留键：不在任一联合类型里，保留以兼容旧记录
};

interface RoomInfo {
  code: string;
  mode: string;
  phase: string;
  players: number;
  host: string;
  maxPlayers: number;
}

interface FeedbackInfo {
  t: number;
  room?: string;
  name?: string;
  text: string;
  contact?: string;
  ip?: string;
}

interface CharStat {
  charId: string;
  games: number;
  wins: number;
  winRate: number;
  avgRank: number | null;
}

interface MatchStats {
  total: number;
  last7d: number;
  avgDurationMin: number | null;
  botShare: number;
  byMode: Record<string, number>;
  chars: CharStat[];
}

interface MatchRow {
  endedAt: number;
  durationMin?: number;
  mode: string;
  seatCount: number;
  winnerSeat: number;
  players: {
    name: string;
    seat: number;
    rank: number;
    charId?: string;
    tickets?: number;
    blood?: number;
    chips?: number;
    isBot?: boolean;
    wasAuto?: boolean;
  }[];
}

interface DauDay {
  day: string;
  /** 当日去重来源 IP（同一 IP 多开/重连只计一次） */
  uv: number;
  /** 当日去重登录账号 */
  accounts: number;
  /** 当日新建连接次数（含重连/刷新） */
  conns: number;
}

interface DauInfo {
  /** 实时：当前 WS 连接 / 房间数 / 进行中对局数 */
  online: number;
  rooms: number;
  games: number;
  days: DauDay[]; // 新→旧，首条恒为今天
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
  const [roomsError, setRoomsError] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackInfo[] | null>(null);
  const [feedbackError, setFeedbackError] = useState('');
  const [stats, setStats] = useState<MatchStats | null>(null);
  const [recent, setRecent] = useState<MatchRow[] | null>(null);
  const [matchError, setMatchError] = useState('');
  const [dau, setDau] = useState<DauInfo | null>(null);
  const [dauError, setDauError] = useState('');

  const loadDau = useCallback(async (t: string) => {
    try {
      const r = await fetch('/api/admin/dau', { headers: { Authorization: `Bearer ${t}` } });
      if (r.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setError('登录已过期，请重新输入密码');
        return;
      }
      const data = (await r.json()) as DauInfo & { ok?: boolean };
      setDau({ online: data.online ?? 0, rooms: data.rooms ?? 0, games: data.games ?? 0, days: data.days ?? [] });
      setDauError('');
    } catch {
      setDauError('加载日活数据失败，请重试');
    }
  }, []);

  const loadMatches = useCallback(async (t: string) => {
    try {
      const r = await fetch('/api/admin/matches', { headers: { Authorization: `Bearer ${t}` } });
      if (r.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setError('登录已过期，请重新输入密码');
        return;
      }
      const data = (await r.json()) as { stats?: MatchStats; recent?: MatchRow[] };
      setStats(data.stats ?? null);
      setRecent(data.recent ?? []);
      setMatchError('');
    } catch {
      setMatchError('加载对局统计失败，请重试');
    }
  }, []);

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
    if (token) {
      void loadFeedback(token);
      void loadMatches(token);
      void loadDau(token);
    }
  }, [token, loadFeedback, loadMatches, loadDau]);

  const loadRooms = useCallback(async (t: string) => {
    try {
      const r = await fetch('/api/admin/rooms', { headers: { Authorization: `Bearer ${t}` } });
      if (r.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setError('登录已过期，请重新输入密码');
        return;
      }
      const data = (await r.json()) as { rooms?: RoomInfo[] };
      setRooms(data.rooms ?? []);
      setRoomsError('');
    } catch {
      setRoomsError('房间列表加载失败，请重试');
    }
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
              {rooms == null && !roomsError && <p className="hint">加载中…</p>}
              {roomsError && <p className="admin-error">{roomsError}</p>}
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
                      <th>操作</th>
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
                        <td className="admin-room-ops">
                          {r.phase === 'gameover' ? (
                            <span className="hint">已结束</span>
                          ) : (
                            <>
                              {r.players < r.maxPlayers && (
                                <button
                                  className="btn tiny"
                                  title="管理员免密码加入该房间"
                                  onClick={() =>
                                    net.send({
                                      t: r.mode === 'blood' || r.phase === 'waiting' ? 'join' : 'spectate',
                                      name: net.loadName() || '管理员',
                                      code: r.code,
                                      adminToken: token ?? undefined,
                                    })
                                  }
                                >
                                  {r.phase === 'waiting' ? '加入' : '旁观'}
                                </button>
                              )}
                              <button
                                className="btn tiny ghost"
                                title="管理员免密码以观战身份进入"
                                onClick={() =>
                                  net.send({
                                    t: 'spectate',
                                    name: net.loadName() || '管理员',
                                    code: r.code,
                                    adminToken: token ?? undefined,
                                  })
                                }
                              >
                                观战
                                </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="admin-feedback admin-stats">
              <div className="admin-feedback-head">
                <b>📊 对局统计</b>
                <span className="spacer" />
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => token && void loadMatches(token)}
                >
                  刷新统计
                </button>
              </div>
              {matchError && <p className="admin-error">{matchError}</p>}
              {stats == null && <p className="hint">加载中…</p>}
              {stats != null && (
                <>
                  <p className="hint">
                    累计 {stats.total} 局 · 近 7 天 {stats.last7d} 局 · 平均时长{' '}
                    {stats.avgDurationMin != null ? `${stats.avgDurationMin} 分钟` : '—'} · 机器人座位占{' '}
                    {stats.botShare}% · 血色 {stats.byMode.blood ?? 0} 局 / 德州 {stats.byMode.classic ?? 0} 局
                  </p>
                  {stats.chars.length > 0 && (
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>角色</th>
                          <th>出场</th>
                          <th>胜率</th>
                          <th>平均名次</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.chars.map((c) => (
                          <tr key={c.charId}>
                            <td>
                              {BLOOD_CHAR_BY_ID.get(c.charId)?.emoji ?? ''}{' '}
                              {BLOOD_CHAR_BY_ID.get(c.charId)?.name ?? c.charId}
                            </td>
                            <td>{c.games}</td>
                            <td>{c.winRate}%</td>
                            <td>{c.avgRank ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
              {recent != null && recent.length > 0 && (
                <div className="feedback-list">
                  {recent.map((m) => (
                    <div key={`${m.endedAt}-${m.winnerSeat}`} className="feedback-item">
                      <div className="feedback-item-meta">
                        {new Date(m.endedAt).toLocaleString('zh-CN', { hour12: false })}
                        {m.durationMin != null ? ` · ${m.durationMin} 分钟` : ''}
                        {` · ${m.mode === 'blood' ? '血色' : '德州'} ${m.seatCount} 人`}
                      </div>
                      <div className="feedback-item-text">
                        {m.players
                          .map(
                            (p) =>
                              `${p.rank === 1 ? '👑' : ''}${p.name}${p.isBot ? '🤖' : ''}${
                                p.charId ? `(${BLOOD_CHAR_BY_ID.get(p.charId)?.name ?? p.charId})` : ''
                              }`,
                          )
                          .join(' · ')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="admin-feedback admin-stats">
              <div className="admin-feedback-head">
                <b>📈 日活</b>
                <span className="spacer" />
                <button className="btn small" disabled={busy} onClick={() => token && void loadDau(token)}>
                  刷新
                </button>
              </div>
              {dauError && <p className="admin-error">{dauError}</p>}
              {dau == null && <p className="hint">加载中…</p>}
              {dau != null && (
                <>
                  <p className="hint">
                    当前在线连接 {dau.online} · 房间 {dau.rooms} · 进行中对局 {dau.games}
                  </p>
                  <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>日期</th>
                          <th>活跃 IP</th>
                          <th>登录账号</th>
                          <th>新连接</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dau.days.map((d, i) => (
                          <tr key={d.day}>
                            <td>
                              {d.day}
                              {i === 0 ? '（今天）' : ''}
                            </td>
                            <td>{d.uv}</td>
                            <td>{d.accounts}</td>
                            <td>{d.conns}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
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
