/**
 * 全面审查（2026-10-03）批次 A 的回归测试：致命对局缺陷。
 *
 * 本文件的第一批用例在修复前**必须失败**——它们复现的是「对局永久卡死」：
 * 跨玩家的挂起（共享信息对手链 / 定点爆破受害者）如果在购买阶段结束时仍然存活，
 * 会被带进删牌阶段，而删牌阶段的托管只认 dogTarget，于是受害者的 bRemove/bRemoveDone
 * 永远抛 PENDING、被 act() 吞掉，阶段永不推进（线上表现为零推进零广播，只能解散房间）。
 */
import { describe, expect, it } from 'vitest';
import { bPassBuy, bloodTick, createBloodGame } from '../src/blood/engine';
import type { BloodState } from '../src/blood/types';

const NOW = 1000;

function make2p(): BloodState {
  return createBloodGame(
    2,
    [
      { id: 'p0', name: '甲', seat: 0 },
      { id: 'p1', name: '乙', seat: 1 },
    ],
    NOW,
  );
}

/**
 * 摆出「购买阶段即将结束，但对手身上还挂着跨人挂起」的状态。
 * 复刻真实时序：对手先跳过购买 → 买家（当前回合）买入共享信息并把挂起交给对手 → 买家点跳过购买。
 */
function reachEndBuyWithOppPending(kind: 'sharedInfoOpp' | 'pinpointVictim'): BloodState {
  const gs = make2p();
  gs.phase = 'buy';
  gs.turnSeat = 0;
  gs.privilegeSeat = 0;
  for (const p of gs.players) {
    p.buyPassed = p.id === 'p1'; // 对手已跳过购买；买家尚未
    p.removeDone = false;
  }
  gs.secretPending = { seat: 'p1', kind, max: 1, buyerId: 'p0', rank: 7 };
  gs.deadline = NOW + 60_000;
  return gs;
}

describe('批次 A · 跨人挂起不得带进删牌阶段（永久卡死）', () => {
  it('对手挂着 sharedInfoOpp 时，买家不能结束购买阶段', () => {
    const gs = reachEndBuyWithOppPending('sharedInfoOpp');
    expect(() => bPassBuy(gs, 'p0', NOW)).toThrow();
    expect(gs.phase).toBe('buy');
    expect(gs.players[0].buyPassed).toBe(false);
    expect(gs.secretPending).not.toBeNull();
  });

  it('对手挂着 pinpointVictim 时，买家不能结束购买阶段', () => {
    const gs = reachEndBuyWithOppPending('pinpointVictim');
    expect(() => bPassBuy(gs, 'p0', NOW)).toThrow();
    expect(gs.phase).toBe('buy');
    expect(gs.secretPending).not.toBeNull();
  });

  it('删牌阶段遇到无法处理的残留挂起时，托管兜底清理并推进（不再永久卡死）', () => {
    const gs = make2p();
    gs.phase = 'remove';
    gs.turnSeat = 0;
    for (const p of gs.players) p.removeDone = false;
    // 泄漏进删牌阶段的他人挂起：删牌阶段的托管不认识它
    gs.secretPending = { seat: 'p1', kind: 'sharedInfoOpp', max: 1, buyerId: 'p0' };
    gs.deadline = NOW; // 已到期，托管应立即接管

    const changed = bloodTick(gs, NOW + 1000);
    expect(changed).toBe(true);
    expect(gs.secretPending).toBeNull();
    expect(gs.phase).not.toBe('remove'); // 推进到重整阶段
  });

  it('多次超时托管后仍能走出删牌阶段（连续 20 拍不再原地打转）', () => {
    const gs = make2p();
    gs.phase = 'remove';
    gs.turnSeat = 0;
    for (const p of gs.players) p.removeDone = false;
    gs.secretPending = { seat: 'p1', kind: 'pinpointVictim', max: 1, buyerId: 'p0', rank: 7 };
    gs.deadline = NOW;
    for (let i = 0; i < 20; i++) bloodTick(gs, NOW + 61_000 * (i + 1));
    expect(gs.phase).not.toBe('remove');
  });
});

describe('批次 A · 局规模按实际开局人数（S6）', () => {
  const P = (seat: number, n = seat) => ({ id: `p${n}`, name: `玩家${n}`, seat });

  it('4 座房只坐 2 人：按 2 人局分档（目标 24 票，而非 4 人局的 16）', () => {
    const gs = createBloodGame(4, [P(0), P(1)], NOW);
    expect(gs.seatCount).toBe(2);
    expect(gs.target).toBe(24);
  });

  it('稀疏座位（1/3 号位）归一到连续 0..n-1：环绕推算（(seat+i)%seatCount）才成立', () => {
    const gs = createBloodGame(4, [P(1, 0), P(3, 1)], NOW);
    expect(gs.players.map((p) => p.seat)).toEqual([0, 1]);
    expect(gs.seatCount).toBe(2);
    expect(gs.target).toBe(24);
    // 归一化后每个座位号都必须能找到玩家（否则 (seat+i)%seatCount 会落到空位）
    for (let s = 0; s < gs.seatCount; s++) {
      expect(gs.players.some((p) => p.seat === s)).toBe(true);
    }
  });

  it('3 人局目标 20 票', () => {
    const gs = createBloodGame(3, [P(0), P(1), P(2)], NOW);
    expect(gs.seatCount).toBe(3);
    expect(gs.target).toBe(20);
  });

  it('房主自定义目标票数仍然优先于人数分档', () => {
    const gs = createBloodGame(4, [P(0), P(1)], NOW, false, false, { targetTickets: 12 });
    expect(gs.seatCount).toBe(2);
    expect(gs.target).toBe(12);
  });
});
