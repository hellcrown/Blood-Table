import { useEffect, useState } from 'react';
import { BLOOD_CHAR_BY_ID } from '@shared/bloodChars';
import { net } from '../net/socket';
import { MyStatsModal } from './MyStatsModal';

interface LeaderRow {
  charId: string;
  games: number;
  wins: number;
  winRate: number;
  avgRank: number;
}

interface LadderRow {
  name: string;
  points: number;
  wins: number;
}

const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * 排行榜（公开）：天梯榜（注册玩家天梯积分）+ 角色胜率榜（终局落库聚合）。
 * 角色榜只统计血色模式、出场 ≥ 5 次的角色；服务端 60s 缓存。
 */
export function LeaderboardModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'ladder' | 'chars'>('ladder');
  const [chars, setChars] = useState<{ total: number; rows: LeaderRow[] } | null>(null);
  const [ladder, setLadder] = useState<LadderRow[] | null>(null);
  const [error, setError] = useState('');
  const [statsOpen, setStatsOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    if (tab === 'chars' && chars == null) {
      setError(''); // 重试时清掉上次错误（期间显示加载中；再次失败会在 catch 里重新置位）
      fetch('/api/stats/chars')
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status)); // 5xx/4xx 不再被 ?? 兜底成「空榜单」假象
          return r.json();
        })
        .then((d: { total?: number; chars?: LeaderRow[] }) => {
          if (alive) setChars({ total: d.total ?? 0, rows: d.chars ?? [] });
        })
        .catch(() => {
          if (alive) setError('加载失败，请稍后重试');
        });
    }
    if (tab === 'ladder' && ladder == null) {
      setError('');
      fetch('/api/stats/ladder')
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((d: { board?: LadderRow[] }) => {
          if (alive) setLadder(d.board ?? []);
        })
        .catch(() => {
          if (alive) setError('加载失败，请稍后重试');
        });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div className="overlay codex-overlay" onClick={onClose}>
      <div className="panel codex-panel lb-panel" onClick={(e) => e.stopPropagation()}>
        <div className="codex-head">
          <h3 style={{ margin: 0 }}>🏆 排行榜</h3>
          <span className="spacer" />
          {net.account && (
            <button className="btn small ghost" onClick={() => setStatsOpen(true)}>
              📊 我的战绩
            </button>
          )}
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="lb-tabs">
          <button className={`btn small ${tab === 'ladder' ? 'primary' : 'ghost'}`} onClick={() => setTab('ladder')}>
            ⭐ 天梯榜
          </button>
          <button className={`btn small ${tab === 'chars' ? 'primary' : 'ghost'}`} onClick={() => setTab('chars')}>
            🎭 角色胜率榜
          </button>
        </div>
        {error && <p className="admin-error">{error}</p>}
        {tab === 'ladder' && (
          <>
            {ladder == null && !error && <p className="hint">加载中…</p>}
            {ladder != null && ladder.length === 0 && (
              <p className="hint">
                天梯榜暂无数据：注册并登录后，赢下有真人参与的对局即可获得 0~5 积分（按对局时长、车票优势与竞争强度综合评分，全机器人局不计分）。
              </p>
            )}
            {ladder != null && ladder.length > 0 && (
              <div className="codex-body lb-body">
                <p className="hint">
                  注册玩家天梯积分排行：赢真人局得 0~5 分（时长 + 车票优势 + 险胜强敌）；全机器人局不计分。
                </p>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>排名</th>
                      <th>玩家</th>
                      <th>积分</th>
                      <th>计分胜场</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ladder.map((r, i) => (
                      <tr key={r.name} style={net.account?.name === r.name ? { fontWeight: 700 } : undefined}>
                        <td>{MEDALS[i] ?? i + 1}</td>
                        <td>{r.name}</td>
                        <td>
                          <b>⭐ {r.points}</b>
                        </td>
                        <td>{r.wins}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {tab === 'chars' && (
          <>
            {chars == null && !error && <p className="hint">加载中…</p>}
            {chars != null && chars.rows.length === 0 && (
              <p className="hint">
                数据积累中：本服已完成 {chars.total} 局。角色出场满 5 次后进入排行（每局结束自动统计）。
              </p>
            )}
            {chars != null && chars.rows.length > 0 && (
              <div className="codex-body lb-body">
                <p className="hint">
                  本服累计 {chars.total} 局 · 仅统计血色模式 · 出场 ≥ 5 次的角色按胜率排名（60 秒刷新）
                </p>
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
                    {chars.rows.map((r, i) => (
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
            )}
          </>
        )}
        {statsOpen && <MyStatsModal onClose={() => setStatsOpen(false)} />}
      </div>
    </div>
  );
}
