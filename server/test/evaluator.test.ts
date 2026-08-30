import { describe, expect, it } from 'vitest';
import type { Card, Rank, Suit } from '@shared/protocol';
import { bestHand, eval5, handName } from '../src/game/evaluator';

const RANK_MAP: Record<string, Rank> = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
function c(s: string): Card {
  const r = s[0];
  const suit = s[1] as Suit;
  const rank = RANK_MAP[r] ?? (Number(r) as Rank);
  return { r: rank, s: suit };
}
function hand(str: string): Card[] {
  return str.split(' ').map(c);
}

describe('eval5 牌型识别', () => {
  it('皇家同花顺', () => {
    const v = eval5(hand('Th Jh Qh Kh Ah'));
    expect(v.cat).toBe(8);
    expect(handName(v)).toBe('皇家同花顺');
  });

  it('同花顺', () => {
    const v = eval5(hand('5h 6h 7h 8h 9h'));
    expect(v.cat).toBe(8);
    expect(v.ks[0]).toBe(9);
    expect(handName(v)).toBe('同花顺');
  });

  it('四条', () => {
    const v = eval5(hand('9s 9h 9d 9c 2d'));
    expect(v.cat).toBe(7);
  });

  it('葫芦', () => {
    const v = eval5(hand('3s 3h 3d Kc Kh'));
    expect(v.cat).toBe(6);
    expect(v.ks).toEqual([3, 13]);
  });

  it('同花', () => {
    const v = eval5(hand('As Ts 7s 4s 2s'));
    expect(v.cat).toBe(5);
  });

  it('顺子', () => {
    const v = eval5(hand('6d 7c 8h 9s Td'));
    expect(v.cat).toBe(4);
    expect(v.ks[0]).toBe(10);
  });

  it('A2345 轮子顺按 5 高', () => {
    const v = eval5(hand('Ah 2d 3c 4s 5h'));
    expect(v.cat).toBe(4);
    expect(v.ks[0]).toBe(5);
  });

  it('三条', () => {
    expect(eval5(hand('7s 7h 7d Kc 2d')).cat).toBe(3);
  });

  it('两对', () => {
    const v = eval5(hand('As Ad Qc Qd 7h'));
    expect(v.cat).toBe(2);
    expect(v.ks).toEqual([14, 12, 7]);
  });

  it('一对', () => {
    expect(eval5(hand('As Ad Qc 7d 3h')).cat).toBe(1);
  });

  it('高牌', () => {
    expect(eval5(hand('As Jd 8c 6d 3h')).cat).toBe(0);
  });
});

describe('牌型比较', () => {
  it('同花顺 > 四条 > 葫芦', () => {
    const sf = eval5(hand('5h 6h 7h 8h 9h'));
    const quads = eval5(hand('9s 9h 9d 9c 2d'));
    const boat = eval5(hand('3s 3h 3d Kc Kh'));
    expect(sf.score).toBeGreaterThan(quads.score);
    expect(quads.score).toBeGreaterThan(boat.score);
  });

  it('轮子顺最小', () => {
    const wheel = eval5(hand('Ah 2d 3c 4s 5h'));
    const sixHigh = eval5(hand('2d 3c 4s 5h 6d'));
    expect(wheel.score).toBeLessThan(sixHigh.score);
  });

  it('一对比踢脚', () => {
    const a = eval5(hand('As Ad Kc 7d 3h'));
    const b = eval5(hand('As Ad Qc 9d 5h'));
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('两对比第二对', () => {
    const a = eval5(hand('As Ad Kc Kd 7h'));
    const b = eval5(hand('As Ad Qc Qd Th'));
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('葫芦比三张大小再比对子', () => {
    const a = eval5(hand('3s 3h 3d Kc Kh'));
    const b = eval5(hand('3s 3h 3d Qc Qh'));
    const c2 = eval5(hand('2s 2h 2d Ac Ah'));
    expect(a.score).toBeGreaterThan(b.score);
    expect(b.score).toBeGreaterThan(c2.score);
  });
});

describe('bestHand 7 选 5', () => {
  it('从 7 张中选出同花', () => {
    const best = bestHand(hand('As Ks 2s 5s 9s 3d Jc'));
    expect(best.value.cat).toBe(5);
    expect(handName(best.value)).toBe('同花');
  });

  it('7 张里公牌四条优先于两对', () => {
    // 公牌 9 9 9 9 A，手牌 K Q → 四条 9
    const best = bestHand(hand('9s 9h 9d 9c Ah Ks Qd'));
    expect(best.value.cat).toBe(7);
    expect(best.value.ks).toEqual([9, 14]);
  });

  it('用两张底牌补成顺子', () => {
    // 公牌 5 6 7 8 K + 手牌 4 9 → 9 高顺（8 9 10? 不对，4-8 顺与 5-9 顺，取 9 高）
    const best = bestHand(hand('4d 9c 5c 6d 7h 8s Kh'));
    expect(best.value.cat).toBe(4);
    expect(best.value.ks[0]).toBe(9);
  });
});
