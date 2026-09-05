import { randomInt } from 'node:crypto';
import { BLOOD_MARKET_BY_ID, buildBloodMarketDeck, type BloodEffect } from '@shared/bloodCards';
import { catName, evalBloodHand, toEvalCard, applyImitate, type EvalCard } from '@shared/bloodEval';
import { BLOOD_CHAR_BY_ID, applyCharEval, charHandCap, charPoolIds, charSwapMax } from '@shared/bloodChars';
import { coreOrder, showdownReadyMs } from '@shared/bloodShowdown';
import type { LogLine, Suit } from '@shared/protocol';
import {
  BLOOD_HAND_CAP,
  BLOOD_PLAY_COUNT,
  BLOOD_SD_WAIT_MS,
  BLOOD_SETUP_KEEP,
  BLOOD_TURN_MS,
  type BCard,
  type BarrierEffect,
  type ChipInst,
  type RevealDecision,
  type BloodFinal,
  type BloodPhase,
  type BloodResultView,
  type BloodState,
  type BPlayer,
  type MarketSlot,
  type SettleRow,
} from './types';

export class BloodError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.code = code;
  }
}

const SUIT_CH: Record<Suit, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

/** 生效中的角色（暂时失忆 charOff 期间视为无角色；无面人临时技能优先；捣蛋鬼技能不可被无效） */
export function effChar(p: BPlayer): string | null {
  if (p.charId === 'imp') return 'imp';
  if (p.charOff) return null;
  return p.tempChar ?? p.charId;
}

/** 从牌 id 前缀 c{seat}- 解析牌的原始归属座位（捣蛋鬼/无业游民/清洁工等跨牌堆效果用） */
function cardOwnerSeat(cardId: string): number | null {
  const m = /^c(\d+)-/.exec(cardId);
  return m ? Number(m[1]) : null;
}

/** 角色性别判定（魅魔）：gender 字段缺失视为无性别（同时视为男性与女性） */
function charGender(charId: string | null): 'm' | 'f' | null {
  if (!charId) return null;
  return BLOOD_CHAR_BY_ID.get(charId)?.gender ?? null;
}

function genderMatches(charId: string | null, want: 'm' | 'f'): boolean {
  const g = charGender(charId);
  return g === null || g === want;
}

/** 结算期血筹获得（双生子·弟：结算阶段获得血筹 -2，最低为 0） */
function settleGainBlood(gs: BloodState, p: BPlayer, n: number): number {
  void gs;
  const gain = Math.max(0, n - (effChar(p) === 'twinB' ? 2 : 0));
  return gain;
}

export function bloodCardText(c: BCard): string {
  if (c.s == null) return '🃏';
  const rank = c.r === 14 ? 'A' : c.r === 13 ? 'K' : c.r === 12 ? 'Q' : c.r === 11 ? 'J' : String(c.r);
  return `${rank}${SUIT_CH[c.s]}`;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newPlayerDeck(seat: number): BCard[] {
  const cards: BCard[] = [];
  let n = 0;
  for (const s of ['s', 'h', 'd', 'c'] as Suit[]) {
    for (let r = 2; r <= 14; r++) cards.push({ id: `c${seat}-${n++}`, r, s });
  }
  cards.push({ id: `c${seat}-${n++}`, r: 0, s: null });
  cards.push({ id: `c${seat}-${n++}`, r: 0, s: null });
  return shuffle(cards);
}

export interface BloodPlayerInit {
  id: string;
  name: string;
  seat: number;
}

export function createBloodGame(
  seatCount: number,
  players: BloodPlayerInit[],
  now = Date.now(),
  charExpansion = false,
  expansion = false,
): BloodState {
  const bps: BPlayer[] = players
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      blood: 0,
      tickets: 0,
      draw: newPlayerDeck(p.seat),
      hand: [],
      discard: [],
      removed: [],
      play: [],
      chips: [],
      items: [],
      privilege: false,
      swapLeft: 0,
      swapDone: false,
      locked: false,
      buyPassed: false,
      removeDone: false,
      reorgDone: false,
      sdSeen: false,
      setupRound: 0,
      setupHand: [],
      charId: null,
      charOptions: [],
      streamerUsed: false,
      firstBuyUsed: false,
      boughtAny: false,
      skipBuyRemove: false,
      skipBuy: false,
      swapMalus: 0,
      charOff: false,
      charOffNextRound: false,
      skipReorg: false,
      claimedWin: false,
      princessDark: true,
      curseStash: [],
      undertakerStash: [],
      undertakerUsed: false,
      dogUsed: false,
      extraSwapProtected: false,
      fryerDelCount: 0,
      baristaPending: false,
      tempChar: null,
      facelessDone: false,
      agentUsed: false,
      swapEndPrompted: false,
      lastAction: null,
      connected: true,
    }));

  const gs: BloodState = {
    phase: 'pick',
    round: 0,
    players: bps,
    seatCount,
    supply: buildBloodMarketDeck((n) => randomInt(0, n), expansion),
    market: [],
    recycle: [],
    turnSeat: null,
    deadline: null,
    stealPending: null,
    secretPending: null,
    comparePipsFirst: false,
    announce: null,
    revealed: [],
    result: null,
    resultAt: null,
    swapStopSeen: false,
    charDeck: [],
    gamblerGuess: null,
    bomberX: null,
    bluffer: null,
    mynameCat: null,
    mynameText: null,
    smugglerMark: null,
    seerZone: [],
    agentSwap: null,
    impTurns: 0,
    preBuyQueue: [],
    auction: null,
    startupQueue: [],
    preDrawQueue: [],
    swapEndQueue: [],
    settleQueue: [],
    eraserType: null,
    irisGuess: null,
    final: null,
    target: targetTickets(seatCount),
    log: [],
    logSeq: 0,
    privilegeSeat: null,
  };
  for (let i = 0; i < 5; i++) gs.market.push(drawMarketSlot(gs));

  // 掷骰决定临时特权证（点数最高者，平局随机取一）；江东之主始终持有特权证
  const sunwu = bps.find((p) => p.charId === 'sunwu');
  if (sunwu) {
    gs.privilegeSeat = sunwu.seat;
    sunwu.privilege = true;
    for (const p of bps) p.blood = p.privilege ? 2 : 3;
    pushLog(gs, 'sys', `${sunwu.name}【江东之主】始终拥有【临时特权证】（2血筹，其余3血筹）`);
  } else {
    const rolls = bps.map((p) => ({ p, roll: randomInt(1, 7) }));
    const maxRoll = Math.max(...rolls.map((r) => r.roll));
    const winners = rolls.filter((r) => r.roll === maxRoll);
    const holder = winners[randomInt(0, winners.length)];
    gs.privilegeSeat = holder.p.seat;
    holder.p.privilege = true;
    for (const p of bps) p.blood = p.privilege ? 2 : 3;
    pushLog(
      gs,
      'sys',
      `掷骰定特权证：${rolls.map((r) => `${r.p.name} ${r.roll}点`).join('，')} → ${holder.p.name} 获得【临时特权证】（2血筹，其余3血筹）`,
    );
  }

  // 选将/分配：始终进行。2人局每人随机2张选1；3/4人局每人直接随机分配1名角色
  const pool = shuffle(charPoolIds(charExpansion));
  gs.charDeck = shuffle(charPoolIds(charExpansion)); // 无面人每回合抽角色用
  pushLog(gs, 'sys', `🎭 本局角色池：${charExpansion ? `全部 ${pool.length} 名角色（含拓展）` : `基础版 ${pool.length} 名角色`}`);
  if (seatCount === 2) {
    for (const p of bps) p.charOptions = [pool.pop()!, pool.pop()!];
    pushLog(gs, 'sys', '🎭 2人局选将：每人从两张随机角色牌中选择一张');
  } else {
    const assigned = bps.map((p) => {
      p.charId = pool.pop()!;
      return `${p.name}【${BLOOD_CHAR_BY_ID.get(p.charId)!.name}】`;
    });
    pushLog(gs, 'sys', `🎭 ${seatCount}人局随机分配角色：${assigned.join('、')}`);
    beginAfterPick(gs, now);
  }
  gs.deadline = now + BLOOD_TURN_MS;
  return gs;
}

/** 角色确定 → 游戏开始效果结算 → 初始构筑（飞车党/捣蛋鬼跳过；黑客特殊构筑；我的名字？/黑客进入初始化队列） */
function beginAfterPick(gs: BloodState, now: number): void {
  pushLog(gs, 'sys', '🎭 角色确定，游戏开始');
  // 江东之主始终拥有临时特权证（覆盖掷骰结果；血筹同步修正为 2/3）
  const sunwu = gs.players.find((p) => p.charId === 'sunwu');
  if (sunwu && !sunwu.privilege) {
    const old = gs.players.find((p) => p.privilege);
    for (const p of gs.players) p.privilege = false;
    sunwu.privilege = true;
    gs.privilegeSeat = sunwu.seat;
    sunwu.blood -= 1;
    if (old && old.id !== sunwu.id) old.blood += 1;
    pushLog(gs, 'sys', `${sunwu.name}【江东之主】始终拥有【临时特权证】（特权证转移，血筹修正为 2/3）`);
  }
  for (const p of gs.players) {
    const def = BLOOD_CHAR_BY_ID.get(p.charId!)!;
    switch (effChar(p)) {
      case 'noble':
        p.blood += 12;
        pushLog(gs, 'action', `${p.name}【${def.name}】游戏开始：获得 12 血筹`);
        break;
      case 'clerk':
        p.blood += 2;
        pushLog(gs, 'action', `${p.name}【${def.name}】游戏开始：额外获得 2 血筹`);
        break;
      case 'actor': {
        const removed: BCard[] = [];
        for (let i = 0; i < 2; i++) {
          const idx = p.draw.findIndex((c) => c.r === 2);
          if (idx < 0) break;
          removed.push(...p.draw.splice(idx, 1));
        }
        p.removed.push(...removed);
        if (removed.length > 0) {
          pushLog(gs, 'action', `${p.name}【${def.name}】游戏开始：删除 2 张2（${removed.map(bloodCardText).join(' ')}）`);
        }
        break;
      }
      case 'biker': {
        const royals = p.draw.filter((c) => c.r >= 11);
        p.draw = p.draw.filter((c) => c.r < 11);
        p.removed.push(...royals);
        p.setupRound = 2; // 跳过初始构筑
        pushLog(gs, 'action', `${p.name}【${def.name}】游戏开始：删除所有 J/Q/K/A（${royals.length} 张），跳过初始构筑`);
        break;
      }
      case 'imp':
        p.draw = []; // 没有个人牌堆
        p.setupRound = 2; // 跳过初始构筑
        break;
      case 'hacker':
        p.setupRound = 0; // 初始构筑改为从全牌库挑8张删除（走 hackerSetup 交互）
        gs.startupQueue.push({ seat: p.id, kind: 'hackerSetup' });
        break;
      case 'myname':
        gs.startupQueue.push({ seat: p.id, kind: 'mynameSet' });
        break;
    }
  }
  for (const p of gs.players) {
    if (p.setupRound < 2 && effChar(p) !== 'hacker') drawSetupHand(gs, p);
  }
  gs.phase = 'setup';
  gs.deadline = now + BLOOD_TURN_MS;
  processStartupQueue(gs);
}

/** 游戏开始初始化队列：我的名字？设定 → 黑客初始构筑，逐个挂起 */
function processStartupQueue(gs: BloodState): void {
  if (gs.secretPending) return;
  const next = gs.startupQueue.shift();
  if (!next) return;
  gs.secretPending = { seat: next.seat, kind: next.kind };
}

/** 玩家选定角色牌 */
export function bPickChar(gs: BloodState, playerId: string, charId: string, now: number): void {
  if (gs.phase !== 'pick') throw new BloodError('BAD_PHASE', '不在选将阶段');
  const p = gs.players.find((x) => x.id === playerId);
  if (!p) throw new BloodError('NO_PLAYER', '玩家不在对局中');
  if (p.charId) return;
  if (!p.charOptions.includes(charId)) throw new BloodError('BAD_CARD', '该角色牌不在你的选项中');
  p.charId = charId;
  p.charOptions = [];
  const def = BLOOD_CHAR_BY_ID.get(charId)!;
  pushLog(gs, 'sys', `${p.name} 选择角色：【${def.name}】`);
  if (allDone(gs, (x) => x.charId != null)) beginAfterPick(gs, now);
}

function targetTickets(seatCount: number): number {
  if (seatCount <= 2) return 24;
  if (seatCount === 3) return 20;
  return 16;
}

function drawMarketSlot(gs: BloodState): MarketSlot {
  const def = gs.supply.pop() ?? null;
  return { def, bonus: 0 };
}

function pushLog(gs: BloodState, kind: LogLine['kind'], text: string): LogLine {
  const line = { seq: ++gs.logSeq, kind, text };
  gs.log.push(line);
  if (gs.log.length > 150) gs.log.splice(0, gs.log.length - 150);
  return line;
}

function bySeat(gs: BloodState, seat: number): BPlayer | null {
  return gs.players.find((p) => p.seat === seat) ?? null;
}

function orderFrom(gs: BloodState, startSeat: number): BPlayer[] {
  const out: BPlayer[] = [];
  for (let i = 0; i < gs.seatCount; i++) {
    const p = bySeat(gs, (startSeat + i) % gs.seatCount);
    if (p) out.push(p);
  }
  return out;
}

function seatDist(gs: BloodState, from: number, to: number): number {
  return (to - from + gs.seatCount) % gs.seatCount;
}

function reshuffleIfEmpty(gs: BloodState, p: BPlayer): void {
  if (p.draw.length === 0 && p.discard.length > 0) {
    p.draw = shuffle(p.discard);
    p.discard = [];
    onLibraryReshuffle(gs);
  }
}

/** 重洗牌库（弃牌区与抽牌区重新洗混）触发：洗衣房店主 +1 血筹；磁力线圈此牌回到抽牌堆顶 */
function onLibraryReshuffle(gs: BloodState): void {
  for (const x of gs.players) {
    if (effChar(x) === 'laundry') {
      x.blood += 1;
      pushLog(gs, 'action', `${x.name}【洗衣房店主】因重洗牌库获得 1 血筹`);
    }
    // 磁力线圈：弃牌区装有线圈的牌挑出，放在抽牌堆顶
    const coilCard = x.discard.find(
      (c) => x.chips.some((ch) => ch.on === c.id && !ch.off && BLOOD_MARKET_BY_ID.get(ch.def)?.effect.k === 'magCoil'),
    );
    if (coilCard) {
      x.discard = x.discard.filter((c) => c.id !== coilCard.id);
      x.draw.push(coilCard); // draw 末端为堆顶
      pushLog(gs, 'action', `${x.name} 的【磁力线圈】发动：${bloodCardText(coilCard)} 放在抽牌堆顶`);
    }
  }
}

function drawN(gs: BloodState, p: BPlayer, n: number): BCard[] {
  const out: BCard[] = [];
  for (let i = 0; i < n; i++) {
    reshuffleIfEmpty(gs, p);
    const c = p.draw.pop();
    if (!c) break;
    out.push(c);
  }
  return out;
}

function drawToCap(gs: BloodState, p: BPlayer, cap: number = charHandCap(effChar(p))): void {
  // 捣蛋鬼没有个人牌堆：需要抽牌时改为从对手抽牌堆自选（挂起 impDraw）
  if (effChar(p) === 'imp') {
    if (p.hand.length < cap && gs.secretPending == null) tryImpDraw(gs, p, Date.now());
    return;
  }
  while (p.hand.length < cap) {
    reshuffleIfEmpty(gs, p);
    const c = p.draw.pop();
    if (!c) break;
    p.hand.push(c);
  }
}

function drawSetupHand(gs: BloodState, p: BPlayer): void {
  p.setupHand = drawN(gs, p, 8);
  pushLog(gs, 'sys', `${p.name} 抽取初始构筑第 ${p.setupRound + 1} 组 8 张牌`);
}

/* ---------------- 阶段推进 ---------------- */

export function startDrawPhase(gs: BloodState, now: number): void {
  // 抽牌阶段前的角色互动：私家侦探（弃牌区置顶/底）→ 无面人（抽角色 2 选 1）
  gs.phase = 'draw';
  gs.result = null;
  gs.resultAt = null;
  gs.stealPending = null;
  gs.announce = null;
  gs.comparePipsFirst = false;
  gs.revealed = [];
  gs.gamblerGuess = null;
  gs.bomberX = null;
  gs.bluffer = null;
  gs.smugglerMark = null;
  gs.agentSwap = null;
  gs.impTurns = 0;
  gs.preBuyQueue = [];
  gs.auction = null;
  for (const p of gs.players) {
    // 暂时失忆：本回合角色技能失效；餐车投毒：换牌次数 -N（最低 0）
    p.charOff = p.charOffNextRound;
    p.charOffNextRound = false;
    // 无面人：临时技能持续至本抽牌阶段开始前，至此过期
    p.tempChar = null;
    // 每回合角色标志重置
    p.streamerUsed = false;
    p.firstBuyUsed = false;
    p.boughtAny = false;
    p.skipBuyRemove = false;
    p.skipBuy = false;
    p.claimedWin = false;
    p.dogUsed = false;
    p.undertakerUsed = false;
    p.extraSwapProtected = false;
    p.fryerDelCount = 0;
    p.baristaPending = false;
    p.agentUsed = false;
    p.swapEndPrompted = false;
  }
  const preDraw: { seat: string; kind: 'detectivePick' | 'facelessPick' }[] = [];
  for (const p of gs.players) {
    const ch = effChar(p);
    if (ch === 'detective' && p.discard.length > 0) preDraw.push({ seat: p.id, kind: 'detectivePick' });
    if (ch === 'faceless' && !p.facelessDone && gs.charDeck.length >= 2) preDraw.push({ seat: p.id, kind: 'facelessPick' });
  }
  gs.preDrawQueue = preDraw;
  gs.swapStopSeen = false;
  gs.eraserType = null;
  gs.irisGuess = null;
  pushLog(gs, 'hand', `── 第 ${gs.round} 回合 · 抽牌阶段 ──`);
  processPreDrawQueue(gs, now);
}

/** 依次处理抽牌前互动；队列空则完成抽牌进入换牌 */
function processPreDrawQueue(gs: BloodState, now: number): void {
  if (gs.secretPending) return;
  const next = gs.preDrawQueue.shift();
  if (!next) {
    finishDrawPhase(gs, now);
    return;
  }
  if (next.kind === 'facelessPick') {
    const opts = [gs.charDeck.pop()!, gs.charDeck.pop()!];
    gs.secretPending = { seat: next.seat, kind: 'facelessPick', options: opts };
    pushLog(gs, 'action', `🎭 ${gs.players.find((p) => p.id === next.seat)?.name}【无面人】抽取角色牌，须选择其中一张的技能`);
  } else {
    gs.secretPending = { seat: next.seat, kind: 'detectivePick' };
  }
  gs.deadline = now + BLOOD_TURN_MS;
}

/** 抽牌（抽至上限）+ 换牌次数计算，进入换牌阶段 */
function finishDrawPhase(gs: BloodState, now: number): void {
  gs.phase = 'swap';
  for (const p of gs.players) {
    if (effChar(p) === 'imp') continue; // 捣蛋鬼没有个人牌堆，抽牌在其他玩家换牌结束后进行
    drawToCap(gs, p);
    let swapBase = p.privilege ? 4 : 3;
    if (p.swapMalus > 0) {
      const malus = p.swapMalus;
      p.swapMalus = 0;
      swapBase = Math.max(0, swapBase - malus);
      pushLog(gs, 'action', `${p.name} 因【餐车投毒】本回合换牌次数 -${malus}（剩 ${swapBase} 次）`);
    }
    if (effChar(p) === 'dungeon') {
      // 地下城主：换牌阶段前自动掷骰（≥3 调整默认次数，特权证 +1 照常叠加；<3 获得点数血筹）
      const roll = randomInt(1, 7);
      if (roll >= 3) {
        swapBase = roll + (p.privilege ? 1 : 0);
        pushLog(gs, 'action', `${p.name}【地下城主】掷出 ${roll} 点：本回合换牌次数调整为 ${swapBase}`);
      } else {
        p.blood += roll;
        pushLog(gs, 'action', `${p.name}【地下城主】掷出 ${roll} 点：获得 ${roll} 血筹（换牌次数仍为 ${swapBase}）`);
      }
    }
    if (effChar(p) === 'bartender') swapBase += 1;
    p.swapLeft = swapBase;
    p.swapDone = false;
    p.locked = false;
    p.buyPassed = false;
    p.removeDone = false;
    p.reorgDone = false;
    p.skipReorg = false;
    p.lastAction = null;
  }
  // 炸弹客：换牌阶段开始前可宣告 X（0-2）
  const bomber = gs.players.find((p) => effChar(p) === 'bomber');
  if (bomber) gs.swapEndQueue.push({ seat: bomber.id, kind: 'bomberClaim' });
  gs.deadline = now + BLOOD_TURN_MS;
  checkSwapEnd(gs, now);
}

function allDone(gs: BloodState, pred: (p: BPlayer) => boolean): boolean {
  return gs.players.every(pred);
}

/* ---------------- 初始构筑 ---------------- */

