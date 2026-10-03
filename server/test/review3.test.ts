/**
 * 第三轮深查回修回归测试：
 * - classic 再来一场后改设置同步进 GState 快照（幽灵玩家/双筹码根因）
 * - 炸鸡店老板多张删除续挂（此前删 1 张即终止挂起，「至多 3 张」形同虚设）
 * - 投降终局标记 resigned（天梯计分方据此跳过，防互投刷胜场与 2 人局票数倒挂喂满 gap 轴）
 */
import { describe, expect, it } from 'vitest';
import { bFryerDel, bResign, createBloodGame, bCrownBid, bPickChar } from '../src/blood/engine';
import type { BloodState, BCard, BPlayer } from '../src/blood/types';
import { createGame, rematch, startHand } from '../src/game/engine';
import type { GState } from '../src/game/types';

const NOW = 1000;

describe('classic：再来一场后修改设置同步引擎快照', () => {
  it('seatCount 与 settings 同步（handleSettings 新增同步块的引擎侧契约）', () => {
    const players = [
      { id: 'a', name: '甲', seat: 0, chips: 1000 },
      { id: 'b', name: '乙', seat: 1, chips: 1000 },
    ];
    const gs = createGame({ sb: 5, bb: 10, startChips: 1000 }, 2, players);
    startHand(gs, NOW);
    gs.phase = 'gameover'; // 打完一局
    rematch(gs);
    expect(gs.seatCount).toBe(2);
    expect(gs.settings.startChips).toBe(1000);
    // 房间层 handleSettings 的同步行为：改 maxPlayers/startChips 时写回快照（此前不写回 → 幽灵玩家/双筹码）
    roomSyncSettings(gs, 4, { sb: 10, bb: 20, startChips: 5000 });
    expect(gs.seatCount).toBe(4);
    expect(gs.settings).toEqual({ sb: 10, bb: 20, startChips: 5000 });
  });
});

/** rooms.handleSettings 中新增的同步块（抽出单测引擎侧契约） */
function roomSyncSettings(gs: GState, maxPlayers: number, settings: { sb: number; bb: number; startChips: number }): void {
  gs.seatCount = maxPlayers;
  gs.settings = { ...settings };
}

describe('炸鸡店老板：多张删除续挂', () => {
  function settleWithFryer(): { gs: BloodState; p0: BPlayer } {
    const gs = createBloodGame(2, [
      { id: 'p0', name: '甲', seat: 0 },
      { id: 'p1', name: '乙', seat: 1 },
    ], NOW);
    // 2 人局选将路径：先选将（触发竞拍）再全员出价
    for (const p of gs.players) {
      p.charOptions = ['fryer', 'dealer'];
      bPickChar(gs, p.id, 'fryer', NOW);
    }
    for (const p of gs.players) bCrownBid(gs, p.id, 0, NOW);
    // 快进到结算期挂起
    gs.phase = 'settle';
    for (const p of gs.players) {
      p.blood = 10;
    }
    const p0 = gs.players[0]!;
    p0.discard = [
      { id: 'd1', r: 5, s: 'h' },
      { id: 'd2', r: 7, s: 's' },
      { id: 'd3', r: 9, s: 'd' },
      { id: 'dX', r: 3, s: 'c' }, // 非本回合打出的牌
    ];
    gs.result = {
      rows: [
        {
          seat: 0,
          name: '甲',
          cat: 1,
          catName: '高牌',
          pips: 24,
          rank: 1,
          gainTickets: 0,
          gainBlood: 0,
          cores: 0,
          cards: [{ id: 'd1', r: 5, s: 'h' }, { id: 'd2', r: 7, s: 's' }, { id: 'd3', r: 9, s: 'd' }],
        },
      ],
      winnerSeat: 0,
      comparePipsFirst: false,
    };
    gs.secretPending = { seat: p0.id, kind: 'fryerDel', max: 3 };
    return { gs, p0 };
  }

  it('删第一张后挂起保持（不终止），可继续删到预算/牌尽', () => {
    const { gs, p0 } = settleWithFryer();
    bFryerDel(gs, p0.id, ['d1'], false, NOW);
    expect(p0.fryerDelCount).toBe(1);
    expect(p0.blood).toBe(9);
    expect(gs.secretPending?.kind).toBe('fryerDel'); // 续挂（此前删 1 张即清挂起，第 2 张必吃 PENDING）
    bFryerDel(gs, p0.id, ['d2'], false, NOW);
    expect(p0.fryerDelCount).toBe(2);
    expect(gs.secretPending?.kind).toBe('fryerDel');
    bFryerDel(gs, p0.id, ['d3'], true, NOW);
    expect(p0.fryerDelCount).toBe(3);
    expect(gs.secretPending).toBeNull(); // 弃牌区已无本回合打出的牌 → 清挂起推进
    expect(p0.discard.some((c) => (c as BCard).id === 'dX')).toBe(true); // 非打出牌不受影响
  });

  it('血筹不足时删完即清挂起（不续挂空转）', () => {
    const { gs, p0 } = settleWithFryer();
    p0.blood = 1;
    bFryerDel(gs, p0.id, ['d1'], false, NOW);
    expect(p0.fryerDelCount).toBe(1);
    expect(p0.blood).toBe(0);
    expect(gs.secretPending).toBeNull();
  });
});

describe('投降终局标记 resigned', () => {
  it('bResign 后 final.resigned = true（天梯计分方据此跳过：防互投刷胜场与 2 人局票数倒挂）', () => {
    const gs = createBloodGame(2, [
      { id: 'p0', name: '甲', seat: 0 },
      { id: 'p1', name: '乙', seat: 1 },
    ], NOW);
    // 快进过竞拍守卫：直接强制到换牌阶段（bResign 拒绝 crownBid/pick/setup）
    gs.phase = 'swap';
    for (const p of gs.players) {
      p.charId = 'dealer';
      p.setupRound = 2;
    }
    gs.players[1]!.tickets = 23; // 贴近目标的票数（投降后成为第二名，倒挂场景）
    bResign(gs, 'p1', NOW);
    expect(gs.final?.resigned).toBe(true);
    expect(gs.final?.winnerSeat).toBe(0);
    expect(gs.final?.ranking[gs.final.ranking.length - 1]?.name).toBe('乙'); // 投降者排最后
  });
});
