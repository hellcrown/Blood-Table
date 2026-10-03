import { useEffect, useState } from 'react';
import { BLOOD_CHAR_BY_ID } from '@shared/bloodChars';
import { net } from '../net/socket';

interface CharsRow {
  charId: string;
  games: number;
  wins: number;
  winRate: number;
  avgRank: number;
}

interface RecentRow {
  endedAt: number;
  mode: 'blood' | 'classic';
  durationMin?: number;
  seatCount: number;
  rank: number;
  charId?: string;
  tickets?: number;
  chips?: number;
}

interface MeResponse {
  ok: boolean;
  account?: { id: string; name: string };
  ladder?: { points: number; wins: number };
  stats?: {
    games: number;
    wins: number;
    avgRank: number | null;
    chars: CharsRow[];
    recent: RecentRow[];
  } | null;
}

const RANK_MARK = ['🥇', '🥈', '🥉'];

/** 个人战绩弹窗（登录态）：总局数/夺冠/胜率/常用角色/最近对局 + 天梯积分 */
export function MyStatsModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<MeResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    if (!net.authToken) {
      setError('未登录');
      return;
    }
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${net.authToken}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<MeResponse>;
      })
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {
        if (alive) setError('加载失败，请稍后重试');
      });
    return () => {
      alive = false;
    };
  }, []);

  const stats = data?.stats;
  const winRate = stats && stats.games > 0 ? Math.round((stats.wins / stats.games) * 1000) / 10 : null;

  return (
    <div className="overlay codex-overlay" onClick={onClose}>
      <div className="panel codex-panel lb-panel" onClick={(e) => e.stopPropagation()}>
        <div className="codex-head">
          <h3 style={{ margin: 0 }}>
            📊 {data?.account?.name ?? '我'} 的战绩
            {data && (
              <small className="my-pts">
                ⭐ 天梯 {data.ladder?.points ?? 0} 分 · {data.ladder?.wins ?? 0} 个计分胜场
              </small>
            )}
          </h3>
          <span className="spacer" />
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>
        {error && <p className="admin-error">{error}</p>}
        {!error && data == null && <p className="hint">加载中…</p>}
        {data != null && !stats && <p className="hint">还没有完成过对局——开一局试试！</p>}
        {stats && (
          <div className="codex-body lb-body">
            <p className="hint">
              共 {stats.games} 局 · 夺冠 {stats.wins} 次（{winRate}%）· 平均名次 {stats.avgRank ?? '—'}
            </p>
            {stats.chars.length > 0 && (
              <table className="admin-table" style={{ marginBottom: 12 }}>
                <thead>
                  <tr>
                    <th>角色</th>
                    <th>出场</th>
                    <th>夺冠</th>
                    <th>胜率</th>
                    <th>平均名次</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.chars.map((r) => (
                    <tr key={r.charId}>
                      <td>
                        {BLOOD_CHAR_BY_ID.get(r.charId)?.emoji ?? ''} {BLOOD_CHAR_BY_ID.get(r.charId)?.name ?? r.charId}
                      </td>
                      <td>{r.games}</td>
                      <td>{r.wins}</td>
                      <td>
                        <b>{r.winRate}%</b>
                      </td>
                      <td>{r.avgRank}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <table className="admin-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模式</th>
                  <th>人数</th>
                  <th>名次</th>
                  <th>角色 / 筹码</th>
                  <th>时长</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.map((r, i) => (
                  <tr key={i}>
                    <td>{new Date(r.endedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{r.mode === 'blood' ? '血色' : '德州'}</td>
                    <td>{r.seatCount}</td>
                    <td>
                      <b>{RANK_MARK[r.rank - 1] ?? `第${r.rank}名`}</b>
                    </td>
                    <td>
                      {r.mode === 'blood'
                        ? `${BLOOD_CHAR_BY_ID.get(r.charId ?? '')?.name ?? '—'}${r.tickets != null ? ` · ${r.tickets}🎫` : ''}`
                        : `${r.chips ?? '—'} 筹码`}
                    </td>
                    <td>{r.durationMin != null ? `${r.durationMin} 分钟` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
