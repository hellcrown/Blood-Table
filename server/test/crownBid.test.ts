/**
 * 特权证暗标竞拍（规则创新）回归测试：
 * - 时序：建局先选将（2人局）/随机分配（基础池 3/4 人局），选将完成后进入 crownBid 竞拍
 * - 每人密封出价 0~3（0=不参与），最高者得证（开局血筹 = 3 − 出价，其余 3），平局掷骰定得主
 * - 超时托管按 0 出价；江东之主夺证：竞拍作废、原持证者出价退还，血筹修正为原版 2/3
 */
import { describe, expect, it } from 'vitest';
import { BloodError, bCrownBid, bPickChar, bResign, bloodTick, createBloodGame } from '../src/blood/engine';
import type { BloodState } from '../src/blood/types';

const NOW = 1000;

function make2p(): BloodState {
  return createBloodGame(2, [
    { id: 'p0', name: '甲', seat: 0 },
    { id: 'p1', name: '乙', seat: 1 },
  ], NOW);
}

/** 全员强制选「赌场荷官」（无开局血筹效果）→ 进入 crownBid，保证竞拍结算断言不受随机角色干扰 */
function pickAll(gs: BloodState): void {
  for (const p of gs.players) {
    p.charOptions = ['dealer', 'noble'];
    bPickChar(gs, p.id, 'dealer', NOW);
  }
}

describe('特权证暗标竞拍 · 时序（选将后）', () => {
  it('建局先选将：2人局 phase=pick，角色牌已发、血筹全 3、无特权证', () => {
    const gs = make2p();
    expect(gs.phase).toBe('pick');
    expect(gs.players.every((p) => p.charOptions.length === 2)).toBe(true);
    expect(gs.players.every((p) => p.blood === 3)).toBe(true);
    expect(gs.players.every((p) => !p.privilege)).toBe(true);
    expect(gs.privilegeSeat).toBeNull();
    expect(Object.keys(gs.crownBids)).toHaveLength(0);
  });

  it('选将完成前出价被拒（BAD_PHASE）；全员选完进入 crownBid', () => {
    const gs = make2p();
    expect(() => bCrownBid(gs, 'p0', 1, NOW)).toThrow(BloodError);
    pickAll(gs);
    expect(gs.phase).toBe('crownBid');
    expect(gs.players.every((p) => p.charId != null)).toBe(true);
  });

  it('竞拍阶段禁止投降（否则凭空产生冠军且可刷天梯胜场）', () => {
    const gs = make2p();
    pickAll(gs);
    expect(() => bResign(gs, 'p0', NOW)).toThrow(BloodError);
    // 结算后（setup 阶段）同样拒绝
    for (const p of gs.players) bCrownBid(gs, p.id, 1, NOW);
    expect(() => bResign(gs, 'p0', NOW)).toThrow(BloodError);
  });
});

describe('特权证暗标竞拍 · 结算', () => {
  it('出价边界：-1/4/NaN 拒绝、0 合法；重复出价静默忽略；非竞拍阶段拒绝', () => {
    const gs = make2p();
    pickAll(gs);
    expect(() => bCrownBid(gs, 'p0', -1, NOW)).toThrow();
    expect(() => bCrownBid(gs, 'p0', 4, NOW)).toThrow();
    expect(() => bCrownBid(gs, 'p0', Number.NaN, NOW)).toThrow();
    expect(() => bCrownBid(gs, 'ghost', 1, NOW)).toThrow(); // 不在对局中
    bCrownBid(gs, 'p0', 0, NOW); // 0 = 不参与，合法
    bCrownBid(gs, 'p0', 3, NOW); // 重复出价忽略
    expect(gs.crownBids['p0']).toBe(0);
    expect(gs.phase).toBe('crownBid'); // 未全员出价不结算
    // 结算后阶段守卫生效
    bCrownBid(gs, 'p1', 1, NOW);
    expect(gs.phase).toBe('setup');
    expect(() => bCrownBid(gs, 'p0', 1, NOW)).toThrow();
  });

  it('最高价得证：出价 3 者开局 0 血筹，其余 3；2人局结算后进入初始构筑', () => {
    const gs = make2p();
    pickAll(gs);
    bCrownBid(gs, 'p0', 1, NOW);
    bCrownBid(gs, 'p1', 3, NOW);
    const winner = gs.players.find((p) => p.privilege)!;
    const loser = gs.players.find((p) => !p.privilege)!;
    expect(winner.id).toBe('p1');
    expect(winner.blood).toBe(0); // 3 − 出价3
    expect(loser.blood).toBe(3);
    expect(gs.privilegeSeat).toBe(winner.seat);
    expect(gs.phase).toBe('setup');
  });

  it('平局掷骰：恰好一人得证（血筹 = 3 − 出价），其余 3', () => {
    for (let i = 0; i < 20; i++) {
      const gs = make2p();
      pickAll(gs);
      bCrownBid(gs, 'p0', 2, NOW);
      bCrownBid(gs, 'p1', 2, NOW);
      const holders = gs.players.filter((p) => p.privilege);
      expect(holders).toHaveLength(1);
      expect(holders[0]!.blood).toBe(1);
      expect(gs.players.find((p) => !p.privilege)!.blood).toBe(3);
    }
  });

  it('出价 0 得证者不扣血筹（3 血筹白得）；其余 3', () => {
    const gs = make2p();
    pickAll(gs);
    bCrownBid(gs, 'p0', 0, NOW);
    bCrownBid(gs, 'p1', 1, NOW);
    const winner = gs.players.find((p) => p.privilege)!;
    expect(winner.id).toBe('p1');
    expect(winner.blood).toBe(2); // 3 − 1
    expect(gs.players.find((p) => !p.privilege)!.blood).toBe(3);
  });

  it('全员出 0：掷骰产生免费持证者（全员 3 血筹）', () => {
    for (let i = 0; i < 20; i++) {
      const gs = make2p();
      pickAll(gs);
      for (const p of gs.players) bCrownBid(gs, p.id, 0, NOW);
      expect(gs.players.filter((p) => p.privilege)).toHaveLength(1);
      expect(gs.players.every((p) => p.blood === 3)).toBe(true);
    }
  });

  it('超时托管两级：选将超时自动选将 → 竞拍超时按 0（不参与）出价', () => {
    const gs = make2p();
    bloodTick(gs, NOW + 61_000); // 选将超时：全员自动选第一张
    expect(gs.phase).toBe('crownBid');
    expect(gs.players.every((p) => p.charId != null)).toBe(true);
    bloodTick(gs, NOW + 122_000); // 竞拍超时：按 0 托管
    expect(gs.players.every((p) => gs.crownBids[p.id] === 0)).toBe(true);
    expect(gs.players.every((p) => p.wasAuto === true)).toBe(true);
    expect(gs.phase).toBe('setup');
  });

  it('3人局：建局随机分配角色后直接进入竞拍，结算后进初始构筑', () => {
    const gs = createBloodGame(3, [
      { id: 'p0', name: '甲', seat: 0 },
      { id: 'p1', name: '乙', seat: 1 },
      { id: 'p2', name: '丙', seat: 2 },
    ], NOW);
    expect(gs.phase).toBe('crownBid'); // 基础池随机分配：无选将交互，直接竞拍
    expect(gs.players.every((p) => p.charId != null)).toBe(true);
    bCrownBid(gs, 'p0', 3, NOW);
    bCrownBid(gs, 'p1', 2, NOW);
    bCrownBid(gs, 'p2', 2, NOW); // 与 p1 平局掷骰
    expect(gs.phase).toBe('setup');
    const holder = gs.players.find((p) => p.privilege)!;
    expect(holder.id).toBe('p0'); // 唯一最高价得证
    // 竞拍后 0 血筹；开局角色效果（贵族+12/银行职员+2）在此之后叠加
    const startBonus = holder.charId === 'noble' ? 12 : holder.charId === 'clerk' ? 2 : 0;
    expect(holder.blood).toBe(startBonus);
    // 其余人不因竞拍扣血筹（≥3：可能叠加开局加血效果）
    expect(gs.players.filter((p) => p !== holder).every((p) => p.blood >= 3)).toBe(true);
  });
});