export function bSetup(gs: BloodState, playerId: string, removedIds: string[], now: number): void {
  if (gs.phase !== 'setup') throw new BloodError('BAD_PHASE', '不在初始构筑阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (p.setupRound >= 2) return;
  if (removedIds.length > BLOOD_SETUP_KEEP) throw new BloodError('TOO_MANY', `最多删除 ${BLOOD_SETUP_KEEP} 张`);
  const removedCards: BCard[] = [];
  const kept: BCard[] = [];
  for (const c of p.setupHand) {
    if (removedIds.includes(c.id)) removedCards.push(c);
    else kept.push(c);
  }
  p.discard.push(...kept);
  p.removed.push(...removedCards);
  if (removedCards.length > 0) {
    pushLog(gs, 'action', `${p.name} 初始构筑删除：${removedCards.map(bloodCardText).join(' ')}`);
  }
  gainChefDeleteThrees(gs, p, removedCards); // 特级大厨：初始构筑删除3也触发
  p.setupHand = [];
  p.setupRound += 1;
  if (p.setupRound < 2) {
    drawSetupHand(gs, p);
  } else if (allDone(gs, (x) => x.setupRound >= 2)) {
    pushLog(gs, 'sys', '初始构筑完毕');
    startDrawPhase(gs, now);
  }
}

/* ---------------- 换牌阶段 ---------------- */

export function bSwap(gs: BloodState, playerId: string, cardIds: string[], drawCount: number | undefined, now: number): void {
  if (gs.phase !== 'swap') throw new BloodError('BAD_PHASE', '不在换牌阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (gs.secretPending && gs.secretPending.seat === p.id) throw new BloodError('PENDING', '先完成当前角色技能抉择');
  if (p.swapDone) throw new BloodError('ALREADY_DONE', '你已停止换牌');
  const tarot = effChar(p) === 'tarot';
  // 塔罗师：每次换牌可先抽牌（≤2）再弃牌（≤2）
  const draw = tarot ? Math.max(0, Math.min(2, Math.floor(drawCount ?? 0))) : 0;
  const maxN = Math.min(tarot ? 2 : charSwapMax(effChar(p)), p.hand.length + draw);
  if (cardIds.length > maxN) {
    throw new BloodError('TOO_MANY', tarot ? '塔罗师每次换牌最多弃置2张' : effChar(p) === 'idol' ? '弃置张数不能超过手牌数' : '每次换牌最多弃置3张');
  }
  if (draw > 0) {
    const drawn = drawN(gs, p, draw);
    p.hand.push(...drawn);
    pushLog(gs, 'action', `${p.name}【塔罗师】先抽牌：${drawn.map(bloodCardText).join(' ') || '（牌库已空）'}`);
  }
  const set = new Set(cardIds);
  const discardCards = p.hand.filter((c) => set.has(c.id));
  if (discardCards.length !== cardIds.length) throw new BloodError('BAD_CARD', '手牌不存在');
  p.hand = p.hand.filter((c) => !set.has(c.id));
  p.discard.push(...discardCards);

  // 特级大厨：换牌阶段每弃置1张【3】获得1血筹
  const chefThrees = discardCards.filter((c) => finalRank(p, c) === 3).length;
  if (effChar(p) === 'chef' && chefThrees > 0) {
    p.blood += chefThrees;
    pushLog(gs, 'action', `${p.name}【特级大厨】弃置 ${chefThrees} 张3：获得 ${chefThrees} 血筹`);
  }
  // 偶像：一次弃置≥4张获得1血筹
  if (effChar(p) === 'idol' && discardCards.length >= 4) {
    p.blood += 1;
    pushLog(gs, 'action', `${p.name}【偶像】一次弃置 ${discardCards.length} 张：获得 1 血筹`);
  }
  // 主播：一次弃置≥2张同最终点数（每回合一次）
  if (effChar(p) === 'streamer' && !p.streamerUsed && discardCards.length >= 2) {
    const ranks = discardCards.map((c) => finalRank(p, c));
    if (new Set(ranks).size < ranks.length) {
      p.streamerUsed = true;
      p.blood += 3;
      pushLog(gs, 'action', `${p.name}【主播】一次弃置同点数的牌：公示并获得 3 血筹`);
    }
  }

  drawToCap(gs, p);
  p.swapLeft -= 1;
  p.lastAction = `换牌 ${cardIds.length}张`;
  pushLog(gs, 'action', `${p.name} 换牌：弃置 ${discardCards.map(bloodCardText).join(' ')}，抽至上限`);
  if (p.swapLeft <= 0) {
    p.swapDone = true;
    // 酒保：剩余可换牌次数实际变为 0 时获得 1 血筹
    if (effChar(p) === 'bartender') {
      p.blood += 1;
      pushLog(gs, 'action', `${p.name}【酒保】换牌次数用尽：获得 1 血筹`);
    }
    markSwapStopped(gs, p);
    afterSwapEnded(gs, p, now);
  }
  checkSwapEnd(gs, now);
}

/** 宣告换牌结束（停止或次数用尽）：白蔷薇判定首位 */
function markSwapStopped(gs: BloodState, p: BPlayer): void {
  if (gs.swapStopSeen) return;
  gs.swapStopSeen = true;
  if (effChar(p) === 'rose') {
    p.blood += 3;
    pushLog(gs, 'action', `${p.name}【白蔷薇】第一位宣告换牌结束：获得 3 血筹`);
  }
}

/** 某玩家换牌结束（停止或次数用尽）后的角色钩子：入队等待逐一结算 */
function afterSwapEnded(gs: BloodState, p: BPlayer, now: number): void {
  void now;
  // 神作章鱼：换牌结束时洗混弃牌区，随机取回至多 2 张加入手牌
  if (effChar(p) === 'octopus' && p.discard.length > 0) {
    const shuffled = shuffle(p.discard);
    const take = shuffled.slice(0, Math.min(2, shuffled.length));
    p.discard = shuffled.slice(take.length);
    p.hand.push(...take);
    pushLog(gs, 'action', `${p.name}【神作章鱼】从弃牌区随机取回：${take.map(bloodCardText).join(' ')}`);
  }
  // 入殓师：换牌结束时角色牌上的牌置入弃牌区；未用过特殊换牌则获得 2 血筹
  if (effChar(p) === 'undertaker') {
    if (p.undertakerStash.length > 0) {
      p.discard.push(...p.undertakerStash);
      p.undertakerStash = [];
      pushLog(gs, 'action', `${p.name}【入殓师】角色牌上的牌置入弃牌区`);
    }
    if (!p.undertakerUsed) {
      p.blood += 2;
      pushLog(gs, 'action', `${p.name}【入殓师】本回合未执行特殊换牌：获得 2 血筹`);
    }
  }
  // 捣蛋鬼：其他玩家换牌结束时，捣蛋鬼开始抽牌与换牌
  const imp = gs.players.find((x) => x.charId === 'imp');
  if (imp && p.id !== imp.id) gs.impTurns += 1;
  // 换牌结束的互动技能入队（每回合一次，额外换牌后的再次结束不重复触发）
  const ch = effChar(p);
  if (!p.swapEndPrompted) {
    let pushed = false;
    if (ch === 'curse' && p.curseStash.length > 0) {
      gs.swapEndQueue.push({ seat: p.id, kind: 'curseTake' });
      pushed = true;
    }
    if (ch === 'godOfGambling') {
      gs.swapEndQueue.push({ seat: p.id, kind: 'godPeek' });
      pushed = true;
    }
    if (ch === 'general') {
      gs.swapEndQueue.push({ seat: p.id, kind: 'generalChoice' });
      pushed = true;
    }
    if (ch === 'vagrant' && gs.players.some((o) => o.id !== p.id && o.draw.length >= 2)) {
      gs.swapEndQueue.push({ seat: p.id, kind: 'vagrantDraw' });
      pushed = true;
    }
    if (ch === 'ceo') {
      gs.swapEndQueue.push({ seat: p.id, kind: 'ceoGive' });
      pushed = true;
    }
    if (pushed) p.swapEndPrompted = true;
  }
}

export function bSwapStop(gs: BloodState, playerId: string, now: number): void {
  if (gs.phase !== 'swap') throw new BloodError('BAD_PHASE', '不在换牌阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (gs.secretPending && gs.secretPending.seat === p.id) {
    throw new BloodError('PENDING', '先完成当前角色技能抉择');
  }
  if (p.swapDone) return;
  p.swapDone = true;
  p.lastAction = '停止换牌';
  pushLog(gs, 'action', `${p.name} 停止换牌`);
  markSwapStopped(gs, p);
  afterSwapEnded(gs, p, now);
  checkSwapEnd(gs, now);
}

function impId(gs: BloodState): string | null {
  return gs.players.find((x) => x.charId === 'imp')?.id ?? null;
}

function checkSwapEnd(gs: BloodState, now: number): void {
  if (gs.secretPending) return;
  if (gs.swapEndQueue.length > 0) {
    const next = gs.swapEndQueue.shift()!;
    gs.secretPending = { seat: next.seat, kind: next.kind };
    gs.deadline = now + BLOOD_TURN_MS;
    return;
  }
  if (gs.impTurns > 0) {
    beginImpTurn(gs, now);
    return;
  }
  if (!allDone(gs, (p) => p.swapDone)) return;
  for (const p of gs.players) {
    if (p.swapLeft > 0) {
      if (p.extraSwapProtected) {
        p.swapLeft = 0;
        continue; // 将军/赌神的额外换牌不兑换成血筹
      }
      p.blood += p.swapLeft;
      pushLog(gs, 'action', `${p.name} 未使用的换牌次数兑换 ${p.swapLeft} 血筹`);
      p.swapLeft = 0;
    }
  }
  startPlayPhase(gs, now);
}

/** 捣蛋鬼小回合：其他玩家换牌结束后，捣蛋鬼抽牌（自选对手）并换牌 */
function beginImpTurn(gs: BloodState, now: number): void {
  const imp = gs.players.find((x) => x.charId === 'imp');
  if (!imp) {
    gs.impTurns = 0;
    return;
  }
  gs.impTurns -= 1;
  imp.swapDone = false;
  imp.swapLeft = imp.privilege ? 4 : 3;
  imp.lastAction = null;
  pushLog(gs, 'action', `🃏 ${imp.name}【捣蛋鬼】开始抽牌与换牌（剩余小回合 ${gs.impTurns}）`);
  tryImpDraw(gs, imp, now);
}

/** 捣蛋鬼抽牌：手牌未满上限且对手有牌可抽时挂起自选来源 */
function tryImpDraw(gs: BloodState, imp: BPlayer, now: number): void {
  const cap = charHandCap('imp');
  if (imp.hand.length >= cap) return;
  const sources = gs.players.filter((o) => o.id !== imp.id && o.draw.length > 0);
  if (sources.length === 0) {
    pushLog(gs, 'action', `${imp.name} 无牌可抽（对手抽牌堆均空）`);
    return;
  }
  gs.secretPending = { seat: imp.id, kind: 'impDraw' };
  gs.deadline = now + BLOOD_TURN_MS;
}

function startPlayPhase(gs: BloodState, now: number): void {
  gs.phase = 'play';
  for (const p of gs.players) p.locked = false;
  pushLog(gs, 'hand', `第 ${gs.round} 回合 · 出牌阶段：暗选 5 张`);
  // 职业赌徒：对决阶段前可猜测本回合夺魁者（可猜自己）
  const gambler = gs.players.find((p) => effChar(p) === 'gambler');
  if (gambler) {
    gs.secretPending = { seat: gambler.id, kind: 'gamblerGuess' };
    pushLog(gs, 'action', `🎲 ${gambler.name}【职业赌徒】可猜测本回合的夺魁者`);
  }
  gs.deadline = now + BLOOD_TURN_MS;
}

/* ---------------- 出牌阶段 ---------------- */

/** 牌的最终点数（含强化芯片修正，钳制 2-14；王牌为 0） */
function finalRank(p: BPlayer, c: BCard): number {
  if (c.s == null || c.r === 0) return 0;
  let r = c.r;
  for (const ch of p.chips.filter((x) => x.on === c.id)) {
    const eff = BLOOD_MARKET_BY_ID.get(ch.def)?.effect;
    if (eff && eff.k === 'rankMod') r = Math.min(14, Math.max(2, r + eff.mod));
  }
  return r;
}

/** 出牌区最终花色是否全为黑色（joker/变色类芯片可宣告为黑即算；瞎掰王宣告成立时按宣告牌） */
function allSuitsMatch(gs: BloodState, p: BPlayer, colors: 'black' | 'red'): boolean {
  const ok = (s: string) => (colors === 'black' ? s === 's' || s === 'c' : s === 'h' || s === 'd');
  return evalCardsFor(p, gs).every((c) => c.suits.some(ok));
}

/** 出牌区可达成花色种数（固定花色计入，灵活牌可补足缺失花色） */
function suitDiversity(gs: BloodState, p: BPlayer): number {
  const singles = new Set<string>();
  let flex = 0;
  for (const c of evalCardsFor(p, gs)) {
    if (c.suits.length === 1) singles.add(c.suits[0]);
    else flex += 1;
  }
  return Math.min(4, singles.size + flex);
}

/** 由玩家出牌/手牌构建评估输入（含芯片、仿制印章与角色技能改写；瞎掰王宣告成立时以宣告牌为准） */
function evalCardsFor(p: BPlayer, gs?: BloodState): EvalCard[] {
  // 瞎掰王：无人质疑时按宣告的牌进行对决
  if (gs && gs.bluffer && gs.bluffer.seat === p.id && !gs.bluffer.challenged) {
    return gs.bluffer.declared.map((c) => toEvalCard(c.id, c.r, c.s, []));
  }
  const toEval = (c: BCard): EvalCard =>
    toEvalCard(
      c.id,
      c.r,
      c.s,
      p.chips.filter((ch) => ch.on === c.id).flatMap((ch) => chipEffectsFor(p, ch)),
    );
  const evals = p.play.map(toEval);
  const imitate = p.play.map((c) =>
    p.chips
      .filter((ch) => ch.on === c.id)
      .flatMap((ch) => chipEffectsFor(p, ch))
      .some((eff) => eff.k === 'imitate'),
  );
  // 顺序：仿制印章（视为其它基础牌面）→ 角色技能（特型演员可链式视为JOKER等）
  return applyCharEval(applyImitate(evals, p.play, imitate), effChar(p));
}

export function evalForPlayer(p: BPlayer, gs?: BloodState): { cat: number; catName: string; pips: number } {
  const res = evalBloodHand(evalCardsFor(p, gs));
  return { cat: res.cat, catName: res.name, pips: res.pips };
}

/** 自动出牌：从手牌中选评估最优的 5 张（含角色技能修正） */
export function bestFive(p: BPlayer): string[] {
  const toEval = (c: BCard): EvalCard =>
    applyCharEval(
      [
        toEvalCard(
          c.id,
          c.r,
          c.s,
          p.chips.filter((ch) => ch.on === c.id).flatMap((ch) => chipEffectsFor(p, ch)),
        ),
      ],
      effChar(p),
    )[0];
  let best: { ids: string[]; cat: number; pips: number } | null = null;
  const combos = combinations(p.hand, BLOOD_PLAY_COUNT);
  for (const combo of combos) {
    const res = evalBloodHand(combo.map(toEval));
    if (!best || res.cat > best.cat || (res.cat === best.cat && res.pips > best.pips)) {
      best = { ids: combo.map((c) => c.id), cat: res.cat, pips: res.pips };
    }
  }
  return best?.ids ?? p.hand.slice(0, BLOOD_PLAY_COUNT).map((c) => c.id);
}

function combinations<T>(arr: T[], k: number): T[][] {
  const res: T[][] = [];
  const cur: T[] = [];
  const walk = (start: number) => {
    if (cur.length === k) {
      res.push(cur.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      cur.push(arr[i]);
      walk(i + 1);
      cur.pop();
    }
  };
  walk(0);
  return res;
}

export function bPlay(gs: BloodState, playerId: string, cardIds: string[], now: number): void {
  if (gs.phase !== 'play') throw new BloodError('BAD_PHASE', '不在出牌阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (p.locked) return;
  if (gs.secretPending && gs.secretPending.seat === p.id) throw new BloodError('PENDING', '先完成当前角色技能抉择');
  // 手牌充足时恰好 5 张；被删/被抢后手牌不足 5 张（含捣蛋鬼）时打出全部手牌（0 张也可）
  const expected = Math.min(BLOOD_PLAY_COUNT, p.hand.length);
  if (cardIds.length !== expected) {
    throw new BloodError(
      'BAD_COUNT',
      expected < BLOOD_PLAY_COUNT ? `手牌不足 5 张，须打出全部 ${expected} 张` : '必须恰好选择 5 张',
    );
  }
  const set = new Set(cardIds);
  const played = p.hand.filter((c) => set.has(c.id));
  if (played.length !== cardIds.length) throw new BloodError('BAD_CARD', '手牌不存在');
  p.hand = p.hand.filter((c) => !set.has(c.id));
  p.discard.push(...p.hand); // 其余手牌弃置
  p.hand = [];
  p.play = played;
  p.locked = true;
  p.lastAction = '已出牌';
  pushLog(gs, 'action', `${p.name} 已暗扣 ${played.length} 张`);
  // 出牌阶段结束的角色钩子（出牌区已被暗扣，尚可发动弃置/询问类技能）
  const ch = effChar(p);
  if (ch === 'designer' && p.play.length > 0 && !gs.secretPending) {
    gs.secretPending = { seat: p.id, kind: 'designerDiscard' };
    gs.deadline = now + BLOOD_TURN_MS;
  } else if (ch === 'student' && p.play.length > 0 && !gs.secretPending) {
    gs.secretPending = { seat: p.id, kind: 'studentDump' };
    gs.deadline = now + BLOOD_TURN_MS;
  } else if (ch === 'bluffer' && p.play.length > 0 && !gs.secretPending) {
    gs.secretPending = { seat: p.id, kind: 'blufferDeclare' };
    gs.deadline = now + BLOOD_TURN_MS;
  }
  if (allDone(gs, (x) => x.locked)) tryStartReveal(gs, now);
}

/** 对决启动：存在未决的角色互动（高中生/设计师/特工/瞎掰王）时暂缓，待其结束后启动 */
function tryStartReveal(gs: BloodState, now: number): void {
  if (gs.secretPending) return;
  // 特工：全员锁定后（出牌区已确定）询问交换出牌区
  const agent = gs.players.find((p) => effChar(p) === 'agent' && !p.agentUsed);
  if (agent) {
    agent.agentUsed = true;
    gs.secretPending = { seat: agent.id, kind: 'agentAsk' };
    gs.deadline = now + BLOOD_TURN_MS;
    return;
  }
  startReveal(gs, now);
}

/** 角色互动（出牌后）结束：若全员已锁定则启动对决 */
function afterPlayHookResolved(gs: BloodState, now: number): void {
  if (gs.phase === 'play' && allDone(gs, (x) => x.locked)) tryStartReveal(gs, now);
}

function startReveal(gs: BloodState, now: number): void {
  gs.phase = 'reveal';
  gs.comparePipsFirst = false;
  gs.stealPending = null;
  gs.revealed = gs.players.map((p) => ({ seat: p.seat, cardIds: p.play.map((c) => c.id) }));
  pushLog(gs, 'hand', `第 ${gs.round} 回合 · 对决阶段：亮牌！`);
  const order = orderFrom(gs, gs.privilegeSeat ?? gs.players[0].seat);
  gs.turnSeat = order[0].seat;
  gs.deadline = now + BLOOD_TURN_MS;
  openRevealWindow(gs, order[0], now);
}

function usableItemCount(p: BPlayer): number {
  // 荷官证已改为出牌阶段宣告；亮牌窗口仅等待消磁枪
  return p.items.filter((i) => BLOOD_MARKET_BY_ID.get(i.def)?.effect.k === 'demagNullify').length;
}

/** 芯片的生效效果列表（自身 + 复制快照 + 弹簧修正），失效芯片为空 */
function chipEffectsFor(p: BPlayer, ch: ChipInst): BloodEffect[] {
  const out: BloodEffect[] = [];
  if (!ch.off) {
    const def = BLOOD_MARKET_BY_ID.get(ch.def);
    if (def) out.push(def.effect);
    if (ch.copiedFx) out.push(ch.copiedFx);
  }
  if (ch.springMod && !ch.off) out.push({ k: 'rankMod', mod: ch.springMod });
  return out;
}

/** 亮牌决策队列：弹出当前决策并挂起下一条；队列空则推进窗口 */
function nextRevealDecision(gs: BloodState, now: number): void {
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'revealDecide') return;
  const queue = (pend.queue ?? []).slice();
  if (queue.length === 0) {
    gs.secretPending = null;
    nextRevealOrSettle(gs, now);
    return;
  }
  gs.secretPending = { ...pend, kind: 'revealDecide', queue: queue.slice(1), decision: queue[0] };
}

/** 防护屏障：受害者持有屏障则消耗并进入询问窗口，返回 true 表示已拦截 */
function tryBarrierAsk(gs: BloodState, defenderId: string, attackerId: string, eff: BarrierEffect): boolean {
  const d = gs.players.find((x) => x.id === defenderId)!;
  const barrier = d.items.find((i) => BLOOD_MARKET_BY_ID.get(i.def)?.effect.k === 'barrierFx');
  if (!barrier) return false;
  d.items = d.items.filter((i) => i.id !== barrier.id);
  gs.recycle.push(barrier.def);
  gs.secretPending = { seat: defenderId, kind: 'barrierAsk', barrier: eff, eff: barrierText(gs, eff) };
  pushLog(gs, 'action', `【防护屏障】${d.name} 可以抵消该效果`);
  return true;
}

function barrierText(gs: BloodState, eff: BarrierEffect): string {
  const by = gs.players.find((x) => x.id === eff.by)?.name ?? '?';
  const t = gs.players.find((x) => x.id === eff.seat)?.name ?? '?';
  const map: Record<BarrierEffect['t'], string> = {
    violent: '暴力删除', pinpoint: '定点爆破', boxRob: '黑厢抢夺', poison: '餐车投毒',
    freeze: '冻结车厢', amnesia: '暂时失忆', signal: '信号干扰器', demag: '消磁枪',
  };
  return `${by} 对 ${t} 使用【${map[eff.t]}】${eff.t === 'pinpoint' ? `（宣称 ${eff.rank} 点）` : ''}`;
}

/** 反制窗口结束：按选择结算（use=true 抵消；false 生效），并按来源推进 */
function resolveBarrier(gs: BloodState, use: boolean, now: number): void {
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'barrierAsk' || !pend.barrier) return;
  const eff = pend.barrier;
  const attacker = gs.players.find((x) => x.id === eff.by)!;
  gs.secretPending = null;
  if (use) {
    pushLog(gs, 'action', `【防护屏障】${attacker.name} 的效果被抵消（费用不退）`);
  } else {
    pushLog(gs, 'action', `【防护屏障】未发动，效果生效`);
    applyBarrierEffect(gs, eff, now);
  }
  if (eff.after === 'market') afterMarketResolved(gs, attacker, false);
  else if (eff.after === 'reveal') nextRevealOrSettle(gs, now);
}

/** 序列化效果的真正结算 */
function applyBarrierEffect(gs: BloodState, eff: BarrierEffect, now: number): void {
  const by = gs.players.find((x) => x.id === eff.by)!;
  const t = gs.players.find((x) => x.id === eff.seat)!;
  switch (eff.t) {
    case 'violent': {
      const n = Math.min(3, t.draw.length);
      const top = t.draw.splice(-n, n);
      t.removed.push(...top);
      pushLog(gs, 'action', `【暴力删除】生效：${t.name} 抽牌堆顶 ${top.map(bloodCardText).join(' ')} 被删除`);
      break;
    }
    case 'pinpoint': {
      const rank = eff.rank ?? 0;
      const matches = t.discard.filter((c) => finalRank(t, c) === rank);
      if (matches.length === 0) {
        pushLog(gs, 'action', `【定点爆破】${t.name} 弃牌堆没有 ${rank} 点的牌，落空`);
      } else {
        const pick = matches[randomInt(0, matches.length)];
        t.discard = t.discard.filter((c) => c.id !== pick.id);
        t.removed.push(pick);
        pushLog(gs, 'action', `【定点爆破】生效：${t.name} 删除弃牌堆中的 ${bloodCardText(pick)}`);
      }
      break;
    }
    case 'boxRob': {
      const myRoll = randomInt(1, 7);
      const tRoll = randomInt(1, 7);
      if (myRoll > tRoll) {
        const gain = Math.min(4, Math.max(0, t.blood));
        t.blood -= gain;
        by.blood += gain;
        pushLog(gs, 'action', `【黑厢抢夺】生效：${by.name} ${myRoll} 对 ${t.name} ${tRoll}，抢夺 ${gain} 血筹`);
      } else {
        pushLog(gs, 'action', `【黑厢抢夺】生效：${by.name} ${myRoll} 对 ${t.name} ${tRoll}，抢夺失败`);
      }
      break;
    }
    case 'poison': {
      t.swapMalus += 2;
      pushLog(gs, 'action', `【餐车投毒】生效：${t.name} 下回合换牌次数 -2`);
      break;
    }
    case 'freeze': {
      t.skipReorg = true;
      pushLog(gs, 'action', `【冻结车厢】生效：${t.name} 跳过本回合重整`);
      break;
    }
    case 'amnesia': {
      t.charOffNextRound = true;
      pushLog(gs, 'action', `【暂时失忆】生效：${t.name} 下回合技能失效`);
      break;
    }
    case 'signal': {
      if (t.hand.length === 0) {
        pushLog(gs, 'action', `【信号干扰器】生效：${t.name} 没有手牌，落空`);
      } else {
        const idx = randomInt(0, t.hand.length);
        const [c] = t.hand.splice(idx, 1);
        t.discard.push(c);
        drawToCap(gs, t);
        pushLog(gs, 'action', `【信号干扰器】生效：${t.name} 随机弃置 ${bloodCardText(c)}，抽 1 张牌`);
      }
      break;
    }
    case 'demag': {
      const chips = t.chips.filter((ch) => t.play.some((card) => card.id === ch.on) && !ch.off);
      if (chips.length === 0) {
        pushLog(gs, 'action', `【消磁枪】${t.name} 出牌区没有强化芯片，落空`);
      } else {
        const best = chips
          .map((ch) => ({ ch, def: BLOOD_MARKET_BY_ID.get(ch.def)! }))
          .sort((a, b) => b.def.cost - a.def.cost)[0];
        best.ch.off = true;
        pushLog(gs, 'action', `【消磁枪】生效：${t.name} 出牌区的【${best.def.name}】本次对决失效`);
      }
      break;
    }
  }
}

/** 当前宣告窗口的自动触发（镀层出/夺）；若该玩家无任何可决定事项则立即推进 */
function openRevealWindow(gs: BloodState, p: BPlayer, now: number): void {
  for (const ch of p.chips.filter((cc) => p.play.some((card) => card.id === cc.on) && !cc.off)) {
    const def = BLOOD_MARKET_BY_ID.get(ch.def);
    if (!def) continue;
    const eff = def.effect;
    if (eff.k === 'revealGain') {
      p.blood += eff.blood;
      pushLog(gs, 'action', `${p.name} 的【${def.name}】发动：获得 ${eff.blood} 血筹`);
    } else if (eff.k === 'revealSteal') {
      gs.stealPending = { seat: p.id, blood: eff.blood };
      pushLog(gs, 'action', `${p.name} 的【${def.name}】发动：需选择掠夺目标`);
    }
  }
  const needSteal = gs.stealPending != null && gs.stealPending.seat === p.id;
  if (needSteal) {
    const anyValid = gs.players.some((o) => o.id !== p.id && o.blood >= (gs.stealPending?.blood ?? 1));
    if (!anyValid) {
      gs.stealPending = null;
      pushLog(gs, 'action', `${p.name} 的掠夺效果无合法目标，落空`);
    }
  }
  // 拓展芯片决策队列：弹簧夹层（±X）/ 复制芯片（选目标效果）/ 屏蔽器（选失效目标）
  const queue: RevealDecision[] = [];
  for (const cc of p.chips.filter((c2) => p.play.some((card) => card.id === c2.on) && !c2.off)) {
    const k = BLOOD_MARKET_BY_ID.get(cc.def)?.effect.k;
    if (k === 'springFx') queue.push({ t: 'spring', chipId: cc.id, cardId: cc.on, defId: cc.def });
    else if (k === 'copyChip') queue.push({ t: 'copy', chipId: cc.id, cardId: cc.on, defId: cc.def });
    else if (k === 'shieldFx') queue.push({ t: 'shield', chipId: cc.id, cardId: cc.on, defId: cc.def });
  }
  if (queue.length > 0) {
    gs.secretPending = { seat: p.id, kind: 'revealDecide', queue, decision: queue[0] };
    return; // 窗口停留等待决策
  }
  const needStealNow = gs.stealPending != null && gs.stealPending.seat === p.id;
  const hasItem = usableItemCount(p) > 0;
  if (!needStealNow && !hasItem) {
    nextRevealOrSettle(gs, now);
  }
}

/** 决策确认/跳过后：弹出下一条或结束决策推进窗口（复制「镀层夺」产生的掠夺未结清时保持等待） */
function advanceRevealDecision(gs: BloodState, now: number): void {
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'revealDecide') return;
  const rest = (pend.queue ?? []).slice();
  if (rest.length === 0) {
    gs.secretPending = null;
    const needSteal = gs.stealPending != null && gs.stealPending.seat === pend.seat;
    if (!needSteal) nextRevealOrSettle(gs, now);
    return;
  }
  gs.secretPending = { ...pend, kind: 'revealDecide', queue: rest.slice(1), decision: rest[0] };
}

/** 弹簧夹层：花费 X 血筹令该牌临时 ±X（2-14 钳制） */
export function bSpringUse(gs: BloodState, playerId: string, chipId: string, mod: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'revealDecide' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待决策的芯片');
  }
  const d = pend.decision;
  if (!d || d.t !== 'spring' || d.chipId !== chipId) throw new BloodError('BAD_TARGET', '决策目标不匹配');
  const p = gs.players.find((x) => x.id === playerId)!;
  const ch = p.chips.find((c) => c.id === chipId);
  if (!ch || ch.off) throw new BloodError('BAD_TARGET', '芯片不存在或已失效');
  if (!Number.isInteger(mod) || mod === 0) throw new BloodError('BAD_TARGET', '修正量无效');
  if (p.blood < Math.abs(mod)) throw new BloodError('NO_BLOOD', `血筹不足（需 ${Math.abs(mod)}）`);
  const card = p.play.find((c) => c.id === ch.on)!;
  const base = finalRank(p, card);
  const final = base + mod;
  if (final < 2 || final > 14) throw new BloodError('OUT_OF_RANGE', `点数超出 2-14（${base}${mod > 0 ? '+' : ''}${mod} = ${final}）`);
  p.blood -= Math.abs(mod);
  ch.springMod = mod;
  pushLog(gs, 'action', `【弹簧夹层】${p.name} 花费 ${Math.abs(mod)} 血筹：${bloodCardText(card)} 临时${mod > 0 ? '+' : ''}${mod} 点（${base} → ${final}）`);
  advanceRevealDecision(gs, now);
}

