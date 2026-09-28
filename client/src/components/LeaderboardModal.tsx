import { useEffect, useState } from 'react';
import { BLOOD_CHAR_BY_ID } from '@shared/bloodChars';

interface LeaderRow {
  charId: string;
  games: number;
  wins: number;
  winRate: number;
  avgRank: number;
}

const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * 角色胜率排行榜（公开）：数据来自服务器终局落库聚合，
 * 只统计血色模式、出场 ≥ 5 次的角色；服务端 60s 缓存。
 */
export function LeaderboardModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{ total: number; chars: LeaderRow[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/api/stats/chars')
      .then((r) => r.json())
      .then((d: { total?: number; chars?: LeaderRow[] }) => {
        if (alive) setData({ total: d.total ?? 0, chars: d.chars ?? [] });
      })
      .catch(() => {
        if (alive) setError('加载失败，请稍后重试');
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="overlay codex-overlay" onClick={onClose}>
      <div className="panel codex-panel lb-panel" onClick={(e) => e.stopPropagation()}>
        <div className="codex-head">
          <h3 style={{ margin: 0 }}>🏆 角色胜率榜</h3>
          <span className="spacer" />
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>
        {error && <p className="admin-error">{error}</p>}
        {!error && data == null && <p className="hint">加载中…</p>}
        {data != null && data.chars.length === 0 && (
          <p className="hint">
            数据积累中：本服已完成 {data.total} 局。角色出场满 5 次后进入排行（每局结束自动统计）。
          </p>
        )}
        {data != null && data.chars.length > 0 && (
          <>
            <p className="hint">
              本服累计 {data.total} 局 · 仅统计血色模式 · 出场 ≥ 5 次的角色按胜率排名（60 秒刷新）
            </p>
            <div className="codex-body lb-body">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>排名</th>
                    <th>角色</th>
                    <th>出场</th>
                    <th>夺冠</th>
                    <th>胜率</th>
                    <th>平均名次</th>
                  </tr>
                </thead>
                <tbody>
                  {data.chars.map((r, i) => (
                    <tr key={r.charId}>
                      <td>{MEDALS[i] ?? i + 1}</td>
                      <td>
                        {BLOOD_CHAR_BY_ID.get(r.charId)?.emoji ?? ''}{' '}
                        {BLOOD_CHAR_BY_ID.get(r.charId)?.name ?? r.charId}
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}
