/**
 * 血色牌局 · 对决评估器（前后端共用）
 * - 牌型等级（高→低）：七条 > 同花六条 > 六条 > 同花五条 > 同花葫芦 > 同花顺 >
 *   五条 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌
 * - A 恒为 14 点：最小顺子 23456，最大 10JQKA，无轮子顺
 * - 牌型判断仅取单一最大牌型；牌型相同时按规则另比总点数（评估器同时返回 pips）
 * - 候选点数/花色（JOKER、数字滑轨、百变影像等）通过枚举取最优解释
 */

export type Suit = 's' | 'h' | 'd' | 'c';
export const ALL_SUITS: Suit[] = ['s', 'h', 'd', 'c'];
export const ALL_RANKS = Array.from({ length: 13 }, (_, i) => i + 2); // 2..14

import type { BloodEffect } from './bloodCards';

export interface EvalCard {
  id: string;
  /** 候选点数（固定牌长度为 1） */
  ranks: number[];
  /** 候选花色（固定牌长度为 1） */
  suits: Suit[];
  /** 视为几张（双生镜片=2，默认 1） */
  count: number;
}

const CAT_NAMES = [
  '高牌',
  '一对',
  '两对',
  '三条',
  '顺子',
  '同花',
  '葫芦',
  '四条',
  '五条',
  '同花顺',
  '同花葫芦',
  '同花五条',
  '六条',
  '同花六条',
  '七条',
] as const;

export function catName(cat: number): string {
  return CAT_NAMES[cat] ?? '高牌';
}

const ENUM_CAP = 200_000; // 枚举上限，超出则贪心回退

export interface BloodHandResult {
  cat: number; // 牌型等级
  name: string;
  pips: number; // 全部牌的点数总和（灵活牌取所选解释）
}

interface Pair {
  r: number;
  s: Suit;
}

