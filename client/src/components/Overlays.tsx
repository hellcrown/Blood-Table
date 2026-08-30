import type { TableView } from '@shared/protocol';
import { net } from '../net/socket';
import { CardView } from './Card';

export function ResultOverlay({ view }: { view: TableView }) {
  const res = view.result;
  if (!res) return null;
  const rows = [...res.rows].sort((a, b) => b.won - a.won || b.net - a.net);
  return (
    <div className="overlay">
      <div className="panel">
        <h3>第 {view.handNumber} 手结算</h3>
        <div className="result-list">
          {rows.map((r) => (
            <div
              key={r.seat}
              className={`result-row ${r.won > 0 ? 'winner' : ''} ${r.foldedOut ? 'out' : ''}`}
            >
              <span className="r-name">{r.name}</span>
              <span className="r-cards">
                {r.hole ? (
                  r.hole.map((c, i) => <CardView key={i} card={c} size="xs" />)
                ) : (
                  <span className="muck">已弃牌</span>
                )}
              </span>
              <span className="r-hand">{r.handName ?? ''}</span>
              <span className={`r-net ${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}`}>
                {r.net > 0 ? `+${r.net}` : String(r.net)}
              </span>
            </div>
          ))}
        </div>
        <div className="panel-actions">
          <button className="btn primary" onClick={() => net.send({ t: 'nextHand' })}>
            下一手
          </button>
          <span className="hint">稍后自动开始下一手</span>
        </div>
      </div>
    </div>
  );
}

export function GameOverOverlay({ view }: { view: TableView }) {
  const final = view.final;
  if (!final) return null;
  const isHost = view.hostId === net.playerId;
  return (
    <div className="overlay">
      <div className="panel">
        <h3>🏆 整场结束</h3>
        <ol className="ranking">
          {final.ranking.map((r, i) => (
            <li key={r.seat} className={i === 0 ? 'champ' : ''}>
              {i + 1}. {r.name} — {r.chips} 筹码 {i === 0 ? '👑' : ''}
            </li>
          ))}
        </ol>
        <div className="panel-actions">
          {isHost ? (
            <button className="btn primary" onClick={() => net.send({ t: 'rematch' })}>
              再来一场
            </button>
          ) : (
            <span className="hint">等待房主开始新一场…</span>
          )}
        </div>
      </div>
    </div>
  );
}
