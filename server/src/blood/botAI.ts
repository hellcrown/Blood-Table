/**
 * 血色牌局 · 机器人决策器（服务端内存 bot，不占用 WebSocket 连接）
 * - 决策同步执行：仅出牌阶段做蒙特卡洛推演（约 200ms 预算上限，用户可接受更长思考时间），其余阶段为启发式
 * - 只读 BloodState 与公开信息；Brain 为跨回合记忆（对手亮牌累计），局结束随房间销毁
 * - 决策异常由 rooms.runBots 捕获并回退到超时托管的安全默认，绝不软锁
 */
import { randomInt } from 'node:crypto';
import { BLOOD_MARKET_BY_ID, type BloodEffect } from '@shared/bloodCards';
import { applyCharEval, charSwapMax } from '@shared/bloodChars';
import { evalBloodHand, toEvalCard, type EvalCard, type Suit } from '@shared/bloodEval';
import { promptFor } from './view';
import * as blood from './engine';
import type { BCard, BPlayer, BloodState } from './types';

/* ---------------- 跨回合记忆 ---------------- */

/**
 * 长线构筑策略：围绕一个牌型目标统一换牌/购买/删牌。
 * - rank：凑同一主点数多条（如「凑很多 8」→ 四条/葫芦）
 * - flush：凑同一花色同花
 * - straight：凑一个 5 连窗口顺子
 * score 为可达牌型分（与牌型 cat 同量纲，含万能张/牌库密度加成），用于策略间比较。
 */
export type Strat =
  | { kind: 'rank'; rank: number; score: number }
  | { kind: 'flush'; suit: Suit; score: number }
  | { kind: 'straight'; lo: number; score: number };

export interface BotBrain {
  /** 对手座位 -> 对决亮牌累计（跨回合，牌 id） */
  seen: Map<number, Set<string>>;
  /** '点数:花色' -> 次数（跨回合聚合计数） */
  rankSuit: Map<string, number>;
  /** 记录点位（-1=结果行游标，其余为对手座位）-> 已记录到的回合 */
  lastRound: Map<number, number>;
  /** 对手座位 -> 本回合换牌张数（来自公开 lastAction） */
  swapped: Map<number, number>;
  /** 当前长线策略（构筑删牌/被对手删牌后活牌构成变化时自动切换） */
  strategy: Strat | null;
  /** 对手座位 -> 公开购入的黑市牌 defId（购买宣告滚动记录，至多 12 条） */
  oppBuys: Map<number, string[]>;
  /** 对手座位 -> 上次记录的购买宣告时间戳（防同一条宣告重复计数） */
  oppBuyAt: Map<number, number>;
}

export function createBrain(): BotBrain {
  return {
    seen: new Map(),
    rankSuit: new Map(),
    lastRound: new Map(),
    swapped: new Map(),
    strategy: null,
    oppBuys: new Map(),
    oppBuyAt: new Map(),
  };
}

/* ---------------- 策略推导与切换 ---------------- */

/** 活牌 = 还能抽到/打出的所有牌（抽牌堆+手牌+弃牌区+构筑区，不含删牌区） */
function aliveCards(p: BPlayer): BCard[] {
  return [...p.draw, ...p.hand, ...p.discard, ...p.setupHand];
}

