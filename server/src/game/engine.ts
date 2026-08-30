import type { Card, GameOverView, HandResultView, LogLine, PlayerAction, RoomSettings } from '@shared/protocol';
import { bestHand, handName } from './evaluator';
import {
  activePlayers,
  bySeat,
  canActPlayers,
  computePots,
  legalActionsFor,
  nextActor,
  nextPlayer,
  nextWithChips,
  roundComplete,
  seatDistance,
} from './betting';
import { newDeck, shuffle } from './deck';
import { GameError, RESULT_MS, TURN_MS, type GPlayer, type GState } from './types';

const STREET_ORDER = ['preflop', 'flop', 'turn', 'river'] as const;

export interface PlayerInit {
  id: string;
  name: string;
  seat: number;
  chips: number;
}

export function createGame(settings: RoomSettings, seatCount: number, players: PlayerInit[]): GState {
  const gs: GState = {
    phase: 'waiting',
    handNumber: 0,
    deck: [],
    community: [],
    players: [],
    seatCount,
    buttonSeat: players[0]?.seat ?? 0,
    sbSeat: null,
    bbSeat: null,
    settings: { ...settings },
    currentBet: 0,
    minRaise: settings.bb,
    shortAllIn: false,
    toActSeat: null,
    deadline: null,
    log: [],
    logSeq: 0,
    result: null,
    resultAt: null,
    final: null,
  };
  for (const p of players) addPlayer(gs, p);
  return gs;
}

export function addPlayer(gs: GState, init: PlayerInit): void {
  if (gs.players.some((p) => p.id === init.id)) return;
  const p: GPlayer = {
    id: init.id,
    name: init.name,
    seat: init.seat,
    chips: init.chips,
    hole: [],
    inHand: false,
    folded: false,
    allIn: false,
    acted: false,
    bet: 0,
    committed: 0,
    lastAction: null,
    won: 0,
    handScore: 0,
    handName: null,
  };
  // 有筹码即从下一手自动参与（对局中途加入的玩家等待下一手）
  gs.players.push(p);
  gs.players.sort((a, b) => a.seat - b.seat);
}

export function removePlayer(gs: GState, id: string): void {
  const p = gs.players.find((x) => x.id === id);
  if (!p) return;
  if (p.inHand && !p.folded && gs.toActSeat != null) {
    // 手牌进行中不能直接抽走：等结算后由房间层移除
    return;
  }
  gs.players = gs.players.filter((x) => x.id !== id);
}

function pushLog(gs: GState, kind: LogLine['kind'], text: string): LogLine {
  const line = { seq: ++gs.logSeq, kind, text };
  gs.log.push(line);
  if (gs.log.length > 120) gs.log.splice(0, gs.log.length - 120);
  return line;
}

export function startHand(gs: GState, now: number = Date.now()): void {
  const eligible = gs.players.filter((p) => p.chips > 0);
  if (eligible.length < 2) throw new GameError('NOT_ENOUGH_PLAYERS', '有筹码的玩家不足 2 人');

  gs.handNumber += 1;
  gs.phase = 'preflop';
  gs.community = [];
  gs.deck = shuffle(newDeck());
  gs.result = null;
  gs.resultAt = null;
  gs.currentBet = 0;
  gs.minRaise = gs.settings.bb;
  gs.shortAllIn = false;
  gs.sbSeat = null;
  gs.bbSeat = null;

  for (const p of gs.players) {
    p.hole = [];
    p.bet = 0;
    p.committed = 0;
    p.folded = false;
    p.allIn = false;
    p.acted = false;
    p.won = 0;
    p.handScore = 0;
    p.handName = null;
    p.lastAction = null;
    p.inHand = p.chips > 0;
  }

  pushLog(gs, 'hand', `── 第 ${gs.handNumber} 手 ──`);

  // 庄位移动到下一位有筹码玩家
  gs.buttonSeat = nextWithChips(gs, gs.buttonSeat)?.seat ?? eligible[0].seat;

  // 发底牌（从庄家下一位开始，两手各一张）
  for (let round = 0; round < 2; round++) {
    let seat = gs.buttonSeat;
    for (let i = 0; i < gs.seatCount; i++) {
      seat = (seat + 1) % gs.seatCount;
      const p = bySeat(gs, seat);
      if (p && p.inHand) p.hole.push(gs.deck.pop()!);
    }
  }

  // 盲注位：2 人单挑庄家即小盲；3 人起庄下一位小盲、再下一位大盲
  const n = eligible.length;
  let sbP: GPlayer;
  let bbP: GPlayer;
  if (n === 2) {
    sbP = bySeat(gs, gs.buttonSeat)!;
    bbP = nextPlayer(gs, gs.buttonSeat, (p) => p.inHand)!;
  } else {
    sbP = nextPlayer(gs, gs.buttonSeat, (p) => p.inHand)!;
    bbP = nextPlayer(gs, sbP.seat, (p) => p.inHand)!;
  }
  gs.sbSeat = sbP.seat;
  gs.bbSeat = bbP.seat;
  postBlind(gs, sbP, gs.settings.sb, '小盲');
  postBlind(gs, bbP, gs.settings.bb, '大盲');
  gs.currentBet = Math.max(sbP.bet, bbP.bet);

  const first = nextActor(gs, bbP.seat);
  if (first) {
    gs.toActSeat = first.seat;
    gs.deadline = now + TURN_MS;
  } else {
    // 盲注阶段即全员全下：直接发完公共牌摊牌
    gs.toActSeat = null;
    gs.deadline = null;
    closeBettingRound(gs, now);
  }
}

