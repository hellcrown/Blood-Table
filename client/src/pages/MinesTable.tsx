import { useEffect, useMemo, useRef, useState } from 'react';
import type { MinesView } from '@shared/minesProtocol';
import { net } from '../net/socket';

const NUM_COLORS = ['', '#1976d2', '#388e3c', '#d32f2f', '#7b1fa2', '#c2185b', '#0097a7', '#424242', '#616161'];

/** 扫雷竞速 · 对局页 */
export function MinesTable({ view }: { view: MinesView }) {
  // 标记模式（手机友好；标记仅本地，不上传）
  const [flagMode, setFlagMode] = useState(false);
  const [flags, setFlags] = useState<Set<number>>(new Set());
  const flagsRef = useRef(flags);
  flagsRef.current = flags;

  const me = view.players.find((p) => p.id === net.playerId);
  const spectating = !me;
  const myStatus = me?.status ?? 'playing';  // 对局结束清空本地标记
  useEffect(() => {
    if (view.phase === 'gameover') setFlags(new Set());
  }, [view.phase]);

  const cells = useMemo(() => {
    // 观战者：合并全员已证实安全格；玩家：自己的揭开格
    const byIndex = new Map<number, number>();
    if (spectating) {
      for (const p of view.players) {
        for (const c of (p as { cells?: { i: number; n: number }[] }).cells ?? []) {
          if (!byIndex.has(c.i)) byIndex.set(c.i, c.n);
        }
      }
    }
    return byIndex;
  }, [spectating, view.players, view]);

  const myCells = view.cells; // 玩家视角=自己的揭开格；观战者=服务端合并的全员安全格
  const merged = myCells;
  const revealedSet = useMemo(() => new Set(merged.map((c) => c.i)), [merged]);

  const hit = (r: number, c: number): void => {
    if (spectating || myStatus !== 'playing' || view.phase !== 'playing') return;
    const i = r * view.cols + c;
    if (revealedSet.has(i)) return;
    if (flagMode) {
      setFlags((s) => {
        const next = new Set(s);
        if (next.has(i)) next.delete(i);
        else next.add(i);
        return next;
      });
      return;
    }
    if (flagsRef.current.has(i)) return; // 已插旗的格子不直接揭开
    net.send({ t: 'mReveal', r, c });
  };

  const grid: React.ReactNode[] = [];
  for (let r = 0; r < view.rows; r++) {
    for (let c = 0; c < view.cols; c++) {
      const i = r * view.cols + c;
      const cell = merged.find((x) => x.i === i);
      const flagged = flags.has(i) && !cell;
      let content: React.ReactNode = null;
      let cls = 'mine-cell';
      if (cell != null) {
        cls += ' opened';
        const num = cell.n;
        if (num < 0) {
          // 终局/出局揭示的雷位：「看答案」
          cls += ' mine-hit';
          content = <span>💣</span>;
        } else if (num > 0) {
          content = <b style={{ color: NUM_COLORS[num] ?? undefined }}>{num}</b>;
        }
      } else if (flagged) {
        cls += ' flagged';
        content = <span className="mine-flag">🚩</span>;
      }
      grid.push(
        <div
          key={i}
          className={cls}
          onClick={() => {
            if (cell != null || myStatus !== 'playing' || view.phase !== 'playing') return;
            if (flagMode) {
              setFlags((s) => {
                const next = new Set(s);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                return next;
              });
              return;
            }
            if (flagsRef.current.has(i)) return;
            net.send({ t: 'mReveal', r, c });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (cell != null) return;
            setFlags((s) => {
              const next = new Set(s);
              if (next.has(i)) next.delete(i);
              else next.add(i);
              return next;
            });
          }}
        >
          {content}
        </div>,
      );
    }
  }

  const alive = view.players.filter((p) => p.status === 'playing').length;
  const secsLeft = view.deadline ? Math.max(0, Math.ceil((view.deadline - Date.now()) / 1000)) : null;

  return (
    <div className="mines-page">
      <header className="page-bar">
        <span className="brand">扫雷竞速</span>
        <span className="room-code">
          房间码 <b>{view.code}</b>
        </span>
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => net.leaveRoom()}>
          退出房间
        </button>
      </header>

      <div className="phase-bar">
        <span>
          {view.difficulty === 'easy' ? '初级 9×9' : view.difficulty === 'medium' ? '中级 16×16' : '高级 30×16'} ·{' '}
          {view.mines} 雷 ·{' '}
        </span>
        {view.phase === 'playing' && secsLeft != null && (
          <span className={secsLeft < 30 ? 'danger' : ''}>⏱ 剩余 {secsLeft}s</span>
        )}
        <span>
          存活 {alive}/{view.players.length} · 安全格 {view.totalSafe}
        </span>
      </div>

      {spectating && <div className="spectate-banner">🔭 观战中 —— 等待下一局开始时点击空座位加入</div>}

      {view.phase === 'gameover' && view.ranking.length > 0 && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <h3>🏁 本局结束</h3>
          <ol className="ranking">
            {view.ranking.map((r) => (
              <li key={r.seat} className={r.rank === 1 ? 'champ' : ''}>
                {r.rank}. {r.name} — 已揭开 {r.revealed} 格 {r.status === 'done' ? '（通关）' : r.status === 'out' ? '（踩雷出局）' : '（存活）'}
                {r.rank === 1 ? ' 👑' : ''}
              </li>
            ))}
          </ol>
          <div className="panel-actions">
            {!spectating && view.phase === 'gameover' && me?.status === 'done' && (
              <span className="hint">等待房主开始下一局…</span>
            )}
            {isHostSafe() && (
              <button
                className="btn primary"
                onClick={() => {
                  if (view.phase === 'gameover') net.send({ t: 'mRematch' });
                }}
              >
                再来一局（新雷图）
              </button>
            )}
            <button className="btn" onClick={() => net.send({ t: 'backToRoom' })}>
              返回房间
            </button>
          </div>
        </div>
      )}

      <div className="mine-board-wrap">
        <div className={`mine-grid cols-${view.cols}`}>{grid}</div>
      </div>

      <div className="act-row" style={{ marginTop: 10 }}>
        {!spectating && myStatus === 'playing' && view.phase === 'playing' && (
          <>
            <button className={`btn ${!flagMode ? 'primary' : ''}`} onClick={() => setFlagMode(false)}>
              ⛏ 翻开
            </button>
            <button className={`btn ${flagMode ? 'primary' : ''}`} onClick={() => setFlagMode(true)}>
              🚩 标记
            </button>
          </>
        )}
        <span className="hint">
          已揭开 {merged.length}/{view.totalSafe} · 本地标记 {flags.size}
        </span>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="box-title">玩家进度</div>
        {view.players.map((p) => (
          <div key={p.id} className="result-row">
            <span className="r-name">
              {p.name}
              {p.id === net.playerId && <em>（你）</em>}
            </span>
            <span className="r-hand">
              {p.status === 'playing'
                ? `进行中 · 已揭开 ${p.revealed}/${view.totalSafe}`
                : p.status === 'done'
                  ? '✅ 通关'
                  : '💥 出局'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  function isHostSafe(): boolean {
    return view.hostId === net.playerId;
  }
}
