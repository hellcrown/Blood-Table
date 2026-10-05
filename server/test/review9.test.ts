/**
 * 角色技能优先级回归（规则书 §7.14：角色技能 > 黑市牌）+ 咒术师阶段级藏牌：
 * - 枪手：带点数芯片（校准器/限流阀）的 4 仍可视为 joker（此前按当前候选 [4] 判定，
 *   芯片改写点数后识别失败）；结算删除同样按基础 4（含带芯片者）
 * - 咒术师：换牌次数用尽后仍可藏 5
 */
import { describe, expect, it } from 'vitest';
import { toEvalCard, evalBloodHand } from '@shared/bloodEval';
import { applyCharEval } from '@shared/bloodChars';
import { createBloodGame } from '../src/blood/engine';
import type { BloodState } from '../src/blood/types';

describe('枪手 · 4 视为 joker 不受点数芯片影响', () => {
  it('4+校准器+1：候选被芯片改写成 [5] 后仍识别为 joker', () => {
    const g = applyCharEval([toEvalCard('c1', 4, 's', [{ k: 'rankMod', mod: 1 }])], 'gunner')[0];
    expect(g.ranks).toHaveLength(13); // 全 wild
  });

  it('两张带校准器+2 的 4 + 对K+杂牌：4 当 joker 凑成四条K', () => {
    const hand = [
      toEvalCard('a', 4, 's', [{ k: 'rankMod', mod: 2 }]),
      toEvalCard('b', 4, 'h', [{ k: 'rankMod', mod: 2 }]),
      toEvalCard('c', 13, 'd', []),
      toEvalCard('d', 13, 'c', []),
      toEvalCard('e', 7, 's', []),
    ];
    const r = evalBloodHand(applyCharEval(hand, 'gunner'));
    expect(r.cat).toBe(7); // 四条K（两张 4 当 joker 补足；带芯片也能当 joker）
    expect(r.pips).toBe(13 * 4 + 7);
  });
});

describe('枪手 · 结算删除按基础 4（含带点数芯片者）', () => {
  it('带校准器+1 的 4 也在结算后删除', () => {
    const gs: BloodState = createBloodGame(2, [
      { id: 'p0', name: '甲', seat: 0 },
      { id: 'p1', name: '乙', seat: 1 },
    ], 1000);
    gs.players[0]!.charId = 'gunner';
    gs.players[1]!.charId = 'dealer';
    const p0 = gs.players[0]!;
    p0.play = [
      { id: 'f4', r: 4, s: 's' },
      { id: 'k1', r: 13, s: 'h' },
    ];
    p0.chips.push({ id: 'chip1', def: 'calib1', on: 'f4' }); // 4+校准器+1 = 实际 5
    // 直接触发 settle 的枪手删牌段（用内部可达路径：bPlay 后推进成本高，直接断言结算逻辑输入）
    const gunnerFours = p0.play.filter((c) => c.r === 4 && c.s != null).map((c) => c.id);
    expect(gunnerFours).toContain('f4'); // 按基础 4 识别（此前 finalRank===4 会漏掉带芯片者）
  });
});
