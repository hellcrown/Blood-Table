/**
 * 全面审查（2026-10-03）批次 B 的回归测试：角色技能与黑市卡的实现缺陷。
 *
 * B1 防护屏障：卡面「取消玩家即将单独对你使用的[秘密交易]或[备用道具]效果」+ 规则书
 * §5「之后可使用一次；用后背面朝上弃入回收站」——即**只有真正发动才消耗**。
 * 修复前 tryBarrierAsk 在询问之前就把道具移出并回收，选择不使用/超时同样白丢一张屏障。
 */
import { describe, expect, it } from 'vitest';
import { bBarrierDecide, bBuy, bPinpoint, bRemoveDone, bUseItem, createBloodGame } from '../src/blood/engine';
import { botAct, createBrain } from '../src/blood/botAI';
import { promptFor } from '../src/blood/view';
import type { BloodState } from '../src/blood/types';

const NOW = 1_000_000;

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

/** 把状态摆到「甲（p0）已购入定点爆破、指着持有防护屏障的乙（p1）宣称 7 点」 */
function reachBarrierAsk(deadlineLeftMs = 60_000): BloodState {
  const gs = make2p();
  gs.phase = 'buy';
  gs.players[1].items.push({ id: 'it-barrier', def: 'barrier' });
  gs.secretPending = { seat: 'p0', kind: 'pinpointClaim', defId: 'pinpoint' };
  gs.deadline = NOW + deadlineLeftMs;
  bPinpoint(gs, 'p0', 1, 7, NOW);
  return gs;
}

const hasBarrier = (gs: BloodState): boolean =>
  gs.players[1].items.some((i) => i.def === 'barrier');

describe('批次 B · 防护屏障只有真正发动才消耗（B1）', () => {
  it('进入反制询问时道具仍在手上（不得提前消耗）', () => {
    const gs = reachBarrierAsk();
    expect(gs.secretPending?.kind).toBe('barrierAsk');
    expect(hasBarrier(gs)).toBe(true);
  });

  it('选择不发动：屏障留在道具区，效果照常结算', () => {
    const gs = reachBarrierAsk();
    gs.players[1].discard = gs.players[1].draw.splice(0, 3);
    gs.players[1].discard.forEach((c) => (c.r = 7)); // 让定点爆破有目标可删
    bBarrierDecide(gs, 'p1', false, NOW);
    expect(gs.secretPending).toBeNull();
    expect(hasBarrier(gs)).toBe(true); // 修复前：已被提前回收
    expect(gs.recycle).not.toContain('barrier');
  });

  it('选择发动：屏障被消耗并进入回收站，效果被抵消', () => {
    const gs = reachBarrierAsk();
    gs.players[1].discard = gs.players[1].draw.splice(0, 3);
    gs.players[1].discard.forEach((c) => (c.r = 7));
    const discardBefore = gs.players[1].discard.length;
    bBarrierDecide(gs, 'p1', true, NOW);
    expect(hasBarrier(gs)).toBe(false);
    expect(gs.recycle).toContain('barrier');
    expect(gs.players[1].discard.length).toBe(discardBefore); // 效果被抵消：没有牌被删
  });

  it('询问窗口重置时限：防御者拿到完整倒计时（沿用旧 deadline 会让面板一闪而过）', () => {
    const gs = reachBarrierAsk(1_000); // 发起者回合只剩 1 秒
    expect(gs.deadline).toBeGreaterThan(NOW + 30_000);
  });
});

