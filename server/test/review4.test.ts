/**
 * 第四轮审查回修回归测试：
 * - H1 掠夺重入：bSteal 在芯片决策挂起未清时拒绝（防 settle 二次结算全场奖励翻倍）
 * - H2 掠夺残留：决策超时/异主残留的 stealPending 由 tick 落空清理（防对局永久卡死）
 * - M1 消磁枪覆盖挂起：任何存活 secretPending 期间禁止使用道具（屏障被扣但询问丢失）
 * - M2 barrierAsk 泄漏进删牌阶段：bPassBuy 拒绝（否则受害者永远 PENDING 卡死）
 * - M4 黑客双重构筑：hackerSetup 挂起未决时 bSetup 拒绝
 * - M5 走私客标记漂移：购买补位后按 defId 重新定位（防误收过路费）
 * - M3 拍卖得牌：道具牌结算时即发放；得牌者被预设跳过购买时 endBuy 兜底补发
 */
import { describe, expect, it } from 'vitest';
import {
  bAuctionBid,
  bBuy,
  bCrownBid,
  bPassBuy,
  bPickChar,
  bSetup,
  bSteal,
  bUseItem,
  bloodTick,
  createBloodGame,
} from '../src/blood/engine';
import type { BloodState } from '../src/blood/types';

const NOW = 1000;

/** 建局：2 人局选荷官（无开局技能干扰）→ 竞拍全员出 0 → setup 阶段 */
function makeGame(): BloodState {
  const gs = createBloodGame(2, [
    { id: 'p0', name: '甲', seat: 0 },
    { id: 'p1', name: '乙', seat: 1 },
  ], NOW);
  for (const p of gs.players) {
    p.charOptions = ['dealer', 'noble'];
    bPickChar(gs, p.id, 'dealer', NOW);
  }
  for (const p of gs.players) bCrownBid(gs, p.id, 0, NOW);
  return gs;
}

describe('H1：掠夺重入防线', () => {
  it('bSteal 在 secretPending 存活时拒绝；清空后正常掠夺', () => {
    const gs = makeGame();
    gs.phase = 'reveal';
    gs.turnSeat = 0;
    gs.privilegeSeat = 0; // 固定亮牌顺序 [p0,p1]：竞拍平局掷骰是随机的，防用例抖动
    gs.players[0]!.blood = 5;
    gs.players[1]!.blood = 5;
    gs.stealPending = { seat: 'p0', blood: 1 };
    gs.secretPending = { seat: 'p0', kind: 'revealDecide' };
    expect(() => bSteal(gs, 'p0', 1, NOW)).toThrow(/决策/);
    gs.secretPending = null;
    // p1 持有道具：其窗口保持等待（否则 openRevealWindow 会连跳至结算，干扰断言）
    gs.players[1]!.items.push({ id: 'blk', def: 'demag' });
    bSteal(gs, 'p0', 1, NOW);
    expect(gs.players[1]!.blood).toBe(4);
    expect(gs.players[0]!.blood).toBe(6);
    expect(gs.stealPending).toBeNull();
  });
});

describe('H2：掠夺残留由 tick 落空清理', () => {
  it('revealDecide 超时：同主的未结清 stealPending 一并落空并推进窗口', () => {
    const gs = makeGame();
    gs.phase = 'reveal';
    gs.turnSeat = 0;
    gs.privilegeSeat = 0; // 固定顺序：推进断言依赖下家是 p1
    gs.deadline = NOW + 60_000;
    gs.secretPending = { seat: 'p0', kind: 'revealDecide' };
    gs.stealPending = { seat: 'p0', blood: 1 };
    bloodTick(gs, NOW + 61_000);
    expect(gs.secretPending).toBeNull();
    expect(gs.stealPending).toBeNull();
    expect(gs.turnSeat).toBe(1); // 已推进到下家窗口（不再卡在原窗口）
  });

  it('异主 stealPending 残留：tick 落空清理（此前对窗口玩家重放 bUseItem 永久空转）', () => {
    const gs = makeGame();
    gs.phase = 'reveal';
    gs.turnSeat = 0;
    gs.deadline = NOW + 60_000;
    gs.stealPending = { seat: 'p1', blood: 1 }; // 属主不是当前窗口玩家
    bloodTick(gs, NOW + 61_000);
    expect(gs.stealPending).toBeNull();
  });
});

describe('M1：消磁枪不得覆盖存活挂起', () => {
  it('barrierAsk 存活时 bUseItem 拒绝（防屏障被扣但反制询问丢失）', () => {
    const gs = makeGame();
    gs.phase = 'reveal';
    gs.turnSeat = 0;
    gs.players[0]!.items.push({ id: 'it1', def: 'demag' });
    gs.secretPending = { seat: 'p1', kind: 'barrierAsk' };
    expect(() => bUseItem(gs, 'p0', 'it1', NOW)).toThrow(/挂起/);
    expect(gs.players[0]!.items).toHaveLength(1); // 道具未被消耗
    gs.secretPending = null;
    bUseItem(gs, 'p0', 'it1', NOW); // 清空后正常进入消磁链
    expect(gs.secretPending?.kind).toBe('demagTarget');
  });
});

describe('M2：barrierAsk 不得随 endBuy 泄漏', () => {
  it('他人 barrierAsk 存活时 bPassBuy 拒绝', () => {
    const gs = makeGame();
    gs.phase = 'buy';
    gs.turnSeat = 0;
    for (const p of gs.players) p.buyPassed = false;
    gs.secretPending = { seat: 'p1', kind: 'barrierAsk' };
    expect(() => bPassBuy(gs, 'p0', NOW)).toThrow(/互动/);
    expect(gs.players[0]!.buyPassed).toBe(false);
  });
});