function postBlind(gs: GState, p: GPlayer, amount: number, label: string): void {
  const pay = Math.min(amount, p.chips);
  p.chips -= pay;
  p.bet += pay;
  p.committed += pay;
  if (p.chips === 0) p.allIn = true;
  p.lastAction = `${label} ${pay}`;
  pushLog(gs, 'action', `${p.name} 下${label} ${pay}${p.allIn ? '（全下）' : ''}`);
}

/** 校验并执行玩家动作 */
export function applyAction(gs: GState, seat: number, action: PlayerAction, now: number = Date.now()): void {
  if (!STREET_ORDER.includes(gs.phase as (typeof STREET_ORDER)[number])) {
    throw new GameError('BAD_PHASE', '当前阶段不能行动');
  }
  if (gs.toActSeat !== seat) throw new GameError('NOT_YOUR_TURN', '还没轮到你行动');
  const p = bySeat(gs, seat);
  if (!p) throw new GameError('NO_SEAT', '座位不存在');
  const legal = legalActionsFor(gs, seat);
  if (!legal) throw new GameError('NOT_YOUR_TURN', '你当前无法行动');

  switch (action.k) {
    case 'fold': {
      p.folded = true;
      p.lastAction = '弃牌';
      pushLog(gs, 'action', `${p.name} 弃牌`);
      break;
    }
    case 'check': {
      if (!legal.canCheck) throw new GameError('CANNOT_CHECK', '有人下注，你不能让牌');
      p.acted = true;
      p.lastAction = '让牌';
      pushLog(gs, 'action', `${p.name} 让牌`);
      break;
    }
    case 'call': {
      if (!legal.canCall) throw new GameError('CANNOT_CALL', '当前无需跟注');
      const amount = legal.callAmount;
      p.chips -= amount;
      p.bet += amount;
      p.committed += amount;
      p.acted = true;
      if (p.chips === 0) p.allIn = true;
      p.lastAction = p.allIn ? `全下跟注 ${p.bet}` : `跟注 ${amount}`;
      pushLog(gs, 'action', `${p.name} ${p.lastAction}`);
      break;
    }
    case 'raise': {
      if (!legal.canRaise) throw new GameError('CANNOT_RAISE', '当前不能加注');
      doRaise(gs, p, action.to);
      break;
    }
    case 'allin': {
      const to = p.bet + p.chips;
      if (to > gs.currentBet) {
        // 全下加注不受最小加注/短全下限制
        doRaise(gs, p, to, true);
      } else {
        // 全下跟注
        const amount = p.chips;
        p.chips = 0;
        p.bet += amount;
        p.committed += amount;
        p.allIn = true;
        p.acted = true;
        p.lastAction = `全下跟注 ${p.bet}`;
        pushLog(gs, 'action', `${p.name} 全下跟注 ${p.bet}`);
      }
      break;
    }
  }
  proceed(gs, now);
}

function doRaise(gs: GState, p: GPlayer, toRaw: number, forceAllIn = false): void {
  const maxTo = p.bet + p.chips;
  const to = Math.min(Math.floor(toRaw), maxTo);
  if (to <= gs.currentBet) throw new GameError('BAD_RAISE', `加注必须高于当前注 ${gs.currentBet}`);
  const isAllIn = forceAllIn || to === maxTo;
  if (!isAllIn && to < gs.currentBet + gs.minRaise) {
    throw new GameError('BAD_RAISE', `最小加注到 ${gs.currentBet + gs.minRaise}`);
  }
  const add = to - p.bet;
  p.chips -= add;
  p.bet = to;
  p.committed += add;

  const raiseSize = to - gs.currentBet;
  const fullRaise = raiseSize >= gs.minRaise;
  if (fullRaise) {
    gs.minRaise = Math.max(raiseSize, gs.settings.bb);
    gs.shortAllIn = false;
    for (const other of canActPlayers(gs)) {
      if (other.seat !== p.seat) other.acted = false;
    }
  } else {
    gs.shortAllIn = true;
  }
  gs.currentBet = to;
  p.acted = true;
  if (p.chips === 0) p.allIn = true;
  p.lastAction = isAllIn ? `全下 ${to}` : `加注到 ${to}`;
  pushLog(gs, 'action', `${p.name} ${p.lastAction}`);
}

