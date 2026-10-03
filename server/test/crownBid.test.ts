/**
 * 特权证暗标竞拍（规则创新）回归测试：
 * - 开局不再掷骰：每人密封出价 1~3，最高者得证（开局血筹 = 3 − 出价，其余 3）
 * - 平局掷骰定得主；全员出 1 时退化为原版「持证 2 血筹」平衡锚点
 * - 超时托管按最低价出价；江东之主夺证按其本人出价重算血筹
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

describe('特权证暗标竞拍 · 开局阶段', () => {
  it('建局进入 crownBid：全员 3 血筹、无特权证、竞拍未结算', () => {
    const gs = make2p();
    expect(gs.phase).toBe('crownBid');
    expect(gs.players.every((p) => p.blood === 3)).toBe(true);
    expect(gs.players.every((p) => !p.privilege)).toBe(true);
    expect(gs.privilegeSeat).toBeNull();
    expect(Object.keys(gs.crownBids)).toHaveLength(0);
  });

  it('出价边界：0/4/NaN 拒绝；重复出价静默忽略；非竞拍阶段拒绝', () => {
    const gs = make2p();
    expect(() => bCrownBid(gs, 'p0', 0, NOW)).toThrow();
    expect(() => bCrownBid(gs, 'p0', 4, NOW)).toThrow();
    expect(() => bCrownBid(gs, 'p0', Number.NaN, NOW)).toThrow();
    expect(() => bCrownBid(gs, 'ghost', 1, NOW)).toThrow(); // 不在对局中
    bCrownBid(gs, 'p0', 2, NOW);
    bCrownBid(gs, 'p0', 3, NOW); // 重复出价忽略
    expect(gs.crownBids['p0']).toBe(2);
    expect(gs.phase).toBe('crownBid'); // 未全员出价不结算
    // 结算后阶段守卫生效
    bCrownBid(gs, 'p1', 1, NOW);
    expect(gs.phase).toBe('pick');
    expect(() => bCrownBid(gs, 'p0', 1, NOW)).toThrow();
  });

  it('最高价得证：出价 3 者开局 0 血筹，其余 3；2人局随后进入选将', () => {
    const gs = make2p();
    bCrownBid(gs, 'p0', 1, NOW);
    bCrownBid(gs, 'p1', 3, NOW);
    const winner = gs.players.find((p) => p.privilege)!;
    const loser = gs.players.find((p) => !p.privilege)!;
    expect(winner.id).toBe('p1');
    expect(winner.blood).toBe(0); // 3 − 出价3
    expect(loser.blood).toBe(3);
    expect(gs.privilegeSeat).toBe(winner.seat);
    expect(gs.phase).toBe('pick');
    expect(gs.players.every((p) => p.charOptions.length === 2)).toBe(true);
  });

  it('平局掷骰：恰好一人得证（血筹 = 3 − 出价），其余 3', () => {
    for (let i = 0; i < 20; i++) {
      const gs = make2p();
      bCrownBid(gs, 'p0', 2, NOW);
      bCrownBid(gs, 'p1', 2, NOW);
      const holders = gs.players.filter((p) => p.privilege);
      expect(holders).toHaveLength(1);
      expect(holders[0]!.blood).toBe(1);
      expect(gs.players.find((p) => !p.privilege)!.blood).toBe(3);
    }
  });

  it('全员出 1 退化为原版：得证者 2 血筹、其余 3', () => {
    const gs = make2p();
    for (const p of gs.players) bCrownBid(gs, p.id, 1, NOW);
    const holder = gs.players.find((p) => p.privilege)!;
    expect(holder.blood).toBe(2);
    expect(gs.players.find((p) => !p.privilege)!.blood).toBe(3);
  });

  it('超时托管：未出价者自动按最低价 1 出价并标记 wasAuto', () => {
    const gs = make2p();
    bCrownBid(gs, 'p0', 2, NOW);
    bloodTick(gs, NOW + 61_000);
    expect(gs.crownBids['p1']).toBe(1);
    expect(gs.players.find((p) => p.id === 'p1')!.wasAuto).toBe(true);
    expect(gs.phase).toBe('pick');
  });

  it('竞拍阶段禁止投降（否则凭空产生冠军且可刷天梯胜场）', () => {
    const gs = make2p();
    expect(() => bResign(gs, 'p0', NOW)).toThrow(BloodError);
    // 结算后（pick 阶段）同样拒绝
    for (const p of gs.players) bCrownBid(gs, p.id, 1, NOW);
    expect(() => bResign(gs, 'p0', NOW)).toThrow(BloodError);
  });

  it('3人局：出价结算后直接随机分配角色（不经选将）', () => {
    const gs = createBloodGame(3, [
      { id: 'p0', name: '甲', seat: 0 },
      { id: 'p1', name: '乙', seat: 1 },
      { id: 'p2', name: '丙', seat: 2 },
    ], NOW);
    bCrownBid(gs, 'p0', 3, NOW);
    bCrownBid(gs, 'p1', 2, NOW);
    bCrownBid(gs, 'p2', 2, NOW); // 与 p1 平局掷骰
    expect(gs.phase).not.toBe('crownBid'); // 已结算（pick 或 setup：基础池 3 人局随机分配）
    const holder = gs.players.find((p) => p.privilege)!;
    expect(holder.id).toBe('p0'); // 唯一最高价得证
    // 出价 3 → 竞拍后 0 血筹；随机分配到贵族(+12)/银行职员(+2)会叠加开局效果，故只断言下界与「其余人不低于 3」
    expect(holder.blood).toBeGreaterThanOrEqual(0);
    expect(gs.players.filter((p) => p !== holder).every((p) => p.blood >= 3)).toBe(true);
    expect(gs.players.every((p) => p.charId != null)).toBe(true); // 已分配角色
  });
});

describe('特权证暗标竞拍 · 江东之主夺证', () => {
  it('sunwu 夺证：按其本人出价重算（持证 = 3 − 出价），失证者回到 3', () => {
    const gs = make2p();
    bCrownBid(gs, 'p0', 3, NOW); // p0 赢得竞拍，开局 0 血筹
    bCrownBid(gs, 'p1', 1, NOW); // p1 开局 3 血筹（非持证）
    expect(gs.players.find((p) => p.id === 'p0')!.privilege).toBe(true);
    // 选将：p1 拿到江东之主
    gs.players[0].charOptions = ['dealer', 'noble'];
    gs.players[1].charOptions = ['sunwu', 'clerk'];
    bPickChar(gs, 'p0', 'dealer', NOW);
    bPickChar(gs, 'p1', 'sunwu', NOW);
    expect(gs.players.find((p) => p.id === 'p1')!.privilege).toBe(true);
    expect(gs.privilegeSeat).toBe(1);
    expect(gs.players.find((p) => p.id === 'p1')!.blood).toBe(2); // 3 − 自己出价 1
    expect(gs.players.find((p) => p.id === 'p0')!.blood).toBe(3); // 失证回到 3
  });

  it('sunwu 未夺证（自己本就持证）时血筹不被二次修正', () => {
    const gs = make2p();
    bCrownBid(gs, 'p0', 2, NOW);
    bCrownBid(gs, 'p1', 1, NOW);
    gs.players[0].charOptions = ['sunwu', 'clerk'];
    gs.players[1].charOptions = ['dealer', 'noble'];
    bPickChar(gs, 'p0', 'sunwu', NOW);
    bPickChar(gs, 'p1', 'dealer', NOW);
    expect(gs.players.find((p) => p.id === 'p0')!.blood).toBe(1); // 3 − 出价 2，无二次修正
  });
});