/** 复制芯片 / 屏蔽器：选择目标芯片（按 座位+牌+def 定位实例） */
export function bRevealChipTarget(
  gs: BloodState,
  playerId: string,
  seat: number,
  cardId: string,
  defId: string,
  now: number,
): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'revealDecide' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待决策的芯片');
  }
  const d = pend.decision;
  if (!d || (d.t !== 'copy' && d.t !== 'shield')) throw new BloodError('BAD_TARGET', '决策目标不匹配');
  const p = gs.players.find((x) => x.id === playerId)!;
  const myChip = p.chips.find((c) => c.id === d.chipId);
  if (!myChip || myChip.off) throw new BloodError('BAD_TARGET', '芯片不存在或已失效');
  const target = bySeat(gs, seat);
  if (!target) throw new BloodError('BAD_TARGET', '目标不存在');
  const targetChip = target.chips.find((ch) => ch.on === cardId && ch.def === defId && !ch.off);
  if (!targetChip) throw new BloodError('BAD_TARGET', '目标芯片不存在或已失效');

  if (d.t === 'copy') {
    if (defId === 'twinLens') throw new BloodError('BAD_TARGET', '双生镜片不可被复制');
    const srcFx = targetChip.copiedFx ?? BLOOD_MARKET_BY_ID.get(targetChip.def)?.effect;
    if (!srcFx) throw new BloodError('BAD_TARGET', '该芯片没有可复制的效果');
    myChip.copiedFx = srcFx;
    pushLog(gs, 'action', `【复制芯片】${p.name} 复制了 ${target.name} 的【${BLOOD_MARKET_BY_ID.get(defId)?.name}】效果`);
    // 复制到「镀层（出/夺）」：立即结算；复制到「屏蔽器」：追加失效目标决策
    if (srcFx.k === 'revealGain') {
      p.blood += srcFx.blood;
      pushLog(gs, 'action', `【复制芯片】发动：${p.name} 获得 ${srcFx.blood} 血筹`);
    } else if (srcFx.k === 'revealSteal') {
      gs.stealPending = { seat: p.id, blood: srcFx.blood };
      pushLog(gs, 'action', `【复制芯片】发动：${p.name} 需选择掠夺目标`);
    } else if (srcFx.k === 'shieldFx') {
      const rest = (pend.queue ?? []).slice();
      const shieldDecision: RevealDecision = { t: 'shield', chipId: myChip.id, cardId: d.cardId, defId: 'shield' };
      gs.secretPending = { ...pend, kind: 'revealDecide', queue: [shieldDecision, ...rest], decision: shieldDecision };
      return;
    }
  } else {
    targetChip.off = true;
    pushLog(gs, 'action', `【屏蔽器】${p.name} 令 ${target.name} 的【${BLOOD_MARKET_BY_ID.get(defId)?.name}】本次对决失效`);
  }
  advanceRevealDecision(gs, now);
}

/** 跳过当前决策 */
export function bSkipDecision(gs: BloodState, playerId: string, now: number): void {
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'revealDecide' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待决策的芯片');
  }
  advanceRevealDecision(gs, now);
}

/** 消磁枪：使用者选定要失效的目标芯片 */
export function bDemagPick(gs: BloodState, playerId: string, cardId: string, defId: string, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'demagPick' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待选择的消磁目标');
  }
  const t = gs.players.find((x) => x.id === pend.targetSeat)!;
  const chip = t.chips.find((ch) => ch.on === cardId && ch.def === defId && !ch.off);
  if (!chip) throw new BloodError('BAD_TARGET', '目标芯片不存在或已失效');
  chip.off = true;
  const def = BLOOD_MARKET_BY_ID.get(defId)!;
  gs.recycle.push(pend.defId ?? 'demag');
  gs.secretPending = null;
  pushLog(gs, 'action', `【消磁枪】${t.name} 出牌区的【${def.name}】本次对决失效`);
  nextRevealOrSettle(gs, now);
}

/** 定点爆破：受害者选定要删除的牌 */
export function bPinpointVictimPick(gs: BloodState, playerId: string, cardId: string, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'pinpointVictim' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待处理的定点爆破');
  }
  const t = gs.players.find((x) => x.id === playerId)!;
  const rank = pend.rank ?? 0;
  const card = t.discard.find((c) => c.id === cardId);
  if (!card) throw new BloodError('BAD_CARD', '目标牌不在你的弃牌区');
  if (finalRank(t, card) !== rank) throw new BloodError('BAD_CARD', `须选择 ${rank} 点的牌`);
  t.discard = t.discard.filter((c) => c.id !== cardId);
  t.removed.push(card);
  const buyer = gs.players.find((x) => x.id === pend.buyerId)!;
  gs.secretPending = null;
  pushLog(gs, 'action', `【定点爆破】${t.name} 删除弃牌堆中的 ${bloodCardText(card)}（${rank} 点）`);
  afterMarketResolved(gs, buyer, false);
}

/** 防护屏障决策：use=true 抵消；false 允许生效 */
export function bBarrierDecide(gs: BloodState, playerId: string, use: boolean, now: number): void {
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'barrierAsk' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待回应的反制询问');
  }
  resolveBarrier(gs, use, now);
}

function nextRevealOrSettle(gs: BloodState, now: number): void {
  const order = orderFrom(gs, gs.privilegeSeat ?? gs.players[0].seat);
  const idx = order.findIndex((p) => p.seat === gs.turnSeat);
  const next = order[idx + 1];
  if (next) {
    gs.turnSeat = next.seat;
    gs.deadline = now + BLOOD_TURN_MS;
    openRevealWindow(gs, next, now);
  } else {
    settle(gs, now);
  }
}

export function bSteal(gs: BloodState, playerId: string, targetSeat: number, now: number): void {
  void now;
  if (gs.phase !== 'reveal') throw new BloodError('BAD_PHASE', '不在对决阶段');
  if (!gs.stealPending || gs.stealPending.seat !== playerId) throw new BloodError('NOT_YOUR_TURN', '当前没有需要你选择的掠夺目标');
  const p = gs.players.find((x) => x.id === playerId)!;
  const target = bySeat(gs, targetSeat);
  if (!target || target.id === playerId) throw new BloodError('BAD_TARGET', '掠夺目标无效');
  if (target.blood < gs.stealPending.blood) throw new BloodError('BAD_TARGET', '目标血筹不足');
  target.blood -= gs.stealPending.blood;
  p.blood += gs.stealPending.blood;
  pushLog(gs, 'action', `${p.name} 掠夺 ${target.name} ${gs.stealPending.blood} 血筹`);
  gs.stealPending = null;
}

export function bUseItem(gs: BloodState, playerId: string, itemId: string | null, now: number): void {
  const p = gs.players.find((x) => x.id === playerId);
  if (!p) throw new BloodError('NO_PLAYER', '玩家不在对局中');
  if (itemId != null && gs.secretPending && gs.secretPending.seat !== p.id) {
    throw new BloodError('PENDING', '其他玩家的结算尚未完成，请稍候');
  }

  // 换牌阶段：皮下密信（直接抽牌）与信号干扰器（选择目标）
  if (gs.phase === 'swap') {
    if (itemId == null) return;
    if (p.swapDone) throw new BloodError('ALREADY_DONE', '你已停止换牌');
    const item = p.items.find((i) => i.id === itemId);
    if (!item) throw new BloodError('BAD_ITEM', '道具不存在');
    const def = BLOOD_MARKET_BY_ID.get(item.def);
    if (def?.effect.k === 'secretNoteFx') {
      if (p.blood < 2) throw new BloodError('NO_BLOOD', '血筹不足（需 2）');
      p.blood -= 2;
      const drawn = drawN(gs, p, 3);
      p.hand.push(...drawn);
      gs.recycle.push(item.def);
      p.items = p.items.filter((i) => i.id !== itemId);
      pushLog(gs, 'action', `${p.name} 使用【皮下密信】：支付 2 血筹，抽 3 张牌`);
      return;
    }
    if (def?.effect.k === 'signalJamFx') {
      gs.recycle.push(item.def);
      p.items = p.items.filter((i) => i.id !== itemId);
      gs.secretPending = { seat: p.id, kind: 'signalTarget' };
      pushLog(gs, 'action', `${p.name} 使用【信号干扰器】：请选择一位玩家随机弃 1 抽 1`);
      return;
    }
    throw new BloodError('BAD_TIMING', '该道具在换牌阶段无法使用');
  }

  // 荷官证/魔术橡皮/广播喇叭/赌徒虹膜：出牌阶段（暗扣确认前）宣告——此时还看不到对手的牌
  if (gs.phase === 'play') {
    if (itemId == null) return;
    if (p.locked) throw new BloodError('ALREADY_DONE', '你已确认出牌，无法再宣告');
    const item = p.items.find((i) => i.id === itemId);
    if (!item) throw new BloodError('BAD_ITEM', '道具不存在');
    const def = BLOOD_MARKET_BY_ID.get(item.def);
    switch (def?.effect.k) {
      case 'dealerLicense': {
        p.items = p.items.filter((i) => i.id !== itemId);
        gs.recycle.push(item.def);
        gs.announce = { defId: item.def, buyerSeat: p.seat, at: now };
        gs.comparePipsFirst = true;
        pushLog(gs, 'action', `${p.name} 使用【荷官证】：本次对决先比总点数，平局再比牌型（出牌阶段宣告）`);
        return;
      }
      case 'loudspeakerFx': {
        p.items = p.items.filter((i) => i.id !== itemId);
        gs.recycle.push(item.def);
        p.claimedWin = true;
        gs.announce = { defId: item.def, buyerSeat: p.seat, at: now };
        pushLog(gs, 'action', `${p.name} 使用【广播喇叭】：宣称本回合将夺魁！`);
        return;
      }
      case 'eraserFx': {
        p.items = p.items.filter((i) => i.id !== itemId);
        gs.secretPending = { seat: p.id, kind: 'eraserClaim', defId: item.def };
        pushLog(gs, 'action', `${p.name} 使用【魔术橡皮】：请宣称一种牌型`);
        return;
      }
      case 'irisGambleFx': {
        p.items = p.items.filter((i) => i.id !== itemId);
        gs.secretPending = { seat: p.id, kind: 'irisGuess', defId: item.def };
        pushLog(gs, 'action', `${p.name} 使用【赌徒虹膜】：请选择竞猜目标与牌型`);
        return;
      }
      default:
        throw new BloodError('BAD_TIMING', '该道具在出牌阶段无法使用');
    }
  }

  if (gs.phase !== 'reveal') throw new BloodError('BAD_PHASE', '不在对决阶段');
  if (gs.stealPending) throw new BloodError('PENDING', '先选择掠夺目标');
  if (gs.turnSeat !== seatOf(gs, playerId)) throw new BloodError('NOT_YOUR_TURN', '还没轮到你宣告');
  if (itemId == null) {
    pushLog(gs, 'action', `${p.name} 宣告完毕`);
    nextRevealOrSettle(gs, now);
    return;
  }
  // 消磁枪：对决阶段令一位玩家的 1 张强化芯片失效
  const item = p.items.find((i) => i.id === itemId);
  if (!item) throw new BloodError('BAD_ITEM', '道具不存在');
  const def = BLOOD_MARKET_BY_ID.get(item.def);
  if (def?.effect.k !== 'demagNullify') throw new BloodError('BAD_TIMING', '该道具当前无法使用');
  p.items = p.items.filter((i) => i.id !== itemId);
  // 防护屏障询问：受害者为亮牌顺序中的下家暂不可知，按目标选择后再拦截（demagTarget 分支内处理）
  gs.secretPending = { seat: p.id, kind: 'demagTarget', defId: item.def };
  pushLog(gs, 'action', `${p.name} 使用【消磁枪】：请选择要失效的强化芯片来源`);
}

function seatOf(gs: BloodState, playerId: string): number {
  const p = gs.players.find((x) => x.id === playerId);
  if (!p) throw new BloodError('NO_PLAYER', '玩家不在对局中');
  return p.seat;
}

/* ---------------- 结算 ---------------- */

function settle(gs: BloodState, now: number): void {
  const order = orderFrom(gs, gs.privilegeSeat ?? gs.players[0].seat);
  const dist = (p: BPlayer) => seatDist(gs, order[0].seat, p.seat);
  const rows: SettleRow[] = gs.players.map((p) => {
    let ev = evalForPlayer(p, gs);
    // 魔术橡皮：本回合被宣称的牌型视为高牌（只降牌型，不改点数）
    if (gs.eraserType != null && ev.cat === gs.eraserType) {
      ev = { cat: 0, catName: '高牌（魔术橡皮）', pips: ev.pips };
    }
    // 我的名字？：全桌该牌型以自定义名称宣告
    if (gs.mynameCat != null && ev.cat === gs.mynameCat && gs.mynameText) {
      ev = { ...ev, catName: gs.mynameText };
    }
    // 带芯片的结算牌视图（与 view.ts 下发的摊牌牌面一致），供核心牌计数
    const bluffActive = gs.bluffer && gs.bluffer.seat === p.id && !gs.bluffer.challenged;
    const shownCards: BCard[] = bluffActive ? gs.bluffer!.declared : p.play;
    const cardViews = shownCards.map((c) => ({
      id: c.id,
      r: c.r,
      s: c.s,
      chipIds: bluffActive ? [] : p.chips.filter((ch) => ch.on === c.id).map((ch) => ch.def),
    }));
    return {
      seat: p.seat,
      name: p.name,
      cat: ev.cat,
      catName: ev.catName,
      pips: ev.pips,
      rank: 0,
      gainTickets: 0,
      gainBlood: 0,
      cores: coreOrder(cardViews, ev.cat).length,
      cards: shownCards.slice(), // 亮出的牌随结算视图公开（供对决演示回放）
    };
  });
  // 赌场荷官：+20 仅在比较总点数时生效（不提高牌型等级，见官方FAQ）
  const pipBonus = (r: SettleRow): number => {
    const p = bySeat(gs, r.seat)!;
    return r.pips + (effChar(p) === 'dealer' ? 20 : 0);
  };
  rows.sort((a, b) => {
    if (gs.comparePipsFirst) {
      if (pipBonus(b) !== pipBonus(a)) return pipBonus(b) - pipBonus(a);
      if (b.cat !== a.cat) return b.cat - a.cat;
    } else {
      if (b.cat !== a.cat) return b.cat - a.cat;
      if (pipBonus(b) !== pipBonus(a)) return pipBonus(b) - pipBonus(a);
    }
    return dist(bySeat(gs, a.seat)!) - dist(bySeat(gs, b.seat)!);
  });
  rows.forEach((r, i) => {
    r.rank = i + 1;
    const n = gs.seatCount;
    if (i === 0) {
      r.gainTickets = 4;
    } else if (i === 1) {
      if (n === 2) r.gainBlood = 4;
      else {
        r.gainTickets = 2;
        r.gainBlood = 2;
      }
    } else if (i === 2) {
      if (n >= 4) {
        r.gainTickets = 1;
        r.gainBlood = 3;
      } else r.gainBlood = 4;
    } else if (i === 3) {
      r.gainBlood = 4;
    }
  });

  const winner = bySeat(gs, rows[0].seat)!;
  // 特权证转移：江东之主持有期间，任何人都无法以任意方式获得临时特权证
  const curHolder = gs.players.find((p) => p.privilege);
  if (curHolder && curHolder !== winner && effChar(curHolder) === 'sunwu') {
    pushLog(gs, 'action', `${curHolder.name}【江东之主】的【临时特权证】不可被夺走`);
  } else {
    for (const p of gs.players) p.privilege = false;
    winner.privilege = true;
    gs.privilegeSeat = winner.seat;
  }

  for (const r of rows) {
    const p = bySeat(gs, r.seat)!;
    const gainB = settleGainBlood(gs, p, r.gainBlood);
    r.gainBlood = gainB;
    p.tickets += r.gainTickets;
    p.blood += gainB;
    // 镀层触发：胜/败（含复制芯片的快照效果）
    for (const ch of p.chips.filter((cc) => p.play.some((card) => card.id === cc.on) && !cc.off)) {
      const def = BLOOD_MARKET_BY_ID.get(ch.def);
      if (!def) continue;
      for (const eff of chipEffectsFor(p, ch)) {
        if (eff.k === 'settleWin' && p === winner) {
          const g = settleGainBlood(gs, p, eff.blood);
          p.blood += g;
          pushLog(gs, 'action', `${p.name} 的【${def.name}】发动：魁首获得 ${g} 血筹`);
        } else if (eff.k === 'settleLose' && p !== winner) {
          const g = settleGainBlood(gs, p, eff.blood);
          p.blood += g;
          pushLog(gs, 'action', `${p.name} 的【${def.name}】发动：战败获得 ${g} 血筹`);
        }
      }
    }
  }

  // 职业赌徒：结算若猜对夺魁者，获得（人数+2）血筹
  if (gs.gamblerGuess) {
    const guesser = gs.players.find((x) => x.id === gs.gamblerGuess!.by);
    if (guesser && gs.gamblerGuess.seat === winner.seat) {
      const gain = settleGainBlood(gs, guesser, gs.seatCount + 2);
      guesser.blood += gain;
      pushLog(gs, 'action', `${guesser.name}【职业赌徒】猜中夺魁者：获得 ${gain} 血筹`);
    } else if (guesser) {
      pushLog(gs, 'action', `${guesser.name}【职业赌徒】竞猜落空`);
    }
    gs.gamblerGuess = null;
  }

  // 无业游民：出牌区每有1张对手的牌，该对手支付1血筹
  for (const p of gs.players) {
    if (effChar(p) !== 'vagrant') continue;
    let took = 0;
    for (const c of p.play) {
      const owner = cardOwnerSeat(c.id);
      if (owner == null || owner === p.seat) continue;
      const victim = bySeat(gs, owner)!;
      const pay = Math.min(1, Math.max(0, victim.blood));
      victim.blood -= pay;
      p.blood += pay;
      took += pay;
    }
    if (took > 0) pushLog(gs, 'action', `${p.name}【无业游民】出牌区含对手的牌：收取 ${took} 血筹`);
  }

  // 捣蛋鬼：出牌区含夺魁玩家的牌 → 获得 1 车票
  const imp = gs.players.find((x) => x.charId === 'imp');
  if (imp) {
    const has = imp.play.some((c) => cardOwnerSeat(c.id) === winner.seat);
    if (has) {
      imp.tickets += 1;
      pushLog(gs, 'action', `${imp.name}【捣蛋鬼】出牌区含夺魁者的牌：获得 1 车票`);
    }
  }

  // 拓展芯片结算：加密线路（魁首+车票，先于武士等按本回合车票结算的效果）
  for (const r of rows) {
    const p = bySeat(gs, r.seat)!;
    for (const ch of p.chips.filter((cc) => p.play.some((card) => card.id === cc.on) && !cc.off)) {
      const def = BLOOD_MARKET_BY_ID.get(ch.def);
      if (!def) continue;
      for (const eff of chipEffectsFor(p, ch)) {
        if (eff.k === 'settleWinTicket' && p === winner) {
          r.gainTickets += eff.tickets;
          p.tickets += eff.tickets;
          pushLog(gs, 'action', `${p.name} 的【${def.name}】发动：魁首获得 ${eff.tickets} 车票`);
        }
      }
    }
  }

  // 拓展结算：赌徒虹膜竞猜判定（先于武士，按最终车票结算）；广播喇叭宣称判定
  if (gs.irisGuess) {
    const { by, seat, cat } = gs.irisGuess;
    const guesser = gs.players.find((x) => x.id === by);
    const target = bySeat(gs, seat);
    const row = rows.find((r) => r.seat === seat);
    if (guesser && target && row) {
      const actual = catName(row.cat);
      const guessed = catName(cat);
      if (row.cat === cat) {
        guesser.blood += 3;
        const dec = Math.min(4, row.gainTickets);
        row.gainTickets -= dec;
        target.tickets -= dec;
        pushLog(gs, 'action', `【赌徒虹膜】${guesser.name} 猜中 ${target.name} 的【${guessed}】：获得 3 血筹，${target.name} 本回合车票 -${dec}`);
      } else {
        pushLog(gs, 'action', `【赌徒虹膜】${guesser.name} 竞猜落空（猜【${guessed}】，实际【${actual}】）`);
      }
    }
    gs.irisGuess = null;
  }
  for (const r of rows) {
    const p = bySeat(gs, r.seat)!;
    if (!p.claimedWin) continue;
    if (p === winner) {
      const gain = gs.seatCount * 3;
      p.blood += gain;
      pushLog(gs, 'action', `【广播喇叭】${p.name} 宣称成功夺魁：获得 ${gain} 血筹`);
    } else {
      p.skipBuyRemove = true;
      p.skipReorg = true;
      pushLog(gs, 'action', `【广播喇叭】${p.name} 宣称失败：跳过本回合购买、删牌、重整`);
    }
  }

  // 角色技能结算（同一行内按 依赖顺序：公主车票 → 武士血筹）
  for (const r of rows) {
    const p = bySeat(gs, r.seat)!;
    // 我的名字？：任何玩家（含自己）打出自定义牌型 → 获得 2 血筹
    if (gs.mynameCat != null && r.cat === gs.mynameCat && gs.mynameText) {
      const me = gs.players.find((x) => x.charId === 'myname');
      if (me) {
        me.blood += 2;
        pushLog(gs, 'action', `${me.name}【我的名字？】有人打出【${gs.mynameText}】：获得 2 血筹`);
      }
    }
    switch (p.charId) {
      case 'miner':
        if (allSuitsMatch(gs, p, 'black')) {
          p.blood += settleGainBlood(gs, p, 3);
          pushLog(gs, 'action', `${p.name}【矿工】打出的牌均为黑色：获得 3 血筹`);
        }
        break;
      case 'painter': {
        const n = suitDiversity(gs, p);
        let gain = 0;
        if (n >= 3) gain += 2;
        if (n >= 4) gain += 1;
        if (gain > 0) {
          p.blood += settleGainBlood(gs, p, gain);
          pushLog(gs, 'action', `${p.name}【画家】出牌区存在 ${n} 种花色：获得 ${gain} 血筹`);
        }
        break;
      }
      case 'chef': {
        const threes = p.play.filter((c) => finalRank(p, c) === 3).length;
        if (threes > 0) {
          p.blood += settleGainBlood(gs, p, threes);
          pushLog(gs, 'action', `${p.name}【特级大厨】打出 ${threes} 张3：获得 ${threes} 血筹`);
        }
        break;
      }
      case 'screenwriter': {
        const ev = evalForPlayer(p, gs);
        if (ev.pips === 50) {
          p.blood += settleGainBlood(gs, p, 5);
          pushLog(gs, 'action', `${p.name}【编剧】总点数恰好 50：获得 5 血筹`);
        } else {
          p.skipBuyRemove = true;
          pushLog(gs, 'action', `${p.name}【编剧】总点数 ${ev.pips} ≠ 50：跳过本回合购买与删牌阶段`);
        }
        break;
      }
      case 'princess': {
        const dark = p.princessDark;
        const triggered = dark ? allSuitsMatch(gs, p, 'black') : allSuitsMatch(gs, p, 'red');
        if (dark && triggered) {
          p.blood += settleGainBlood(gs, p, 3);
          pushLog(gs, 'action', `${p.name}【双重人格公主·常时】打出的牌均为黑色：获得 3 血筹`);
        } else if (!dark && triggered) {
          r.gainTickets += 1;
          p.tickets += 1;
          pushLog(gs, 'action', `${p.name}【双重人格公主·躁狂】打出的牌均为红色：获得 1 车票`);
        }
        if (triggered) p.princessDark = !dark; // 技能发动后切换人格
        break;
      }
      case 'samurai':
        if (r.gainTickets > 0) {
          p.blood += settleGainBlood(gs, p, r.gainTickets);
          pushLog(gs, 'action', `${p.name}【武士】额外获得 ${r.gainTickets} 血筹（等量于本回合车票）`);
        }
        break;
      case 'sunwu':
        if (p === winner) {
          p.blood += settleGainBlood(gs, p, 2);
          pushLog(gs, 'action', `${p.name}【江东之主】夺魁：获得 2 血筹`);
        }
        break;
    }
  }
  for (const r of rows) {
    pushLog(
      gs,
      'win',
      `第${r.rank}名 ${r.name}：${r.catName} ${r.pips}点${r.gainTickets ? ` +${r.gainTickets}车票` : ''}${r.gainBlood ? ` +${r.gainBlood}血筹` : ''}`,
    );
  }
  pushLog(gs, 'win', `${winner.name} 夺魁，获得【临时特权证】`);

  // 出牌区置入弃牌区（枪手先记下本回合打出的4；自毁芯片记下是否发动）
  const gunnerFours = new Map<string, string[]>();
  const playedIdsByP = new Map<string, string[]>();
  let selfDestructFired = false;
  for (const p of gs.players) {
    if (effChar(p) === 'gunner') gunnerFours.set(p.id, p.play.filter((c) => c.r === 4).map((c) => c.id));
    if (
      p.chips
        .filter((ch) => p.play.some((card) => card.id === ch.on) && !ch.off)
        .some((ch) => chipEffectsFor(p, ch).some((eff) => eff.k === 'selfDestruct'))
    ) {
      selfDestructFired = true;
    }
    playedIdsByP.set(p.id, p.play.map((c) => c.id));
    p.discard.push(...p.play);
    p.play = [];
  }
  for (const [pid, ids] of gunnerFours) {
    if (ids.length === 0) continue;
    const p = gs.players.find((x) => x.id === pid)!;
    const moved = p.discard.filter((c) => ids.includes(c.id));
    p.discard = p.discard.filter((c) => !ids.includes(c.id));
    p.removed.push(...moved);
    pushLog(gs, 'action', `${p.name}【枪手】结算结束：删除本回合打出的4（${moved.map(bloodCardText).join(' ')}）`);
  }
  if (selfDestructFired) {
    for (const p of gs.players) {
      const ids = playedIdsByP.get(p.id)!;
      const moved = p.discard.filter((c) => ids.includes(c.id));
      if (moved.length === 0) continue;
      p.discard = p.discard.filter((c) => !ids.includes(c.id));
      p.removed.push(...moved);
      pushLog(gs, 'action', `【自毁芯片】发动：${p.name} 本回合打出的 ${moved.length} 张牌全部删除`);
    }
  }

  // 炸弹客：结算结束时，其他玩家随机删除 X 张本回合打出的牌，自己删除 X+1 张
  if (gs.bomberX != null && gs.bomberX > 0) {
    for (const p of gs.players) {
      const n = effChar(p) === 'bomber' ? gs.bomberX + 1 : gs.bomberX;
      const ids = playedIdsByP.get(p.id)!;
      const avail = p.discard.filter((c) => ids.includes(c.id));
      const deleted: BCard[] = [];
      for (let i = 0; i < n && avail.length > 0; i++) {
        const idx = randomInt(0, avail.length);
        const [c] = avail.splice(idx, 1);
        p.discard = p.discard.filter((x) => x.id !== c.id);
        p.removed.push(c);
        deleted.push(c);
      }
      if (deleted.length > 0) {
        pushLog(gs, 'action', `💣 ${p.name}${effChar(p) === 'bomber' ? '【炸弹客】' : '（炸弹客宣告）'}随机删除本回合打出的牌：${deleted.map(bloodCardText).join(' ')}`);
      }
    }
  }

  // 无业游民：结算结束时，牌库中对手的牌放入其弃牌区
  for (const p of gs.players) {
    if (effChar(p) !== 'vagrant') continue;
    const returned: BCard[] = [];
    p.draw = p.draw.filter((c) => {
      const owner = cardOwnerSeat(c.id);
      if (owner != null && owner !== p.seat) {
        returned.push(c);
        return false;
      }
      return true;
    });
    for (const c of returned) {
      const owner = bySeat(gs, cardOwnerSeat(c.id)!)!;
      owner.discard.push(c);
    }
    if (returned.length > 0) {
      pushLog(gs, 'action', `${p.name}【无业游民】归还牌库中对手的牌：${returned.map(bloodCardText).join(' ')}`);
    }
  }

  // 特工：结算结束时归还交换的出牌区
  if (gs.agentSwap) {
    const a = gs.players.find((x) => x.id === gs.agentSwap!.a)!;
    const b = gs.players.find((x) => x.id === gs.agentSwap!.b)!;
    const backA = b.discard.filter((c) => gs.agentSwap!.aCards.includes(c.id));
    const backB = a.discard.filter((c) => gs.agentSwap!.bCards.includes(c.id));
    b.discard = b.discard.filter((c) => !gs.agentSwap!.aCards.includes(c.id));
    a.discard = a.discard.filter((c) => !gs.agentSwap!.bCards.includes(c.id));
    a.discard.push(...backA);
    b.discard.push(...backB);
    pushLog(gs, 'action', `🤝 ${a.name} 与 ${b.name}【特工】归还交换的出牌区`);
    gs.agentSwap = null;
  }

  const result: BloodResultView = {
    rows: rows.slice().sort((a, b) => a.rank - b.rank),
    winnerSeat: winner.seat,
    comparePipsFirst: gs.comparePipsFirst,
  };
  gs.result = result;
  gs.resultAt = now;

  // 胜利判定（皇叔只能以「删光整副牌」的方式获胜，不计入常规胜利）
  const reached = gs.players.filter((p) => p.tickets >= gs.target && effChar(p) !== 'liu');
  if (reached.length > 0) {
    finishByTickets(gs, reached, dist);
    return;
  }

  // 对决展示确认门：所有玩家看完演示后（最后一人确认）统一进入购买，倒计时同步
  gs.phase = 'settle';
  for (const p of gs.players) p.sdSeen = false;
  // deadline = 演示完整播完（关键牌高亮收尾）+ 确认等待上限；客户端演示结束才开始显示倒计时
  const maxCards = Math.max(0, ...rows.map((r) => r.cards?.length ?? 0));
  const maxCores = Math.max(0, ...rows.map((r) => r.cores));
  gs.deadline = now + showdownReadyMs(rows.length, maxCards, maxCores) + BLOOD_SD_WAIT_MS;
  pushLog(gs, 'hand', '对决展示：所有玩家确认后统一进入购买阶段');
  processSettleQueue(gs, now);
}

