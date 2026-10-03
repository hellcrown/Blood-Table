/**
 * 全面审查（2026-10-03）批次 B5 的补充回归测试：血幕镀层（夺）的多次掠夺。
 *
 * 卡面：「【对决】选择并掠夺一位对手 1 血筹」——**每张各自掠夺 1 点、各自选目标**。
 * 但引擎原先把同一玩家挂的多张镀层合并成"总额"（blood += 1 累加）后要求**单一目标**持有那么多血筹：
 * 对手各只有 1 血筹时，两张镀层会整体落空（无合法目标），凭空亏掉两张牌。
 */
import { describe, expect, it } from 'vitest';
import { bSteal, bUseItem, createBloodGame } from '../src/blood/engine';
import type { BloodState } from '../src/blood/types';

const NOW = 1_000_000;

function make3p(): BloodState {
  return createBloodGame(
    3,
    [
      { id: 'p0', name: '甲', seat: 0 },
      { id: 'p1', name: '乙', seat: 1 },
      { id: 'p2', name: '丙', seat: 2 },
    ],
    NOW,
  );
}

/** 甲在自己两张出牌上各插一张血幕镀层（夺），并打开甲的亮牌窗口（走真实路径：上家宣告完毕） */
function reachRevealWithTwoSteals(): BloodState {
  const gs = make3p();
  const me = gs.players[0];
  me.play = me.draw.splice(0, 2);
  me.chips.push({ id: 'ch-a', def: 'coatSteal', on: me.play[0].id });
  me.chips.push({ id: 'ch-b', def: 'coatSteal', on: me.play[1].id });
  // 两位对手都只有 1 血筹：合并口径下"需要某个目标 ≥2"→ 整体落空
  gs.players[1].blood = 1;
  gs.players[2].blood = 1;
  // 给甲留一张消磁枪：掠夺结算完毕后窗口仍需等他宣告道具，于是不会立刻推进到结算
  // （否则结算按名次发血筹，会把"掠夺拿了多少"的断言搅乱）
  me.items.push({ id: 'it-demag', def: 'demag' });
  gs.phase = 'reveal';
  // 特权证给丙：亮牌顺序为 [2,0,1]，于是丙宣告完毕后窗口轮到甲（甲是顺序里的下一个）
  gs.privilegeSeat = 2;
  gs.turnSeat = 2;
  gs.players[2].play = gs.players[2].draw.splice(0, 5);
  bUseItem(gs, 'p2', null, NOW); // 丙宣告完毕 → 窗口轮到甲
  return gs;
}

describe('批次 B5 · 血幕镀层（夺）×2：各自掠夺 1 血筹、分别选目标', () => {
  it('两张镀层不会因"没有单一目标持有 2 血筹"而整体落空', () => {
    const gs = reachRevealWithTwoSteals();
    const me = gs.players[0];
    expect(gs.stealPending?.seat).toBe('p0'); // 窗口已轮到甲且挂起待选目标
    expect(gs.stealPending?.blood).toBe(1); // 每次掠夺 1 点（修复前为 2）
    expect(me.blood).toBe(3); // 尚未掠夺
  });

  it('第一次掠夺 1 点后仍保留第二次选择（不一次抢光同一人）', () => {
    const gs = reachRevealWithTwoSteals();
    const me = gs.players[0];
    bSteal(gs, 'p0', 1, NOW);
    expect(gs.players[1].blood).toBe(0);
    expect(me.blood).toBe(4); // 只拿到 1 点
    expect(gs.stealPending?.seat).toBe('p0'); // 还剩一次，仍在等甲选目标
  });

  it('第二次可以选择另一位对手：两张镀层各得 1 血筹', () => {
    const gs = reachRevealWithTwoSteals();
    const me = gs.players[0];
    bSteal(gs, 'p0', 1, NOW);
    bSteal(gs, 'p0', 2, NOW);
    expect(gs.players[1].blood).toBe(0);
    expect(gs.players[2].blood).toBe(0);
    expect(me.blood).toBe(5); // 3 + 2
    expect(gs.stealPending).toBeNull(); // 两次都用完
  });
});
