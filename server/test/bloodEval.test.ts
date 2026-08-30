import { describe, expect, it } from 'vitest';
import { BLOOD_MARKET_BY_ID, BLOOD_MARKET_DEFS, BLOOD_MARKET_EXPANSION_DEFS } from '@shared/bloodCards';
import { evalBloodHand, toEvalCard, type EvalCard } from '@shared/bloodEval';

function C(r: number, s: 's' | 'h' | 'd' | 'c'): EvalCard {
  return toEvalCard(`${r}${s}`, r, s, []);
}
function JK(n = 1): EvalCard {
  return toEvalCard(`jk${n}`, 0, null, []);
}
function chip(id: string): import('@shared/bloodCards').BloodEffect {
  return BLOOD_MARKET_BY_ID.get(id)!.effect;
}
function CC(r: number, s: 's' | 'h' | 'd' | 'c', chipId: string): EvalCard {
  return toEvalCard(`${r}${s}-${chipId}`, r, s, [chip(chipId)]);
}

const cat = (cards: EvalCard[]) => evalBloodHand(cards).cat;
const name = (cards: EvalCard[]) => evalBloodHand(cards).name;

describe('血色评估器 · 基础牌型', () => {
  it('高牌', () => {
    expect(cat([C(14, 's'), C(11, 'h'), C(8, 'd'), C(6, 'c'), C(3, 's')])).toBe(0);
  });
  it('一对/两对/三条', () => {
    expect(cat([C(9, 's'), C(9, 'h'), C(5, 'd'), C(3, 'c'), C(2, 's')])).toBe(1);
    expect(cat([C(9, 's'), C(9, 'h'), C(5, 'd'), C(5, 'c'), C(2, 's')])).toBe(2);
    expect(cat([C(9, 's'), C(9, 'h'), C(9, 'd'), C(3, 'c'), C(2, 's')])).toBe(3);
  });
  it('顺子：23456 最小，10JQKA 最大，A 恒为 14', () => {
    expect(cat([C(2, 's'), C(3, 'h'), C(4, 'd'), C(5, 'c'), C(6, 's')])).toBe(4);
    expect(cat([C(10, 's'), C(11, 'h'), C(12, 'd'), C(13, 'c'), C(14, 's')])).toBe(4);
  });
  it('无轮子顺：A2345 不是顺子', () => {
    expect(cat([C(14, 's'), C(2, 'h'), C(3, 'd'), C(4, 'c'), C(5, 's')])).toBe(0);
  });
  it('同花与同花顺', () => {
    expect(cat([C(2, 's'), C(5, 's'), C(9, 's'), C(11, 's'), C(13, 's')])).toBe(5);
    expect(cat([C(7, 's'), C(8, 's'), C(9, 's'), C(10, 's'), C(11, 's')])).toBe(9);
  });
  it('葫芦与四条', () => {
    expect(cat([C(9, 's'), C(9, 'h'), C(9, 'd'), C(5, 'c'), C(5, 's')])).toBe(6);
    expect(cat([C(9, 's'), C(9, 'h'), C(9, 'd'), C(9, 'c'), C(2, 's')])).toBe(7);
  });
  it('JOKER 补四条成五条，补两王成六条', () => {
    expect(cat([C(9, 's'), C(9, 'h'), C(9, 'd'), C(9, 'c'), JK()])).toBe(8);
    expect(cat([C(9, 's'), C(9, 'h'), C(9, 'd'), C(9, 'c'), JK(), JK()])).toBe(12);
  });
  it('JOKER 补同花顺', () => {
    expect(cat([C(7, 's'), C(8, 's'), C(9, 's'), C(10, 's'), JK()])).toBe(9);
  });
  it('同花五条：四张同点数同花 + JOKER', () => {
    expect(cat([C(9, 's'), C(9, 's'), C(9, 's'), C(9, 's'), JK()])).toBe(11);
  });
  it('同花葫芦', () => {
    expect(cat([C(13, 's'), C(13, 's'), C(13, 's'), C(5, 's'), C(5, 's')])).toBe(10);
    expect(cat([C(13, 's'), C(13, 'h'), C(13, 'd'), C(5, 's'), C(5, 's')])).toBe(6);
  });
});