describe('M4：hackerSetup 挂起未决时 bSetup 拒绝', () => {
  it('本人挂起拒绝（防双重初始构筑）；他人不受影响', () => {
    const gs = makeGame(); // setup 阶段
    expect(gs.phase).toBe('setup');
    gs.secretPending = { seat: 'p0', kind: 'hackerSetup' };
    expect(() => bSetup(gs, 'p0', [], NOW)).toThrow(/抉择/);
    expect(() => bSetup(gs, 'p1', [], NOW)).not.toThrow();
  });
});

describe('M5：走私客标记购买补位后重新定位', () => {
  it('买空非标记栏位导致右推后，标记跟随被标记的牌（defId 定位）', () => {
    const gs = makeGame();
    gs.phase = 'buy';
    gs.turnSeat = 0;
    gs.supply.push('dealerLic'); // 补位来源
    gs.market = [
      { def: 'dealerLic', bonus: 0 }, // slot0 ← 标记这张
      { def: 'demag', bonus: 0 },     // slot1 ← 买这张（道具立即结算触发补位）
      { def: null, bonus: 0 },
      { def: null, bonus: 0 },
      { def: null, bonus: 0 },
    ];
    gs.smugglerMark = { slot: 0, by: 'p1', defId: 'dealerLic' };
    const p0 = gs.players[0]!;
    p0.blood = 50;
    for (const p of gs.players) p.buyPassed = false;
    bBuy(gs, 'p0', 1, undefined, NOW);
    // demag 被买空补位：补位会连续填满空栏，被标记的 dealerLic 整体右移——
    // 标记必须始终指向 dealerLic 现所在栏位（此前停在旧 slot0，会让他人在新栏位误付过路费）
    const dlSlot = gs.market.findIndex((m) => m.def === 'dealerLic');
    expect(dlSlot).toBeGreaterThan(0); // 确实发生了右移
    expect(gs.smugglerMark?.slot).toBe(dlSlot);
  });

  it('被标记的牌被买走：标记作废（不转移到补位新牌）', () => {
    const gs = makeGame();
    gs.phase = 'buy';
    gs.turnSeat = 0;
    gs.supply.push('calib1'); // 补位来源：与被标记的 dealerLic 不同 def，防同 id 误定位
    gs.market = [
      { def: 'calib1', bonus: 0 },
      { def: 'dealerLic', bonus: 0 }, // ← 标记这张，且它就是被买走的
      { def: null, bonus: 0 },
      { def: null, bonus: 0 },
      { def: null, bonus: 0 },
    ];
    gs.smugglerMark = { slot: 1, by: 'p1', defId: 'dealerLic' };
    const p0 = gs.players[0]!;
    p0.blood = 50;
    // p0 非走私客：先付 2 过路费再购买（标记生效口径保持）
    for (const p of gs.players) p.buyPassed = false;
    bBuy(gs, 'p0', 1, undefined, NOW);
    expect(gs.smugglerMark).toBeNull();
  });
});

describe('M3：拍卖得牌不蒸发', () => {
  it('道具牌在叫价结算时立即发放（不等购买回合）', () => {
    const gs = makeGame();
    gs.phase = 'buy';
    const p1 = gs.players[1]!;
    p1.blood = 5;
    gs.auction = { defId: 'dealerLic', highest: 2, highestBy: 'p1', queue: [], by: 'p0' };
    gs.secretPending = { seat: 'p1', kind: 'auctionBid', amount: 2 };
    bAuctionBid(gs, 'p1', 0, NOW); // 最后一位不再加价 → 结算
    expect(gs.auction).toBeNull();
    expect(p1.items.some((i) => i.def === 'dealerLic')).toBe(true);
    expect(p1.blood).toBe(3); // 5 − 2
  });

  it('得牌者被预设跳过购买时：endBuy 兜底补发芯片（自动插入合法宿主）', () => {
    const gs = makeGame();
    gs.phase = 'buy';
    gs.turnSeat = 1; // 最后执行跳过的玩家
    const p0 = gs.players[0]!;
    p0.blood = 5;
    p0.discard.push({ id: 'dx', r: 5, s: 'h' });
    for (const p of gs.players) p.buyPassed = true; // p0（得牌者）被编剧/闭店礼预设跳过
    gs.players[1]!.buyPassed = false;
    gs.auction = { defId: 'calib1', highest: 2, highestBy: 'p0', queue: [], by: 'p1' };
    bPassBuy(gs, 'p1', NOW); // 最后一人跳过 → endBuy
    expect(gs.auction).toBeNull();
    expect(gs.phase).toBe('remove');
    expect(p0.chips.some((ch) => ch.on === 'dx')).toBe(true); // 自动插入弃牌区宿主牌
    expect(p0.blood).toBe(5); // 测试未实际扣拍卖款；此处验证不触发退款路径
  });

  it('endBuy 兜底：无合法芯片宿主时退血筹并弃置', () => {
    const gs = makeGame();
    gs.phase = 'buy';
    gs.turnSeat = 1; // 最后执行跳过的玩家
    const p0 = gs.players[0]!;
    p0.blood = 5; // 付 2 后剩 3，且弃牌区为空（无宿主）
    for (const p of gs.players) p.buyPassed = true;
    gs.players[1]!.buyPassed = false;
    gs.auction = { defId: 'calib1', highest: 2, highestBy: 'p0', queue: [], by: 'p1' };
    bPassBuy(gs, 'p1', NOW);
    expect(gs.auction).toBeNull();
    expect(p0.blood).toBe(7); // 5 + 退还 2（测试未实际扣款，验证退款金额正确）
    expect(gs.recycle).toContain('calib1');
    expect(p0.chips).toHaveLength(0);
  });
});
