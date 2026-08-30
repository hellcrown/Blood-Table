import { useEffect, useReducer } from 'react';
import type { SeatView } from '@shared/protocol';
import { CardView } from './Card';

export interface Pos {
  left: string;
  top: string;
}

/** 自己固定在正下方，其余座位按顺时针均分 */
export function seatPos(i: number, n: number): Pos {
  const angle = Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
  const rx = 44;
  const ry = 41;
  return {
    left: `${50 + rx * Math.cos(angle)}%`,
    top: `${50 + ry * Math.sin(angle)}%`,
  };
}

export function Seat({
  sv,
  pos,
  isMe,
  isToAct,
  deadline,
  offsetRef,
}: {
  sv: SeatView;
  pos: Pos;
  isMe: boolean;
  isToAct: boolean;
  deadline: number | null;
  offsetRef: React.MutableRefObject<number>;
}) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!isToAct) return;
    const t = window.setInterval(force, 250);
    return () => window.clearInterval(t);
  }, [isToAct]);

  const remainMs = isToAct && deadline != null ? Math.max(0, deadline - (Date.now() + offsetRef.current)) : 0;
  const pct = Math.min(100, (remainMs / 60000) * 100);
  const roleText = sv.role === 'sb' ? '小盲' : sv.role === 'bb' ? '大盲' : null;

  return (
    <div
      className={`seat ${isToAct ? 'to-act' : ''} ${sv.folded ? 'folded' : ''} ${sv.allIn ? 'allin' : ''} ${
        sv.chips <= 0 ? 'busted' : ''
      }`}
      style={pos}
    >
      {sv.isButton && <span className="btn-badge">庄</span>}
      {!isMe && (
        <div className="hole-cards">
          {sv.hole
            ? sv.hole.map((c, i) => <CardView key={i} card={c} size="sm" />)
            : sv.hasCards
              ? (
                <>
                  <CardView faceDown size="sm" />
                  <CardView faceDown size="sm" />
                </>
              )
              : null}
        </div>
      )}
      <div className="seat-plate">
        <div className="seat-name">
          {sv.name}
          {isMe && <em>（你）</em>}
          {!sv.connected && <span className="tag off">掉线</span>}
          {sv.chips <= 0 && <span className="tag busted">出局</span>}
        </div>
        <div className="seat-chips">
          {sv.chips} 筹码{roleText ? ` · ${roleText}` : ''}
        </div>
        {sv.handName && <div className="hand-name">{sv.handName}</div>}
        {sv.lastAction && <div className="seat-action">{sv.lastAction}</div>}
        {isToAct && (
          <div className="timer-bar">
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      {sv.bet > 0 && <div className="bet-chip">{sv.bet}</div>}
    </div>
  );
}
