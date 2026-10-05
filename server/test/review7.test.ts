/**
 * 交叉复查回归测试：
 * - addSession 同账号断线接管：新标签页（无 session token，只发 join）不再被查重锁死
 * - replaceBot 同账号落座守卫：先落座再观战再接替机器人的双座绕过被封死
 * - endBuy 拍卖兜底补发秘密牌 noAdvance：右两格血筹等收尾结算不得重入双发
 */
import { describe, expect, it } from 'vitest';
import { bCrownBid, bPassBuy, bPickChar, createBloodGame } from '../src/blood/engine';
import type { BloodState } from '../src/blood/types';
import { RoomManager } from '../src/rooms';

describe('addSession · 同账号断线接管', () => {
  function mgr(): RoomManager {
    return new RoomManager();
  }
  // denoted as any：addSession 为私有方法，测试经 as unknown 调用并传入最小房间形状
  function fakeRoom(): { sessions: Map<string, unknown>; pendingRemove: Set<string>; [k: string]: unknown } {
    return {
      code: 'T1',
      mode: 'blood',
      game: null,
      sessions: new Map(),
      pendingRemove: new Set(),
      hostId: '',
    };
  }

  it('断线旧会话被新连接接管（同一会话对象，不另立新座）', () => {
    const m = mgr();
    const room = fakeRoom();
    const s1 = (m as unknown as { addSession: Function }).addSession(room, '甲', false, 'acc-1');
    expect(room.sessions.size).toBe(1);
    s1.connected = false; // 掉线（血色对局中：会话保留）
    const s2 = (m as unknown as { addSession: Function }).addSession(room, '甲', false, 'acc-1');
    expect(s2).toBe(s1); // 接管而非新建
    expect(room.sessions.size).toBe(1);
    expect(s2.connected).toBe(true);
  });

  it('在线的同账号会话仍拒绝双开', () => {
    const m = mgr();
    const room = fakeRoom();
    (m as unknown as { addSession: Function }).addSession(room, '甲', false, 'acc-1');
    expect(() => (m as unknown as { addSession: Function }).addSession(room, '甲', false, 'acc-1')).toThrow(
      /已在本房间/,
    );
  });
});

describe('replaceBot · 同账号落座守卫', () => {
  it('账号已在本房落座时，观战会话不能接替机器人（双座绕过封死）', () => {
    const m = new RoomManager();
    const bot = {
      id: 'b1',
      token: 'bot-token',
      name: '🤖机器人1',
      seat: 1,
      connected: true,
      ws: null,
      bot: true,
      spectator: false,
      accountId: undefined,
    };
    const seated = {
      id: 's-seated',
      token: 'seated-token',
      name: '甲',
      seat: 0,
      connected: false,
      ws: null,
      accountId: 'acc-2',
      spectator: false,
    };
    const watcher = {
      id: 's-watch',
      token: 'watch-token',
      name: '甲',
      seat: -1,
      connected: true,
      ws: { readyState: 0, send: () => {}, close: () => {}, OPEN: 0 },
      accountId: 'acc-2',
      spectator: true,
    };
    const room = {
      code: 'T2',
      mode: 'blood',
      maxPlayers: 4,
      hostId: '',
      game: { phase: 'reveal', players: [{ id: 'b1' }], log: [], logSeq: 0 },
      sessions: new Map(
        Object.entries({ b1: bot, 's-seated': seated, 's-watch': watcher }).map(([k, v]) => [k, v]),
      ),
      botBrains: new Map(),
      pendingRemove: new Set(),
    };
    expect(() =>
      (m as unknown as { handleReplaceBot: Function }).handleReplaceBot(
        room,
        watcher,
        { t: 'replaceBot', seat: 1 },
        1000,
      ),
    ).toThrow(/已在本房间/);
  });
});

describe('endBuy · 拍卖兜底补发秘密牌不重入', () => {
  it('补发对赌协议后右两格血筹只叠加 1（曾重入 endBuy 双发）', () => {
    const gs: BloodState = createBloodGame(2, [
      { id: 'p0', name: '甲', seat: 0 },
      { id: 'p1', name: '乙', seat: 1 },
    ], 1000);
    for (const p of gs.players) {
      p.charOptions = ['dealer', 'noble'];
      bPickChar(gs, p.id, 'dealer', 1000);
    }
    for (const p of gs.players) bCrownBid(gs, p.id, 0, 1000);
    gs.phase = 'buy';
    gs.market = [
      { def: 'betDeal', bonus: 0 },
      { def: 'calib1', bonus: 0 },
      { def: null, bonus: 0 },
      { def: 'betDeal', bonus: 0 },
      { def: 'calib1', bonus: 0 },
    ];
    const p0 = gs.players[0]!;
    const p1 = gs.players[1]!;
    p0.blood = 10;
    p0.buyPassed = true; // 得牌者被预设跳过购买（编剧/闭店礼场景）
    p1.buyPassed = false;
    gs.turnSeat = 1;
    gs.auction = { defId: 'betDeal', highest: 1, highestBy: 'p0', queue: [], by: 'p1' };
    bPassBuy(gs, 'p1', 1000); // 最后一人跳过 → endBuy → 兜底补发
    expect(gs.auction).toBeNull();
    expect(gs.phase).toBe('remove');
    // 重入曾让右两格各 +2；noAdvance 后恒为各 +1
    expect(gs.market[3]!.bonus).toBe(1);
    expect(gs.market[4]!.bonus).toBe(1);
    // 补发的对赌协议立即结算（rollDice → 血筹入账），不落道具区
    expect(p0.items).toHaveLength(0);
    expect(p0.blood).toBeGreaterThan(10);
  });
});
