/**
 * 塔罗师分步换牌回归测试（等量置换语义：抽几必须弃几，换牌结束时手牌数不变）：
 * - 先抽（bSwapDraw 1-2）立即到手、不消耗换牌次数、不补至上限
 * - 弃置步（bSwap drawCount=0）须弃置恰好等量的牌：完成后计次、清暂存、手牌数还原
 * - 先抽后停止换牌被拒（防借停止白拿抽到的牌）；超时托管自动弃置先抽的牌
 * - 旧合体路径（bSwap drawCount>0）同样强制配对（bot 本就按 drop.length 发 drawCount，兼容）
 * - 防线：非塔罗拒绝、重复先抽拒绝、弃置数量不符拒绝、先抽日志不泄牌面
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

describe('塔罗师 · 分步换牌（等量置换）', () => {
  it('先抽 1 弃 1：立即到手、完成时手牌数还原、计次、清暂存', () => {
    const gs = tarotSwapGame();
    const p0 = gs.players[0]!;
    const handBefore = p0.hand.length;
    bSwapDraw(gs, 'p0', 1, NOW);
    expect(p0.hand.length).toBe(handBefore + 1);
    expect(p0.swapLeft).toBe(3); // 先抽不消耗换牌次数
    expect(p0.swapDrawnIds).toHaveLength(1);
    // 弃置步：可与原手牌混合选择，弃恰好 1 张
    const discardId = p0.hand[0]!.id;
    bSwap(gs, 'p0', [discardId], 0, NOW + 1);
    expect(p0.swapDrawnIds).toHaveLength(0);
    expect(p0.swapLeft).toBe(2); // 弃置步才计次
    expect(p0.hand.length).toBe(handBefore); // 等量置换：手牌数不变
    expect(p0.discard.some((c) => c.id === discardId)).toBe(true);
  });

  it('先抽 2 必须弃 2：弃 0/弃 1 均拒绝；弃 2 完成后手牌还原', () => {
    const gs = tarotSwapGame();
    const p0 = gs.players[0]!;
    const handBefore = p0.hand.length;
    bSwapDraw(gs, 'p0', 2, NOW);
    expect(() => bSwap(gs, 'p0', [], 0, NOW + 1)).toThrow(/相同的牌（2 张）/);
    expect(() => bSwap(gs, 'p0', [p0.hand[0]!.id], 0, NOW + 1)).toThrow(/相同的牌（2 张）/);
    expect(p0.swapLeft).toBe(3); // 被拒动作不产生任何消耗
    const two = p0.hand.slice(0, 2).map((c) => c.id);
    bSwap(gs, 'p0', two, 0, NOW + 1);
    expect(p0.swapLeft).toBe(2);
    expect(p0.hand.length).toBe(handBefore); // 6+2-2
    for (const id of two) expect(p0.discard.some((c) => c.id === id)).toBe(true);
  });

  it('先抽后停止换牌被拒（防白拿）；完成弃置后可正常停止', () => {
    const gs = tarotSwapGame();
    const p0 = gs.players[0]!;
    bSwapDraw(gs, 'p0', 2, NOW);
    const drawnIds = [...p0.swapDrawnIds];
    expect(() => bSwapStop(gs, 'p0', NOW + 1)).toThrow(/先完成本次换牌/);
    expect(p0.swapDone).toBe(false);
    expect(p0.swapDrawnIds).toHaveLength(2); // 暂存未被洗掉
    // 完成等量弃置后再停止：正常
    bSwap(gs, 'p0', drawnIds, 0, NOW + 1);
    bSwapStop(gs, 'p0', NOW + 2);
    expect(p0.swapDone).toBe(true);
    expect(p0.swapLeft).toBe(2);
    for (const id of drawnIds) expect(p0.discard.some((c) => c.id === id)).toBe(true);
  });

  it('超时托管：先抽未弃者自动弃置先抽的等量牌（不卡死也不白拿）', () => {
    const gs = tarotSwapGame();
    const p0 = gs.players[0]!;
    const handAtStart = p0.hand.length;
    bSwapDraw(gs, 'p0', 2, NOW);
    const drawnIds = [...p0.swapDrawnIds];
    // 推进 tick 到换牌超时托管（deadline = NOW + 60s）
    bloodTick(gs, NOW + 61_000);
    expect(p0.swapDone).toBe(true);
    expect(p0.swapDrawnIds).toHaveLength(0);
    expect(p0.hand.length).toBe(handAtStart); // 弃置先抽的 2 张，补至上限口径下回到原手牌数
    for (const id of drawnIds) expect(p0.discard.some((c) => c.id === id)).toBe(true);
  });

  it('防线：重复先抽/数量越界/非塔罗/弃置步再抽 全部拒绝', () => {
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

  it('旧合体路径保持等量语义且兼容 bot（本就按弃数发抽数）：抽 2 弃 2 一次完成', () => {
    const gs = tarotSwapGame();
    const p0 = gs.players[0]!;
    const handBefore = p0.hand.length;
    const two = p0.hand.slice(0, 2).map((c) => c.id);
    bSwap(gs, 'p0', two, 2, NOW);
    expect(p0.swapLeft).toBe(2);
    expect(p0.swapDrawnIds).toHaveLength(0);
    for (const id of two) expect(p0.discard.some((c) => c.id === id)).toBe(true);
    expect(p0.hand.length).toBe(handBefore);
    // 不配对（抽 2 弃 1）在合体路径同样拒绝
    expect(() => bSwap(gs, 'p0', [p0.hand[0]!.id], 2, NOW)).toThrow(/须弃置 2 张/);
  });

  it('先抽日志只记张数，不泄牌面（弃牌区/手牌私有）', () => {
    const gs = tarotSwapGame();
    bSwapDraw(gs, 'p0', 2, NOW);
    const leak = gs.log.filter((l) => l.text.includes('先抽') && /[♠♥♦♣]/.test(l.text));
    expect(leak).toHaveLength(0);
  });
});