/** 按车票数结束比赛（含并列判定），供结算与票贩子强购后复用 */
function finishByTickets(
  gs: BloodState,
  reached: BPlayer[],
  dist: (p: BPlayer) => number,
): void {
  reached.sort((a, b) => {
    if (b.tickets !== a.tickets) return b.tickets - a.tickets;
    if (b.blood !== a.blood) return b.blood - a.blood;
    return dist(a) - dist(b);
  });
  const champion = reached[0];
  gs.phase = 'gameover';
  gs.deadline = null;
  gs.final = {
    winnerSeat: champion.seat,
    ranking: gs.players
      .slice()
      .sort((a, b) => b.tickets - a.tickets || b.blood - a.blood || dist(a) - dist(b))
      .map((p) => ({ seat: p.seat, name: p.name, tickets: p.tickets, blood: p.blood })),
  };
  pushLog(gs, 'sys', `🏆 ${champion.name} 集齐 ${champion.tickets} 张车票（目标 ${gs.target}），赢得比赛！`);
}

/** 结算阶段角色互动队列推进（魅魔/票贩子/炸鸡店老板）；队列空且全员已确认则进入购买 */
function processSettleQueue(gs: BloodState, now: number): void {
  if (gs.secretPending) return;
  const winner = gs.players.find((p) => p.privilege) ?? gs.players[0];
  while (gs.settleQueue.length > 0) {
    const next = gs.settleQueue.shift()!;
    const p = gs.players.find((x) => x.id === next.seat)!;
    if (next.kind === 'succubusSteal') {
      const amount = p === winner ? 3 : 1;
      const want: 'm' | 'f' = p === winner ? 'm' : 'f';
      const targets = gs.players.filter(
        (o) => o.id !== p.id && genderMatches(effChar(o), want) && o.blood > 0,
      );
      if (targets.length === 0) {
        p.blood += amount;
        pushLog(gs, 'action', `${p.name}【魅魔】无法抢夺：直接获得 ${amount} 血筹`);
        continue;
      }
      gs.secretPending = { seat: p.id, kind: 'succubusSteal', blood: amount };
      gs.deadline = now + BLOOD_TURN_MS;
      return;
    }
    if (next.kind === 'scalperDeal') {
      if (p.blood < 3 || winner.tickets < 1) continue;
      gs.secretPending = { seat: p.id, kind: 'scalperDeal' };
      gs.deadline = now + BLOOD_TURN_MS;
      return;
    }
    if (next.kind === 'fryerDel') {
      const playedIds = gs.result?.rows.find((r) => r.seat === p.seat)?.cards?.map((c) => c.id) ?? [];
      const avail = p.discard.filter((c) => playedIds.includes(c.id));
      if (p.blood < 1 || avail.length === 0 || p.fryerDelCount >= 3) continue;
      gs.secretPending = { seat: p.id, kind: 'fryerDel', max: 3 };
      gs.deadline = now + BLOOD_TURN_MS;
      return;
    }
  }
  // 队列清空：若全员已确认对决展示则进入购买阶段
  if (gs.phase === 'settle' && allDone(gs, (x) => x.sdSeen)) startBuyPhase(gs, now);
}

/** 玩家看完对决演示：全员确认后立即统一进入购买阶段（倒计时同步；30s 上限由超时托管兜底） */
export function bShowdownDone(gs: BloodState, playerId: string, now: number): void {
  if (gs.phase !== 'settle') return;
  const p = gs.players.find((x) => x.id === playerId);
  if (!p || p.sdSeen) return;
  p.sdSeen = true;
  pushLog(gs, 'action', `${p.name} 已确认对决展示`);
  if (allDone(gs, (x) => x.sdSeen) && !gs.secretPending) startBuyPhase(gs, now);
}

function startBuyPhase(gs: BloodState, now: number): void {
  const winner = gs.players.find((p) => p.privilege) ?? gs.players[0];
  gs.phase = 'buy';
  for (const p of gs.players) {
    p.buyPassed = false;
    if (p.skipBuyRemove || p.skipBuy) {
      p.buyPassed = true; // 编剧/闭店礼：跳过本回合购买阶段
    }
  }
  // 窥天师：第一回合购买阶段前，将黑市牌堆顶 7 张暗置为「天意」
  const seer = gs.players.find((p) => effChar(p) === 'seer');
  if (seer && gs.seerZone.length === 0 && gs.supply.length >= 7) {
    for (let i = 0; i < 7; i++) gs.seerZone.push(gs.supply.pop()!);
    pushLog(gs, 'action', `🔮 ${seer.name}【窥天师】将黑市牌堆顶 7 张暗置为「天意」`);
  }
  // 购买阶段前的角色互动队列（按特权证持有者开始顺时针）：海盗抢劫 → 走私客标记 → 瞎掰帝拍卖 → 捣蛋鬼赎回
  gs.preBuyQueue = [];
  const start = gs.privilegeSeat ?? gs.players[0].seat;
  for (let i = 0; i < gs.seatCount; i++) {
    const p = bySeat(gs, (start + i) % gs.seatCount);
    if (!p) continue;
    const ch = effChar(p);
    if (ch === 'pirate' && !p.skipBuy) gs.preBuyQueue.push({ seat: p.id, kind: 'pirateRob' });
    if (ch === 'smuggler' && !p.skipBuy && gs.market.some((m) => m.def != null)) {
      gs.preBuyQueue.push({ seat: p.id, kind: 'smugglerMark' });
    }
    if (ch === 'auctioneer' && gs.round === 0 && !p.skipBuy && gs.supply.length >= 2) {
      gs.preBuyQueue.push({ seat: p.id, kind: 'auctionStart' });
    }
    const imp = gs.players.find((x) => x.charId === 'imp');
    if (imp && imp.id !== p.id && impOwnsCardsOf(gs, imp, p.id)) {
      gs.preBuyQueue.push({ seat: p.id, kind: 'impRedeem' });
    }
  }
  gs.turnSeat = gs.privilegeSeat;
  gs.deadline = now + BLOOD_TURN_MS;
  pushLog(gs, 'hand', `购买阶段：从 ${winner.name} 开始顺时针购买`);
  // 推进购买回合（队列清空时）或挂起首位购买前互动
  processPreBuyQueue(gs, now);
}

/** 捣蛋鬼各牌区是否持有属于 targetId 的牌 */
function impOwnsCardsOf(gs: BloodState, imp: BPlayer, targetId: string): boolean {
  const ownerSeat = gs.players.find((x) => x.id === targetId)!.seat;
  const has = (cards: BCard[]) => cards.some((c) => cardOwnerSeat(c.id) === ownerSeat);
  return has(imp.draw) || has(imp.discard) || has(imp.hand);
}

/** 购买阶段前互动队列推进 */
function processPreBuyQueue(gs: BloodState, now: number): void {
  if (gs.secretPending) return;
  while (gs.preBuyQueue.length > 0) {
    const next = gs.preBuyQueue.shift()!;
    const p = gs.players.find((x) => x.id === next.seat)!;
    if (next.kind === 'pirateRob') {
      gs.secretPending = { seat: p.id, kind: 'pirateRob' };
      gs.deadline = now + BLOOD_TURN_MS;
      return;
    }
    if (next.kind === 'smugglerMark') {
      gs.secretPending = { seat: p.id, kind: 'smugglerMark' };
      gs.deadline = now + BLOOD_TURN_MS;
      return;
    }
    if (next.kind === 'auctionStart') {
      if (gs.supply.length < 2) continue;
      const top2 = [gs.supply[gs.supply.length - 1], gs.supply[gs.supply.length - 2]];
      gs.secretPending = { seat: p.id, kind: 'auctionPick', options: top2 };
      gs.deadline = now + BLOOD_TURN_MS;
      return;
    }
    if (next.kind === 'impRedeem') {
      const imp = gs.players.find((x) => x.charId === 'imp')!;
      if (p.blood < 1) continue;
      gs.secretPending = { seat: p.id, kind: 'impRedeem', targetSeat: imp.id };
      gs.deadline = now + BLOOD_TURN_MS;
      return;
    }
  }
  // 队列清空：推进购买回合（跳过因角色技能已跳过的玩家）
  const start = gs.privilegeSeat ?? gs.players[0].seat;
  advanceBuyTurn(gs, (start - 1 + gs.seatCount) % gs.seatCount, now);
}

/* ---------------- 购买阶段 ---------------- */

function refillMarket(gs: BloodState): void {
  let guard = 0;
  while (guard++ < 10) {
    const emptyIdx = gs.market.findIndex((m) => m.def == null);
    if (emptyIdx >= 0) {
      if (gs.supply.length === 0) break; // 黑市卖空不补
      gs.market.splice(emptyIdx, 1);
      gs.market.unshift(drawMarketSlot(gs)); // 右推，新牌补到最左（01格）
      continue;
    }
    // 栏位被整格移除（再来一批）：不足 5 张即从供应堆补满
    if (gs.market.length < 5 && gs.supply.length > 0) {
      gs.market.unshift(drawMarketSlot(gs));
      continue;
    }
    break;
  }
}

function isChipInsertable(p: BPlayer, card: BCard, def: import('@shared/bloodCards').BloodMarketDef): boolean {
  if (p.chips.some((c) => c.on === card.id)) return false;
  if (def.noJoker && card.s == null) return false; // 不可插入JOKER中
  if (def.effect.k === 'rankMod') {
    const v = card.r + def.effect.mod;
    return v >= 2 && v <= 14;
  }
  return true;
}

