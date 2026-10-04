/**
 * 塔罗师分步换牌回归测试：
 * - 先抽（bSwapDraw 1-2）立即到手、不消耗换牌次数、不补至上限
 * - 弃置步（bSwap drawCount=0）完成本次换牌：弃 0-2 张、补至上限、计次、清暂存
 * - 先抽后停止：保留抽到的牌并计一次（防白嫖多看 2 张）
 * - 旧合体路径（bSwap drawCount>0 一次完成）保持兼容（bot 在用）
 * - 防线：非塔罗拒绝、重复先抽拒绝、抽后带 drawCount 拒绝、先抽日志不泄牌面
 */
import { describe, expect, it } from 'vitest';
import { bCrownBid, bPickChar, bSetup, bSwap, bSwapDraw, bSwapStop, bloodTick, createBloodGame } from '../src/blood/engine';
import type { BloodState } from '../src/blood/types';

const NOW = 1000;

/** 建局并推进到换牌阶段：p0 塔罗师、p1 荷官 */
function tarotSwapGame(): BloodState {
  const gs = createBloodGame(2, [
    { id: 'p0', name: '甲', seat: 0 },
    { id: 'p1', name: '乙', seat: 1 },
  ], NOW);
  gs.players[0]!.charOptions = ['tarot', 'dealer'];
  gs.players[1]!.charOptions = ['dealer', 'noble'];
  bPickChar(gs, 'p0', 'tarot', NOW);
  bPickChar(gs, 'p1', 'dealer', NOW);
  for (const p of gs.players) bCrownBid(gs, p.id, 0, NOW);
  for (let r = 0; r < 2; r++) for (const p of gs.players) bSetup(gs, p.id, [], NOW);
  // 抽牌阶段为自动推进：驱动到 swap
  for (let i = 0; i < 10 && gs.phase !== 'swap'; i++) bloodTick(gs, NOW + 1 + i);
  expect(gs.phase).toBe('swap');
  // 去随机化：竞拍全员出 0 会掷骰发特权证（换牌 4 次），清除后次数恒为 3
  for (const p of gs.players) {
    p.privilege = false;
    p.swapLeft = 3;
    p.swapDrawnIds = [];
  }
  return gs;
}

describe('塔罗师 · 分步换牌', () => {
  it('先抽 2 张：立即到手、不消耗次数、不补上限、暂存记录；弃置步完成换牌', () => {
    const gs = tarotSwapGame();
    const p0 = gs.players[0]!;
    const handBefore = p0.hand.length;
    bSwapDraw(gs, 'p0', 2, NOW);
    expect(p0.hand.length).toBe(handBefore + 2);
    expect(p0.swapLeft).toBe(3); // 先抽不消耗换牌次数
    expect(p0.swapDrawnIds).toHaveLength(2);
    expect(p0.swapDone).toBe(false);
    // 抽到的牌 id 都在手牌中
    for (const id of p0.swapDrawnIds) expect(p0.hand.some((c) => c.id === id)).toBe(true);
    // 弃置步：弃 1 张完成
    const discardId = p0.swapDrawnIds[0]!;
    bSwap(gs, 'p0', [discardId], 0, NOW + 1);
    expect(p0.swapDrawnIds).toHaveLength(0);
    expect(p0.swapLeft).toBe(2); // 弃置步才计次
    // 既有语义：先抽使手牌可超上限（6+2-1=7，drawToCap 只补不弃），与旧合体路径一致
    expect(p0.hand.length).toBe(handBefore + 1);
    expect(p0.discard.some((c) => c.id === discardId)).toBe(true);
  });

  it('先抽后不弃置：bSwap 空弃置完成，牌保留、计次、补上限', () => {
    const gs = tarotSwapGame();
    const p0 = gs.players[0]!;
    bSwapDraw(gs, 'p0', 1, NOW);
    const handAfterDraw = p0.hand.length;
    bSwap(gs, 'p0', [], 0, NOW + 1);
    expect(p0.swapLeft).toBe(2);
    expect(p0.swapDrawnIds).toHaveLength(0);
    expect(p0.hand.length).toBe(7); // 6+1：不弃则净得 1 张（与旧合体路径同口径）
    expect(handAfterDraw).toBe(7);
  });

  it('先抽后停止换牌：保留抽到的牌并计一次（防白嫖）', () => {
    const gs = tarotSwapGame();
    const p0 = gs.players[0]!;
    bSwapDraw(gs, 'p0', 2, NOW);
    const drawnIds = [...p0.swapDrawnIds];
    bSwapStop(gs, 'p0', NOW + 1);
    expect(p0.swapDone).toBe(true);
    expect(p0.swapLeft).toBe(2);
    expect(p0.swapDrawnIds).toHaveLength(0);
    for (const id of drawnIds) expect(p0.hand.some((c) => c.id === id)).toBe(true); // 牌保留在手
  });

  it('防线：重复先抽/数量越界/非塔罗/抽后再抽 全部拒绝', () => {
    const gs = tarotSwapGame();
    const p0 = gs.players[0]!;
    const p1 = gs.players[1]!;
    expect(() => bSwapDraw(gs, 'p0', 0, NOW)).toThrow(/1-2/);
    expect(() => bSwapDraw(gs, 'p0', 3, NOW)).toThrow(/1-2/);
    expect(() => bSwapDraw(gs, 'p1', 1, NOW)).toThrow(/塔罗师/); // 非塔罗
    bSwapDraw(gs, 'p0', 1, NOW);
    expect(() => bSwapDraw(gs, 'p0', 1, NOW)).toThrow(/已先抽过/);
    expect(() => bSwap(gs, 'p0', [], 2, NOW + 1)).toThrow(/已先抽牌/); // 弃置步不得再抽
    expect(p0.swapLeft).toBe(3); // 被拒动作不产生任何消耗
  });

  it('旧合体路径保持兼容（bot 在用）：一次消息完成先抽+弃置', () => {
    const gs = tarotSwapGame();
    const p0 = gs.players[0]!;
    const first = p0.hand[0]!.id;
    bSwap(gs, 'p0', [first], 2, NOW);
    expect(p0.swapLeft).toBe(2);
    expect(p0.swapDrawnIds).toHaveLength(0);
    expect(p0.discard.some((c) => c.id === first)).toBe(true);
    expect(p0.hand.length).toBe(7); // 6+2-1：先抽超出上限为既有设计
  });

  it('先抽日志只记张数，不泄牌面（弃牌区/手牌私有）', () => {
    const gs = tarotSwapGame();
    bSwapDraw(gs, 'p0', 2, NOW);
    const leak = gs.log.filter((l) => l.text.includes('先抽') && /[♠♥♦♣]/.test(l.text));
    expect(leak).toHaveLength(0);
  });
});
