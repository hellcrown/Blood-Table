/**
 * 第五轮深查回修回归测试：
 * - 亮牌宣告窗口超时托管（持消磁枪断线曾致全桌永久卡死）+ 弹簧决策后保留道具窗
 * - 全员跳过初始构筑（飞车党/捣蛋鬼局）的 setup 阶段推进
 * - 走私客过路费在插入校验失败时不扣（可反复抽血漏洞）
 * - 特工交换超时托管默认拒绝（曾默认接受=无上界让渡）
 * - 仿制印章候选含宿主自身面（「可视为」应可不发动）；摊牌核心牌高亮不含无关王
 */
import { describe, expect, it } from 'vitest';
import {
  bBuy,
  bCrownBid,
  bPickChar,
  bSkipDecision,
  bloodTick,
  createBloodGame,
} from '../src/blood/engine';
import { applyImitate, evalBloodHand, type EvalCard } from '@shared/bloodEval';
import { coreOrder, type SdSortableCard } from '@shared/bloodShowdown';
import type { BloodState } from '../src/blood/types';

const NOW = 1000;

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

describe('亮牌宣告窗口超时托管', () => {
  it('持消磁枪的窗口玩家超时：视为宣告完毕推进（不替其消耗道具），全桌不卡死', () => {
    const gs = makeGame();
    gs.phase = 'reveal';
    gs.turnSeat = 0;
    gs.privilegeSeat = 0; // 固定顺序 [p0,p1]
    gs.deadline = NOW + 60_000;
    gs.players[0]!.items.push({ id: 'it1', def: 'demag' });
    bloodTick(gs, NOW + 61_000);
    expect(gs.phase).not.toBe('reveal'); // 已推进出该窗口（2 人局直抵结算）
    expect(gs.players[0]!.items).toHaveLength(1); // 托管不替玩家消耗消磁枪
  });

  it('弹簧决策队列走空但仍持有道具：保留宣告窗口等待 bUseItem（超时托管兜底）', () => {
    const gs = makeGame();
    gs.phase = 'reveal';
    gs.turnSeat = 0;
    gs.privilegeSeat = 0;
    gs.deadline = NOW + 60_000;
    gs.players[0]!.items.push({ id: 'it1', def: 'demag' });
    gs.players[0]!.play.push({ id: 'cx', r: 5, s: 's' });
    gs.players[0]!.chips.push({ id: 'cs', def: 'spring', on: 'cx' });
    gs.secretPending = { seat: 'p0', kind: 'revealDecide' }; // 队列已空（弹簧已当场决策）
    bSkipDecision(gs, 'p0', NOW);
    // 决策结束但消磁枪未宣告：窗口保持（此前直接推进会让消磁枪当轮失效）
    expect(gs.secretPending).toBeNull();
    expect(gs.turnSeat).toBe(0);
    expect(gs.phase).toBe('reveal');
    // 超时托管兜底推进
    bloodTick(gs, NOW + 61_000);
    expect(gs.phase).not.toBe('reveal');
  });
});

describe('全员跳过初始构筑的推进', () => {
  it('双飞车党局：竞拍结算后不再卡在 setup（draw 为自动阶段，直接推进至换牌）', () => {
    const gs = createBloodGame(2, [
      { id: 'p0', name: '甲', seat: 0 },
      { id: 'p1', name: '乙', seat: 1 },
    ], NOW);
    for (const p of gs.players) {
      p.charOptions = ['biker', 'dealer'];
      bPickChar(gs, p.id, 'biker', NOW);
    }
    for (const p of gs.players) bCrownBid(gs, p.id, 0, NOW);
    expect(gs.players.every((p) => p.setupRound >= 2)).toBe(true);
    expect(gs.phase).toBe('swap'); // 此前永久停在 setup：无人会调 bSetup，阶段死锁
  });
});

