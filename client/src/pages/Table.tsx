import { useMemo, useRef } from 'react';
import type { TableView } from '@shared/protocol';
import { net } from '../net/socket';
import { CardView } from '../components/Card';
import { Seat, seatPos } from '../components/Seat';
import { ActionBar } from '../components/ActionBar';
import { GameOverOverlay, ResultOverlay } from '../components/Overlays';
import { LogPanel } from '../components/LogPanel';

const COMMUNITY_SLOTS = 5;

export function Table({ view }: { view: TableView }) {
  const me = view.players.find((p) => p.id === net.playerId) ?? null;

  // 服务器时间偏移，用于行动倒计时
  const offsetRef = useRef(0);
  offsetRef.current = view.serverTime - Date.now();

  // 自己固定正下方，其余座位顺时针排布
  const ordered = useMemo(() => {
    const meSeat = me?.seat ?? 0;
    const rel = (seat: number) => (seat - meSeat + view.maxPlayers) % view.maxPlayers;
    return [...view.players].sort((a, b) => rel(a.seat) - rel(b.seat));
  }, [view.players, me?.seat, view.maxPlayers]);

  const myHole = me?.hole ?? null;

  return (
    <div className="table-page">
      <header className="page-bar">
        <span className="brand">血色牌局</span>
        <span>
          房间 <b>{view.code}</b> · 第 {view.handNumber || '-'} 手 · {phaseText(view.phase)}
        </span>
        <span className="spacer" />
        <button
          className="btn small ghost"
          onClick={() => {
            if (window.confirm('确定退出房间？对局中将按弃牌处理。')) net.leaveRoom();
          }}
        >
          退出房间
        </button>
      </header>

      <div className="table-area">
        <div className="poker-table">
          {ordered.map((sv, i) => (
            <Seat
              key={sv.id}
              sv={sv}
              pos={seatPos(i, ordered.length)}
              isMe={sv.id === net.playerId}
              isToAct={view.toActSeat === sv.seat}
              deadline={view.deadline}
              offsetRef={offsetRef}
            />
          ))}
          <div className="table-center">
            <div className="pot-line">底池 {view.pot}</div>
            <div className="community">
              {Array.from({ length: COMMUNITY_SLOTS }, (_, i) => (
                <div key={i} className="slot">
                  {view.community[i] && <CardView card={view.community[i]} size="md" />}
                </div>
              ))}
            </div>
            {view.currentBet > 0 && <div className="current-bet">当前注 {view.currentBet}</div>}
          </div>
        </div>

        <div className="my-cards">
          {myHole ? (
            myHole.map((c, i) => <CardView key={i} card={c} size="lg" />)
          ) : (
            <span className="hint">{view.phase === 'waiting' ? '' : '等待发牌…'}</span>
          )}
        </div>
      </div>

      <LogPanel view={view} />
      <ActionBar view={view} offsetRef={offsetRef} />
      {view.phase === 'result' && <ResultOverlay view={view} />}
      {view.phase === 'gameover' && <GameOverOverlay view={view} />}
    </div>
  );
}

function phaseText(phase: string): string {
  switch (phase) {
    case 'preflop':
      return '翻牌前';
    case 'flop':
      return '翻牌圈';
    case 'turn':
      return '转牌圈';
    case 'river':
      return '河牌圈';
    case 'result':
      return '结算';
    case 'gameover':
      return '终局';
    default:
      return '';
  }
}