function proceed(gs: GState, now: number): void {
  if (activePlayers(gs).length <= 1) {
    awardUncontested(gs, now);
    return;
  }
  if (roundComplete(gs)) {
    closeBettingRound(gs, now);
    return;
  }
  const next = nextActor(gs, gs.toActSeat!);
  if (!next) {
    closeBettingRound(gs, now);
    return;
  }
  gs.toActSeat = next.seat;
  gs.deadline = now + TURN_MS;
}

function closeBettingRound(gs: GState, now: number): void {
  gs.toActSeat = null;
  gs.deadline = null;
  for (const p of gs.players) {
    p.bet = 0;
    p.acted = false;
  }
  gs.currentBet = 0;
  gs.minRaise = gs.settings.bb;
  gs.shortAllIn = false;

  if (gs.phase === 'river') {
    showdown(gs, now);
    return;
  }
  const idx = STREET_ORDER.indexOf(gs.phase as (typeof STREET_ORDER)[number]);
  gs.phase = STREET_ORDER[idx + 1];
  dealCommunity(gs);

  const first = nextActor(gs, gs.buttonSeat);
  if (first) {
    gs.toActSeat = first.seat;
    gs.deadline = now + TURN_MS;
  } else {
    // 全员全下：继续发牌直至摊牌
    closeBettingRound(gs, now);
  }
}

function dealCommunity(gs: GState): void {
  const count = gs.phase === 'flop' ? 3 : 1;
  const dealt: Card[] = [];
  for (let i = 0; i < count; i++) {
    const c = gs.deck.pop()!;
    gs.community.push(c);
    dealt.push(c);
  }
  const label = gs.phase === 'flop' ? '翻牌' : gs.phase === 'turn' ? '转牌' : '河牌';
  pushLog(gs, 'street', `${label} ${cardsText(dealt)}`);
}

export function cardsText(cards: Card[]): string {
  return cards
    .map((c) => `${rankChar(c.r)}${suitChar(c.s)}`)
    .join(' ');
}

export function rankChar(r: number): string {
  if (r === 14) return 'A';
  if (r === 13) return 'K';
  if (r === 12) return 'Q';
  if (r === 11) return 'J';
  if (r === 10) return '10';
  return String(r);
}

export function suitChar(s: Card['s']): string {
  return s === 's' ? '♠' : s === 'h' ? '♥' : s === 'd' ? '♦' : '♣';
}

/** 无人再可下注时按牌力分池摊牌 */
function showdown(gs: GState, now: number): void {
  gs.phase = 'result';
  gs.resultAt = now;
  const contenders = activePlayers(gs);
  for (const p of contenders) {
    const best = bestHand([...p.hole, ...gs.community]);
    p.handScore = best.value.score;
    p.handName = handName(best.value);
  }
  settlePots(gs, contenders, now, true);
}

/** 其余玩家全弃牌时直接赢池 */
function awardUncontested(gs: GState, now: number): void {
  gs.phase = 'result';
  gs.resultAt = now;
  const winner = activePlayers(gs)[0];
  const amount = gs.players.reduce((s, p) => s + p.committed, 0);
  winner.chips += amount;
  winner.won += amount;
  pushLog(gs, 'win', `${winner.name} 收下底池 ${amount}（其余玩家弃牌）`);
  buildResult(gs, now);
}

/** 结算各池并分配（摊牌或无人竞争） */
function settlePots(gs: GState, contenders: GPlayer[], now: number, withShowdown: boolean): void {
  const pots = computePots(gs);
  for (const pot of pots) {
    const elig = contenders.filter((p) => pot.seats.includes(p.seat));
    if (elig.length === 0) continue;
    const maxScore = Math.max(...elig.map((p) => p.handScore));
    const winners = elig.filter((p) => p.handScore === maxScore);
    const share = Math.floor(pot.amount / winners.length);
    let rem = pot.amount - share * winners.length;
    // 余码从庄家下一位开始顺时针分给赢家
    const ordered = winners.slice().sort(
      (a, b) => seatDistance(gs.seatCount, gs.buttonSeat, a.seat) - seatDistance(gs.seatCount, gs.buttonSeat, b.seat),
    );
    for (const w of ordered) {
      let amt = share;
      if (rem > 0) {
        amt += 1;
        rem -= 1;
      }
      w.chips += amt;
      w.won += amt;
    }
    const desc = withShowdown
      ? winners.map((w) => `${w.name}（${w.handName}）`).join('、')
      : winners.map((w) => w.name).join('、');
    pushLog(
      gs,
      'win',
      winners.length > 1
        ? `${desc} 平分 ${pot.amount} 底池`
        : `${desc} 赢得 ${pot.amount} 底池`,
    );
  }
  buildResult(gs, now);
}

