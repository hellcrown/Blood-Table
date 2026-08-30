import type { GPlayer, GState } from './types';

/** 仍可赢池的玩家（本手中且未弃牌） */
export function activePlayers(gs: GState): GPlayer[] {
  return gs.players.filter((p) => p.inHand && !p.folded);
}

/** 仍需行动的玩家（未弃牌且未全下） */
export function canActPlayers(gs: GState): GPlayer[] {
  return gs.players.filter((p) => p.inHand && !p.folded && !p.allIn);
}

export function bySeat(gs: GState, seat: number): GPlayer | null {
  return gs.players.find((p) => p.seat === seat) ?? null;
}

/** 从 fromSeat 起顺时针找第一个满足条件的玩家（不含 fromSeat 本身） */
export function nextPlayer(gs: GState, fromSeat: number, pred: (p: GPlayer) => boolean): GPlayer | null {
  for (let i = 1; i <= gs.seatCount; i++) {
    const p = bySeat(gs, (fromSeat + i) % gs.seatCount);
    if (p && pred(p)) return p;
  }
  return null;
}

export function nextActor(gs: GState, fromSeat: number): GPlayer | null {
  return nextPlayer(gs, fromSeat, (p) => p.inHand && !p.folded && !p.allIn);
}

export function nextWithChips(gs: GState, fromSeat: number): GPlayer | null {
  return nextPlayer(gs, fromSeat, (p) => p.chips > 0);
}

/** 下注轮是否结束 */
export function roundComplete(gs: GState): boolean {
  const act = canActPlayers(gs);
  if (act.length === 0) return true;
  // 只剩一名可行动者且已匹配当前注（其余全下或弃牌）→ 无需再行动
  if (act.length === 1) return act[0].bet >= gs.currentBet;
  return act.every((p) => p.acted && p.bet >= gs.currentBet);
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export function legalActionsFor(gs: GState, seat: number): LegalActions | null {
  const p = bySeat(gs, seat);
  if (!p || gs.toActSeat !== seat || !p.inHand || p.folded || p.allIn) return null;
  const toCall = Math.max(0, gs.currentBet - p.bet);
  const maxRaiseTo = p.bet + p.chips;
  // 不足最小加注的全下不重开行动：已行动过且正面对注者只能跟注/弃牌
  const blockedByShortAllIn = gs.shortAllIn && p.acted && toCall > 0;
  return {
    canFold: true,
    canCheck: toCall === 0,
    canCall: toCall > 0,
    callAmount: Math.min(toCall, p.chips),
    canRaise: maxRaiseTo > gs.currentBet && !blockedByShortAllIn,
    minRaiseTo: Math.min(gs.currentBet + gs.minRaise, maxRaiseTo),
    maxRaiseTo,
  };
}

export interface Pot {
  amount: number;
  /** 可赢取该池的座位 */
  seats: number[];
}

/** 按各家本手投入额切分主池与边池 */
export function computePots(gs: GState): Pot[] {
  const contributors = gs.players
    .filter((p) => p.committed > 0)
    .map((p) => ({ seat: p.seat, folded: p.folded || !p.inHand, rem: p.committed }));

  const pots: Pot[] = [];
  for (;;) {
    const total = contributors.reduce((s, c) => s + c.rem, 0);
    if (total <= 0) break;
    const elig = contributors.filter((c) => !c.folded && c.rem > 0);
    if (elig.length === 0) {
      // 极端情况：可赢池者已全部取回层级，剩余归属最后一个池
      if (pots.length > 0) pots[pots.length - 1].amount += total;
      else pots.push({ amount: total, seats: [] });
      break;
    }
    const cap = Math.min(...elig.map((c) => c.rem));
    let amount = 0;
    for (const c of contributors) {
      const take = Math.min(c.rem, cap);
      amount += take;
      c.rem -= take;
    }
    const seats = elig.map((c) => c.seat).sort((a, b) => a - b);
    const prev = pots[pots.length - 1];
    if (prev && sameSeats(prev.seats, seats)) prev.amount += amount;
    else pots.push({ amount, seats });
  }
  return pots;
}

function sameSeats(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 沿座位顺时针的距离（用于不平分筹码时分配余码） */
export function seatDistance(seatCount: number, from: number, to: number): number {
  return (to - from + seatCount) % seatCount;
}
