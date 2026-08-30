import { useEffect, useState } from 'react';
import type { SeatView, TableView } from '@shared/protocol';
import { net } from '../net/socket';

const BETTING = new Set(['preflop', 'flop', 'turn', 'river']);

export function phaseLabel(phase: string): string {
  switch (phase) {
    case 'waiting':
      return '等待开局…';
    case 'result':
      return '本手结算中…';
    case 'gameover':
      return '整场结束';
    case 'preflop':
      return '翻牌前';
    case 'flop':
      return '翻牌圈';
    case 'turn':
      return '转牌圈';
    case 'river':
      return '河牌圈';
    default:
      return '';
  }
}

export function ActionBar({
  view,
  offsetRef,
}: {
  view: TableView;
  offsetRef: React.MutableRefObject<number>;
}) {
  const me = view.players.find((p) => p.id === net.playerId);
  const betting = BETTING.has(view.phase);
  const myTurn = betting && view.toActSeat != null && me != null && view.toActSeat === me.seat;

  if (!betting) return <div className="action-bar idle">{phaseLabel(view.phase)}</div>;
  if (!myTurn) {
    const actor = view.players.find((p) => p.seat === view.toActSeat);
    return <div className="action-bar idle">等待 {actor?.name ?? '…'} 行动…</div>;
  }
  return <BetControls view={view} me={me} offsetRef={offsetRef} />;
}

function BetControls({
  view,
  me,
  offsetRef,
}: {
  view: TableView;
  me: SeatView;
  offsetRef: React.MutableRefObject<number>;
}) {
  const toCall = Math.max(0, view.currentBet - me.bet);
  const maxTo = me.bet + me.chips;
  const minTo = Math.min(view.minRaiseTo, maxTo);
  const canRaise = maxTo > view.currentBet;
  const [raiseTo, setRaiseTo] = useState(minTo);
  const [showRaise, setShowRaise] = useState(false);

  useEffect(() => {
    setRaiseTo(minTo);
    setShowRaise(false);
    // 换人行动 / 新一手 / 新一圈时重置加注控件
  }, [view.toActSeat, view.handNumber, view.phase, minTo]);

  const clamp = (v: number) => Math.max(minTo, Math.min(maxTo, Math.round(v)));
  const potNow = view.pot;
  const quicks = [
    { label: `最小 ${minTo}`, to: minTo },
    { label: '半池', to: view.currentBet + Math.round(potNow * 0.5) },
    { label: '满池', to: view.currentBet + potNow },
    { label: '全下', to: maxTo },
  ].filter((q) => q.to >= minTo && q.to <= maxTo);

  const remainMs = view.deadline != null ? Math.max(0, view.deadline - (Date.now() + offsetRef.current)) : 0;
  const pct = Math.min(100, (remainMs / 60000) * 100);
  const callLabel = toCall >= me.chips ? `全下跟注 ${me.chips}` : `跟注 ${toCall}`;

  return (
    <div className="action-bar">
      <div className="timer-bar mine">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="action-row">
        <button className="btn danger" onClick={() => net.send({ t: 'act', action: { k: 'fold' } })}>
          弃牌
        </button>
        <button
          className="btn"
          disabled={toCall > 0}
          onClick={() => net.send({ t: 'act', action: { k: 'check' } })}
        >
          让牌
        </button>
        {toCall > 0 && (
          <button className="btn primary" onClick={() => net.send({ t: 'act', action: { k: 'call' } })}>
            {callLabel}
          </button>
        )}
        {canRaise && !showRaise && (
          <button className="btn primary" onClick={() => setShowRaise(true)}>
            加注 {minTo >= maxTo ? '（只能全下）' : ''}
          </button>
        )}
      </div>

      {canRaise && showRaise && (
        <div className="raise-panel">
          <div className="raise-quick">
            {quicks.map((q) => (
              <button key={q.label} className="btn tiny" onClick={() => setRaiseTo(clamp(q.to))}>
                {q.label}
              </button>
            ))}
          </div>
          <div className="raise-slider">
            <input
              type="range"
              min={minTo}
              max={maxTo}
              step={1}
              value={raiseTo}
              onChange={(e) => setRaiseTo(Number(e.target.value))}
            />
            <span className="raise-value">{raiseTo === maxTo ? `全下 ${maxTo}` : `加注到 ${raiseTo}`}</span>
          </div>
          <div className="raise-confirm">
            <button className="btn ghost" onClick={() => setShowRaise(false)}>
              取消
            </button>
            <button
              className="btn primary"
              onClick={() => net.send({ t: 'act', action: { k: 'raise', to: raiseTo } })}
            >
              {raiseTo === maxTo ? `全下 ${maxTo}` : `加注到 ${raiseTo}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