export function bBuy(
  gs: BloodState,
  playerId: string,
  slot: number,
  insertInto: string | undefined,
  now: number,
): void {
  void now;
  if (gs.phase !== 'buy') throw new BloodError('BAD_PHASE', '不在购买阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (gs.secretPending && gs.secretPending.seat === p.id) throw new BloodError('PENDING', '先完成上一张牌的结算');
  if (gs.secretPending && gs.secretPending.seat !== p.id) {
    throw new BloodError('PENDING', '其他玩家的结算尚未完成，请稍候');
  }
  if (gs.turnSeat !== p.seat || p.buyPassed) throw new BloodError('NOT_YOUR_TURN', '还没轮到你购买');
  const ms = gs.market[slot];
  if (!ms || ms.def == null) throw new BloodError('BAD_SLOT', '该栏位没有黑市牌');
  const def = BLOOD_MARKET_BY_ID.get(ms.def);
  if (!def) throw new BloodError('BAD_SLOT', '黑市牌数据异常');
  // 角色价格修正：吉祥物首次购买付一半（向下取整）；魏王购芯片-2
  let cost = def.cost;
  const mascotDeal = effChar(p) === 'mascot' && !p.firstBuyUsed;
  if (mascotDeal) cost = Math.floor(cost / 2);
  if (effChar(p) === 'wei' && def.kind === 'chip') cost = Math.max(0, cost - 2);
  // 走私客：被标记的黑市牌，他人购买须先交 2 血筹；走私客自己购买价格 -2
  const smuggled = gs.smugglerMark && gs.smugglerMark.slot === slot;
  if (smuggled) {
    const smuggler = gs.players.find((x) => x.id === gs.smugglerMark!.by)!;
    if (smuggler.id !== p.id) {
      if (p.blood < cost + 2) throw new BloodError('NO_BLOOD', `须先向走私客支付 2 血筹（共需 ${cost + 2}）`);
      p.blood -= 2;
      smuggler.blood += 2;
      pushLog(gs, 'action', `🚚 ${p.name} 向 ${smuggler.name}【走私客】支付 2 血筹后才可购买该牌`);
    } else {
      cost = Math.max(0, cost - 2);
    }
  }
  if (p.blood < cost) throw new BloodError('NO_BLOOD', `血筹不足（需 ${cost}）`);
  // 强化芯片的插入目标先校验（避免扣费后失败导致牌丢失）
  if (def.kind === 'chip' && insertInto != null) {
    const target = p.discard.find((c) => c.id === insertInto);
    if (!target) throw new BloodError('BAD_CARD', '目标牌不在你的弃牌区');
    if (!isChipInsertable(p, target, def)) throw new BloodError('BAD_INSERT', '该牌无法插入强化芯片');
  }
  const bonusTaken = ms.bonus;
  p.blood -= cost;
  p.blood += bonusTaken;
  ms.bonus = 0;
  const baristaFirst = effChar(p) === 'barista' && !p.firstBuyUsed && def.cost >= 3;
  p.firstBuyUsed = true; // 首次购买已消耗（0血筹购入也算）
  p.boughtAny = true;
  gs.announce = { defId: def.id, buyerSeat: p.seat, at: Date.now() };
  if (mascotDeal) {
    pushLog(gs, 'action', `${p.name}【吉祥物】首次购买优惠：${def.cost} → ${cost} 血筹`);
  }
  if (smuggled && gs.smugglerMark!.by === p.id) {
    pushLog(gs, 'action', `${p.name}【走私客】购买自己标记的牌：价格 -2`);
  }
  const bonusTxt = bonusTaken > 0 ? `，连同栏位上的 ${bonusTaken} 血筹一并取走` : '';
  pushLog(gs, 'action', `${p.name} 支付 ${cost} 血筹购买【${def.name}】${bonusTxt}`);

  // 清空该栏位，效果结算完毕后由 refillMarket 右推补位（规则：结算完才翻新牌）
  ms.def = null;

  processMarketDef(gs, p, def, false, insertInto);
}

/** 处理一张已支付/免费获得的黑市牌 */
function processMarketDef(
  gs: BloodState,
  p: BPlayer,
  def: NonNullable<ReturnType<typeof BLOOD_MARKET_BY_ID.get>>,
  free: boolean,
  insertInto?: string,
): void {
  void free;
  // 强化芯片（含触发类）：立即插入自己弃牌区的一张牌
  if (def.kind === 'chip') {
    // 魏王：最多同时持有3张强化芯片，超出直接弃置新获得的芯片（费用不退）
    if (effChar(p) === 'wei' && p.chips.length >= 3) {
      gs.recycle.push(def.id);
      pushLog(gs, 'action', `${p.name}【魏王】已有 3 张强化芯片：新获得的【${def.name}】直接弃置`);
      afterMarketResolved(gs, p, false);
      return;
    }
    const chipId = `ch-${Math.random().toString(36).slice(2, 10)}`;
    if (insertInto) {
      insertChip(gs, p, chipId, def.id, insertInto);
      afterMarketResolved(gs, p, false);
    } else {
      gs.secretPending = { seat: p.id, kind: 'insertChip', chipId, defId: def.id };
    }
    return;
  }
  switch (def.effect.k) {
    case 'dealerLicense': {
      p.items.push({ id: `it-${Math.random().toString(36).slice(2, 10)}`, def: def.id });
      pushLog(gs, 'action', `${p.name} 将【${def.name}】正面朝上放入道具区`);
      afterMarketResolved(gs, p, false);
      return;
    }
    case 'rollDice': {
      const roll = randomInt(1, 7);
      p.blood += roll;
      pushLog(gs, 'action', `【${def.name}】发动：${p.name} 掷出 ${roll} 点，获得 ${roll} 血筹`);
      if (gs.announce && gs.announce.defId === def.id) {
        gs.announce.extra = `掷出 ${roll} 点，获得 ${roll} 血筹`;
        gs.announce.at = Date.now(); // 结果已出，宣告刷新多展示一会
      }
      gs.recycle.push(def.id);
      afterMarketResolved(gs, p, false);
      return;
    }
    case 'deleteUpTo': {
      gs.recycle.push(def.id);
      gs.secretPending = { seat: p.id, kind: 'deleteUpTo', max: effN(def) };
      return;
    }
    case 'violentDelete': {
      gs.recycle.push(def.id);
      gs.secretPending = { seat: p.id, kind: 'violentTarget' };
      return;
    }
    case 'topOfMarket': {
      gs.recycle.push(def.id);
      const topId = gs.supply.pop();
      if (!topId) {
        pushLog(gs, 'action', `【${def.name}】发动：黑市牌堆已空，无事发生`);
        afterMarketResolved(gs, p, false);
        return;
      }
      const topDef = BLOOD_MARKET_BY_ID.get(topId)!;
      pushLog(gs, 'action', `【${def.name}】发动：${p.name} 免费获得牌堆顶的【${topDef.name}】`);
      gs.announce = { defId: topId, buyerSeat: p.seat, at: Date.now() };
      processMarketDef(gs, p, topDef, true, insertInto);
      return;
    }
    case 'privilegeBonus': {
      if (p.privilege) {
        p.blood += def.effect.blood;
        pushLog(gs, 'action', `【${def.name}】发动：${p.name} 持有特权证，获得 ${def.effect.blood} 血筹`);
      } else {
        pushLog(gs, 'action', `【${def.name}】发动：${p.name} 未持有特权证，无事发生`);
      }
      gs.recycle.push(def.id);
      afterMarketResolved(gs, p, false);
      return;
    }
    case 'refreshMarket': {
      gs.recycle.push(def.id);
      gs.secretPending = { seat: p.id, kind: 'refreshPick', max: 2 };
      return;
    }
    case 'closingGift': {
      // 闭店礼：获得N血筹，本回合不可再购买（购买轮转到下一位）
      p.blood += def.effect.blood;
      p.skipBuy = true;
      p.buyPassed = true;
      p.lastAction = '跳过购买';
      gs.recycle.push(def.id);
      pushLog(gs, 'action', `【${def.name}】发动：${p.name} 获得 ${def.effect.blood} 血筹，本回合不再购买`);
      afterMarketResolved(gs, p, false);
      return;
    }
    case 'bloodShare': {
      // 血袭分享：自己获得N，其他每位对手获得M
      p.blood += def.effect.blood;
      for (const o of gs.players) {
        if (o.id !== p.id) o.blood += def.effect.oppBlood;
      }
      gs.recycle.push(def.id);
      pushLog(
        gs,
        'action',
        `【${def.name}】发动：${p.name} 获得 ${def.effect.blood} 血筹，其他玩家各获得 ${def.effect.oppBlood} 血筹`,
      );
      afterMarketResolved(gs, p, false);
      return;
    }
    case 'stealPrivilege': {
      // 鬼手探囊：夺得更衣室大权——临时特权证归你
      for (const o of gs.players) o.privilege = false;
      p.privilege = true;
      gs.privilegeSeat = p.seat;
      gs.recycle.push(def.id);
      pushLog(gs, 'action', `【${def.name}】发动：${p.name} 夺得【临时特权证】`);
      afterMarketResolved(gs, p, false);
      return;
    }
    case 'todo': {
      // 拓展牌占位：强交互效果暂未自动结算，按公示弃置处理
      gs.recycle.push(def.id);
      pushLog(gs, 'action', `【${def.name}】暂未自动结算，请按卡面与同桌执行后弃置`);
      afterMarketResolved(gs, p, false);
      return;
    }
    case 'poisonMalus': {
      gs.recycle.push(def.id);
      gs.secretPending = { seat: p.id, kind: 'poisonTarget' };
      return;
    }
    case 'freezeReorg': {
      gs.recycle.push(def.id);
      gs.secretPending = { seat: p.id, kind: 'freezeTarget' };
      return;
    }
    case 'amnesiaOff': {
      gs.recycle.push(def.id);
      gs.secretPending = { seat: p.id, kind: 'amnesiaTarget' };
      return;
    }
    case 'boxRob': {
      gs.recycle.push(def.id);
      gs.secretPending = { seat: p.id, kind: 'boxRobTarget' };
      return;
    }
    case 'pinpointBlast': {
      gs.recycle.push(def.id);
      gs.secretPending = { seat: p.id, kind: 'pinpointClaim' };
      return;
    }
    case 'preciseDelDraw': {
      gs.recycle.push(def.id);
      if (p.draw.length < 3) {
        pushLog(gs, 'action', `【${def.name}】抽牌堆不足 3 张：弃置（费用不退）`);
        afterMarketResolved(gs, p, false);
        return;
      }
      const drawn = drawN(gs, p, 3);
      gs.secretPending = { seat: p.id, kind: 'preciseDel', cards: drawn, max: 2 };
      pushLog(gs, 'action', `【${def.name}】发动：${p.name} 抽 3 张牌，选择 0-2 张删除，其余弃置`);
      return;
    }
    case 'pullChipGain': {
      gs.recycle.push(def.id);
      if (!p.discard.some((c) => p.chips.some((ch) => ch.on === c.id))) {
        pushLog(gs, 'action', `【${def.name}】弃牌区没有带强化芯片的牌：弃置（费用不退）`);
        afterMarketResolved(gs, p, false);
        return;
      }
      gs.secretPending = { seat: p.id, kind: 'pullChip' };
      return;
    }
    case 'sharedInfoFx': {
      gs.recycle.push(def.id);
      gs.secretPending = { seat: p.id, kind: 'sharedInfo', max: 2, buyerId: p.id };
      pushLog(gs, 'action', `【${def.name}】发动：${p.name} 可删除至多 2 张牌，随后每位对手可删除 1 张`);
      return;
    }
  }
}

function effN(def: { effect: { k: string; n?: number } }): number {
  return (def.effect as { n?: number }).n ?? 0;
}

/** 一张黑市牌效果结算完毕：补齐黑市；非“再来一批”则轮到下一位（咖啡师免费牌先结算） */
function afterMarketResolved(gs: BloodState, p: BPlayer, refreshExtraBuy: boolean): void {
  // 咖啡师：首次购买原价≥3的黑市牌后，免费获得黑市牌堆顶的一张
  if (p.baristaPending) {
    p.baristaPending = false;
    const topId = gs.supply.pop();
    if (topId) {
      const topDef = BLOOD_MARKET_BY_ID.get(topId)!;
      pushLog(gs, 'action', `☕ ${p.name}【咖啡师】免费获得黑市牌堆顶的【${topDef.name}】`);
      gs.announce = { defId: topId, buyerSeat: p.seat, at: Date.now() };
      processMarketDef(gs, p, topDef, true);
      return; // 免费牌结算完毕后由其自身的 afterMarketResolved 推进
    }
  }
  refillMarket(gs);
  gs.secretPending = null;
  if (refreshExtraBuy) return; // 再来一批：该玩家可立即再购买
  advanceBuyTurn(gs, p.seat, Date.now());
}

export function bInsertChip(gs: BloodState, playerId: string, cardId: string, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (gs.phase !== 'buy' || !pend || pend.kind !== 'insertChip' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待插入的芯片');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const card = p.discard.find((c) => c.id === cardId);
  if (!card) throw new BloodError('BAD_CARD', '目标牌不在你的弃牌区');
  const def = BLOOD_MARKET_BY_ID.get(pend.defId!);
  if (!def) throw new BloodError('BAD_DEF', '芯片数据异常');
  insertChip(gs, p, pend.chipId!, def.id, cardId);
  afterMarketResolved(gs, p, false);
}

export function bInsertSkip(gs: BloodState, playerId: string, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (gs.phase !== 'buy' || !pend || pend.kind !== 'insertChip' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待插入的芯片');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const def = BLOOD_MARKET_BY_ID.get(pend.defId!);
  gs.recycle.push(pend.defId!);
  pushLog(gs, 'action', `${p.name} 的【${def?.name ?? '强化芯片'}】无合法目标，弃置入黑市回收站`);
  afterMarketResolved(gs, p, false);
}

function insertChip(gs: BloodState, p: BPlayer, chipId: string, defId: string, cardId: string): void {
  const card = p.discard.find((c) => c.id === cardId);
  if (!card) throw new BloodError('BAD_CARD', '目标牌不在你的弃牌区');
  if (p.chips.some((c) => c.on === cardId)) throw new BloodError('HAS_CHIP', '该牌已有强化芯片');
  const def = BLOOD_MARKET_BY_ID.get(defId)!;
  if (def.noJoker && card.s == null) throw new BloodError('BAD_INSERT', '该芯片不可插入JOKER中');
  if (def.effect.k === 'rankMod') {
    const v = card.r + def.effect.mod;
    if (v < 2 || v > 14) throw new BloodError('OUT_OF_RANGE', `点数超出 2-14 范围（${card.r}${def.effect.mod > 0 ? '+' : ''}${def.effect.mod} = ${v}）`);
  }
  p.chips.push({ id: chipId, def: defId, on: cardId });
  pushLog(gs, 'action', `${p.name} 将【${def.name}】插入 ${bloodCardText(card)}`);
}

export function bSecretDelete(gs: BloodState, playerId: string, cardIds: string[], now: number): void {
  void now;
  const pend = gs.secretPending;
  const kindOk = pend && (pend.kind === 'deleteUpTo' || pend.kind === 'sharedInfo' || pend.kind === 'sharedInfoOpp');
  if (gs.phase !== 'buy' || !pend || !kindOk || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待执行的删除');
  }
  if (cardIds.length > (pend.max ?? 0)) throw new BloodError('TOO_MANY', `最多删除 ${pend.max} 张`);
  const p = gs.players.find((x) => x.id === playerId)!;
  const set = new Set(cardIds);
  const cards = p.discard.filter((c) => set.has(c.id));
  if (cards.length !== cardIds.length) throw new BloodError('BAD_CARD', '目标牌不在你的弃牌区');
  p.discard = p.discard.filter((c) => !set.has(c.id));
  p.removed.push(...cards);
  if (cards.length > 0) {
    pushLog(gs, 'action', `${p.name} 删除：${cards.map(bloodCardText).join(' ')}`);
  }
  gainChefDeleteThrees(gs, p, cards);

  // 共享信息链式：买家删完后每位对手依次可删 1 张（空选择=跳过）
  if (pend.kind === 'sharedInfo') {
    const queue = gs.players.filter((o) => o.id !== p.id).map((o) => o.id);
    if (queue.length > 0) {
      gs.secretPending = { seat: queue[0], kind: 'sharedInfoOpp', max: 1, buyerId: p.id, oppQueue: queue.slice(1) };
      pushLog(gs, 'action', '【共享信息】轮到对手选择：可删除 1 张牌或跳过');
      return;
    }
    gs.secretPending = null;
    afterMarketResolved(gs, p, false);
    return;
  }
  if (pend.kind === 'sharedInfoOpp') {
    const buyerId = pend.buyerId!;
    const queue = pend.oppQueue ?? [];
    if (queue.length > 0) {
      gs.secretPending = { seat: queue[0], kind: 'sharedInfoOpp', max: 1, buyerId, oppQueue: queue.slice(1) };
      pushLog(gs, 'action', '【共享信息】轮到下一位对手选择');
      return;
    }
    gs.secretPending = null;
    const buyer = gs.players.find((x) => x.id === buyerId)!;
    afterMarketResolved(gs, buyer, false);
    return;
  }
  afterMarketResolved(gs, p, false);
}

export function bViolent(gs: BloodState, playerId: string, targetSeat: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (gs.phase !== 'buy' || !pend || pend.kind !== 'violentTarget' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待执行的目标选择');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  if (targetSeat < 0) {
    pushLog(gs, 'action', `【暴力删除】发动失败：无合法目标`);
    afterMarketResolved(gs, p, false);
    return;
  }
  const target = bySeat(gs, targetSeat);
  if (!target) throw new BloodError('BAD_TARGET', '目标不存在');
  if (target.draw.length < 3) throw new BloodError('BAD_TARGET', '目标抽牌堆不足3张');
  // 防护屏障询问（对自己发动不触发）
  if (target.id !== p.id) {
    const eff: BarrierEffect = { t: 'violent', by: p.id, seat: target.id, after: 'market' };
    if (tryBarrierAsk(gs, target.id, p.id, eff)) return;
  }
  const top = target.draw.splice(-3, 3);
  target.removed.push(...top);
  pushLog(gs, 'action', `【暴力删除】发动：${p.name} 删除 ${target.name} 抽牌堆顶的 ${top.map(bloodCardText).join(' ')}`);
  afterMarketResolved(gs, p, false);
}

export function bRefreshPick(gs: BloodState, playerId: string, slots: number[], now: number): void {
  void now;
  const pend = gs.secretPending;
  if (gs.phase !== 'buy' || !pend || pend.kind !== 'refreshPick' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待挑选的黑市牌');
  }
  const uniq = [...new Set(slots)];
  if (uniq.length > (pend.max ?? 0)) throw new BloodError('TOO_MANY', `最多选择 ${pend.max} 张`);
  const p = gs.players.find((x) => x.id === playerId)!;
  const moved: MarketSlot[] = [];
  for (const s of uniq.sort((a, b) => b - a)) {
    const ms = gs.market[s];
    if (!ms || ms.def == null) continue;
    moved.push(ms);
    gs.market.splice(s, 1);
  }
  for (const ms of moved) {
    if (ms.def) gs.supply.unshift(ms.def); // 放入牌堆底
    if (ms.bonus > 0) {
      // 弃置的黑市牌上叠加的血筹一同弃置
      pushLog(gs, 'action', `【${ms.def ? BLOOD_MARKET_BY_ID.get(ms.def)?.name : '?'}】上的 ${ms.bonus} 血筹一同弃置`);
    }
  }
  pushLog(gs, 'action', `${p.name} 使用【再来一批】换掉 ${moved.length} 张黑市牌`);
  refillMarket(gs);
  gs.secretPending = null;
  // 可立即再进行一次购买：不推进回合
}

export function bPassBuy(gs: BloodState, playerId: string, now: number): void {
  if (gs.phase !== 'buy') throw new BloodError('BAD_PHASE', '不在购买阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (gs.secretPending && gs.secretPending.seat === p.id) throw new BloodError('PENDING', '先完成上一张牌的结算');
  if (
    gs.secretPending &&
    ['pirateRob', 'pirateDecide', 'smugglerMark', 'auctionPick', 'auctionBid', 'impRedeem'].includes(gs.secretPending.kind)
  ) {
    throw new BloodError('PENDING', '购买前的角色互动尚未完成');
  }
  if (p.buyPassed) return;
  if (gs.turnSeat !== p.seat) throw new BloodError('NOT_YOUR_TURN', '还没轮到你选择');
  p.buyPassed = true;
  p.lastAction = '跳过购买';
  pushLog(gs, 'action', `${p.name} 跳过购买（本阶段不可再买）`);
  if (allDone(gs, (x) => x.buyPassed)) {
    endBuy(gs, now);
  } else {
    advanceBuyTurn(gs, p.seat, now);
  }
}

function advanceBuyTurn(gs: BloodState, fromSeat: number, now: number): void {
  if (allDone(gs, (x) => x.buyPassed)) {
    endBuy(gs, now);
    return;
  }
  for (let i = 1; i <= gs.seatCount; i++) {
    const p = bySeat(gs, (fromSeat + i) % gs.seatCount);
    if (p && !p.buyPassed) {
      gs.turnSeat = p.seat;
      gs.deadline = now + BLOOD_TURN_MS;
      // 瞎掰帝拍卖得牌者轮到其购买回合时发放暗置的牌
      if (gs.auction && gs.auction.highestBy === p.id) {
        const def = BLOOD_MARKET_BY_ID.get(gs.auction.defId);
        gs.auction = null;
        if (def) {
          pushLog(gs, 'action', `🔨 ${p.name} 获得拍卖得牌【${def.name}】`);
          processMarketDef(gs, p, def, true);
          return;
        }
      }
      return;
    }
  }
  endBuy(gs, now);
}

function endBuy(gs: BloodState, now: number): void {
  if (gs.phase !== 'buy') return;
  for (const idx of [3, 4]) {
    if (gs.market[idx] && gs.market[idx].def != null) {
      gs.market[idx].bonus += 1;
    }
  }
  pushLog(gs, 'hand', '购买阶段结束：右两格黑市牌各叠加 1 血筹');
  gs.smugglerMark = null;
  // 购买阶段结束时角色技能
  for (const p of gs.players) {
    if (effChar(p) === 'stockholder' && p.blood === 0) {
      p.blood += 3;
      pushLog(gs, 'action', `${p.name}【股民】购买阶段结束剩余 0 血筹：获得 3 血筹`);
    }
    if (effChar(p) === 'wei' && p.boughtAny) {
      p.blood += 2;
      pushLog(gs, 'action', `${p.name}【魏王】本回合购买过黑市牌：获得 2 血筹`);
    }
  }
  gs.phase = 'remove';
  for (const p of gs.players) {
    p.removeDone = false;
    // 女仆必须跳过删牌阶段；编剧未达50点同样跳过
    if (effChar(p) === 'maid') {
      p.removeDone = true;
      pushLog(gs, 'action', `${p.name}【女仆】跳过删牌阶段`);
    } else if (p.skipBuyRemove) {
      p.removeDone = true;
    }
  }
  // 赌狗：删牌阶段可发动一次掷骰删牌
  const dog = gs.players.find((p) => effChar(p) === 'dogGambler' && !p.removeDone);
  if (dog) {
    gs.secretPending = { seat: dog.id, kind: 'dogTarget' };
    gs.deadline = now + BLOOD_TURN_MS;
    return;
  }
  gs.deadline = now + BLOOD_TURN_MS;
  if (allDone(gs, (x) => x.removeDone)) startReorg(gs, now);
}

/* ---------------- 删牌阶段 ---------------- */

export function bRemove(gs: BloodState, playerId: string, cardIds: string[], now: number): void {
  void now;
  if (gs.phase !== 'remove') throw new BloodError('BAD_PHASE', '不在删牌阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (p.removeDone) return;
  if (gs.secretPending && gs.secretPending.seat === p.id) throw new BloodError('PENDING', '先完成当前角色技能抉择');
  const set = new Set(cardIds);
  const cards = p.discard.filter((c) => set.has(c.id));
  if (cards.length !== cardIds.length) throw new BloodError('BAD_CARD', '目标牌不在你的弃牌区');
  // 免费删牌张数：默认1，黑客2；飞车党/双生子（兄）只可付费删牌；皇叔每张 1 血筹（无次数限制）
  let cost: number;
  if (effChar(p) === 'liu') {
    cost = cards.length;
  } else {
    const freeN = effChar(p) === 'hacker' ? 2 : effChar(p) === 'biker' || effChar(p) === 'twinA' ? 0 : 1;
    cost = Math.max(0, cards.length - freeN) * 2;
  }
  if (p.blood < cost) throw new BloodError('NO_BLOOD', `血筹不足（需 ${cost}）`);
  p.blood -= cost;
  p.discard = p.discard.filter((c) => !set.has(c.id));
  p.removed.push(...cards);
  p.removeDone = true;
  p.lastAction = cards.length > 0 ? `删除 ${cards.length} 张` : '跳过删牌';
  if (cards.length > 0) {
    pushLog(gs, 'action', `${p.name} 删除 ${cards.length} 张（${cost > 0 ? `支付 ${cost} 血筹` : '免费'}）：${cards.map(bloodCardText).join(' ')}`);
  } else {
    pushLog(gs, 'action', `${p.name} 跳过删牌`);
  }
  gainChefDeleteThrees(gs, p, cards);
  checkLiuWin(gs, p, now);
  if (gs.phase !== 'remove') return; // 皇叔达成特殊胜利
  if (allDone(gs, (x) => x.removeDone)) startReorg(gs, now);
}

/** 皇叔：分数达到目标一半且整副 54 张全部删除 → 直接获胜 */
function checkLiuWin(gs: BloodState, p: BPlayer, now: number): void {
  if (effChar(p) !== 'liu') return;
  if (p.removed.length >= 54 && p.tickets >= gs.target / 2) {
    gs.phase = 'gameover';
    gs.deadline = null;
    gs.final = {
      winnerSeat: p.seat,
      ranking: gs.players
        .slice()
        .sort((a, b) => (b.id === p.id ? 1 : a.id === p.id ? -1 : 0) || b.tickets - a.tickets || b.blood - a.blood)
        .map((x) => ({ seat: x.seat, name: x.name, tickets: x.tickets, blood: x.blood })),
    };
    pushLog(gs, 'sys', `⚰️ ${p.name}【皇叔】删光整副 54 张牌且分数过半，达成宿命胜利！`);
    void now;
  }
}

export function bRemoveDone(gs: BloodState, playerId: string, now: number): void {
  void now;
  if (gs.phase !== 'remove') throw new BloodError('BAD_PHASE', '不在删牌阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (p.removeDone) return;
  if (gs.secretPending && gs.secretPending.seat === p.id) throw new BloodError('PENDING', '先完成当前角色技能抉择');
  p.removeDone = true;
  p.lastAction = '跳过删牌';
  pushLog(gs, 'action', `${p.name} 跳过删牌`);
  if (allDone(gs, (x) => x.removeDone)) startReorg(gs, now);
}

/** 特级大厨：任意时候删除1张【3】获得4血筹（按最终点数判定） */
function gainChefDeleteThrees(gs: BloodState, p: BPlayer, cards: BCard[]): void {
  if (effChar(p) !== 'chef') return;
  const threes = cards.filter((c) => finalRank(p, c) === 3).length;
  if (threes > 0) {
    p.blood += threes * 4;
    pushLog(gs, 'action', `${p.name}【特级大厨】删除 ${threes} 张3：获得 ${threes * 4} 血筹`);
  }
}

function startReorg(gs: BloodState, now: number): void {
  gs.phase = 'reorg';
  for (const p of gs.players) p.reorgDone = false;
  pushLog(gs, 'hand', '重整阶段：重洗牌库 或 获得2血筹');
  // 冻结车厢 / 广播喇叭（宣称失败）/ 捣蛋鬼：跳过本回合重整
  for (const p of gs.players) {
    if (p.skipReorg || effChar(p) === 'imp') {
      p.reorgDone = true;
      pushLog(gs, 'action', `${p.name} 跳过重整阶段${effChar(p) === 'imp' ? '【捣蛋鬼】' : ''}`);
    }
  }
  gs.deadline = now + BLOOD_TURN_MS;
  if (allDone(gs, (x) => x.reorgDone)) finishReorg(gs, now);
}

/** 重整阶段全部完成 → 回合收尾（清洁工自选删牌）并进入下回合 */
function finishReorg(gs: BloodState, now: number): void {
  // 对决期芯片状态（失效/弹簧修正/复制快照）回合结束清除
  for (const p2 of gs.players) {
    for (const ch of p2.chips) {
      delete ch.off;
      delete ch.springMod;
      delete ch.copiedFx;
    }
  }
  // 清洁工：重整阶段结束时从全牌库自选 1 张删除（跨玩家抽牌堆/弃牌区）
  const cleaners = gs.players.filter((p2) => effChar(p2) === 'cleaner');
  if (cleaners.length > 0) {
    gs.secretPending = {
      seat: cleaners[0].id,
      kind: 'cleanerDel',
      oppQueue: cleaners.slice(1).map((c) => c.id),
    };
    gs.deadline = now + BLOOD_TURN_MS;
    return; // 全部清洁工结算后再进入下回合
  }
  gs.round += 1;
  startDrawPhase(gs, now);
}

/** 清洁工队列全部结束后进入下回合 */
function afterCleanerResolved(gs: BloodState, now: number): void {
  if (gs.secretPending) return;
  gs.round += 1;
  startDrawPhase(gs, now);
}

/* ---------------- 重整阶段 ---------------- */

export function bReorg(
  gs: BloodState,
  playerId: string,
  choice: 'reshuffle' | 'blood',
  now: number,
  pickCardId?: string,
): void {
  void now;
  if (gs.phase !== 'reorg') throw new BloodError('BAD_PHASE', '不在重整阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (p.reorgDone) return;
  if (p.skipReorg) {
    p.reorgDone = true;
    p.lastAction = '跳过重整';
    pushLog(gs, 'action', `${p.name} 跳过重整阶段`);
    if (allDone(gs, (x) => x.reorgDone)) finishReorg(gs, now);
    return;
  }
  if (choice === 'reshuffle') {
    p.draw = shuffle([...p.discard, ...p.draw]);
    p.discard = [];
    onLibraryReshuffle(gs);
    pushLog(gs, 'action', `${p.name} 重洗牌库`);
    // 质检员：重洗牌库则获得 1 血筹
    if (effChar(p) === 'inspector') {
      p.blood += 1;
      pushLog(gs, 'action', `${p.name}【质检员】重洗牌库：获得 1 血筹`);
    }
  } else {
    p.blood += 2;
    // 洗衣房店主：选择不重洗牌库额外获得 2 血筹
    if (effChar(p) === 'laundry') {
      p.blood += 2;
      pushLog(gs, 'action', `${p.name}【洗衣房店主】选择不重洗：额外获得 2 血筹`);
    }
    pushLog(gs, 'action', `${p.name} 获得 2 血筹`);
    // 质检员：不重洗牌库（+2）时，可从弃牌区选 1 张公示后放到抽牌堆顶
    if (effChar(p) === 'inspector' && pickCardId) {
      const card = p.discard.find((c) => c.id === pickCardId);
      if (card) {
        p.discard = p.discard.filter((c) => c.id !== pickCardId);
        p.draw.push(card);
        pushLog(gs, 'action', `${p.name}【质检员】公示 ${bloodCardText(card)} 并放到抽牌堆顶`);
      }
    }
  }
  // 银行职员：重整阶段固定获得 2 血筹（与重洗/不重洗叠加）
  if (effChar(p) === 'clerk') {
    p.blood += 2;
    pushLog(gs, 'action', `${p.name}【银行职员】重整阶段获得 2 血筹`);
  }
  p.reorgDone = true;
  p.lastAction = choice === 'reshuffle' ? '重洗牌库' : '+2血筹';
  if (allDone(gs, (x) => x.reorgDone)) {
    finishReorg(gs, now);
  }
}

/* ---------------- 超时托管 ---------------- */

export function bloodTick(gs: BloodState, now: number): boolean {
  if (gs.phase === 'gameover' || gs.deadline == null) return false;
  if (now < gs.deadline) return false;
  // 托管动作可能触发阶段推进，循环内逐次复核阶段，且吞掉竞态非法操作
  const act = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      if (!(e instanceof BloodError)) throw e;
    }
  };
  switch (gs.phase) {
    case 'pick': {
      // 选将超时托管：自动选择第一张
      for (const p of gs.players) {
        if (gs.phase !== 'pick') break;
        if (!p.charId) act(() => bPickChar(gs, p.id, p.charOptions[0], now));
      }
      return true;
    }
    case 'setup': {
      // 游戏开始初始化队列（我的名字？/黑客初始构筑）超时托管
      const pend = gs.secretPending;
      if (pend?.kind === 'mynameSet') {
        const p = gs.players.find((x) => x.id === pend.seat)!;
        gs.mynameCat = 1;
        gs.mynameText = '神秘牌型';
        gs.secretPending = null;
        pushLog(gs, 'action', `${p.name}【我的名字？】超时托管：将「一对」命名为「神秘牌型」`);
        processStartupQueue(gs);
        return true;
      }
      if (pend?.kind === 'hackerSetup') {
        const p = gs.players.find((x) => x.id === pend.seat)!;
        gs.secretPending = null;
        act(() => bHackerSetup(gs, p.id, p.draw.slice(-8).map((c) => c.id), now));
        return true;
      }
      for (const p of gs.players) {
        if (gs.phase !== 'setup') break;
        if (p.setupRound < 2) act(() => bSetup(gs, p.id, [], now));
      }
      return true;
    }
    case 'draw': {
      // 抽牌前互动（私家侦探/无面人）超时托管
      const pend = gs.secretPending;
      if (pend?.kind === 'detectivePick') {
        const p = gs.players.find((x) => x.id === pend.seat)!;
        p.blood += 1;
        pushLog(gs, 'action', `${p.name}【私家侦探】未调整牌库：获得 1 血筹`);
        gs.secretPending = null;
        processPreDrawQueue(gs, now);
        return true;
      }
      if (pend?.kind === 'facelessPick') {
        const p = gs.players.find((x) => x.id === pend.seat)!;
        gs.secretPending = null;
        act(() => bFacelessPick(gs, p.id, pend.options?.[0] ?? '', now));
        return true;
      }
      finishDrawPhase(gs, now);
      return true;
    }
    case 'swap': {
      if (gs.secretPending?.kind === 'barrierAsk') {
        pushLog(gs, 'action', '【防护屏障】询问超时，视为允许生效');
        resolveBarrier(gs, false, now);
        return true;
      }
      const pend = gs.secretPending;
      if (pend) {
        const p = gs.players.find((x) => x.id === pend.seat);
        if (p) resolveSwapEndOnTimeout(gs, p, now);
        return true;
      }
      for (const p of gs.players) {
        if (gs.phase !== 'swap') break;
        if (!p.swapDone && !(gs.secretPending && gs.secretPending.seat === p.id)) {
          act(() => bSwapStop(gs, p.id, now));
        }
      }
      // 自愈：超时托管统一走 checkSwapEnd（内部依次处理结束队列/捣蛋鬼小回合/阶段收尾）
      if (gs.phase === 'swap' && !gs.secretPending) checkSwapEnd(gs, now);
      return true;
    }
    case 'play': {
      const pend = gs.secretPending;
      if (pend?.kind === 'studentDump' || pend?.kind === 'designerDiscard' || pend?.kind === 'agentAsk') {
        pushLog(gs, 'action', '出牌阶段角色技能选择超时：视为放弃');
        gs.secretPending = null;
        afterPlayHookResolved(gs, now);
        return true;
      }
      if (pend?.kind === 'agentDecide') {
        const t = gs.players.find((x) => x.id === pend.seat)!;
        gs.secretPending = null;
        act(() => bAgentDecide(gs, t.id, true, now));
        return true;
      }
      if (pend?.kind === 'blufferDeclare') {
        pushLog(gs, 'action', `${gs.players.find((x) => x.id === pend.seat)?.name}【瞎掰王】宣告超时：放弃宣告`);
        gs.secretPending = null;
        afterPlayHookResolved(gs, now);
        return true;
      }
      if (pend?.kind === 'blufferChallenge') {
        gs.secretPending = null;
        act(() => bBlufferChallenge(gs, pend.seat, false, now));
        return true;
      }
      if (pend?.kind === 'studentRemove') {
        pushLog(gs, 'action', '【高中生】删牌选择超时：视为放弃');
        gs.secretPending = null;
        afterPlayHookResolved(gs, now);
        return true;
      }
      // 出牌阶段的宣告挂起（魔术橡皮/赌徒虹膜/职业赌徒）超时：落空弃置后继续托管
      if (gs.secretPending) {
        if (gs.secretPending.defId) gs.recycle.push(gs.secretPending.defId);
        pushLog(gs, 'action', '宣告超时，效果落空弃置');
        gs.secretPending = null;
      }
      for (const p of gs.players) {
        if (gs.phase !== 'play') break;
        if (!p.locked) act(() => bPlay(gs, p.id, bestFive(p), now));
      }
      if (gs.phase === 'play' && allDone(gs, (x) => x.locked) && !gs.secretPending) {
        tryStartReveal(gs, now);
      }
      return true;
    }
    case 'reveal': {
      if (gs.phase !== 'reveal') return true;
      if (gs.secretPending?.kind === 'revealDecide') {
        pushLog(gs, 'action', '对决决策超时，剩余芯片效果按跳过处理');
        gs.secretPending = null;
        nextRevealOrSettle(gs, now);
        return true;
      }
      if (gs.secretPending?.kind === 'barrierAsk') {
        pushLog(gs, 'action', '【防护屏障】询问超时，视为允许生效');
        resolveBarrier(gs, false, now);
        return true;
      }
      const p = bySeat(gs, gs.turnSeat ?? -1);
      if (!p) return true;
      if (gs.secretPending?.kind === 'demagTarget') {
        // 消磁枪选择超时：落空弃置，继续宣告流程
        if (gs.secretPending.defId) gs.recycle.push(gs.secretPending.defId);
        pushLog(gs, 'action', '【消磁枪】选择超时，效果落空弃置');
        gs.secretPending = null;
        nextRevealOrSettle(gs, now);
        return true;
      }
      if (gs.stealPending && gs.stealPending.seat === p.id) {
        gs.stealPending = null;
        pushLog(gs, 'action', `${p.name} 掠夺目标无效，效果落空`);
      } else {
        act(() => bUseItem(gs, p.id, null, now));
      }
      return true;
    }
    case 'settle': {
      // 对决展示确认：全员确认立即统一推进；演示播完后的 30s 等待上限到期自动确认兜底
      if (gs.phase !== 'settle') return true;
      const pend = gs.secretPending;
      if (pend?.kind === 'succubusSteal' || pend?.kind === 'scalperDeal' || pend?.kind === 'fryerDel') {
        const p = gs.players.find((x) => x.id === pend.seat);
        if (p) resolveSettleOnTimeout(gs, p, now);
        return true;
      }
      if (allDone(gs, (x) => x.sdSeen)) {
        if (gs.secretPending) return true; // 结算互动未完成，等待
        startBuyPhase(gs, now);
        return true;
      }
      for (const p of gs.players) {
        if (gs.phase !== 'settle') break;
        if (!p.sdSeen) act(() => bShowdownDone(gs, p.id, now));
      }
      return true;
    }
    case 'buy': {
      if (gs.phase !== 'buy') return true;
      // 挂起中的交互（含共享信息的对手链）优先按其座位解析超时
      if (gs.secretPending) {
        if (gs.secretPending.kind === 'barrierAsk') {
          pushLog(gs, 'action', '【防护屏障】询问超时，视为允许生效');
          resolveBarrier(gs, false, now);
          return true;
        }
        const pp = gs.players.find((x) => x.id === gs.secretPending!.seat);
        if (pp) resolvePendingOnTimeout(gs, pp, now);
        return true;
      }
      const p = bySeat(gs, gs.turnSeat ?? -1);
      if (!p) return true;
      if (p.buyPassed) {
        advanceBuyTurn(gs, p.seat, now); // 自愈：回合玩家已跳过购买（如编剧/闭店礼）则推进
        return true;
      }
      act(() => bPassBuy(gs, p.id, now));
      return true;
    }
    case 'remove': {
      const pend = gs.secretPending;
      if (pend?.kind === 'dogTarget') {
        pushLog(gs, 'action', `${gs.players.find((x) => x.id === pend.seat)?.name}【赌狗】超时：放弃发动`);
        gs.secretPending = null;
        return true;
      }
      for (const p of gs.players) {
        if (gs.phase !== 'remove') break;
        if (!p.removeDone) act(() => bRemoveDone(gs, p.id, now));
      }
      return true;
    }
    case 'reorg': {
      const pend = gs.secretPending;
      if (pend?.kind === 'cleanerDel') {
        const p = gs.players.find((x) => x.id === pend.seat)!;
        // 托管：退化为删除自己抽牌堆顶 1 张
        gs.secretPending = null;
        if (p.draw.length > 0) {
          const c = p.draw.pop()!;
          p.removed.push(c);
          pushLog(gs, 'action', `${p.name}【清洁工】托管：删除自己抽牌堆顶的 ${bloodCardText(c)}`);
        } else {
          pushLog(gs, 'action', `${p.name}【清洁工】托管：抽牌堆为空，无事发生`);
        }
        const next = pend.oppQueue?.shift();
        if (next) {
          gs.secretPending = { seat: next, kind: 'cleanerDel', oppQueue: pend.oppQueue };
          gs.deadline = now + BLOOD_TURN_MS;
          return true;
        }
        afterCleanerResolved(gs, now);
        return true;
      }
      for (const p of gs.players) {
        if (gs.phase !== 'reorg') break;
        if (!p.reorgDone) act(() => bReorg(gs, p.id, 'blood', now));
      }
      return true;
    }
    default:
      return false;
  }
}

/** 换牌阶段挂起互动的超时托管 */
function resolveSwapEndOnTimeout(gs: BloodState, p: BPlayer, now: number): void {
  const pend = gs.secretPending!;
  switch (pend.kind) {
    case 'bomberClaim':
      pushLog(gs, 'action', `${p.name}【炸弹客】宣告超时：本回合不发动`);
      gs.bomberX = 0;
      break;
    case 'curseTake':
      pushLog(gs, 'action', `${p.name}【咒术师】取回超时：藏牌保留在角色牌下`);
      break;
    case 'generalChoice':
      pushLog(gs, 'action', `${p.name}【将军】选择超时：视为放弃`);
      break;
    case 'godPeek':
      pushLog(gs, 'action', `${p.name}【赌神】选择超时：视为放弃`);
      break;
    case 'vagrantDraw':
      pushLog(gs, 'action', `${p.name}【无业游民】抽牌超时：视为放弃`);
      break;
    case 'ceoGive':
      pushLog(gs, 'action', `${p.name}【霸道总裁】超时：结束给予`);
      break;
    case 'impDraw':
      pushLog(gs, 'action', `${p.name}【捣蛋鬼】抽牌超时：暂停抽牌`);
      break;
    default:
      return;
  }
  gs.secretPending = null;
  checkSwapEnd(gs, now);
}

/** 结算阶段挂起互动的超时托管（魅魔/票贩子/炸鸡店老板） */
function resolveSettleOnTimeout(gs: BloodState, p: BPlayer, now: number): void {
  const pend = gs.secretPending!;
  if (pend.kind === 'succubusSteal') {
    const amount = pend.blood ?? 1;
    const want: 'm' | 'f' = effChar(p) === 'succubus' && p.privilege ? 'm' : 'f';
    const targets = gs.players.filter((o) => o.id !== p.id && genderMatches(effChar(o), want) && o.blood > 0);
    gs.secretPending = null;
    if (targets.length > 0) {
      const t = targets[randomInt(0, targets.length)];
      const pay = Math.min(amount, t.blood);
      t.blood -= pay;
      p.blood += pay;
      pushLog(gs, 'action', `${p.name}【魅魔】托管抢夺 ${t.name}：获得 ${pay} 血筹`);
    } else {
      p.blood += amount;
      pushLog(gs, 'action', `${p.name}【魅魔】托管：直接获得 ${amount} 血筹`);
    }
    processSettleQueue(gs, now);
    return;
  }
  if (pend.kind === 'scalperDeal') {
    pushLog(gs, 'action', `${p.name}【票贩子】超时：放弃强购`);
    gs.secretPending = null;
    processSettleQueue(gs, now);
    return;
  }
  if (pend.kind === 'fryerDel') {
    pushLog(gs, 'action', `${p.name}【炸鸡店老板】删牌超时：结束`);
    gs.secretPending = null;
    processSettleQueue(gs, now);
    void now;
  }
}

/**
 * 拓展牌统一目标选择结算：毒害/冻结/失忆/黑厢抢夺（购买阶段），信号干扰（换牌阶段），消磁（对决阶段）
 */
export function bSecretTarget(gs: BloodState, playerId: string, seat: number, now: number): void {
  const pend = gs.secretPending;
  if (!pend || pend.seat !== playerId) throw new BloodError('PENDING', '当前没有待选择的目标');
  const p = gs.players.find((x) => x.id === playerId)!;
  const t = bySeat(gs, seat);
  if (!t || t.id === playerId) throw new BloodError('BAD_TARGET', '目标无效');
  const finish = (): void => {
    gs.secretPending = null;
    if (pend.kind === 'signalTarget') return; // 道具：无购买推进
    afterMarketResolved(gs, p, false);
  };
  // 防护屏障：单独指定的效果先询问受害者是否抵消
  const barrierMap: Partial<Record<typeof pend.kind, BarrierEffect['t']>> = {
    poisonTarget: 'poison',
    freezeTarget: 'freeze',
    amnesiaTarget: 'amnesia',
    boxRobTarget: 'boxRob',
    signalTarget: 'signal',
  };
  const effKind = barrierMap[pend.kind];
  if (effKind) {
    const eff: BarrierEffect = { t: effKind, by: p.id, seat: t.id, after: pend.kind === 'signalTarget' ? 'none' : 'market' };
    if (tryBarrierAsk(gs, t.id, p.id, eff)) return; // 进入反制询问窗口
  }
  switch (pend.kind) {
    case 'poisonTarget': {
      t.swapMalus += 2;
      gs.recycle.push(pend.defId ?? 'poison');
      pushLog(gs, 'action', `【餐车投毒】${p.name} 毒害 ${t.name}：下回合换牌次数 -2`);
      finish();
      return;
    }
    case 'freezeTarget': {
      t.skipReorg = true;
      gs.recycle.push(pend.defId ?? 'freezeCar');
      pushLog(gs, 'action', `【冻结车厢】${t.name} 跳过本回合重整阶段`);
      finish();
      return;
    }
    case 'amnesiaTarget': {
      t.charOffNextRound = true;
      gs.recycle.push(pend.defId ?? 'amnesia');
      pushLog(gs, 'action', `【暂时失忆】${t.name} 的角色技能在下回合失效`);
      finish();
      return;
    }
    case 'boxRobTarget': {
      const myRoll = randomInt(1, 7);
      const tRoll = randomInt(1, 7);
      if (myRoll > tRoll) {
        const gain = Math.min(4, Math.max(0, t.blood));
        t.blood -= gain;
        p.blood += gain;
        pushLog(gs, 'action', `【黑厢抢夺】${p.name} 掷出 ${myRoll}，${t.name} 掷出 ${tRoll}：抢夺 ${gain} 血筹`);
      } else {
        pushLog(gs, 'action', `【黑厢抢夺】${p.name} 掷出 ${myRoll}，${t.name} 掷出 ${tRoll}：抢夺失败，无事发生`);
      }
      finish();
      return;
    }
    case 'signalTarget': {
      if (t.hand.length === 0) {
        pushLog(gs, 'action', `【信号干扰器】${t.name} 没有手牌，效果落空`);
      } else {
        const idx = randomInt(0, t.hand.length);
        const [c] = t.hand.splice(idx, 1);
        t.discard.push(c);
        drawToCap(gs, t);
        pushLog(gs, 'action', `【信号干扰器】${t.name} 随机弃置 ${bloodCardText(c)}，并抽 1 张牌`);
      }
      finish();
      return;
    }
    case 'demagTarget': {
      // 防护屏障询问（消磁枪单独指向）
      const eff: BarrierEffect = { t: 'demag', by: p.id, seat: t.id, after: 'reveal' };
      if (tryBarrierAsk(gs, t.id, p.id, eff)) return;
      const chips = t.chips.filter((ch) => t.play.some((card) => card.id === ch.on) && !ch.off);
      if (chips.length === 0) {
        gs.recycle.push(pend.defId ?? 'demag');
        gs.secretPending = null;
        pushLog(gs, 'action', `【消磁枪】${t.name} 的出牌区没有强化芯片，效果落空`);
        nextRevealOrSettle(gs, now);
        return;
      }
      // 使用者自选目标玩家的具体芯片
      gs.secretPending = { seat: p.id, kind: 'demagPick', defId: pend.defId ?? 'demag', targetSeat: t.id };
      pushLog(gs, 'action', `【消磁枪】${p.name} 请选择 ${t.name} 出牌区要失效的芯片`);
      return;
    }
    default:
      throw new BloodError('PENDING', '当前没有待选择的目标');
  }
}

/** 魔术橡皮：宣告一种牌型，本回合该牌型视为高牌 */
export function bEraserClaim(gs: BloodState, playerId: string, cat: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'eraserClaim' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待宣告的魔术橡皮');
  }
  if (!Number.isInteger(cat) || cat < 0 || cat > 14) throw new BloodError('BAD_TARGET', '牌型无效');
  const p = gs.players.find((x) => x.id === playerId)!;
  gs.eraserType = cat;
  gs.recycle.push(pend.defId ?? 'eraser');
  gs.secretPending = null;
  pushLog(gs, 'action', `【魔术橡皮】${p.name} 宣告：本回合【${catName(cat)}】视为高牌`);
}

/** 赌徒虹膜：竞猜一位玩家的最终牌型（结算时判定） */
export function bIrisGuess(gs: BloodState, playerId: string, seat: number, cat: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'irisGuess' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待提交的竞猜');
  }
  const t = bySeat(gs, seat);
  if (!t) throw new BloodError('BAD_TARGET', '竞猜目标无效');
  if (!Number.isInteger(cat) || cat < 0 || cat > 14) throw new BloodError('BAD_TARGET', '牌型无效');
  const p = gs.players.find((x) => x.id === playerId)!;
  gs.irisGuess = { by: playerId, seat, cat };
  gs.recycle.push(pend.defId ?? 'irisGamble');
  gs.secretPending = null;
  pushLog(gs, 'action', `【赌徒虹膜】${p.name} 竞猜 ${t.name} 的牌型为【${catName(cat)}】`);
}

/** 定点爆破：选定对手与点数后，随机删除其弃牌堆中一张该点数的牌 */
export function bPinpoint(gs: BloodState, playerId: string, seat: number, rank: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'pinpointClaim' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待执行的定点爆破');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const t = bySeat(gs, seat);
  if (!t || t.id === playerId) throw new BloodError('BAD_TARGET', '目标无效');
  if (!Number.isInteger(rank) || rank < 2 || rank > 14) throw new BloodError('BAD_TARGET', '点数无效');
  // 防护屏障询问
  const eff: BarrierEffect = { t: 'pinpoint', by: p.id, seat: t.id, rank, after: 'market' };
  if (tryBarrierAsk(gs, t.id, p.id, eff)) return;
  const matches = t.discard.filter((c) => finalRank(t, c) === rank);
  if (matches.length === 0) {
    pushLog(gs, 'action', `【定点爆破】${t.name} 公示弃牌堆：没有 ${rank} 点的牌，效果落空`);
    gs.secretPending = null;
    afterMarketResolved(gs, p, false);
    return;
  }
  // 受害者自选要删除的那张（转交选择权）
  gs.secretPending = { seat: t.id, kind: 'pinpointVictim', rank, buyerId: p.id, targetSeat: t.id };
  pushLog(gs, 'action', `【定点爆破】${t.name} 须从弃牌堆选择一张 ${rank} 点的牌删除`);
  gs.deadline = now + BLOOD_TURN_MS;
}

/** 精准删除：抽到的 3 张牌中删除 0-2 张，其余弃置 */
export function bPreciseDel(gs: BloodState, playerId: string, cardIds: string[], now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'preciseDel' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待处理的精准删除');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const drawn = pend.cards ?? [];
  const uniq = [...new Set(cardIds)];
  if (uniq.length > 2) throw new BloodError('TOO_MANY', '最多删除 2 张');
  const picked = drawn.filter((c) => uniq.includes(c.id));
  if (picked.length !== uniq.length) throw new BloodError('BAD_CARD', '目标牌不在抽到的 3 张中');
  p.removed.push(...picked);
  const rest = drawn.filter((c) => !uniq.includes(c.id));
  p.discard.push(...rest);
  pushLog(
    gs,
    'action',
    picked.length > 0
      ? `【精准删除】${p.name} 删除 ${picked.map(bloodCardText).join(' ')}，其余 ${rest.length} 张弃置`
      : `【精准删除】${p.name} 未删除任何牌，3 张全部弃置`,
  );
  gainChefDeleteThrees(gs, p, picked);
  gs.secretPending = null;
  afterMarketResolved(gs, p, false);
}

/** 拔除芯片：拔除弃牌区指定牌上的芯片并获得血筹 */
export function bPullChip(gs: BloodState, playerId: string, cardId: string, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'pullChip' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待执行的拔除芯片');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const card = p.discard.find((c) => c.id === cardId);
  if (!card) throw new BloodError('BAD_CARD', '目标牌不在你的弃牌区');
  const chip = p.chips.find((ch) => ch.on === cardId);
  if (!chip) throw new BloodError('BAD_CARD', '该牌没有强化芯片');
  const def = BLOOD_MARKET_BY_ID.get(chip.def)!;
  p.chips = p.chips.filter((ch) => ch.id !== chip.id);
  gs.recycle.push(chip.def);
  p.blood += 4;
  pushLog(gs, 'action', `【拔除芯片】${p.name} 拔除 ${bloodCardText(card)} 上的【${def.name}】：获得 4 血筹`);
  gs.secretPending = null;
  afterMarketResolved(gs, p, false);
}

function resolvePendingOnTimeout(gs: BloodState, p: BPlayer, now: number): void {
  const pend = gs.secretPending!;
  switch (pend.kind) {
    case 'insertChip':
      bInsertSkip(gs, p.id, now);
      return;
    case 'deleteUpTo':
      bSecretDelete(gs, p.id, [], now);
      return;
    case 'violentTarget':
      bViolent(gs, p.id, -1, now);
      return;
    case 'refreshPick':
      bRefreshPick(gs, p.id, [], now);
      // 超时后玩家仍处于其购买回合：重置该阶段 deadline，允许其继续购买
      gs.turnSeat = p.seat;
      gs.deadline = now + BLOOD_TURN_MS;
      return;
    case 'preciseDel':
      bPreciseDel(gs, p.id, [], now);
      return;
    case 'sharedInfo':
    case 'sharedInfoOpp':
      bSecretDelete(gs, p.id, [], now);
      return;
    case 'poisonTarget':
    case 'freezeTarget':
    case 'amnesiaTarget':
    case 'boxRobTarget':
    case 'pinpointClaim':
    case 'pullChip': {
      pushLog(gs, 'action', '拓展牌效果选择超时，落空弃置');
      gs.secretPending = null;
      afterMarketResolved(gs, p, false);
      return;
    }
    case 'eraserClaim':
    case 'irisGuess': {
      if (pend.defId) gs.recycle.push(pend.defId);
      pushLog(gs, 'action', '宣告超时，效果落空弃置');
      gs.secretPending = null;
      return;
    }
    case 'demagPick': {
      // 托管：随机失效目标出牌区的一张芯片；无芯片则落空
      const t = gs.players.find((x) => x.id === pend.targetSeat);
      const chips = t ? t.chips.filter((ch) => t.play.some((card) => card.id === ch.on) && !ch.off) : [];
      gs.recycle.push(pend.defId ?? 'demag');
      gs.secretPending = null;
      if (chips.length > 0) {
        const pickChip = chips[randomInt(0, chips.length)];
        pickChip.off = true;
        const tName = t?.name ?? '?';
        pushLog(gs, 'action', `【消磁枪】托管：${tName} 出牌区的【${BLOOD_MARKET_BY_ID.get(pickChip.def)?.name}】失效`);
      } else {
        pushLog(gs, 'action', '【消磁枪】托管：无有效目标，落空');
      }
      nextRevealOrSettle(gs, now);
      return;
    }
    case 'pinpointVictim': {
      // 托管：随机删除一张匹配点数的牌；无匹配则落空
      const rank = pend.rank ?? 0;
      const matches = p.discard.filter((c) => finalRank(p, c) === rank);
      gs.secretPending = null;
      if (matches.length === 0) {
        pushLog(gs, 'action', `【定点爆破】${p.name} 弃牌堆没有 ${rank} 点的牌，落空`);
      } else {
        const pickCard = matches[randomInt(0, matches.length)];
        p.discard = p.discard.filter((c) => c.id !== pickCard.id);
        p.removed.push(pickCard);
        pushLog(gs, 'action', `【定点爆破】托管：${p.name} 删除弃牌堆中的 ${bloodCardText(pickCard)}`);
      }
      const buyer = gs.players.find((x) => x.id === pend.buyerId)!;
      afterMarketResolved(gs, buyer, false);
      return;
    }
    /* ---- 购买阶段前的角色互动托管 ---- */
    case 'pirateRob':
      pushLog(gs, 'action', `${p.name}【海盗】超时：放弃抢劫`);
      gs.secretPending = null;
      processPreBuyQueue(gs, now);
      return;
    case 'pirateDecide': {
      // 托管：受害者选择放弃（交出至多 2 血筹）
      gs.secretPending = null;
      act2(() => bPirateDecide(gs, p.id, false, now));
      return;
    }
    case 'smugglerMark':
      pushLog(gs, 'action', `${p.name}【走私客】超时：本回合不标记`);
      gs.secretPending = null;
      processPreBuyQueue(gs, now);
      return;
    case 'auctionPick': {
      // 托管：不发动拍卖，两张牌放回原处
      pushLog(gs, 'action', `${p.name}【瞎掰帝】超时：不发动拍卖`);
      gs.secretPending = null;
      processPreBuyQueue(gs, now);
      return;
    }
    case 'auctionBid': {
      // 托管：本轮不叫价（出价 0）
      gs.secretPending = null;
      act2(() => bAuctionBid(gs, p.id, 0, now));
      return;
    }
    case 'impRedeem':
      pushLog(gs, 'action', `${p.name} 超时：不向捣蛋鬼赎回`);
      gs.secretPending = null;
      processPreBuyQueue(gs, now);
      return;
  }
}

function act2(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof BloodError)) throw e;
  }
}