describe('血色评估器 · 芯片牌型', () => {
  it('双生镜片：此牌视为2张 → 四条+双生9=五条', () => {
    const cards = [C(9, 's'), C(9, 'h'), C(9, 'd'), C(9, 'c'), CC(5, 's', 'twinLens')];
    // 5♣ 挂双生没用，改为直接验证 5×9：四张9 + 双生9
    const five = [C(9, 's'), C(9, 'h'), C(9, 'd'), C(4, 'c'), CC(9, 'c', 'twinLens')];
    expect(cat(cards)).toBe(7); // 四条 9
    expect(cat(five)).toBe(8); // 9×5 → 五条
  });
  it('七条：三张9 + 两张各挂双生的9', () => {
    const cards = [
      C(9, 's'),
      C(9, 'h'),
      C(9, 'd'),
      CC(9, 'c', 'twinLens'),
      CC(9, 'h', 'twinLens'),
    ];
    expect(cat(cards)).toBe(14); // 3 + 2 + 2 = 7 条
    expect(name(cards)).toBe('七条');
  });
  it('校准器+1：点数永久+1', () => {
    const cards = [CC(8, 's', 'calib1'), C(9, 'h'), C(10, 'd'), C(11, 'c'), C(12, 's')];
    expect(cat(cards)).toBe(1); // 8+1=9 → 9,9,10,11,12 一对9
    const straight = [CC(4, 's', 'calib1'), C(6, 'h'), C(7, 'd'), C(8, 'c'), C(9, 's')];
    expect(cat(straight)).toBe(4); // 4+1=5 → 5,6,7,8,9 顺子
  });
  it('限流阀-3：点数-3（说明书示例：红桃5 视为红桃2）', () => {
    const cards = [CC(5, 'h', 'limiter3'), C(2, 's'), C(2, 'h'), C(2, 'd'), C(7, 'c')];
    // 2,2,2,2,7 → 四条
    expect(cat(cards)).toBe(7);
    expect(evalBloodHand(cards).pips).toBe(2 + 2 + 2 + 2 + 7);
  });
  it('数字滑轨：点数任意 → 补顺子', () => {
    const cards = [C(4, 's'), C(5, 'h'), C(6, 'd'), C(7, 'c'), toEvalCard('sl', 2, 's', [chip('slider')])];
    expect(cat(cards)).toBe(4);
  });
  it('变色墨水：花色任意 → 补同花', () => {
    const cards = [C(2, 's'), C(5, 's'), C(9, 's'), C(11, 's'), toEvalCard('ink', 3, 'h', [chip('inkSuit')])];
    expect(cat(cards)).toBe(5);
  });
  it('红色芯片：花色视为♦/♥', () => {
    const cards = [CC(2, 'h', 'redChip'), C(5, 'd'), C(9, 'd'), C(11, 'd'), C(13, 'd')];
    expect(cat(cards)).toBe(5);
  });
  it('同牌型比总点数', () => {
    const a = [C(13, 's'), C(13, 'h'), C(6, 'd'), C(4, 'c'), C(2, 's')]; // 一对K 38点
    const b = [C(12, 's'), C(12, 'h'), C(10, 'd'), C(6, 'c'), C(4, 's')]; // 一对Q 44点
    const ra = evalBloodHand(a);
    const rb = evalBloodHand(b);
    expect(ra.cat).toBe(rb.cat);
    expect(ra.pips).toBeLessThan(rb.pips);
  });
});

describe('黑市牌库构成', () => {
  it('基础 25 种 57 张；拓展 27 种并入 BY_ID 且 id 不冲突', () => {
    const basic = BLOOD_MARKET_DEFS.reduce((s, d) => s + d.count, 0);
    expect(basic).toBe(57);
    expect(BLOOD_MARKET_DEFS.every((d) => !d.expansion)).toBe(true);
    const expansion = BLOOD_MARKET_EXPANSION_DEFS.reduce((s, d) => s + d.count, 0);
    expect(BLOOD_MARKET_EXPANSION_DEFS.every((d) => d.expansion)).toBe(true);
    const total = [...BLOOD_MARKET_BY_ID.values()].reduce((s, d) => s + d.count, 0);
    expect(total).toBe(basic + expansion);
    const ids = new Set(BLOOD_MARKET_DEFS.map((d) => d.id));
    expect(BLOOD_MARKET_EXPANSION_DEFS.every((d) => !ids.has(d.id))).toBe(true);
  });
});