/** 推导全部候选策略并按可达分降序返回（纯函数：随活牌构成自动适应局势变化） */
export function deriveStrategy(p: BPlayer): Strat[] {
  const alive = aliveCards(p);
  const jokers = alive.filter((c) => c.r === 0).length;
  const rankCount = new Map<number, number>();
  const suitCount = new Map<Suit, number>();
  const rankSet = new Set<number>();
  for (const c of alive) {
    if (c.r === 0) continue;
    rankCount.set(c.r, (rankCount.get(c.r) ?? 0) + 1);
    suitCount.set(c.s!, (suitCount.get(c.s!) ?? 0) + 1);
    rankSet.add(c.r);
  }
  const out: Strat[] = [];
  // 多条策略：取活牌数量最多的 4 个点数（4 张全活→四条，3 张→葫芦/三条，2 张→两对）
  const topRanks = [...rankCount.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, 4);
  for (const [r, n] of topRanks) {
    const nEff = Math.min(4, n + jokers);
    let tier: number;
    if (nEff >= 4) tier = 7.2;
    else if (nEff === 3) tier = rankSet.size >= 6 ? 4.8 : 4.2; // 有别的对子可配葫芦
    else if (nEff === 2) tier = 2.2;
    else tier = 0.9;
    out.push({ kind: 'rank', rank: r, score: tier + r / 100 });
  }
  // 同花策略：花色活牌 + 万能张 ≥5 张才成花，牌库越集中（可删的杂牌越多）分越高
  for (const s of ['s', 'h', 'd', 'c'] as Suit[]) {
    const nEff = (suitCount.get(s) ?? 0) + jokers;
    if (nEff >= 5) {
      out.push({
        kind: 'flush',
        suit: s,
        score: 5.1 + Math.min(nEff - 5, 8) * 0.12 + (nEff / Math.max(1, alive.length)) * 1.2,
      });
    }
  }
  // 顺子策略：最长 5 连窗口（万能张补缺），普遍弱于四条/同花，仅在别无更佳时选
  let bestWin: { lo: number; effLen: number } | null = null;
  for (let lo = 2; lo <= 10; lo++) {
    let holes = 0;
    for (let r = lo; r < lo + 5; r++) if (!rankSet.has(r)) holes++;
    const effLen = 5 - holes + Math.min(jokers, holes);
    if (!bestWin || effLen > bestWin.effLen || (effLen === bestWin.effLen && lo > bestWin.lo)) {
      bestWin = { lo, effLen };
    }
  }
  if (bestWin && bestWin.effLen >= 5) {
    out.push({ kind: 'straight', lo: bestWin.lo, score: 4.2 + (bestWin.effLen - 5) * 0.05 });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 当前策略：每回合按活牌构成重推，原策略仍接近最优则保持（防抖动），明显更优才切换 */
export function curStrategy(brain: BotBrain, p: BPlayer): Strat {
  const ranked = deriveStrategy(p);
  if (ranked.length === 0) return { kind: 'rank', rank: 14, score: 0 };
  const best = ranked[0];
  const cur = brain.strategy;
  if (cur) {
    const same = ranked.find(
      (s) =>
        (cur.kind === 'rank' && s.kind === 'rank' && s.rank === cur.rank) ||
        (cur.kind === 'flush' && s.kind === 'flush' && s.suit === cur.suit) ||
        (cur.kind === 'straight' && s.kind === 'straight'),
    );
    if (same && best.score - same.score <= 0.35) return cur;
  }
  brain.strategy = best;
  return best;
}

/* ---------------- 对手策略猜测 ---------------- */

export interface OppGuess {
  /** 被猜测对手的座位号 */
  seat: number;
  strat: Strat;
  /** 置信度 0-1：亮牌直方图 + 公开购买方向共同决定 */
  conf: number;
}

const SUIT_CHIP_IDS = new Set(['redChip', 'blackChip', 'inkSuit', 'morph']);
const RANK_CHIP_IDS = new Set(['limiter1', 'limiter2', 'limiter3', 'limiter4', 'calib1', 'calib2', 'calib3', 'calib4', 'slider']);

/** 猜测一名对手的长线策略：对决亮牌直方图（他反复亮什么就是在凑什么）+ 公开购买方向 */
export function guessOppStrategy(brain: BotBrain, opp: BPlayer): OppGuess | null {
  const deck = seatDeck(opp.seat);
  const seen = brain.seen.get(opp.seat);
  const buys = brain.oppBuys.get(opp.seat) ?? [];
  if ((!seen || seen.size === 0) && buys.length === 0) return null;
  const suitCount = new Map<Suit, number>();
  const rankCount = new Map<number, number>();
  for (const id of seen ?? []) {
    const c = deck.find((x) => x.id === id);
    if (!c || c.r === 0 || c.s == null) continue;
    suitCount.set(c.s, (suitCount.get(c.s) ?? 0) + 1);
    rankCount.set(c.r, (rankCount.get(c.r) ?? 0) + 1);
  }
  const cands: Omit<OppGuess, 'seat'>[] = [];
  for (const [s, n] of suitCount) {
    if (n >= 3) cands.push({ strat: { kind: 'flush', suit: s, score: 0 }, conf: Math.min(0.9, 0.45 + n * 0.09) });
  }
  for (const [r, n] of rankCount) {
    if (n >= 2) cands.push({ strat: { kind: 'rank', rank: r, score: 0 }, conf: Math.min(0.9, 0.4 + n * 0.14) });
  }
  cands.sort((a, b) => b.conf - a.conf);
  if (cands.length === 0) return null;
  const best: OppGuess = { ...cands[0], seat: opp.seat };
  // 购买方向佐证：花色芯片→同花，点数芯片→多条（聚焦点数未知，加成给已有候选）
  const suitChipN = buys.filter((d) => SUIT_CHIP_IDS.has(d)).length;
  const rankChipN = buys.filter((d) => RANK_CHIP_IDS.has(d)).length;
  if (best.strat.kind === 'flush') best.conf = Math.min(0.95, best.conf + suitChipN * 0.12);
  if (best.strat.kind === 'rank') best.conf = Math.min(0.95, best.conf + rankChipN * 0.1);
  return best;
}

/** 全场最危险的对手猜测（置信度最高且达到阈值才返回） */
export function strongestThreat(brain: BotBrain, gs: BloodState, p: BPlayer, minConf = 0.6): OppGuess | null {
  let best: OppGuess | null = null;
  for (const o of opponentsOf(gs, p)) {
    const g = guessOppStrategy(brain, o);
    if (g && g.conf >= minConf && (!best || g.conf > best.conf)) best = g;
  }
  return best;
}

/** 由猜测策略反推其最可能摆出的牌型（魔术橡皮宣告 / 赌徒虹膜竞猜用） */
function guessedCat(g: OppGuess): number {
  if (g.strat.kind === 'flush') return 5; // 同花
  if (g.strat.kind === 'straight') return 4; // 顺子
  // 多条：亮牌里该点数已出现 ≥3 次说明成型度高，押四条；否则押葫芦
  const strat = g.strat;
  return strat.kind === 'rank' && g.conf >= 0.75 ? 7 : 6;
}

/** 随对局推进增量更新记忆（对决亮牌、公开的换牌张数） */
export function updateBrains(brains: Map<string, BotBrain>, botIds: string[], gs: BloodState): void {
  for (const id of botIds) {
    const brain = brains.get(id);
    if (!brain) continue;
    // 对决亮牌累计（result 在 settle→buy 期间存在，按回合去重）
    if (gs.result && gs.round > (brain.lastRound.get(-1) ?? -1)) {
      for (const row of gs.result.rows) {
        if ((brain.lastRound.get(row.seat) ?? -1) >= gs.round) continue;
        if (!brain.seen.has(row.seat)) brain.seen.set(row.seat, new Set());
        const set = brain.seen.get(row.seat)!;
        for (const c of row.cards ?? []) {
          if (c.s == null) continue;
          set.add(c.id);
          const key = `${c.r}:${c.s}`;
          brain.rankSuit.set(key, (brain.rankSuit.get(key) ?? 0) + 1);
        }
        brain.lastRound.set(row.seat, gs.round);
      }
      brain.lastRound.set(-1, gs.round);
    }
    // 公开的换牌张数（'换牌 N张' 只在换牌阶段存在，标记回合防过期使用）
    for (const p of gs.players) {
      if (p.id === id) continue;
      const m = /换牌 (\d+)张/.exec(p.lastAction ?? '');
      if (m) brain.swapped.set(p.seat, Number(m[1]));
    }
    // 对手的公开购买宣告（购买强化芯片/道具的方向暴露其构筑策略）
    if (gs.announce) {
      const buyer = gs.players.find((x) => x.seat === gs.announce!.buyerSeat);
      if (buyer && buyer.id !== id && gs.announce.at !== (brain.oppBuyAt.get(buyer.seat) ?? -1)) {
        brain.oppBuyAt.set(buyer.seat, gs.announce.at);
        const list = brain.oppBuys.get(buyer.seat) ?? [];
        list.push(gs.announce.defId);
        brain.oppBuys.set(buyer.seat, list.slice(-12));
      }
    }
  }
}

/* ---------------- 评估工具 ---------------- */

const SUITS = ['s', 'h', 'd', 'c'] as const;

/** 按发牌顺序重建某座位的整副 54 张（与 newPlayerDeck 一致，仅用于推演采样） */
function seatDeck(seat: number): BCard[] {
  const out: BCard[] = [];
  let n = 0;
  for (const s of SUITS) {
    for (let r = 2; r <= 14; r++) out.push({ id: `c${seat}-${n++}`, r, s });
  }
  out.push({ id: `c${seat}-${n++}`, r: 0, s: null });
  out.push({ id: `c${seat}-${n++}`, r: 0, s: null });
  return out;
}

/** 评估某玩家打出一组牌的牌型（临时改写出牌区，同步恢复） */
function evalPlay(gs: BloodState, p: BPlayer, cards: BCard[]): { cat: number; pips: number } {
  const backup = p.play;
  p.play = cards;
  try {
    const ev = blood.evalForPlayer(p, gs);
    return { cat: ev.cat, pips: ev.pips };
  } finally {
    p.play = backup;
  }
}

function beats(a: { cat: number; pips: number }, b: { cat: number; pips: number }): boolean {
  return a.cat > b.cat || (a.cat === b.cat && a.pips > b.pips);
}

/** 枚举牌池中选出最优 keep 张（默认手牌；构筑阶段传 setupHand）；策略进度加成用于在同等牌型间偏向长线目标 */
function bestKeep(gs: BloodState, p: BPlayer, keep: number, strat?: Strat, src: BCard[] = p.hand, deadline = 0): BCard[] {
  const n = Math.min(keep, src.length);
  const combos = combinations(src, n);
  let best: BCard[] = src.slice(0, n);
  let bestVal = -Infinity;
  for (const c of combos) {
    if (deadline && Date.now() > deadline) break; // 预算耗尽：返回当前最优（时间压力下降级）
    const ev = evalPlay(gs, p, c);
    // 牌型一级权重 12，策略加成上限约 3.6，不会越级压过真实牌型
    const val = ev.cat * 12 + ev.pips * 0.01 + (strat ? stratBonus(c, strat) : 0);
    if (val > bestVal) {
      bestVal = val;
      best = c;
    }
  }
  return best;
}

/** 策略进度加成：组合中贡献策略目标的牌越多分越高（JOKER 计入任意目标） */
function stratBonus(cards: BCard[], strat: Strat): number {
  const isWild = (c: BCard): boolean => c.r === 0;
  switch (strat.kind) {
    case 'rank': {
      const n = cards.filter((c) => c.r === strat.rank || isWild(c)).length;
      return n >= 2 ? (n - 1) * 1.2 : n * 0.3;
    }
    case 'flush': {
      const n = cards.filter((c) => c.s === strat.suit || isWild(c)).length;
      return n >= 3 ? n * 0.7 : n * 0.25;
    }
    case 'straight': {
      const n = cards.filter((c) => (c.r >= strat.lo && c.r < strat.lo + 5) || isWild(c)).length;
      return n * 0.4;
    }
  }
}

function combinations<T>(arr: T[], k: number): T[][] {
  const res: T[][] = [];
  const cur: T[] = [];
  const walk = (start: number): void => {
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

/* ---------------- 蒙特卡洛推演（仅出牌阶段） ---------------- */

const MC_SAMPLES = 64;
const MC_DEADLINE_MS = 200; // 出牌决策推演预算（毫秒）；预算耗尽按当前最优降级返回

/** 按公开信号采样对手手牌：换牌多→偏弱，没换→偏强 */
function sampleOppHand(brain: BotBrain, opp: BPlayer): BCard[] {
  const pool = seatDeck(opp.seat).filter((c) => !opp.play.some((pc) => pc.id === c.id));
  const hand: BCard[] = [];
  for (let i = 0; i < 5 && pool.length > 0; i++) {
    hand.push(...pool.splice(randomInt(0, pool.length), 1));
  }
  const swapped = brain.swapped.get(opp.seat);
  if (hand.length === 5 && swapped != null) {
    hand.sort((a, b) => b.r - a.r);
    if (swapped >= 2) {
      const low = pool.filter((c) => c.r >= 2 && c.r <= 9);
      if (low.length > 0) hand[0] = low[randomInt(0, low.length)];
    } else if (swapped === 0) {
      hand.sort((a, b) => a.r - b.r);
      const high = pool.filter((c) => c.r >= 10 || c.r === 0);
      if (high.length > 0) hand[0] = high[randomInt(0, high.length)];
    }
  }
  return hand;
}

/** 推演胜率：我的候选牌对全部已锁定对手的采样胜率（deadline 为整次决策共享的时间预算） */
function monteCarloWinProb(
  gs: BloodState,
  brain: BotBrain,
  me: BPlayer,
  cards: BCard[],
  samples = MC_SAMPLES,
  deadline = 0,
): number {
  if (deadline && Date.now() > deadline) return 0.35; // 预算耗尽：返回偏保守的中性估计
  const start = Date.now();
  const opps = gs.players.filter((o) => o.id !== me.id && o.locked);
  if (opps.length === 0) return 1;
  const mine = evalPlay(gs, me, cards);
  let score = 0;
  for (let s = 0; s < samples; s++) {
    if (deadline ? Date.now() > deadline : (s & 7) === 7 && Date.now() - start > MC_DEADLINE_MS) break;
    let beatAll = true;
    let ties = 0;
    for (const o of opps) {
      const ev = evalPlay(gs, o, sampleOppHand(brain, o));
      if (beats(ev, mine)) {
        beatAll = false;
        break;
      }
      if (ev.cat === mine.cat && ev.pips === mine.pips) ties++;
    }
    if (beatAll) score += ties > 0 ? 0.5 : 1;
  }
  return score / samples;
}

/** 角色血筹收益修正（矿工全黑/画家花色/编剧 50 点/大厨 3） */
function charBonus(p: BPlayer, cards: BCard[], ev: { pips: number }): number {
  const ch = blood.effChar(p);
  let b = 0;
  if (ch === 'miner' && cards.every((c) => c.s === 's' || c.s === 'c')) b += 0.3;
  if (ch === 'painter') {
    const suits = new Set(cards.filter((c) => c.s != null).map((c) => c.s));
    b += Math.min(4, suits.size) * 0.05;
  }
  if (ch === 'screenwriter' && ev.pips === 50) b += 0.5;
  if (ch === 'chef') b += cards.filter((c) => c.r === 3).length * 0.08;
  if (ch === 'princess' && p.princessDark === false) {
    b += cards.every((c) => c.s === 'h' || c.s === 'd') ? 0.4 : 0;
  }
  return b;
}

/* ---------------- 决策辅助 ---------------- */

function opponentsOf(gs: BloodState, p: BPlayer): BPlayer[] {
  return gs.players.filter((o) => o.id !== p.id);
}

function richestOpp(gs: BloodState, p: BPlayer): BPlayer | null {
  return opponentsOf(gs, p).sort((a, b) => b.blood - a.blood)[0] ?? null;
}

function mostTicketsOpp(gs: BloodState, p: BPlayer): BPlayer | null {
  return opponentsOf(gs, p).sort((a, b) => b.tickets - a.tickets)[0] ?? null;
}

function bySeatOf(gs: BloodState, seat: number): BPlayer | null {
  return gs.players.find((x) => x.seat === seat) ?? null;
}

/** 自己弃牌区中最该删除的牌：孤立低点数优先，且永不删除策略目标牌（保留成对/高牌） */
export function worstDiscardCards(p: BPlayer, n: number, strat?: Strat): string[] {
  const rankFreq = new Map<number, number>();
  for (const c of p.discard) rankFreq.set(c.r, (rankFreq.get(c.r) ?? 0) + 1);
  const scored = p.discard
    .map((c) => {
      let score = (rankFreq.get(c.r) ?? 1) * 20 + c.r;
      if (strat) score += stratKeepWeight(c, strat); // 策略牌 150-500 分，远高于普通牌最高 94
      return { c, score };
    })
    .sort((a, b) => a.score - b.score);
  return scored.slice(0, Math.max(0, n)).map((x) => x.c.id);
}

/** 策略相关牌的保留权重：目标牌绝不被删，窗口内顺子牌次之 */
function stratKeepWeight(c: BCard, strat: Strat): number {
  const wild = c.r === 0;
  switch (strat.kind) {
    case 'rank':
      return c.r === strat.rank || wild ? 500 : 0;
    case 'flush':
      return wild ? 500 : c.s === strat.suit ? 300 : 0;
    case 'straight':
      return (c.r >= strat.lo && c.r < strat.lo + 5) || wild ? 150 : 0;
  }
}

/** 芯片可插入的弃牌区目标（无芯片、点数合法、非 JOKER 限制）；有策略时优先服务策略目标 */
function insertableTarget(gs: BloodState, p: BPlayer, defId: string, strat?: Strat): BCard | null {
  const def = BLOOD_MARKET_BY_ID.get(defId);
  if (!def) return null;
  const candidates = p.discard.filter((c) => {
    if (p.chips.some((ch) => ch.on === c.id)) return false;
    if (def.noJoker && c.s == null) return false;
    if (def.effect.k === 'rankMod') {
      const v = c.r + def.effect.mod;
      if (v < 2 || v > 14) return false;
    }
    return true;
  });
  if (candidates.length === 0) return null;
  if (strat) {
    const preferred = candidates.filter((c) => chipServesStrat(c, def.effect, strat));
    if (preferred.length > 0) return pickChipHost(preferred);
  }
  const best5 = new Set(bestKeep(gs, p, 5, strat).map((c) => c.id));
  return pickChipHost(candidates, best5);
}

/** 策略偏好目标：点数芯片转化为目标点数，花色芯片转成目标花色 */
function chipServesStrat(c: BCard, eff: BloodEffect, strat: Strat): boolean {
  switch (strat.kind) {
    case 'rank':
      return eff.k === 'rankMod' ? c.r + eff.mod === strat.rank : (eff.k === 'rankWild' || eff.k === 'wild') && c.r !== strat.rank;
    case 'flush':
      // 红芯片（♦/♥）：宿主为非目标花色的牌才值得插，使其可视为目标花色
      if (eff.k === 'suit') return eff.suits.includes(strat.suit) && c.s !== strat.suit;
      if (eff.k === 'suitWild' || eff.k === 'wild') return c.s !== strat.suit;
      return false;
    case 'straight':
      return (eff.k === 'rankWild' || eff.k === 'wild') && !(c.r >= strat.lo && c.r < strat.lo + 5);
  }
}

function pickChipHost(cands: BCard[], best5?: Set<string>): BCard {
  return cands.sort(
    (a, b) =>
      Number(best5?.has(b.id) ?? false) - Number(best5?.has(a.id) ?? false) || b.r - a.r,
  )[0];
}

/** 芯片对当前策略的额外价值（叠在基础分上，决定买不买） */
function chipStratBonus(p: BPlayer, eff: BloodEffect, strat: Strat): number {
  const alive = aliveCards(p);
  switch (strat.kind) {
    case 'rank': {
      if (eff.k === 'rankMod') {
        const need = strat.rank - eff.mod;
        const n = alive.filter((c) => c.r === need).length;
        return n > 0 ? 0.5 + Math.min(3, n) * 0.35 : 0;
      }
      if (eff.k === 'rankWild' || eff.k === 'wild') return 0.7;
      return 0;
    }
    case 'flush': {
      if (eff.k === 'suit') return eff.suits.includes(strat.suit) ? 1.2 : 0;
      if (eff.k === 'suitWild') return 1.2;
      if (eff.k === 'wild') return 1.0;
      return 0;
    }
    case 'straight': {
      if (eff.k === 'rankWild') return 1.2;
      if (eff.k === 'wild') return 1.0;
      return 0;
    }
  }
}

function tryOr(primary: () => void, fallback: () => void): void {
  try {
    primary();
  } catch {
    fallback();
  }
}

/* ---------------- 主入口 ---------------- */

/** 让机器人对其当前 prompt 执行一步动作；返回是否实际行动 */
export function botAct(brain: BotBrain, gs: BloodState, playerId: string, now: number): boolean {
  const p = gs.players.find((x) => x.id === playerId);
  if (!p) return false;
  const prompt = promptFor(gs, p);
  switch (prompt.k) {
    /* ---- 基础阶段 ---- */
    case 'pick': {
      blood.bPickChar(gs, p.id, p.charOptions[0], now);
      return true;
    }
    case 'setup': {
      // 初始构筑：按长线策略在 8 张构筑牌里保留最优 5 张，删掉对策略无贡献的牌（删牌构成决定后续策略走向）
      const keep = new Set(bestKeep(gs, p, 5, curStrategy(brain, p), p.setupHand).map((c) => c.id));
      const removed = p.setupHand.filter((c) => !keep.has(c.id)).map((c) => c.id).slice(0, 4);
      blood.bSetup(gs, p.id, removed, now);
      return true;
    }
    case 'swap': {
      return actSwap(brain, gs, p, now);
    }
    case 'play': {
      return actPlay(brain, gs, p, now);
    }
    case 'revealItem': {
      const demag = p.items.find((i) => BLOOD_MARKET_BY_ID.get(i.def)?.effect.k === 'demagNullify');
      if (demag) {
        blood.bUseItem(gs, p.id, demag.id, now);
      } else {
        blood.bUseItem(gs, p.id, null, now);
      }
      return true;
    }
    case 'itemAsk': {
      // 阶段边界道具询问：按效果各自的价值启发决定使用或跳过
      const eff = BLOOD_MARKET_BY_ID.get(prompt.defId ?? '')?.effect;
      const best = bestKeep(gs, p, Math.min(5, p.hand.length), curStrategy(brain, p));
      let use = true;
      switch (eff?.k) {
        case 'secretNoteFx':
          use = p.blood >= 4; // 保留基本血筹储备
          break;
        case 'eraserFx':
          use = monteCarloWinProb(gs, brain, p, best) < 0.3; // 自己弱势时压对手牌型
          break;
        case 'loudspeakerFx':
          use = monteCarloWinProb(gs, brain, p, best) > 0.7;
          break;
        case 'dealerLicense':
          use = evalPlay(gs, p, best).pips >= 38;
          break;
        default:
          use = true; // 信号干扰器：直接使用（目标在选择步骤决定）
      }
      blood.bItemAsk(gs, p.id, use, now);
      return true;
    }
    case 'steal': {
      const t = richestOpp(gs, p);
      if (t && t.blood >= 1) {
        blood.bSteal(gs, p.id, t.seat, now);
        return true;
      }
      return false;
    }
    case 'sdConfirm': {
      blood.bShowdownDone(gs, p.id, now);
      return true;
    }
    case 'buy': {
      return actBuy(brain, gs, p, now);
    }
    case 'insertChip': {
      const target = insertableTarget(gs, p, prompt.defId ?? '');
      if (target) blood.bInsertChip(gs, p.id, target.id, now);
      else blood.bInsertSkip(gs, p.id, now);
      return true;
    }
    case 'secretDelete': {
      blood.bSecretDelete(gs, p.id, worstDiscardCards(p, prompt.max ?? 1), now);
      return true;
    }
    case 'violentTarget': {
      const t = mostTicketsOpp(gs, p);
      if (t && t.draw.length >= 3) {
        blood.bViolent(gs, p.id, t.seat, now);
      } else if (p.draw.length >= 3) {
        blood.bViolent(gs, p.id, p.seat, now);
      } else {
        blood.bViolent(gs, p.id, -1, now);
      }
      return true;
    }
    case 'refreshPick': {
      const affordable = gs.market.some(
        (m) => m.def && (BLOOD_MARKET_BY_ID.get(m.def)?.cost ?? 99) <= p.blood - 4,
      );
      blood.bRefreshPick(gs, p.id, affordable ? [] : [3, 4], now);
      return true;
    }
    case 'remove': {
      return actRemove(brain, gs, p, now);
    }
    case 'reorg': {
      const reshuffle = p.discard.length >= 6 || p.draw.length <= 2;
      const pickCardId = !reshuffle && blood.effChar(p) === 'inspector' && p.discard.length > 0
        ? [...p.discard].sort((a, b) => b.r - a.r)[0].id
        : undefined;
      blood.bReorg(gs, p.id, reshuffle ? 'reshuffle' : 'blood', now, pickCardId);
      return true;
    }
    /* ---- 拓展牌交互 ---- */
    case 'poisonTarget':
    case 'freezeTarget': {
      const t = mostTicketsOpp(gs, p);
      if (t) {
        blood.bSecretTarget(gs, p.id, t.seat, now);
        return true;
      }
      return false;
    }
    case 'amnesiaTarget': {
      const t = mostTicketsOpp(gs, p);
      blood.bSecretTarget(gs, p.id, (t ?? p).seat, now);
      return true;
    }
    case 'boxRobTarget': {
      const t = richestOpp(gs, p);
      if (t) {
        blood.bSecretTarget(gs, p.id, t.seat, now);
        return true;
      }
      return false;
    }
    case 'signalTarget': {
      // 优先干扰策略成型度最高的对手（其手牌是策略引擎），其次手牌最多者
      const threat = strongestThreat(brain, gs, p, 0.5);
      const t = threat
        ? bySeatOf(gs, threat.seat) ?? opponentsOf(gs, p).sort((a, b) => b.hand.length - a.hand.length)[0]
        : opponentsOf(gs, p).sort((a, b) => b.hand.length - a.hand.length)[0];
      if (t) {
        blood.bSecretTarget(gs, p.id, t.seat, now);
        return true;
      }
      return false;
    }
    case 'demagTarget': {
      const t = opponentsOf(gs, p).sort((a, b) => mostExpensiveChip(b) - mostExpensiveChip(a))[0];
      if (t && mostExpensiveChip(t) > 0) {
        blood.bSecretTarget(gs, p.id, t.seat, now);
        return true;
      }
      return false;
    }
    case 'pinpointClaim': {
      const t = mostTicketsOpp(gs, p);
      if (!t) return false;
      const rank = topSeenRank(brain, t.seat) ?? randomInt(5, 11);
      blood.bPinpoint(gs, p.id, t.seat, rank, now);
      return true;
    }
    case 'pullChip': {
      const withChip = p.discard
        .filter((c) => p.chips.some((ch) => ch.on === c.id))
        .sort((a, b) => chipCost(p, a.id) - chipCost(p, b.id))[0];
      if (withChip) {
        blood.bPullChip(gs, p.id, withChip.id, now);
        return true;
      }
      return false;
    }
    case 'preciseDel': {
      const drawn = (prompt.cards ?? []).slice().sort((a, b) => a.r - b.r).slice(0, 2);
      blood.bPreciseDel(gs, p.id, drawn.map((c) => c.id), now);
      return true;
    }
    case 'irisGuess': {
      // 竞猜目标取置信度最高的策略猜测；无猜测时回退"换牌少=手牌强"启发式
      const threat = strongestThreat(brain, gs, p, 0.5);
      const t = threat
        ? bySeatOf(gs, threat.seat) ??
          opponentsOf(gs, p).sort((a, b) => (brain.swapped.get(a.seat) ?? 3) - (brain.swapped.get(b.seat) ?? 3))[0]
        : opponentsOf(gs, p).sort((a, b) => (brain.swapped.get(a.seat) ?? 3) - (brain.swapped.get(b.seat) ?? 3))[0];
      if (t) {
        const guess = guessOppStrategy(brain, t);
        blood.bIrisGuess(gs, p.id, t.seat, guess ? guessedCat(guess) : 2, now);
        return true;
      }
      return false;
    }
    case 'eraserClaim': {
      // 宣告最危险对手最可能摆出的牌型，将其降为高牌；无猜测时回退旧启发式
      const threat = strongestThreat(brain, gs, p);
      const anyStrongOpp = opponentsOf(gs, p).some((o) => (brain.swapped.get(o.seat) ?? 3) === 0);
      blood.bEraserClaim(gs, p.id, threat ? guessedCat(threat) : anyStrongOpp ? 6 : 4, now);
      return true;
    }
    case 'revealDecide': {
      return actRevealDecide(gs, p, prompt.decision?.t, prompt.chipId ?? '', now);
    }
    case 'barrierAsk': {
      blood.bBarrierDecide(gs, p.id, true, now);
      return true;
    }
    case 'demagPick': {
      const t = gs.players.find((x) => x.seat === prompt.targetSeat);
      const chips: { cardId: string; defId: string }[] = [];
      for (const c of t?.play ?? []) {
        for (const ch of (t?.chips ?? []).filter((x) => x.on === c.id && !x.off)) {
          chips.push({ cardId: c.id, defId: ch.def });
        }
      }
      const best = chips.sort((a, b) => (BLOOD_MARKET_BY_ID.get(b.defId)?.cost ?? 0) - (BLOOD_MARKET_BY_ID.get(a.defId)?.cost ?? 0))[0];
      if (best) {
        blood.bDemagPick(gs, p.id, best.cardId, best.defId, now);
        return true;
      }
      return false;
    }
    case 'pinpointVictim': {
      const rank = prompt.rank ?? 0;
      const matches = p.discard.filter((c) => c.r === rank).sort((a, b) => a.r - b.r);
      if (matches[0]) {
        blood.bPinpointVictimPick(gs, p.id, matches[0].id, now);
        return true;
      }
      return false;
    }
    /* ---- 拓展角色交互 ---- */
    case 'gamblerGuess': {
      const weakButConfident = opponentsOf(gs, p).every((o) => (brain.swapped.get(o.seat) ?? 3) >= 2);
      blood.bGamblerGuess(gs, p.id, weakButConfident ? p.seat : (mostTicketsOpp(gs, p)?.seat ?? p.seat), now);
      return true;
    }
    case 'bomberClaim': {
      blood.bBomberClaim(gs, p.id, 1, now);
      return true;
    }
    case 'succubusSteal': {
      const t = richestOpp(gs, p);
      if (!t) return false;
      tryOr(
        () => blood.bSuccubusSteal(gs, p.id, t.seat, now),
        () => blood.bSuccubusSteal(gs, p.id, -1, now),
      );
      return true;
    }
    case 'scalperDeal': {
      blood.bScalperDeal(gs, p.id, p.blood >= 5, now);
      return true;
    }
    case 'studentDump': {
      const ev = evalPlay(gs, p, p.play);
      blood.bStudentDump(gs, p.id, ev.cat <= 2, undefined, now);
      return true;
    }
    case 'studentRemove': {
      const worst = worstDiscardCards(p, 1)[0];
      blood.bStudentDump(gs, p.id, !!worst && p.blood >= 6, worst, now);
      return true;
    }
    case 'designerDiscard': {
      const ev = evalPlay(gs, p, p.play);
      const sorted = [...p.play].sort((a, b) => a.r - b.r);
      blood.bDesignerDiscard(gs, p.id, ev.cat <= 3 ? sorted.slice(0, 2).map((c) => c.id) : [], now);
      return true;
    }
    case 'dogTarget': {
      const t = mostTicketsOpp(gs, p);
      blood.bDogTarget(gs, p.id, (t ?? p).seat, now);
      return true;
    }
    case 'generalChoice': {
      blood.bGeneralChoice(gs, p.id, 'extra', undefined, now);
      return true;
    }
    case 'vagrantDraw': {
      const t = opponentsOf(gs, p).sort((a, b) => b.draw.length - a.draw.length)[0];
      if (t && t.draw.length >= 2) {
        blood.bVagrantDraw(gs, p.id, t.seat, now);
        return true;
      }
      blood.bVagrantDraw(gs, p.id, -1, now);
      return true;
    }
    case 'fryerDel': {
      blood.bFryerDel(gs, p.id, [], true, now);
      return true;
    }
    case 'curseTake': {
      blood.bCurseTake(gs, p.id, p.curseStash.map((c) => c.id), now);
      return true;
    }
    case 'godPeek': {
      blood.bGodPeekChoice(gs, p.id, 'extra', now);
      return true;
    }
    case 'detectivePick': {
      const best = [...p.discard].sort((a, b) => b.r - a.r)[0];
      if (best) {
        blood.bDetectivePick(gs, p.id, 'top', [best.id], now);
      } else {
        blood.bDetectivePick(gs, p.id, 'skip', [], now);
      }
      return true;
    }
    case 'hackerSetup': {
      const cards = (prompt.cards ?? []).slice().sort((a, b) => a.r - b.r).slice(0, 8);
      blood.bHackerSetup(gs, p.id, cards.map((c) => c.id), now);
      return true;
    }
    case 'smugglerMark': {
      const slot = gs.market
        .map((m, i) => ({ m, i }))
        .filter((x) => x.m.def)
        .sort((a, b) => (BLOOD_MARKET_BY_ID.get(b.m.def!)?.cost ?? 0) - (BLOOD_MARKET_BY_ID.get(a.m.def!)?.cost ?? 0))[0];
      blood.bSmugglerMark(gs, p.id, slot ? slot.i : -1, now);
      return true;
    }
    case 'pirateRob': {
      const t = richestOpp(gs, p);
      blood.bPirateRob(gs, p.id, t && t.blood >= 3 ? t.seat : -1, now);
      return true;
    }
    case 'pirateDecide': {
      blood.bPirateDecide(gs, p.id, p.blood >= 5, now);
      return true;
    }
    case 'auctionPick': {
      const options = prompt.options ?? [];
      if (options.length === 0 || p.blood < 8) {
        blood.bAuctionPick(gs, p.id, -1, now);
        return true;
      }
      const costs = options.map((d) => BLOOD_MARKET_BY_ID.get(d)?.cost ?? 0);
      blood.bAuctionPick(gs, p.id, costs[0] >= costs[1] ? 0 : 1, now);
      return true;
    }
    case 'auctionBid': {
      const current = prompt.amount ?? 0;
      const budget = p.blood - 4;
      blood.bAuctionBid(gs, p.id, current + 1 <= budget ? current + 1 : 0, now);
      return true;
    }
    case 'impDraw': {
      const t = opponentsOf(gs, p).sort((a, b) => b.draw.length - a.draw.length)[0];
      if (t && t.draw.length > 0) {
        blood.bImpDraw(gs, p.id, t.seat, now);
        return true;
      }
      return false;
    }
    case 'impRedeem': {
      blood.bImpRedeem(gs, p.id, p.blood >= 5, now);
      return true;
    }
    case 'facelessPick': {
      const opts = prompt.options ?? [];
      if (opts[0]) blood.bFacelessPick(gs, p.id, opts[0], now);
      return true;
    }
    case 'blufferDeclare': {
      blood.bBlufferDeclare(
        gs,
        p.id,
        p.play.map((c) => ({ id: c.id, r: c.r === 0 ? 14 : c.r, s: c.s ?? ('s' as const) })),
        now,
      );
      return true;
    }
    case 'blufferChallenge': {
      const bl = gs.bluffer;
      if (bl) {
        const declared = evalCards(bl.declared, null);
        const mine = evalPlay(gs, p, p.play);
        blood.bBlufferChallenge(gs, p.id, beats(declared, mine), now);
      } else {
        blood.bBlufferChallenge(gs, p.id, false, now);
      }
      return true;
    }
    case 'ceoGive': {
      const t = mostTicketsOpp(gs, p);
      if (t && t.hand.length >= 4 && p.blood >= 6) {
        blood.bCeoGive(gs, p.id, t.seat, 2, now);
      } else {
        blood.bCeoDone(gs, p.id, now);
      }
      return true;
    }
    case 'ceoDecide': {
      blood.bCeoDecide(gs, p.id, true, now);
      return true;
    }
    case 'agentAsk': {
      blood.bAgentAsk(gs, p.id, -1, now);
      return true;
    }
    case 'agentDecide': {
      blood.bAgentDecide(gs, p.id, true, now);
      return true;
    }
    case 'mynameSet': {
      blood.bMynameSet(gs, p.id, 2, '咕咕嘎嘎', now);
      return true;
    }
    case 'cleanerDel': {
      const t = mostTicketsOpp(gs, p);
      if (t) {
        blood.bCleanerDel(gs, p.id, t.seat, '', now);
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/* ---- 换牌决策：保留最优 5 张，弃孤立弱牌 ---- */
function actSwap(brain: BotBrain, gs: BloodState, p: BPlayer, now: number): boolean {
  void brain;
  const ch = blood.effChar(p);
  // 咒术师：有【5】先藏（抽1+1血筹）
  if (ch === 'curse') {
    const five = p.hand.find((c) => c.r === 5 && c.s != null);
    if (five) {
      blood.bCurseHide(gs, p.id, five.id, now);
      return true;
    }
  }
  // 炸鸡店老板：血筹充裕时抽 1（每次 tick 一步，自然限速）
  if (ch === 'fryer' && p.blood >= 6) {
    blood.bFryerDraw(gs, p.id, now);
    return true;
  }
  const isTarot = ch === 'tarot';
  const maxDrop = Math.min(isTarot ? 2 : charSwapMax(ch), p.hand.length);
  // 按长线策略选保留的 5 张：弃掉对策略无贡献的牌，往目标牌型凑
  const keep = new Set(bestKeep(gs, p, 5, curStrategy(brain, p)).map((c) => c.id));
  const ranked = [...p.hand].sort((a, b) => a.r - b.r);
  let drop = ranked.filter((c) => !keep.has(c.id)).slice(0, maxDrop);
  if (drop.length === 0) drop = ranked.slice(0, Math.min(maxDrop, p.hand.length));
  if (drop.length === 0) {
    blood.bSwapStop(gs, p.id, now);
    return true;
  }
  blood.bSwap(gs, p.id, drop.map((c) => c.id), isTarot ? drop.length : undefined, now);
  return true;
}

/* ---- 出牌决策：蒙特卡洛推演 ---- */
function actPlay(brain: BotBrain, gs: BloodState, p: BPlayer, now: number): boolean {
  // 广播喇叭/荷官证/魔术橡皮已改为对决前窗口询问（itemAsk），此处只决定暗扣哪 5 张
  const n = Math.min(5, p.hand.length);
  // 整次出牌决策共享推演预算（选牌/候选评估/多候选推演合计）
  const playDeadline = Date.now() + MC_DEADLINE_MS;
  const best = bestKeep(gs, p, n, curStrategy(brain, p), p.hand, playDeadline);
  const winProb = monteCarloWinProb(gs, brain, p, best, MC_SAMPLES, playDeadline);
  // 候选：最优解 + 次优 + 角色效果导向，取推演 EV 最高者
  const candidates: BCard[][] = [];
  const pushCandidate = (cards: BCard[]): void => {
    if (cards.length !== n) return;
    const key = [...cards].map((c) => c.id).sort().join(',');
    if (candidates.some((c) => [...c].map((x) => x.id).sort().join(',') === key)) return;
    candidates.push(cards);
  };
  pushCandidate(best);
  const combos = combinations(p.hand, n)
    .map((c) => ({ c, ev: evalPlay(gs, p, c) }))
    .sort((a, b) => b.ev.cat - a.ev.cat || b.ev.pips - a.ev.pips);
  for (const x of combos.slice(1, 3)) pushCandidate(x.c);
  const ch = blood.effChar(p);
  if (ch === 'miner') pushCandidate([...p.hand].sort((a, b) => isBlack(b) - isBlack(a) || b.r - a.r).slice(0, n));
  if (ch === 'screenwriter') pushCandidate([...p.hand].sort((a, b) => Math.abs(a.r - 10) - Math.abs(b.r - 10)).slice(0, n));
  let bestPick = combos[0]?.c ?? p.hand.slice(0, n);
  let bestEv = -1;
  for (const cand of candidates) {
    const prob = candidates.length > 1 ? monteCarloWinProb(gs, brain, p, cand, 24, playDeadline) : winProb;
    const ev = evalPlay(gs, p, cand);
    const value = prob + charBonus(p, cand, ev);
    if (value > bestEv) {
      bestEv = value;
      bestPick = cand;
    }
  }
  blood.bPlay(gs, p.id, bestPick.map((c) => c.id), now);
  return true;
}

/* ---- 购买决策：局势打分 ---- */
function actBuy(brain: BotBrain, gs: BloodState, p: BPlayer, now: number): boolean {
  const strat = curStrategy(brain, p);
  const nearWinSelf = p.tickets >= gs.target - 8;
  const nearWinOpp = opponentsOf(gs, p).some((o) => o.tickets >= gs.target - 8);
  // 对手策略成型度威胁：有高置信猜测时提前防御（破坏类/消磁枪/虹膜竞猜）
  const threat = strongestThreat(brain, gs, p);
  const poor = p.blood <= 5;
  const hasChipInDiscard = p.discard.some((c) => p.chips.some((ch) => ch.on === c.id));
  // 保留底金：对手接近胜利时多留血防对决期破坏，平时 4 血够弹簧/删牌应急
  const reserve = nearWinOpp ? 6 : 4;

  const scoreDef = (defId: string): number => {
    const def = BLOOD_MARKET_BY_ID.get(defId);
    if (!def) return -1;
    // 芯片：可插入即有价值，与策略匹配（转化为目标点数/花色）时大幅加分
    if (def.kind === 'chip') {
      const target = insertableTarget(gs, p, defId, strat);
      if (!target) return -1;
      return 2.4 + chipStratBonus(p, def.effect, strat);
    }
    switch (def.id) {
      case 'coatWin': case 'encrypt': return nearWinSelf ? 6 : 2;
      case 'dividend': return p.privilege ? 4 : 0;
      case 'betDeal': return p.blood >= 8 ? 3 : 1; // 血量充裕时才博收益
      case 'bloodShare': return p.blood >= 8 ? 3 : 1;
      case 'violentDel': case 'pinpoint': case 'poison': case 'freezeCar': case 'amnesia':
        return nearWinOpp ? 5 : threat ? 3 : 2; // 对手策略成型 → 提前拆解
      case 'irisGamble': return threat ? 3.5 : 2; // 猜得准才值得买
      case 'ghostHand': return p.privilege ? 0 : 3;
      case 'pullChip': return hasChipInDiscard ? 4 : 0;
      case 'demag': return threat ? 3.5 : 3; // 对手依赖芯片成型 → 消磁价值高
      case 'closingS': case 'closingM': case 'closingL': return poor ? 1 : 0;
      default: return 2;
    }
  };

  let best: { slot: number; value: number } | null = null;
  gs.market.forEach((m, i) => {
    if (!m.def) return;
    const def = BLOOD_MARKET_BY_ID.get(m.def);
    if (!def) return;
    const value = scoreDef(m.def) - def.cost / 3 + m.bonus * 0.5;
    if (!best || value > best.value) best = { slot: i, value };
  });
  const chosen = best as { slot: number; value: number } | null;
  // 门槛 1 分：默认 2 分的 3 费实用牌（干扰器/屏障/橡皮等）也能过线，贵牌靠情境高分
  if (chosen && chosen.value >= 1) {
    const def = BLOOD_MARKET_BY_ID.get(gs.market[chosen.slot].def!);
    let cost = def?.cost ?? 0;
    if (blood.effChar(p) === 'mascot' && !p.firstBuyUsed) cost = Math.floor(cost / 2);
    if (blood.effChar(p) === 'wei' && def?.kind === 'chip') cost = Math.max(0, cost - 2);
    if (p.blood - cost >= reserve) {
      const insertInto = def?.kind === 'chip' ? insertableTarget(gs, p, def.id, strat)?.id : undefined;
      blood.bBuy(gs, p.id, chosen.slot, insertInto, now);
      return true;
    }
  }
  blood.bPassBuy(gs, p.id, now);
  return true;
}

/* ---- 删牌决策 ---- */
function actRemove(brain: BotBrain, gs: BloodState, p: BPlayer, now: number): boolean {
  const strat = curStrategy(brain, p);
  const ch = blood.effChar(p);
  if (ch === 'liu') {
    const n = Math.min(p.discard.length, Math.floor(p.blood));
    blood.bRemove(gs, p.id, worstDiscardCards(p, n, strat), now);
    return true;
  }
  const freeN = ch === 'hacker' ? 2 : ch === 'biker' || ch === 'twinA' ? 0 : 1;
  const budget = freeN + Math.max(0, Math.floor((p.blood - 6) / 2)); // 保留 6 血筹底线
  const cards = worstDiscardCards(p, Math.max(0, budget), strat);
  blood.bRemove(gs, p.id, cards, now);
  return true;
}

/* ---- 对决期芯片决策 ---- */
function actRevealDecide(gs: BloodState, p: BPlayer, t: string | undefined, chipId: string, now: number): boolean {
  if (t === 'spring') {
    if (p.blood >= 5) blood.bSpringUse(gs, p.id, chipId, 2, now);
    else blood.bSkipDecision(gs, p.id, now);
    return true;
  }
  // 复制/屏蔽：选对手最贵的芯片
  let best: { seat: number; cardId: string; defId: string; cost: number } | null = null;
  for (const o of opponentsOf(gs, p)) {
    for (const c of o.play) {
      for (const ch of o.chips.filter((x) => x.on === c.id && !x.off)) {
        const cost = BLOOD_MARKET_BY_ID.get(ch.def)?.cost ?? 0;
        if (!best || cost > best.cost) best = { seat: o.seat, cardId: c.id, defId: ch.def, cost };
      }
    }
  }
  if (best && best.defId !== 'twinLens') {
    blood.bRevealChipTarget(gs, p.id, best.seat, best.cardId, best.defId, now);
  } else {
    blood.bSkipDecision(gs, p.id, now);
  }
  return true;
}

/* ---------------- 工具 ---------------- */

function isBlack(c: BCard): number {
  return c.s === 's' || c.s === 'c' ? 1 : 0;
}

function evalCards(cards: BCard[], charId: string | null): { cat: number; pips: number } {
  const evals: EvalCard[] = cards.map((c) => applyCharEval([toEvalCard(c.id, c.r, c.s, [])], charId)[0]);
  const res = evalBloodHand(evals);
  return { cat: res.cat, pips: res.pips };
}

function mostExpensiveChip(p: BPlayer): number {
  let max = 0;
  for (const c of p.play) {
    for (const ch of p.chips.filter((x) => x.on === c.id && !x.off)) {
      max = Math.max(max, BLOOD_MARKET_BY_ID.get(ch.def)?.cost ?? 0);
    }
  }
  return max;
}

function chipCost(p: BPlayer, cardId: string): number {
  const ch = p.chips.find((x) => x.on === cardId);
  return BLOOD_MARKET_BY_ID.get(ch?.def ?? '')?.cost ?? 0;
}

/** 对手历史亮牌中最常见的点数（用于定点爆破宣称） */
function topSeenRank(brain: BotBrain, seat: number): number | null {
  const set = brain.seen.get(seat);
  if (!set || set.size === 0) return null;
  const counts = new Map<number, number>();
  for (const id of set) {
    const m = /c\d+-(\d+)$/.exec(id);
    if (!m) continue;
    const idx = Number(m[1]);
    if (idx >= 52) continue; // 大小王无点数
    const r = 2 + Math.floor(idx / 4);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let best: { r: number; n: number } | null = null;
  for (const [r, n] of counts) {
    if (!best || n > best.n) best = { r, n };
  }
  return best?.r ?? null;
}