export function evalBloodHand(cards: EvalCard[]): BloodHandResult {
  const flexible: EvalCard[] = [];
  const fixed: Pair[] = [];
  let total = 0;
  for (const c of cards) {
    total += c.count;
    if (c.ranks.length === 1 && c.suits.length === 1) {
      for (let i = 0; i < c.count; i++) fixed.push({ r: c.ranks[0], s: c.suits[0] });
    } else {
      flexible.push(c);
    }
  }

  let combos: Pair[][] = [];
  if (flexible.length === 0) {
    combos = [[]];
  } else {
    // 每张灵活牌的候选 (rank, suit) 组合
    let options: Pair[][] = flexible.map((c) => {
      const pairs: Pair[] = [];
      for (const r of c.ranks) for (const s of c.suits) pairs.push({ r, s });
      return pairs;
    });
    let product = options.reduce((acc, o) => acc * o.length, 1);
    if (product > ENUM_CAP) {
      // 贪心回退：枚举超上限时，每张灵活牌统一取“最有利”候选——
      // 复制固定牌中数量最多的点数（无固定牌则保持首个候选），避免 3+ 王牌时退化成 2♠
      const rankFreq = new Map<number, number>();
      const suitFreq = new Map<Suit, number>();
      for (const p of fixed) {
        rankFreq.set(p.r, (rankFreq.get(p.r) ?? 0) + 1);
        suitFreq.set(p.s, (suitFreq.get(p.s) ?? 0) + 1);
      }
      const bestRank = [...rankFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const bestSuit = [...suitFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      options = options.map((o) => [
        // 优先复制“最多点数 + 最多花色”的组合（凑同花多条），再退而求其次
        (bestRank != null && bestSuit != null
          ? o.find((p) => p.r === bestRank && p.s === bestSuit)
          : undefined) ??
          (bestRank != null ? o.find((p) => p.r === bestRank) : undefined) ??
          (bestSuit != null ? o.find((p) => p.s === bestSuit) : undefined) ??
          o[0],
      ]);
      product = options.length;
    }
    // 笛卡尔积
    combos = [[]];
    for (const opt of options) {
      const next: Pair[][] = [];
      for (const base of combos) {
        for (const o of opt) next.push([...base, o]);
      }
      combos = next;
      if (combos.length > ENUM_CAP) break;
    }
  }

  let best: BloodHandResult = { cat: -1, name: '高牌', pips: -1 };
  for (const combo of combos) {
    const pairs = [...fixed, ...combo.flatMap((p, i) => {
      const copies: Pair[] = [];
      for (let k = 0; k < flexible[i].count; k++) copies.push(p);
      return copies;
    })];
    const cat = detectCat(pairs, total);
    const pips = pairs.reduce((s, p) => s + p.r, 0);
    if (cat > best.cat || (cat === best.cat && pips > best.pips)) {
      best = { cat, name: catName(cat), pips };
    }
  }
  return best;
}

function detectCat(pairs: Pair[], total: number): number {
  const byRank = new Map<number, number>();
  const byRankSuit = new Map<string, number>();
  const bySuit = new Map<Suit, number>();
  const suitRanks = new Map<Suit, Set<number>>();
  for (const p of pairs) {
    byRank.set(p.r, (byRank.get(p.r) ?? 0) + 1);
    const rs = `${p.r}:${p.s}`;
    byRankSuit.set(rs, (byRankSuit.get(rs) ?? 0) + 1);
    bySuit.set(p.s, (bySuit.get(p.s) ?? 0) + 1);
    if (!suitRanks.has(p.s)) suitRanks.set(p.s, new Set());
    suitRanks.get(p.s)!.add(p.r);
  }
  const rankCounts = [...byRank.values()].sort((a, b) => b - a);
  const maxCount = rankCounts[0] ?? 0;
  const rankSet = new Set(byRank.keys());
  const hasStraight = (set: Set<number>) => {
    for (let start = 2; start <= 10; start++) {
      let ok = true;
      for (let r = start; r < start + 5; r++) {
        if (!set.has(r)) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };

  // 同花六条 / 同花五条：某 (点数,花色) 数量足够
  let sameRankSuitMax = 0;
  for (const v of byRankSuit.values()) sameRankSuitMax = Math.max(sameRankSuitMax, v);

  // 同花葫芦：某一花色下，存在点数 a 计≥3 且另一不同点数 b 计≥2
  let flushBoat = false;
  for (const [s, ranks] of suitRanks) {
    const counts = [...ranks].map((r) => byRankSuit.get(`${r}:${s}`) ?? 0).sort((a, b) => b - a);
    if ((counts[0] ?? 0) >= 3 && (counts[1] ?? 0) >= 2) {
      flushBoat = true;
      break;
    }
  }

  const flushStraight = [...suitRanks.values()].some((set) => hasStraight(set));
  const flush = [...bySuit.values()].some((n) => n >= 5);
  const straight = hasStraight(rankSet);
  const trips = rankCounts.filter((n) => n >= 3).length;
  const pairsCount = rankCounts.filter((n) => n >= 2).length;
  const boat = trips >= 1 && rankCounts.filter((n) => n >= 2).length >= 2;

  if (total >= 7 && maxCount >= 7) return 14;
  if (sameRankSuitMax >= 6) return 13;
  if (maxCount >= 6) return 12;
  if (sameRankSuitMax >= 5) return 11;
  if (flushBoat) return 10;
  if (flushStraight) return 9;
  if (maxCount >= 5) return 8;
  if (maxCount >= 4) return 7;
  if (boat) return 6;
  if (flush) return 5;
  if (straight) return 4;
  if (trips >= 1) return 3;
  if (pairsCount >= 2) return 2;
  if (pairsCount >= 1) return 1;
  return 0;
}

/** 由基础牌 + 挂载的芯片效果构建评估输入 */
export function toEvalCard(
  id: string,
  r: number,
  s: Suit | null,
  effects: BloodEffect[],
): EvalCard {
  let ranks = s == null ? [...ALL_RANKS] : [r];
  let suits: Suit[] = s == null ? [...ALL_SUITS] : [s];
  let count = 1;
  for (const eff of effects) {
    switch (eff.k) {
      case 'rankMod':
        ranks = [Math.min(14, Math.max(2, r + eff.mod))];
        break;
      case 'suit':
        suits = [...eff.suits];
        break;
      case 'suitWild':
        suits = [...ALL_SUITS];
        break;
      case 'rankWild':
        ranks = [...ALL_RANKS];
        break;
      case 'wild':
        ranks = [...ALL_RANKS];
        suits = [...ALL_SUITS];
        break;
      case 'dupe':
        count = 2;
        break;
      default:
        break; // 触发类/仿制类效果不影响单牌候选
    }
  }
  return { id, ranks, suits, count };
}

/**
 * 仿制印章：将带印章的牌候选改为“出牌区其他牌的基础牌面（无视其芯片、不含JOKER）”的并集。
 * 近似实现：点数×花色取并集的笛卡尔积（可能包含实际不存在的点花组合），供评估取最优。
 */
export function applyImitate(
  cards: EvalCard[],
  raws: { r: number; s: Suit | null }[],
  imitate: boolean[],
): EvalCard[] {
  if (!imitate.some(Boolean)) return cards;
  const ranks = new Set<number>();
  const suits = new Set<Suit>();
  raws.forEach((raw, i) => {
    if (imitate[i] || raw.s == null) return;
    ranks.add(raw.r);
    suits.add(raw.s);
  });
  if (ranks.size === 0) return cards; // 没有可仿制的目标（出牌区只有自己/JOKER）
  const rs = [...ranks].sort((a, b) => a - b);
  const ss = [...suits];
  return cards.map((c, i) => (imitate[i] ? { ...c, ranks: rs, suits: ss } : c));
}