function buildResult(gs: GState, now: number): void {
  const pots = computePots(gs);
  const rows = gs.players
    .filter((p) => p.committed > 0 || p.inHand)
    .map((p) => {
      const revealed = p.inHand && !p.folded;
      return {
        seat: p.seat,
        name: p.name,
        hole: revealed ? p.hole : null,
        handName: revealed ? p.handName : null,
        won: p.won,
        net: p.won - p.committed,
        foldedOut: p.folded,
      };
    });
  const view: HandResultView = {
    rows,
    pots: pots.map((pot) => ({ amount: pot.amount, winners: pot.seats.filter((s) => rows.some((r) => r.seat === s)) })),
    nextIn: Math.round(RESULT_MS / 1000),
  };
  gs.result = view;
  gs.resultAt = now;
  gs.toActSeat = null;
  gs.deadline = null;
}

/** 超时自动行动：可让牌则让牌，否则弃牌 */
export function autoAction(gs: GState, seat: number, now: number = Date.now()): void {
  if (gs.toActSeat !== seat) return;
  const legal = legalActionsFor(gs, seat);
  if (!legal) return;
  const p = bySeat(gs, seat)!;
  if (legal.canCheck) {
    p.acted = true;
    p.lastAction = '让牌';
    pushLog(gs, 'action', `${p.name} 超时让牌`);
  } else {
    p.folded = true;
    p.lastAction = '弃牌';
    pushLog(gs, 'action', `${p.name} 超时弃牌`);
  }
  proceed(gs, now);
}

/** 周期驱动：处理超时行动与结算后推进；返回状态是否变化 */
export function tick(gs: GState, now: number): boolean {
  if (gs.toActSeat != null && gs.deadline != null && now >= gs.deadline) {
    autoAction(gs, gs.toActSeat, now);
    return true;
  }
  return false;
}

/** 结算后进入下一手或终局（房间层在调用前完成玩家清理） */
export function requestNextHand(gs: GState, now: number = Date.now()): void {
  if (gs.phase !== 'result') return;
  advanceAfterResult(gs, now);
}

function advanceAfterResult(gs: GState, now: number): void {
  for (const p of gs.players) {
    if (p.chips <= 0) p.inHand = false;
  }
  const withChips = gs.players.filter((p) => p.chips > 0);
  if (withChips.length <= 1) {
    const champion = withChips[0];
    gs.phase = 'gameover';
    gs.result = null;
    gs.resultAt = null;
    const ranking = gs.players
      .slice()
      .sort((a, b) => b.chips - a.chips)
      .map((p) => ({ seat: p.seat, name: p.name, chips: p.chips }));
    const final: GameOverView = { ranking };
    gs.final = final;
    pushLog(gs, 'sys', champion ? `🏆 ${champion.name} 赢得整场比赛！` : '比赛结束');
  } else {
    startHand(gs, now);
  }
}

/** 终局后再来一场：筹码重置回等待状态 */
export function rematch(gs: GState): void {
  for (const p of gs.players) {
    p.chips = gs.settings.startChips;
    p.hole = [];
    p.bet = 0;
    p.committed = 0;
    p.folded = false;
    p.allIn = false;
    p.acted = false;
    p.inHand = false;
    p.won = 0;
    p.handScore = 0;
    p.handName = null;
    p.lastAction = null;
  }
  gs.phase = 'waiting';
  gs.handNumber = 0;
  gs.community = [];
  gs.deck = [];
  gs.currentBet = 0;
  gs.minRaise = gs.settings.bb;
  gs.shortAllIn = false;
  gs.toActSeat = null;
  gs.deadline = null;
  gs.result = null;
  gs.resultAt = null;
  gs.final = null;
  gs.sbSeat = null;
  gs.bbSeat = null;
  pushLog(gs, 'sys', '新一即将开始，等待房主开局');
}

/** 结果等待期还剩多少毫秒（供视图展示） */
export function resultRemainMs(gs: GState, now: number): number {
  if (gs.phase !== 'result' || gs.resultAt == null) return 0;
  return Math.max(0, gs.resultAt + RESULT_MS - now);
}

export { RESULT_MS, TURN_MS };