describe('批次 B · 机器人不得误删王、宣称点数必须正确（B3）', () => {
  it('定点爆破宣称的点数按真实牌面解析：c1-4 是 6 点（而非按花色分组算出的 3 点）', () => {
    const gs = make2p();
    gs.phase = 'buy';
    const brain = createBrain();
    brain.seen.set(1, new Set(['c1-4'])); // 对手历史亮出过 c1-4
    // 受害者弃牌堆里放一张 6 点牌：宣称正确时才会转成「受害者自选删除」的挂起
    gs.players[1].discard = gs.players[1].draw.splice(0, 1);
    gs.players[1].discard[0].r = 6;
    gs.secretPending = { seat: 'p0', kind: 'pinpointClaim', defId: 'pinpoint' };
    gs.deadline = NOW + 60_000;

    expect(botAct(brain, gs, 'p0', NOW)).toBe(true);
    expect(gs.secretPending?.kind).toBe('pinpointVictim'); // 转成受害者的删除抉择
    expect(gs.secretPending?.rank).toBe(6); // 修复前为 3：宣称几乎必错、3 血筹白花
  });

  it('黑客初始构筑不会删掉自己的王（王是灵活度最高的牌，r=0 不能当最小牌）', () => {
    const gs = make2p();
    gs.players[0].charId = 'hacker';
    gs.phase = 'setup';
    gs.secretPending = { seat: 'p0', kind: 'hackerSetup' };
    gs.deadline = NOW + 60_000;

    expect(botAct(createBrain(), gs, 'p0', NOW)).toBe(true);
    const me = gs.players[0];
    expect(me.removed.length).toBe(8); // 规则：从全牌库中挑 8 张删除
    expect(me.removed.some((c) => c.r === 0)).toBe(false); // 修复前：两张王必被删
  });

  it('精准删除不会删掉抽到的王', () => {
    const gs = make2p();
    gs.phase = 'buy';
    const me = gs.players[0];
    const joker = me.draw.find((c) => c.r === 0)!;
    const lows = me.draw.filter((c) => c.r !== 0 && c.r <= 5).slice(0, 2);
    expect(joker).toBeDefined();
    expect(lows.length).toBe(2);
    gs.secretPending = { seat: 'p0', kind: 'preciseDel', defId: 'preciseDel', cards: [joker, ...lows] };
    gs.deadline = NOW + 60_000;

    expect(botAct(createBrain(), gs, 'p0', NOW)).toBe(true);
    expect(me.removed.length).toBe(2);
    expect(me.removed.some((c) => c.r === 0)).toBe(false); // 王不该被删
    expect(me.discard.some((c) => c.r === 0)).toBe(true); // 被留下的正是王
  });
});

describe('批次 B · 购买阶段的提示不得越过引擎闸门（B4）', () => {
  it('别人的抉择未结清时，轮到本回合的玩家应看到 wait 而不是可购买', () => {
    const gs = make2p();
    gs.phase = 'buy';
    gs.turnSeat = 0;
    gs.players[0].buyPassed = false;
    // 共享信息把抉择交给了对手（属主不是本回合玩家）
    gs.secretPending = { seat: 'p1', kind: 'sharedInfoOpp', max: 1, buyerId: 'p0' };
    gs.deadline = NOW + 60_000;

    // 修复前返回 { k: 'buy' }：点下去就被引擎按 PENDING 拒绝并抛出原始错误
    //「其他玩家的结算尚未完成，请稍候」——线上表现为人类看到报错、bot 刷「决策异常（回退托管）」
    expect(promptFor(gs, gs.players[0]).k).toBe('wait');
  });

  it('自己的抉择挂起时仍应给出对应交互提示（不要连本人一起挡住）', () => {
    const gs = make2p();
    gs.phase = 'buy';
    gs.turnSeat = 0;
    gs.secretPending = { seat: 'p0', kind: 'refreshPick', max: 2 };
    gs.deadline = NOW + 60_000;
    expect(promptFor(gs, gs.players[0]).k).toBe('refreshPick');
  });
});

describe('批次 B · 结算保留打出的牌（B2 客户端面板的牌源契约）', () => {
  /**
   * 炸鸡店老板的结算删牌面板原本取 `view.me.playCards`，而引擎在挂起 fryerDel **之前**就把出牌区
   * 并入了弃牌区 → 面板恒为空、技能只能放弃（缺陷在客户端，已改为取「结算结果里本座位的牌 ∩ 弃牌区」）。
   * 前端没有测试基建，故在此钉住**服务端契约**：结算后出牌区为空、打出的牌进了弃牌区、
   * 且结算结果里保留着这些牌（客户端据此渲染，重连也能恢复）。
   */
  it('结算后：出牌区已清空，打出的牌在弃牌区，且结算结果里仍能取到', () => {
    const gs = make2p();
    gs.players[0].charId = 'dealer';
    gs.players[1].charId = 'noble';
    gs.phase = 'reveal';
    gs.turnSeat = 0;
    gs.privilegeSeat = 0;
    const deal = (p: (typeof gs.players)[number], ranks: number[], suits: ('s' | 'h' | 'c' | 'd')[]): void => {
      p.play = p.draw.splice(0, 5);
      p.play.forEach((c, i) => {
        c.r = ranks[i];
        c.s = suits[i];
      });
    };
    deal(gs.players[0], [9, 9, 8, 8, 7], ['s', 'h', 's', 'h', 's']);
    deal(gs.players[1], [2, 2, 4, 5, 6], ['s', 'h', 's', 'h', 's']);
    const playedIds = gs.players[0].play.map((c) => c.id);
    gs.deadline = NOW + 60_000;

    bUseItem(gs, 'p0', null, NOW);
    if (gs.phase === 'reveal') bUseItem(gs, 'p1', null, NOW);
    expect(gs.result).not.toBeNull();

    const me = gs.players[0];
    expect(me.play.length).toBe(0); // 面板若还取 playCards 就必然是空的
    const discardIds = new Set(me.discard.map((c) => c.id));
    expect(playedIds.every((id) => discardIds.has(id))).toBe(true);
    const row = gs.result!.rows.find((r) => r.seat === 0);
    expect(row?.cards?.length).toBe(5);
    expect(row!.cards!.every((c) => discardIds.has(c.id))).toBe(true);
  });
});