describe('走私客过路费时序', () => {
  it('插入目标非法时购买中止：过路费与货款分文不扣（此前过路费已转、可反复抽血）', () => {
    const gs = makeGame();
    gs.phase = 'buy';
    gs.turnSeat = 0;
    gs.market = [
      { def: null, bonus: 0 },
      { def: 'calib1', bonus: 0 },
      { def: null, bonus: 0 },
      { def: null, bonus: 0 },
      { def: null, bonus: 0 },
    ];
    gs.smugglerMark = { slot: 1, by: 'p1', defId: 'calib1' };
    const p0 = gs.players[0]!;
    const p1 = gs.players[1]!;
    p0.blood = 50;
    p1.blood = 3;
    for (const p of gs.players) p.buyPassed = false;
    expect(() => bBuy(gs, 'p0', 1, 'ghost-card', NOW)).toThrow();
    expect(p0.blood).toBe(50); // 过路费未扣
    expect(p1.blood).toBe(3); // 走私客未收款
    // 合法购买：过路费正常收取
    p0.discard.push({ id: 'dx', r: 5, s: 'h' });
    bBuy(gs, 'p0', 1, 'dx', NOW);
    expect(p0.blood).toBe(50 - 4 - 2); // calib1 价 4 + 过路费 2
    expect(p1.blood).toBe(5);
  });
});

describe('特工交换超时托管', () => {
  it('受害者超时默认拒绝（出牌区不被换走），付有界补偿', () => {
    const gs = makeGame();
    gs.phase = 'play';
    gs.deadline = NOW + 60_000;
    const p0 = gs.players[0]!;
    const p1 = gs.players[1]!;
    p0.play = [{ id: 'a1', r: 9, s: 's' }];
    p1.play = [{ id: 'b1', r: 3, s: 'h' }];
    const p1Blood = p1.blood;
    gs.secretPending = { seat: 'p1', kind: 'agentDecide', buyerId: 'p0' };
    bloodTick(gs, NOW + 61_000);
    expect(p1.play.map((c) => c.id)).toEqual(['b1']); // 出牌区未被换走
    expect(p0.play.map((c) => c.id)).toEqual(['a1']);
    expect(p1.blood).toBe(p1Blood - 2); // 拒绝的有界代价（此前超时托管先清挂起令 bAgentDecide 抛错被吞，整体失效）
  });
});

describe('仿制印章「可视为」（含不发动选项）', () => {
  const fixed = (id: string, r: number, s: 's' | 'h' | 'd' | 'c'): EvalCard => ({ id, baseR: r, ranks: [r], suits: [s], count: 1 });

  it('宿主自身面保留在候选中（不发动选项）；印章配对收益照常取最优', () => {
    const cards = [fixed('a', 14, 'd'), fixed('b', 13, 's'), fixed('c', 3, 'h')];
    const raws = [
      { r: 14, s: 'd' as const },
      { r: 13, s: 's' as const },
      { r: 3, s: 'h' as const },
    ];
    const out = applyImitate(cards, raws, [true, false, false]);
    expect(out[0].ranks).toContain(14); // 不发动印章的选项（此前被强制替换成 {13,3}）
    expect(out[0].ranks).toContain(13);
    const r = evalBloodHand(out);
    // 评估取最优：A 可仿 K♠ 成对（cat 1 优于高牌），pips 13+13+3
    expect(r.cat).toBe(1);
    expect(r.pips).toBe(29);
  });
});

describe('摊牌核心牌高亮', () => {
  const c = (id: string, r: number): SdSortableCard => ({ id, r, s: 's', chipIds: [] });

  it('三条自成时无关王不高亮；对+王=三条时王是构成牌需高亮', () => {
    const trips = coreOrder([c('k1', 13), c('k2', 13), c('k3', 13), c('j', 0), c('x', 5)], 3);
    expect(trips.map((x) => x.id)).not.toContain('j'); // KKK+王：王与牌型无关
    const tripsWithJoker = coreOrder([c('k1', 13), c('k2', 13), c('j', 0), c('x', 5), c('y', 6)], 3);
    expect(tripsWithJoker.map((x) => x.id)).toContain('j'); // 对+王=三条：王是构成牌
  });
});
