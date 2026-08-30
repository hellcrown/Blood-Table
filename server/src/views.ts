import type { SeatView, TableView } from '@shared/protocol';
import type { Room } from './rooms';
import type { GState } from './game/types';

/** 构建面向某个观察者的个性化视图（他人底牌在摊牌前不下发） */
export function buildView(room: Room, viewerId: string | null): TableView {
  const now = Date.now();
  const base = {
    kind: 'classic' as const,
    code: room.code,
    mode: room.mode,
    maxPlayers: room.maxPlayers,
    settings: room.settings,
    hostId: room.hostId,
    charPick: room.charPick,
    expansion: room.expansion,
    serverTime: now,
  };

  const g = room.game as GState | null;
  if (!g) {
    const players: SeatView[] = [...room.sessions.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((s) => ({
        id: s.id,
        name: s.name,
        seat: s.seat,
        chips: 0,
        isHost: s.id === room.hostId,
        connected: s.connected,
        sittingOut: false,
        inHand: false,
        folded: false,
        allIn: false,
        bet: 0,
        committed: 0,
        isButton: false,
        role: null,
        lastAction: null,
        hasCards: false,
        hole: null,
        handName: null,
        won: 0,
      }));
    return {
      ...base,
      phase: 'waiting',
      handNumber: 0,
      players,
      community: [],
      pot: 0,
      currentBet: 0,
      minRaiseTo: 0,
      toActSeat: null,
      deadline: null,
      log: [],
      result: null,
      final: null,
    };
  }

  const revealAll = g.phase === 'result' || g.phase === 'gameover';
  const players: SeatView[] = g.players.map((p) => {
    const self = p.id === viewerId;
    const revealed = revealAll && p.inHand && !p.folded;
    return {
      id: p.id,
      name: p.name,
      seat: p.seat,
      chips: p.chips,
      isHost: p.id === room.hostId,
      connected: room.sessions.get(p.id)?.connected ?? false,
      sittingOut: p.chips <= 0,
      inHand: p.inHand && !p.folded,
      folded: p.folded,
      allIn: p.allIn,
      bet: p.bet,
      committed: p.committed,
      isButton: p.seat === g.buttonSeat,
      role: p.seat === g.sbSeat ? 'sb' : p.seat === g.bbSeat ? 'bb' : null,
      lastAction: p.lastAction,
      hasCards: p.hole.length === 2,
      hole: self || revealed ? p.hole : null,
      handName: revealed ? p.handName : null,
      won: p.won,
    };
  });

  const betting = g.phase === 'preflop' || g.phase === 'flop' || g.phase === 'turn' || g.phase === 'river';
  return {
    ...base,
    phase: g.phase,
    handNumber: g.handNumber,
    players,
    community: g.community,
    pot: g.players.reduce((s, p) => s + p.committed, 0),
    currentBet: g.currentBet,
    minRaiseTo: betting ? g.currentBet + g.minRaise : 0,
    toActSeat: g.toActSeat,
    deadline: g.deadline,
    log: g.log.slice(-40),
    result: g.result,
    final: g.final,
  };
}