describe('批次 B · 走私客标记必须认「这一张牌」（B6 引擎真实缺陷）', () => {
  /**
   * 原 review4 用例是概率性的：建局时供应堆里还有另一张同 def 的牌（约 9% 概率），
   * 补位翻出它就会让「按 defId 重新定位」把标记转移到新牌上。诊断实测 300 次失败 22 次（7.3%）。
   * 这里把供应堆里放一张同 def 的牌 → 补位必定翻出 → 从概率失败变成确定性复现。
   */
  const LITERAL_MARKET = (markedFirst = false) => [
    { def: 'calib1', bonus: 0, uid: 101 },
    { def: 'dealerLic', bonus: 0, uid: 102 },
    { def: null, bonus: 0, uid: 103 },
    { def: null, bonus: 0, uid: 104 },
    { def: null, bonus: 0, uid: 105 },
  ];

  function buyMarked(): BloodState {
    const gs = make2p();
    gs.phase = 'buy';
    gs.turnSeat = 0;
    gs.supply.push('dealerLic'); // 与被标记的牌同 def：补位必定翻出另一张
    gs.market = LITERAL_MARKET();
    gs.smugglerMark = { slot: 1, by: 'p1', defId: 'dealerLic', uid: 102 };
    gs.players[0].blood = 50;
    for (const p of gs.players) p.buyPassed = false;
    bBuy(gs, 'p0', 1, undefined, NOW); // 买走被标记的那张
    return gs;
  }

  it('被标记的牌被买走 → 标记作废，即使补位又翻出同 def 的另一张', () => {
    const gs = buyMarked();
    expect(gs.smugglerMark).toBeNull();
  });

  it('补位新牌不会被误挂标记（否则后来买它的人白付 2 血筹过路费）', () => {
    const gs = buyMarked();
    // 新翻出的 dealerLic 与旧标记同 def，但它是另一张牌：不得被标记
    const dlSlots = gs.market.map((m, i) => (m.def === 'dealerLic' ? i : -1)).filter((i) => i >= 0);
    expect(dlSlots.length).toBeGreaterThan(0);
    expect(gs.smugglerMark).toBeNull();
  });

  it('同 def 两张并存时，标记跟随的是被标记的那一张（按 uid，而非第一个同 def 栏位）', () => {
    const gs = make2p();
    gs.phase = 'buy';
    gs.turnSeat = 0;
    // 市场里有两张同 def（uid 201=未标记 / 203=被标记），买走 0 号栏位触发右推
    gs.market = [
      { def: 'demag', bonus: 0, uid: 200 },
      { def: 'inkSuit', bonus: 0, uid: 201 },
      { def: 'calib1', bonus: 0, uid: 202 },
      { def: 'inkSuit', bonus: 0, uid: 203 }, // ← 被标记的是这一张
      { def: null, bonus: 0, uid: 204 },
    ];
    gs.smugglerMark = { slot: 3, by: 'p1', defId: 'inkSuit', uid: 203 };
    gs.players[0].blood = 50;
    for (const p of gs.players) p.buyPassed = false;
    bBuy(gs, 'p0', 0, undefined, NOW);

    // 被标记那张右移到最后一个 inkSuit 栏位；若按 defId 取「第一个匹配」会错标到另一张
    const markedSlot = gs.smugglerMark?.slot ?? -1;
    expect(markedSlot).toBeGreaterThanOrEqual(0);
    expect(gs.market[markedSlot].uid).toBe(203);
  });
});

describe('批次 B · 皇叔的宿命胜利不得错失（B5）', () => {
  it('删满 54 张后：点「跳过删牌」也应立即判胜（卡面写的是「任何时候」）', () => {
    const gs = make2p();
    const me = gs.players[0];
    me.charId = 'liu';
    me.tickets = 12; // ≥ 目标一半（2 人局目标 24）
    gs.phase = 'remove';
    me.removeDone = false;
    // 第 54 张由别的路径删掉（此处直接摆出结果）：此后玩家只能跳过删牌
    me.removed.push(...me.draw.splice(0, me.draw.length));
    expect(me.removed.length).toBe(54);

    bRemoveDone(gs, 'p0', NOW); // 修复前：只置 removeDone，宿命胜利永不判定
    expect(gs.phase).toBe('gameover');
    expect(gs.final?.winnerSeat).toBe(0);
  });
});
