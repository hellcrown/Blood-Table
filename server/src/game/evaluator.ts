import type { Card } from '@shared/protocol';

/**
 * 5 张牌估值。cat: 0 高牌 / 1 一对 / 2 两对 / 3 三条 / 4 顺子 / 5 同花 / 6 葫芦 / 7 四条 / 8 同花顺
 * score 把类别与踢脚编码成单个整数，可直接比较大小（A2345 轮子顺按 5 高处理）。
 */
export interface HandValue {
  cat: number;
  ks: number[];
  score: number;
}

export const HAND_NAMES = [
  '高牌',
  '一对',
  '两对',
  '三条',
  '顺子',
  '同花',
  '葫芦',
  '四条',
  '同花顺',
] as const;

export function eval5(cards: Card[]): HandValue {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a); // 降序
  const isFlush = cards.every((c) => c.s === cards[0].s);

  const cnt = new Map<number, number>();
  for (const r of ranks) cnt.set(r, (cnt.get(r) ?? 0) + 1);
  // 组按 (数量降序, 点数降序) 排列，其点数序列即踢脚序列
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ks = groups.map((g) => g[0]);

  // 顺子判断（含 A-2-3-4-5 轮子）
  const uniq = [...new Set(ranks)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5;
  }

  let cat: number;
  let key: number[];
  if (isFlush && straightHigh) {
    cat = 8;
    key = [straightHigh];
  } else if (groups[0][1] === 4) {
    cat = 7;
    key = ks;
  } else if (groups[0][1] === 3 && groups.length > 1 && groups[1][1] === 2) {
    cat = 6;
    key = ks;
  } else if (isFlush) {
    cat = 5;
    key = ranks;
  } else if (straightHigh) {
    cat = 4;
    key = [straightHigh];
  } else if (groups[0][1] === 3) {
    cat = 3;
    key = ks;
  } else if (groups[0][1] === 2 && groups.length > 1 && groups[1][1] === 2) {
    cat = 2;
    key = ks;
  } else if (groups[0][1] === 2) {
    cat = 1;
    key = ks;
  } else {
    cat = 0;
    key = ranks;
  }

  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (key[i] ?? 0);
  return { cat, ks: key, score };
}

export function handName(v: HandValue): string {
  if (v.cat === 8 && v.ks[0] === 14) return '皇家同花顺';
  return HAND_NAMES[v.cat];
}

/** 从 5~7 张里选最佳 5 张 */
export function bestHand(cards: Card[]): { value: HandValue; cards: Card[] } {
  if (cards.length < 5) throw new Error('至少需要 5 张牌');
  let best: { value: HandValue; cards: Card[] } | null = null;
  for (const combo of combinations(cards, 5)) {
    const v = eval5(combo);
    if (!best || v.score > best.value.score) best = { value: v, cards: combo };
  }
  return best!;
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