/** 投降：本局判负并立即结束，其余玩家按车票/血筹码座排序结算名次 */
export function bResign(gs: BloodState, playerId: string, now: number): void {
  void now;
  if (gs.phase === 'gameover') return;
  if (gs.phase === 'pick' || gs.phase === 'setup') throw new BloodError('BAD_PHASE', '当前阶段无法投降');
  const p = gs.players.find((x) => x.id === playerId);
  if (!p) throw new BloodError('NO_PLAYER', '玩家不在对局中');
  const others = gs.players.filter((x) => x.id !== playerId);
  if (others.length === 0) return;
  const winner = others.slice().sort((a, b) => b.tickets - a.tickets || b.blood - a.blood)[0];
  for (const o of gs.players) o.privilege = false;
  winner.privilege = true;
  gs.privilegeSeat = winner.seat;
  gs.phase = 'gameover';
  gs.deadline = null;
  gs.final = {
    winnerSeat: winner.seat,
    ranking: gs.players
      .slice()
      .sort((a, b) => {
        if (a.id === playerId) return 1;
        if (b.id === playerId) return -1;
        return b.tickets - a.tickets || b.blood - a.blood;
      })
      .map((x) => ({ seat: x.seat, name: x.name, tickets: x.tickets, blood: x.blood })),
  };
  pushLog(gs, 'sys', `🏳️ ${p.name} 投降，本局判负 · ${winner.name} 获胜`);
}