describe('特权证暗标竞拍 · 江东之主在场（拍卖作废）', () => {
  it('sunwu 在场：拍卖整体作废，任何出价不扣血筹，sunwu 血筹修正为 2', () => {
    const gs = make2p();
    gs.players[0].charOptions = ['dealer', 'noble'];
    gs.players[1].charOptions = ['sunwu', 'clerk'];
    bPickChar(gs, 'p0', 'dealer', NOW);
    bPickChar(gs, 'p1', 'sunwu', NOW);
    expect(gs.phase).toBe('crownBid');
    bCrownBid(gs, 'p0', 3, NOW); // 出最高价也不得证、不扣血筹
    bCrownBid(gs, 'p1', 1, NOW);
    expect(gs.players.find((p) => p.id === 'p1')!.privilege).toBe(true);
    expect(gs.privilegeSeat).toBe(1);
    expect(gs.players.find((p) => p.id === 'p1')!.blood).toBe(2); // 原版「始终拥有」：2
    expect(gs.players.find((p) => p.id === 'p0')!.blood).toBe(3); // 拍卖作废：未扣
  });

  it('sunwu 在场且全员出 0：同样作废，sunwu 恒 2 血筹（消除平局掷骰的血筹不一致）', () => {
    const gs = make2p();
    gs.players[0].charOptions = ['sunwu', 'clerk'];
    gs.players[1].charOptions = ['dealer', 'noble'];
    bPickChar(gs, 'p0', 'sunwu', NOW);
    bPickChar(gs, 'p1', 'dealer', NOW);
    for (const p of gs.players) bCrownBid(gs, p.id, 0, NOW);
    expect(gs.players.find((p) => p.id === 'p0')!.privilege).toBe(true);
    expect(gs.players.find((p) => p.id === 'p0')!.blood).toBe(2); // 恒 2，不因「自己掷骰赢」变 3
    expect(gs.players.find((p) => p.id === 'p1')!.blood).toBe(3);
  });
});

describe('特权证暗标竞拍 · 离场预填', () => {
  it('选将前离场（引擎侧 connected=false）：进入竞拍时自动按 0 预填并立即结算，不空等托管', () => {
    const gs = make2p();
    gs.players[1].connected = false; // 模拟 rooms.handleLeave 的引擎侧离场标记
    gs.players[0].charOptions = ['dealer', 'noble'];
    gs.players[1].charOptions = ['dealer', 'noble'];
    bPickChar(gs, 'p0', 'dealer', NOW);
    expect(gs.phase).toBe('pick'); // 等待 p1
    bPickChar(gs, 'p1', 'dealer', NOW); // p1 的选将由托管完成（离场者同路径），随后进入竞拍
    expect(gs.crownBids['p1']).toBe(0); // 预填
    expect(gs.phase).toBe('crownBid'); // p0 未出价，等待中
    bCrownBid(gs, 'p0', 2, NOW);
    expect(gs.phase).toBe('setup'); // 无需再等 60s 托管
    expect(gs.players.find((p) => p.privilege)!.id).toBe('p0');
  });
});