/* ---------------- 拓展角色技能交互 ---------------- */

const ALL_SUITS_FOR_DECLARE: Suit[] = ['s', 'h', 'd', 'c'];

/** 我的名字？：游戏开始时自定义一种牌型的名称 */
export function bMynameSet(gs: BloodState, playerId: string, cat: number, name: string, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'mynameSet' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待设定的自定义牌型');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  if (!Number.isInteger(cat) || cat < 0 || cat > 14) throw new BloodError('BAD_TARGET', '牌型无效');
  const trimmed = name.trim().slice(0, 12);
  if (!trimmed) throw new BloodError('BAD_TARGET', '名称不能为空');
  gs.mynameCat = cat;
  gs.mynameText = trimmed;
  gs.secretPending = null;
  pushLog(gs, 'action', `${p.name}【我的名字？】将「${catName(cat)}」命名为「${trimmed}」：此后任何人打出该牌型，其获得 2 血筹`);
  afterStartupResolved(gs, now);
}

function afterStartupResolved(gs: BloodState, now: number): void {
  processStartupQueue(gs);
  if (gs.secretPending) return;
  if (gs.phase === 'setup' && allDone(gs, (x) => x.setupRound >= 2)) {
    pushLog(gs, 'sys', '初始构筑完毕');
    startDrawPhase(gs, now);
    return;
  }
  if (gs.phase === 'draw') processPreDrawQueue(gs, now);
}

/** 黑客：初始构筑改为从自己全牌库中挑选 8 张牌删除 */
export function bHackerSetup(gs: BloodState, playerId: string, removedIds: string[], now: number): void {
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'hackerSetup' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待执行的黑客初始构筑');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  if (removedIds.length !== 8) throw new BloodError('BAD_COUNT', '必须恰好选择 8 张牌删除');
  const set = new Set(removedIds);
  const cards = p.draw.filter((c) => set.has(c.id));
  if (cards.length !== 8) throw new BloodError('BAD_CARD', '目标牌不在你的抽牌堆');
  p.draw = p.draw.filter((c) => !set.has(c.id));
  p.removed.push(...cards);
  p.setupRound = 2;
  gs.secretPending = null;
  pushLog(gs, 'action', `${p.name}【黑客】初始构筑：从全牌库删除 8 张（${cards.map(bloodCardText).join(' ')}）`);
  afterStartupResolved(gs, now);
}

/** 私家侦探：抽牌阶段前调整牌库（1张置顶 / ≤3张置底 / 放弃得1血筹） */
export function bDetectivePick(
  gs: BloodState,
  playerId: string,
  mode: 'top' | 'bottom' | 'skip',
  cardIds: string[],
  now: number,
): void {
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'detectivePick' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待执行的侦探调整');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  gs.secretPending = null;
  if (mode === 'skip') {
    p.blood += 1;
    pushLog(gs, 'action', `${p.name}【私家侦探】未调整牌库：获得 1 血筹`);
  } else if (mode === 'top') {
    if (cardIds.length !== 1) throw new BloodError('BAD_COUNT', '置顶须恰好选择 1 张');
    const card = p.discard.find((c) => c.id === cardIds[0]);
    if (!card) throw new BloodError('BAD_CARD', '目标牌不在你的弃牌区');
    p.discard = p.discard.filter((c) => c.id !== card.id);
    p.draw.push(card);
    pushLog(gs, 'action', `${p.name}【私家侦探】公示 ${bloodCardText(card)} 并放到抽牌堆顶`);
  } else {
    if (cardIds.length < 1 || cardIds.length > 3) throw new BloodError('BAD_COUNT', '置底须选择 1-3 张');
    const set = new Set(cardIds);
    const cards = p.discard.filter((c) => set.has(c.id));
    if (cards.length !== cardIds.length) throw new BloodError('BAD_CARD', '目标牌不在你的弃牌区');
    p.discard = p.discard.filter((c) => !set.has(c.id));
    p.draw.unshift(...cards);
    pushLog(gs, 'action', `${p.name}【私家侦探】公示 ${cards.map(bloodCardText).join(' ')} 并放到抽牌堆底`);
  }
  processPreDrawQueue(gs, now);
}

/** 无面人：每回合从角色牌堆抽 2 张，必选 1 张作为临时技能 */
export function bFacelessPick(gs: BloodState, playerId: string, charId: string, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'facelessPick' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待选择的角色牌');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  if (!pend.options?.includes(charId)) throw new BloodError('BAD_CARD', '该角色牌不在你的选项中');
  p.tempChar = charId;
  gs.secretPending = null;
  const def = BLOOD_CHAR_BY_ID.get(charId)!;
  pushLog(gs, 'action', `🎭 ${p.name}【无面人】获得临时技能：【${def.name}】（持续至下个抽牌阶段前）`);
  processPreDrawQueue(gs, now);
}

/** 无面人：将当前持有的角色技能永久转化（不可逆转） */
export function bFacelessConvert(gs: BloodState, playerId: string, now: number): void {
  void now;
  const p = gs.players.find((x) => x.id === playerId);
  if (!p) throw new BloodError('NO_PLAYER', '玩家不在对局中');
  if (p.charId !== 'faceless' || p.facelessDone) throw new BloodError('BAD_PHASE', '无面人当前无法转化');
  if (!p.tempChar) throw new BloodError('BAD_PHASE', '当前没有可转化的角色技能');
  const def = BLOOD_CHAR_BY_ID.get(p.tempChar)!;
  p.charId = p.tempChar;
  p.tempChar = null;
  p.facelessDone = true;
  pushLog(gs, 'action', `🎭 ${p.name}【无面人】永久转化为【${def.name}】（不可逆转）`);
}

/** 职业赌徒：猜测本回合夺魁者（可猜自己） */
export function bGamblerGuess(gs: BloodState, playerId: string, seat: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'gamblerGuess' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待提交的竞猜');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const t = bySeat(gs, seat);
  if (!t) throw new BloodError('BAD_TARGET', '竞猜目标无效');
  gs.gamblerGuess = { by: playerId, seat };
  gs.secretPending = null;
  pushLog(gs, 'action', `🎲 ${p.name}【职业赌徒】竞猜 ${t.name} 本回合夺魁${t.id === p.id ? '（猜自己）' : ''}`);
}

/** 炸弹客：换牌阶段前宣告 0-2 中的一个数字 X，获得 X 血筹 */
export function bBomberClaim(gs: BloodState, playerId: string, x: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'bomberClaim' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待宣告的数字');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  if (!Number.isInteger(x) || x < 0 || x > 2) throw new BloodError('BAD_TARGET', '只能宣告 0-2');
  gs.bomberX = x;
  gs.secretPending = null;
  if (x > 0) {
    p.blood += x;
    pushLog(gs, 'action', `💣 ${p.name}【炸弹客】宣告 X=${x}：获得 ${x} 血筹（结算时将随机删牌）`);
  } else {
    pushLog(gs, 'action', `💣 ${p.name}【炸弹客】宣告 X=0：无事发生`);
  }
  checkSwapEnd(gs, now);
}

/** 高中生：对决前弃光出牌区（+2血筹）并执行一次删牌；两段共用此入口 */
export function bStudentDump(gs: BloodState, playerId: string, accept: boolean, cardId: string | undefined, now: number): void {
  const pend = gs.secretPending;
  if (!pend || pend.seat !== playerId) throw new BloodError('PENDING', '当前没有待处理的抉择');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (pend.kind === 'studentDump') {
    gs.secretPending = null;
    if (!accept) {
      pushLog(gs, 'action', `${p.name}【高中生】保留出牌区`);
      afterPlayHookResolved(gs, now);
      return;
    }
    const dumped = p.play.slice();
    p.discard.push(...dumped);
    p.play = [];
    p.blood += 2;
    pushLog(gs, 'action', `🎒 ${p.name}【高中生】弃光出牌区（${dumped.map(bloodCardText).join(' ')}）：获得 2 血筹，并可执行一次删牌`);
    if (p.discard.length > 0 && p.blood >= 2) {
      gs.secretPending = { seat: p.id, kind: 'studentRemove' };
      gs.deadline = now + BLOOD_TURN_MS;
    } else {
      afterPlayHookResolved(gs, now);
    }
    return;
  }
  if (pend.kind === 'studentRemove') {
    gs.secretPending = null;
    if (accept && cardId) {
      const card = p.discard.find((c) => c.id === cardId);
      if (!card) throw new BloodError('BAD_CARD', '目标牌不在你的弃牌区');
      p.blood -= 2;
      p.discard = p.discard.filter((c) => c.id !== cardId);
      p.removed.push(card);
      pushLog(gs, 'action', `${p.name}【高中生】执行删牌：删除 ${bloodCardText(card)}（支付 2 血筹）`);
      gainChefDeleteThrees(gs, p, [card]);
      checkLiuWin(gs, p, now);
    } else {
      pushLog(gs, 'action', `${p.name}【高中生】放弃删牌`);
    }
    afterPlayHookResolved(gs, now);
    return;
  }
  throw new BloodError('PENDING', '当前没有待处理的抉择');
}

/** 桌游设计师：出牌结束时弃出牌区 1 张得 2 血筹，或 2 张得 4 血筹 */
export function bDesignerDiscard(gs: BloodState, playerId: string, cardIds: string[], now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'designerDiscard' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待处理的弃置');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  if (cardIds.length > 2) throw new BloodError('TOO_MANY', '最多弃置 2 张');
  const set = new Set(cardIds);
  const cards = p.play.filter((c) => set.has(c.id));
  if (cards.length !== cardIds.length) throw new BloodError('BAD_CARD', '目标牌不在你的出牌区');
  p.play = p.play.filter((c) => !set.has(c.id));
  p.discard.push(...cards);
  const gain = cards.length * 2;
  p.blood += gain;
  gs.secretPending = null;
  pushLog(gs, 'action', `🎲 ${p.name}【桌游设计师】弃置出牌区 ${cards.length} 张：获得 ${gain} 血筹`);
  afterPlayHookResolved(gs, now);
}

/** 特工：出牌结束询问交换出牌区；结算时归还 */
export function bAgentAsk(gs: BloodState, playerId: string, seat: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'agentAsk' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待发起的询问');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  gs.secretPending = null;
  if (seat < 0) {
    pushLog(gs, 'action', `${p.name}【特工】放弃询问`);
    afterPlayHookResolved(gs, now);
    return;
  }
  const t = bySeat(gs, seat);
  if (!t || t.id === playerId) throw new BloodError('BAD_TARGET', '目标无效');
  gs.secretPending = { seat: t.id, kind: 'agentDecide', buyerId: p.id };
  gs.deadline = now + BLOOD_TURN_MS;
  pushLog(gs, 'action', `🤝 ${p.name}【特工】询问 ${t.name} 是否交换出牌区`);
}

export function bAgentDecide(gs: BloodState, playerId: string, accept: boolean, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'agentDecide' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待回应的询问');
  }
  const agent = gs.players.find((x) => x.id === pend.buyerId)!;
  const t = gs.players.find((x) => x.id === playerId)!;
  gs.secretPending = null;
  if (accept) {
    const aCards = agent.play.map((c) => c.id);
    const bCards = t.play.map((c) => c.id);
    const tmp = agent.play;
    agent.play = t.play;
    t.play = tmp;
    gs.agentSwap = { a: agent.id, b: t.id, aCards, bCards };
    pushLog(gs, 'action', `🤝 ${t.name} 接受交换：双方出牌区互换（结算结束时归还）`);
  } else {
    const pay = Math.min(2, Math.max(0, t.blood));
    t.blood -= pay;
    agent.blood += pay;
    pushLog(gs, 'action', `🤝 ${t.name} 拒绝交换：支付 ${pay} 血筹给 ${agent.name}【特工】`);
  }
  afterPlayHookResolved(gs, now);
}

/** 瞎掰王：对决前逐张宣告出牌区每张牌的点数与花色 */
export function bBlufferDeclare(
  gs: BloodState,
  playerId: string,
  declared: { id: string; r: number; s: Suit | null }[],
  now: number,
): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'blufferDeclare' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待宣告的出牌区');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  if (declared.length !== p.play.length) throw new BloodError('BAD_COUNT', '须对出牌区每张牌逐一宣告');
  const playIds = new Set(p.play.map((c) => c.id));
  for (const d of declared) {
    if (!playIds.has(d.id)) throw new BloodError('BAD_CARD', '宣告的牌不在你的出牌区');
    if (!Number.isInteger(d.r) || d.r < 2 || d.r > 14) throw new BloodError('BAD_TARGET', '宣告点数须为 2-14');
    if (d.s == null || !ALL_SUITS_FOR_DECLARE.includes(d.s)) throw new BloodError('BAD_TARGET', '宣告花色无效');
  }
  const declaredCards: BCard[] = declared.map((d) => ({ id: d.id, r: d.r, s: d.s }));
  gs.bluffer = { seat: p.id, declared: declaredCards, challenged: false, challengers: [] };
  gs.secretPending = null;
  const txt = declaredCards.map((c) => bloodCardText(c)).join(' ');
  pushLog(gs, 'action', `🗣️ ${p.name}【瞎掰王】宣告出牌区为：${txt}（等待质疑）`);
  // 从特权证持有者开始顺时针依次质疑（自己除外）
  const start = gs.privilegeSeat ?? gs.players[0].seat;
  const queue: string[] = [];
  for (let i = 0; i < gs.seatCount; i++) {
    const o = bySeat(gs, (start + i) % gs.seatCount);
    if (o && o.id !== p.id) queue.push(o.id);
  }
  if (queue.length > 0) {
    gs.secretPending = { seat: queue[0], kind: 'blufferChallenge', oppQueue: queue.slice(1), buyerId: p.id };
    gs.deadline = now + BLOOD_TURN_MS;
  } else {
    afterPlayHookResolved(gs, now);
  }
}

/** 瞎掰王宣告的质疑回应（顺时针依次） */
export function bBlufferChallenge(gs: BloodState, playerId: string, challenge: boolean, now: number): void {
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'blufferChallenge' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待回应的质疑');
  }
  const bluffer = gs.players.find((x) => x.id === pend.buyerId)!;
  const p = gs.players.find((x) => x.id === playerId)!;
  const bl = gs.bluffer!;
  if (challenge) bl.challengers.push(p.id);
  pushLog(gs, 'action', challenge ? `🗣️ ${p.name} 质疑【瞎掰王】的宣告` : `👀 ${p.name} 不质疑`);
  const next = pend.oppQueue?.shift();
  if (next) {
    gs.secretPending = { seat: next, kind: 'blufferChallenge', oppQueue: pend.oppQueue, buyerId: pend.buyerId };
    gs.deadline = now + BLOOD_TURN_MS;
    return;
  }
  gs.secretPending = null;
  if (bl.challengers.length > 0) {
    bl.challenged = true;
    // 核对出牌区与宣告是否完全一致
    const actual = bluffer.play.slice().sort((a, b) => a.id.localeCompare(b.id));
    const said = bl.declared.slice().sort((a, b) => a.id.localeCompare(b.id));
    const consistent =
      actual.length === said.length &&
      actual.every((c, i) => c.id === said[i].id && c.r === said[i].r && c.s === said[i].s);
    if (consistent) {
      for (const cid of bl.challengers) {
        const c = gs.players.find((x) => x.id === cid)!;
        const pay = Math.min(1, Math.max(0, c.blood));
        c.blood -= pay;
        bluffer.blood += pay;
      }
      pushLog(gs, 'action', `🗣️ 宣告与出牌区一致：质疑者各支付 1 血筹给 ${bluffer.name}【瞎掰王】`);
    } else {
      for (const cid of bl.challengers) {
        const c = gs.players.find((x) => x.id === cid)!;
        c.blood += 1;
      }
      pushLog(gs, 'action', `🗣️ 宣告与出牌区不一致：质疑者各获得 1 血筹（对决按实际牌进行）`);
    }
  } else {
    pushLog(gs, 'action', `🗣️ 无人质疑：按 ${bluffer.name} 的宣告进行对决（实际牌弃置）`);
  }
  afterPlayHookResolved(gs, now);
}

/** 魅魔：结算抢夺（夺魁抢男性3/未夺魁抢女性1） */
export function bSuccubusSteal(gs: BloodState, playerId: string, seat: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'succubusSteal' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待执行的抢夺');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const amount = pend.blood ?? 1;
  gs.secretPending = null;
  if (seat < 0) {
    p.blood += amount;
    pushLog(gs, 'action', `${p.name}【魅魔】放弃抢夺：直接获得 ${amount} 血筹`);
    processSettleQueue(gs, now);
    return;
  }
  const t = bySeat(gs, seat);
  if (!t || t.id === playerId) throw new BloodError('BAD_TARGET', '目标无效');
  const want: 'm' | 'f' = p === (gs.players.find((x) => x.privilege) ?? gs.players[0]) ? 'm' : 'f';
  if (!genderMatches(effChar(t), want)) throw new BloodError('BAD_TARGET', '目标性别不符');
  const pay = Math.min(amount, Math.max(0, t.blood));
  t.blood -= pay;
  p.blood += pay;
  pushLog(gs, 'action', `${p.name}【魅魔】抢夺 ${t.name}：获得 ${pay} 血筹`);
  processSettleQueue(gs, now);
}

/** 票贩子：结算未夺魁时付 3 血筹强购夺魁者 1 车票 */
export function bScalperDeal(gs: BloodState, playerId: string, accept: boolean, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'scalperDeal' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待处理的强购');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  gs.secretPending = null;
  const winner = gs.players.find((x) => x.privilege) ?? gs.players[0];
  if (!accept) {
    pushLog(gs, 'action', `${p.name}【票贩子】放弃强购`);
    processSettleQueue(gs, now);
    return;
  }
  if (p.blood < 3 || winner.tickets < 1) throw new BloodError('BAD_PHASE', '条件不满足');
  p.blood -= 3;
  winner.blood += 3;
  winner.tickets -= 1;
  p.tickets += 1;
  pushLog(gs, 'action', `🎫 ${p.name}【票贩子】支付 3 血筹向 ${winner.name} 强购 1 车票`);
  const dist = (x: BPlayer) => seatDist(gs, (gs.privilegeSeat ?? gs.players[0].seat), x.seat);
  if (p.tickets >= gs.target && effChar(p) !== 'liu') {
    finishByTickets(gs, [p], dist);
    return;
  }
  processSettleQueue(gs, now);
}

/** 炸鸡店老板：结算结束时花 1 血筹删除 1 张本回合打出的牌（每回合至多 3 张） */
export function bFryerDel(gs: BloodState, playerId: string, cardIds: string[], done: boolean, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'fryerDel' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待执行的删牌');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const playedIds = gs.result?.rows.find((r) => r.seat === p.seat)?.cards?.map((c) => c.id) ?? [];
  const budget = Math.min(3 - p.fryerDelCount, p.blood);
  if (cardIds.length > budget) throw new BloodError('TOO_MANY', `本次最多删除 ${budget} 张（每张 1 血筹，累计至多 3 张）`);
  const set = new Set(cardIds);
  const cards = p.discard.filter((c) => set.has(c.id) && playedIds.includes(c.id));
  if (cards.length !== cardIds.length) throw new BloodError('BAD_CARD', '目标牌不在本回合打出的牌中');
  p.blood -= cards.length;
  p.fryerDelCount += cards.length;
  p.discard = p.discard.filter((c) => !set.has(c.id));
  p.removed.push(...cards);
  gainChefDeleteThrees(gs, p, cards);
  if (cards.length > 0) {
    pushLog(gs, 'action', `🍗 ${p.name}【炸鸡店老板】支付 ${cards.length} 血筹删除本回合打出的牌：${cards.map(bloodCardText).join(' ')}`);
  }
  gs.secretPending = null;
  processSettleQueue(gs, now);
  void done;
}

/** 炸鸡店老板：换牌阶段花 1 血筹抽 1 张牌（无次数限制） */
export function bFryerDraw(gs: BloodState, playerId: string, now: number): void {
  void now;
  if (gs.phase !== 'swap') throw new BloodError('BAD_PHASE', '不在换牌阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (effChar(p) !== 'fryer') throw new BloodError('BAD_PHASE', '你不是炸鸡店老板');
  if (p.swapDone) throw new BloodError('ALREADY_DONE', '你已停止换牌');
  if (gs.secretPending && gs.secretPending.seat === p.id) throw new BloodError('PENDING', '先完成当前角色技能抉择');
  if (p.blood < 1) throw new BloodError('NO_BLOOD', '血筹不足（需 1）');
  p.blood -= 1;
  const drawn = drawN(gs, p, 1);
  p.hand.push(...drawn);
  pushLog(gs, 'action', `🍗 ${p.name}【炸鸡店老板】支付 1 血筹抽 1 张牌`);
}

/** 咒术师：换牌中随时将手中【5】藏入角色牌下（游戏外），抽1张牌并获得1血筹 */
export function bCurseHide(gs: BloodState, playerId: string, cardId: string, now: number): void {
  void now;
  if (gs.phase !== 'swap') throw new BloodError('BAD_PHASE', '不在换牌阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (effChar(p) !== 'curse') throw new BloodError('BAD_PHASE', '你不是咒术师');
  if (p.swapDone) throw new BloodError('ALREADY_DONE', '你已停止换牌');
  const card = p.hand.find((c) => c.id === cardId);
  if (!card) throw new BloodError('BAD_CARD', '手牌不存在');
  if (card.r !== 5 || card.s == null) throw new BloodError('BAD_CARD', '只能藏入【5】');
  p.hand = p.hand.filter((c) => c.id !== cardId);
  p.curseStash.push(card);
  const drawn = drawN(gs, p, 1);
  p.hand.push(...drawn);
  p.blood += 1;
  pushLog(gs, 'action', `✨ ${p.name}【咒术师】藏入 1 张【5】并抽 1 张牌：获得 1 血筹（共藏 ${p.curseStash.length} 张）`);
}

/** 咒术师：换牌结束时将角色牌下任意数量的5置入手中 */
export function bCurseTake(gs: BloodState, playerId: string, cardIds: string[], now: number): void {
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'curseTake' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待取回的藏牌');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const set = new Set(cardIds);
  const taken = p.curseStash.filter((c) => set.has(c.id));
  if (taken.length !== cardIds.length) throw new BloodError('BAD_CARD', '目标牌不在角色牌下');
  p.curseStash = p.curseStash.filter((c) => !set.has(c.id));
  p.hand.push(...taken);
  gs.secretPending = null;
  pushLog(gs, 'action', `✨ ${p.name}【咒术师】取回 ${taken.length} 张【5】入手牌`);
  checkSwapEnd(gs, now);
}

/** 入殓师：特殊换牌——至多3张手牌置于角色牌上，从弃牌区随机取回等量 */
export function bUndertakerSwap(gs: BloodState, playerId: string, cardIds: string[], now: number): void {
  if (gs.phase !== 'swap') throw new BloodError('BAD_PHASE', '不在换牌阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (effChar(p) !== 'undertaker') throw new BloodError('BAD_PHASE', '你不是入殓师');
  if (gs.secretPending && gs.secretPending.seat === p.id) throw new BloodError('PENDING', '先完成当前角色技能抉择');
  if (p.swapDone) throw new BloodError('ALREADY_DONE', '你已停止换牌');
  if (cardIds.length > 3) throw new BloodError('TOO_MANY', '特殊换牌至多置 3 张手牌');
  const set = new Set(cardIds);
  const cards = p.hand.filter((c) => set.has(c.id));
  if (cards.length !== cardIds.length) throw new BloodError('BAD_CARD', '手牌不存在');
  p.hand = p.hand.filter((c) => !set.has(c.id));
  p.undertakerStash.push(...cards);
  p.undertakerUsed = true;
  const n = Math.min(cards.length, p.discard.length);
  const shuffled = shuffle(p.discard);
  const taken = shuffled.slice(0, n);
  p.discard = shuffled.slice(n);
  p.hand.push(...taken);
  p.swapLeft -= 1;
  p.lastAction = '特殊换牌';
  pushLog(
    gs,
    'action',
    `⚰️ ${p.name}【入殓师】特殊换牌：置 ${cards.length} 张于角色牌上，从弃牌区随机取回 ${taken.map(bloodCardText).join(' ') || '（弃牌区为空）'}`,
  );
  if (p.swapLeft <= 0) {
    p.swapDone = true;
    markSwapStopped(gs, p);
    afterSwapEnded(gs, p, now);
  }
  checkSwapEnd(gs, now);
}

/** 赌神：换牌结束查看所有玩家手牌后，选择额外换牌一次或获得1血筹 */
export function bGodPeekChoice(gs: BloodState, playerId: string, mode: 'extra' | 'blood', now: number): void {
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'godPeek' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待选择的结果');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  gs.secretPending = null;
  if (mode === 'extra') {
    p.swapDone = false;
    p.swapLeft += 1;
    p.extraSwapProtected = true;
    p.lastAction = '额外换牌';
    pushLog(gs, 'action', `🎲 ${p.name}【赌神】看牌后选择：额外进行一次换牌`);
  } else {
    p.blood += 1;
    pushLog(gs, 'action', `🎲 ${p.name}【赌神】看牌后选择：获得 1 血筹`);
  }
  checkSwapEnd(gs, now);
}

/** 将军：换牌结束时指定玩家随机弃1摸1，或自己额外换牌一次 */
export function bGeneralChoice(
  gs: BloodState,
  playerId: string,
  mode: 'gift' | 'extra' | 'skip',
  seat: number | undefined,
  now: number,
): void {
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'generalChoice' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待选择的结果');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  gs.secretPending = null;
  if (mode === 'gift') {
    const t = bySeat(gs, seat ?? -1);
    if (!t || t.id === playerId) throw new BloodError('BAD_TARGET', '目标无效');
    if (t.hand.length > 0) {
      const idx = randomInt(0, t.hand.length);
      const [c] = t.hand.splice(idx, 1);
      t.discard.push(c);
      pushLog(gs, 'action', `🎖️ ${p.name}【将军】令 ${t.name} 随机弃置 ${bloodCardText(c)}`);
    }
    const drawn = drawN(gs, t, 1);
    t.hand.push(...drawn);
    pushLog(gs, 'action', `🎖️ ${t.name} 摸 1 张牌`);
  } else if (mode === 'extra') {
    p.swapDone = false;
    p.swapLeft += 1;
    p.extraSwapProtected = true;
    p.lastAction = '额外换牌';
    pushLog(gs, 'action', `🎖️ ${p.name}【将军】选择额外进行一次换牌`);
  } else {
    pushLog(gs, 'action', `🎖️ ${p.name}【将军】放弃发动`);
  }
  checkSwapEnd(gs, now);
}

/** 无业游民：换牌结束从一名对手的抽牌堆顶抽总计2张加入手牌 */
export function bVagrantDraw(gs: BloodState, playerId: string, seat: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'vagrantDraw' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待执行的抽牌');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  gs.secretPending = null;
  if (seat < 0) {
    pushLog(gs, 'action', `🚉 ${p.name}【无业游民】放弃抽取`);
    checkSwapEnd(gs, now);
    return;
  }
  const t = bySeat(gs, seat);
  if (!t || t.id === playerId || t.draw.length < 2) throw new BloodError('BAD_TARGET', '目标抽牌堆不足2张');
  const taken = t.draw.splice(-2, 2);
  p.hand.push(...taken);
  pushLog(gs, 'action', `🚉 ${p.name}【无业游民】从 ${t.name} 的抽牌堆抽取：${taken.map(bloodCardText).join(' ')}`);
  checkSwapEnd(gs, now);
}

/** 赌狗：删牌阶段选择一位玩家掷骰，删其抽牌堆顶 X-1 张 */
export function bDogTarget(gs: BloodState, playerId: string, seat: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'dogTarget' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待执行的掷骰');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  gs.secretPending = null;
  p.dogUsed = true;
  if (seat < 0) {
    pushLog(gs, 'action', `🐕 ${p.name}【赌狗】放弃发动`);
    return;
  }
  const t = bySeat(gs, seat);
  if (!t) throw new BloodError('BAD_TARGET', '目标无效');
  const roll = randomInt(1, 7);
  const n = Math.max(0, roll - 1);
  const take = t.draw.splice(-Math.min(n, t.draw.length));
  t.removed.push(...take);
  pushLog(
    gs,
    'action',
    `🐕 ${p.name}【赌狗】指定 ${t.name} 掷出 ${roll} 点：删除其抽牌堆顶 ${take.length} 张（${take.map(bloodCardText).join(' ') || '无牌可删'}）`,
  );
}

/** 走私客：购买阶段前标记黑市 1 张（自己买-2；他人买须先交2血筹） */
export function bSmugglerMark(gs: BloodState, playerId: string, slot: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'smugglerMark' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待标记的黑市牌');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  gs.secretPending = null;
  if (slot < 0) {
    pushLog(gs, 'action', `🚚 ${p.name}【走私客】本回合不标记`);
    processPreBuyQueue(gs, now);
    return;
  }
  const ms = gs.market[slot];
  if (!ms || ms.def == null) throw new BloodError('BAD_SLOT', '该栏位没有黑市牌');
  gs.smugglerMark = { slot, by: p.id };
  const def = BLOOD_MARKET_BY_ID.get(ms.def)!;
  pushLog(gs, 'action', `🚚 ${p.name}【走私客】标记【${def.name}】：自己购买 -2 血筹，他人购买须先支付 2 血筹`);
  processPreBuyQueue(gs, now);
}

/** 海盗：购买阶段前抢劫一位对手 */
export function bPirateRob(gs: BloodState, playerId: string, seat: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'pirateRob' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待发起的抢劫');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  gs.secretPending = null;
  if (seat < 0) {
    pushLog(gs, 'action', `🏴‍☠️ ${p.name}【海盗】放弃抢劫`);
    processPreBuyQueue(gs, now);
    return;
  }
  const t = bySeat(gs, seat);
  if (!t || t.id === playerId) throw new BloodError('BAD_TARGET', '目标无效');
  gs.secretPending = { seat: t.id, kind: 'pirateDecide', buyerId: p.id };
  gs.deadline = now + BLOOD_TURN_MS;
  pushLog(gs, 'action', `🏴‍☠️ ${p.name}【海盗】抢劫 ${t.name}：其须选择【放弃】或【抵抗】`);
}

export function bPirateDecide(gs: BloodState, playerId: string, resist: boolean, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'pirateDecide' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待回应的抢劫');
  }
  const pirate = gs.players.find((x) => x.id === pend.buyerId)!;
  const t = gs.players.find((x) => x.id === playerId)!;
  gs.secretPending = null;
  if (!resist) {
    const pay = Math.min(2, Math.max(0, t.blood));
    t.blood -= pay;
    pirate.blood += pay;
    pushLog(gs, 'action', `🏴‍☠️ ${t.name} 选择【放弃】：交给 ${pirate.name}【海盗】 ${pay} 血筹`);
  } else {
    const pRoll = randomInt(1, 7);
    const tRoll = randomInt(1, 7);
    if (pRoll > tRoll) {
      const gain = Math.min(4, Math.max(0, t.blood));
      t.blood -= gain;
      pirate.blood += gain;
      pushLog(gs, 'action', `🏴‍☠️ ${t.name} 选择【抵抗】：${pirate.name} 掷出 ${pRoll}，${t.name} 掷出 ${tRoll}，${pirate.name}【海盗】抢夺 ${gain} 血筹`);
    } else {
      pushLog(gs, 'action', `🏴‍☠️ ${t.name} 选择【抵抗】：${pirate.name} 掷出 ${pRoll}，${t.name} 掷出 ${tRoll}，抢劫失败`);
    }
  }
  processPreBuyQueue(gs, now);
}

/** 瞎掰帝：查看黑市牌堆顶 2 张并暗置其中 1 张，随后从自己开始顺时针一轮叫价 */
export function bAuctionPick(gs: BloodState, playerId: string, idx: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'auctionPick' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待暗置的拍卖牌');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  gs.secretPending = null;
  if (idx < 0) {
    pushLog(gs, 'action', `🔨 ${p.name}【瞎掰帝】不发动拍卖`);
    processPreBuyQueue(gs, now);
    return;
  }
  const options = pend.options ?? [];
  if (idx !== 0 && idx !== 1) throw new BloodError('BAD_TARGET', '选择无效');
  // 两张均从牌堆顶移出：选中的暗置拍卖，另一张放回牌堆顶（supply 末端为堆顶）
  gs.supply.pop();
  gs.supply.pop();
  const chosen = options[idx];
  const other = options[1 - idx];
  if (other) gs.supply.push(other);
  const bidQueue = seatOrderFrom(gs, p.seat);
  const firstBidder = bidQueue.shift()!;
  gs.auction = { defId: chosen, highest: 0, highestBy: null, queue: bidQueue, by: p.id };
  gs.secretPending = { seat: firstBidder, kind: 'auctionBid', amount: 0 };
  gs.deadline = now + BLOOD_TURN_MS;
  pushLog(gs, 'action', `🔨 ${p.name}【瞎掰帝】暗置一张牌开始叫价（玩家不可查看），从其开始顺时针一轮`);
}

function seatOrderFrom(gs: BloodState, startSeat: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < gs.seatCount; i++) {
    const p = bySeat(gs, (startSeat + i) % gs.seatCount);
    if (p) out.push(p.id);
  }
  return out;
}

/** 瞎掰帝拍卖叫价（每人一轮，0 = 不叫价；须高于当前最高价） */
export function bAuctionBid(gs: BloodState, playerId: string, amount: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'auctionBid' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待叫价的拍卖');
  }
  if (!gs.auction) throw new BloodError('BAD_PHASE', '拍卖不存在');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (!Number.isInteger(amount) || amount < 0 || amount > p.blood) {
    throw new BloodError('BAD_TARGET', `叫价须为 0-${p.blood}（不可超过持有血筹）`);
  }
  if (amount > 0 && amount <= gs.auction.highest) {
    throw new BloodError('BAD_TARGET', `叫价须高于当前最高价 ${gs.auction.highest}`);
  }
  if (amount > 0) {
    gs.auction.highest = amount;
    gs.auction.highestBy = p.id;
    pushLog(gs, 'action', `🔨 ${p.name} 叫价 ${amount} 血筹`);
  } else {
    pushLog(gs, 'action', `🔨 ${p.name} 不叫价`);
  }
  const next = gs.auction.queue.shift();
  if (next) {
    gs.secretPending = { seat: next, kind: 'auctionBid', amount: gs.auction.highest };
    gs.deadline = now + BLOOD_TURN_MS;
    return;
  }
  // 一轮结束：结算
  gs.secretPending = null;
  const winnerId = gs.auction.highestBy;
  const auctioneer = gs.players.find((x) => x.id === gs.auction!.by) ?? p;
  if (winnerId) {
    const w = gs.players.find((x) => x.id === winnerId)!;
    w.blood -= gs.auction.highest;
    pushLog(gs, 'action', `🔨 ${w.name} 以 ${gs.auction.highest} 血筹竞得暗置的牌（于其购买回合发放）`);
    if (w.id !== auctioneer.id) {
      auctioneer.blood += 2;
      pushLog(gs, 'action', `🔨 ${auctioneer.name}【瞎掰帝】得牌者非自己：获得 2 血筹`);
    }
  } else {
    gs.supply.unshift(gs.auction.defId); // 流拍：放回牌堆底
    pushLog(gs, 'action', '🔨 无人叫价：流拍，暗置的牌放回黑市牌堆');
    gs.auction = null;
  }
  processPreBuyQueue(gs, now);
}

/** 窥天师：购买阶段购买一张「天意」（价格-2） */
export function bBuySeer(gs: BloodState, playerId: string, idx: number, now: number): void {
  void now;
  if (gs.phase !== 'buy') throw new BloodError('BAD_PHASE', '不在购买阶段');
  const p = gs.players.find((x) => x.id === playerId)!;
  if (effChar(p) !== 'seer') throw new BloodError('BAD_PHASE', '你不是窥天师');
  if (gs.turnSeat !== p.seat || p.buyPassed) throw new BloodError('NOT_YOUR_TURN', '还没轮到你购买');
  if (idx < 0 || idx >= gs.seerZone.length) throw new BloodError('BAD_SLOT', '天意不存在');
  const defId = gs.seerZone[idx];
  const def = BLOOD_MARKET_BY_ID.get(defId);
  if (!def) throw new BloodError('BAD_SLOT', '天意数据异常');
  const cost = Math.max(0, def.cost - 2);
  if (p.blood < cost) throw new BloodError('NO_BLOOD', `血筹不足（需 ${cost}）`);
  p.blood -= cost;
  gs.seerZone.splice(idx, 1);
  p.boughtAny = true;
  gs.announce = { defId, buyerSeat: p.seat, at: Date.now() };
  pushLog(gs, 'action', `🔮 ${p.name}【窥天师】以 ${cost} 血筹购入天意【${def.name}】`);
  if (gs.seerZone.length === 0) {
    p.tickets = 0;
    pushLog(gs, 'action', `🌀 天意均被购入：${p.name} 被天意侵蚀，车票归 0！`);
  }
  processMarketDef(gs, p, def, false);
}

/** 捣蛋鬼：从指定对手的抽牌堆抽 1 张牌入手牌 */
export function bImpDraw(gs: BloodState, playerId: string, seat: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'impDraw' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待执行的抽牌');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const t = bySeat(gs, seat);
  if (!t || t.id === playerId || t.draw.length === 0) throw new BloodError('BAD_TARGET', '抽牌来源无效');
  const c = t.draw.pop()!;
  p.hand.push(c);
  pushLog(gs, 'action', `🃏 ${p.name}【捣蛋鬼】从 ${t.name} 的抽牌堆抽走 ${bloodCardText(c)}`);
  const cap = charHandCap('imp');
  if (p.hand.length < cap && gs.players.some((o) => o.id !== p.id && o.draw.length > 0)) {
    gs.deadline = now + BLOOD_TURN_MS;
    return; // 继续选择来源
  }
  gs.secretPending = null;
  checkSwapEnd(gs, now); // 抽满/无来源：若全员已停止换牌则推进收尾
}

/** 捣蛋鬼购买阶段前：对手支付 1 血筹赎回属于自己的所有牌 */
export function bImpRedeem(gs: BloodState, playerId: string, accept: boolean, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'impRedeem' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待处理的赎回');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const imp = gs.players.find((x) => x.id === pend.targetSeat)!;
  gs.secretPending = null;
  if (!accept) {
    pushLog(gs, 'action', `${p.name} 不赎回自己的牌`);
    processPreBuyQueue(gs, now);
    return;
  }
  if (p.blood < 1) throw new BloodError('NO_BLOOD', '血筹不足（需 1）');
  p.blood -= 1;
  imp.blood += 1;
  const ownerSeat = p.seat;
  const isMine = (c: BCard) => cardOwnerSeat(c.id) === ownerSeat;
  const reclaimed: BCard[] = [];
  imp.draw = imp.draw.filter((c) => {
    if (isMine(c)) {
      reclaimed.push(c);
      return false;
    }
    return true;
  });
  imp.discard = imp.discard.filter((c) => {
    if (isMine(c)) {
      reclaimed.push(c);
      return false;
    }
    return true;
  });
  imp.hand = imp.hand.filter((c) => {
    if (isMine(c)) {
      reclaimed.push(c);
      return false;
    }
    return true;
  });
  p.discard.push(...reclaimed);
  pushLog(gs, 'action', `💰 ${p.name} 支付 1 血筹向 ${imp.name}【捣蛋鬼】赎回 ${reclaimed.length} 张自己的牌`);
  processPreBuyQueue(gs, now);
}

/** 清洁工：重整阶段结束从全牌库（所有玩家抽牌堆/弃牌区）自选 1 张删除 */
export function bCleanerDel(gs: BloodState, playerId: string, seat: number, cardId: string, now: number): void {
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'cleanerDel' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待执行的删牌');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const t = bySeat(gs, seat);
  if (!t) throw new BloodError('BAD_TARGET', '目标不存在');
  let card: BCard;
  let fromDraw = false;
  if (!cardId) {
    // 抽牌堆为暗置牌不可指定：随机删除其抽牌堆 1 张
    if (t.draw.length === 0) throw new BloodError('BAD_CARD', '其抽牌堆为空');
    card = t.draw[randomInt(0, t.draw.length)];
    fromDraw = true;
  } else {
    const inDraw = t.draw.find((c) => c.id === cardId);
    const inDiscard = t.discard.find((c) => c.id === cardId);
    const found = inDraw ?? inDiscard;
    if (!found) throw new BloodError('BAD_CARD', '目标牌不在该玩家的抽牌堆/弃牌区');
    card = found;
    fromDraw = inDraw != null;
  }
  if (fromDraw) {
    t.draw = t.draw.filter((c) => c.id !== card.id);
    t.draw = shuffle(t.draw); // 删除抽牌堆的牌后重洗抽牌堆
    onLibraryReshuffle(gs);
  } else {
    t.discard = t.discard.filter((c) => c.id !== card.id);
  }
  t.removed.push(card);
  gs.secretPending = null;
  pushLog(gs, 'action', `🧹 ${p.name}【清洁工】删除 ${t.name} ${fromDraw ? '抽牌堆' : '弃牌区'}中的 ${bloodCardText(card)}${fromDraw ? '（并重洗其抽牌堆）' : ''}`);
  const next = pend.oppQueue?.shift();
  if (next) {
    gs.secretPending = { seat: next, kind: 'cleanerDel', oppQueue: pend.oppQueue };
    gs.deadline = now + BLOOD_TURN_MS;
    return;
  }
  afterCleanerResolved(gs, now);
}

/** 霸道总裁：换牌结束依次选择玩家并给予血筹，对方须选择收下弃牌换牌或拒绝付双倍 */
export function bCeoGive(gs: BloodState, playerId: string, seat: number, amount: number, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'ceoGive' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待给予的血筹');
  }
  const p = gs.players.find((x) => x.id === playerId)!;
  const t = bySeat(gs, seat);
  if (!t || t.id === playerId) throw new BloodError('BAD_TARGET', '目标无效');
  if (!Number.isInteger(amount) || amount < 1 || amount > p.blood) {
    throw new BloodError('BAD_TARGET', `给予量须为 1-${p.blood}`);
  }
  p.blood -= amount;
  t.blood += amount;
  pushLog(gs, 'action', `💼 ${p.name}【霸道总裁】给予 ${t.name} ${amount} 血筹，等待其回应`);
  gs.secretPending = { seat: t.id, kind: 'ceoDecide', buyerId: p.id, given: amount };
  gs.deadline = now + BLOOD_TURN_MS;
}

export function bCeoDone(gs: BloodState, playerId: string, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'ceoGive' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待结束的给予');
  }
  gs.secretPending = null;
  pushLog(gs, 'action', `💼 霸道总裁结束给予`);
  checkSwapEnd(gs, now);
}

export function bCeoDecide(gs: BloodState, playerId: string, accept: boolean, now: number): void {
  void now;
  const pend = gs.secretPending;
  if (!pend || pend.kind !== 'ceoDecide' || pend.seat !== playerId) {
    throw new BloodError('PENDING', '当前没有待回应的给予');
  }
  const ceo = gs.players.find((x) => x.id === pend.buyerId)!;
  const t = gs.players.find((x) => x.id === playerId)!;
  const amount = pend.given ?? 0;
  if (accept) {
    const n = t.hand.length;
    t.discard.push(...t.hand);
    t.hand = [];
    const drawn = drawN(gs, t, n);
    t.hand.push(...drawn);
    pushLog(gs, 'action', `💼 ${t.name} 收下 ${amount} 血筹：弃置全部手牌并抽取 ${n} 张（“不愧是顾家。”）`);
  } else {
    const pay = Math.min(amount * 2, Math.max(0, t.blood));
    t.blood -= pay;
    ceo.blood += pay;
    pushLog(gs, 'action', `💼 ${t.name} 拒绝：支付 ${pay} 血筹给 ${ceo.name}（“你顾家算什么东西。”）`);
  }
  gs.secretPending = { seat: ceo.id, kind: 'ceoGive' };
  gs.deadline = now + BLOOD_TURN_MS;
}

export function bloodRematch(gs: BloodState, now: number, charExpansion = false, expansion = false): BloodState {
  return createBloodGame(
    gs.seatCount,
    gs.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat })),
    now,
    charExpansion,
    expansion,
  );
}
