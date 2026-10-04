/**
 * 第六轮审查修复的回归测试：
 * - classic 手牌进行中请离必须走 pendingRemove 延迟移除（此前 removeSession 的 classic 分支
 *   无阶段守卫被 kick 直接调用：已投入筹码随玩家从底池消失，行动中人被删令 tick 空转卡死）
 * - kickPlayer 座位号必须非负（seat=-1 会命中插入序第一个观战者）
 * - 同一账号同房只允许一个落座会话（双开可同看两手底牌联合决策）
 * - 瞎掰帝拍卖得牌的发放不得顺延得牌者的购买回合（芯片以 thenBuy 挂起、内联秘密牌 noAdvance）
 * - 清洁工删牌后判皇叔宿命胜利（第 54 张可能由任何删牌路径送走）
 * - 特工换牌的归还在结算删牌之前执行（先归还再删，牌不会错删/永久丢失）
 */
import { describe, expect, it } from 'vitest';
import { createGame, startHand } from '../src/game/engine';
import { GameError, type GState } from '../src/game/types';
import {
  bCleanerDel,
  bCrownBid,
  bPassBuy,
  bPickChar,
  bloodTick,
  createBloodGame,
} from '../src/blood/engine';
import { RoomManager, type Room, type Session } from '../src/rooms';
import type { BloodState } from '../src/blood/types';

const NOW = 1000;

/* ---------------- 通用桩 ---------------- */

interface FakeWs {
  sent: unknown[];
  readyState: number;
  OPEN: number;
  send(x: string): void;
  close(): void;
}

function fakeWs(): FakeWs {
  const sent: unknown[] = [];
  return {
    sent,
    readyState: 1,
    OPEN: 1,
    send(x: string) {
      sent.push(JSON.parse(x));
    },
    close() {
      /* noop */
    },
  };
}

function mkSession(id: string, seat: number, extra: Partial<Session> = {}): Session {
  return {
    id,
    token: `tok-${id}`,
    name: id,
    seat,
    connected: true,
    ws: fakeWs() as unknown as Session['ws'],
    lastEventSeq: 0,
    ...extra,
  } as Session;
}

function mkRoom(mode: 'classic' | 'blood', game: GState | BloodState | null, sessions: Session[]): Room {
  return {
    code: '7K',
    hostId: sessions[0]?.id ?? '',
    ownerIp: '',
    maxPlayers: 4,
    mode,
    settings: { sb: 5, bb: 10, startChips: 1000 },
    charExpansion: false,
    expansion: false,
    targetTickets: 0,
    sessions: new Map(sessions.map((s) => [s.id, s])),
    game,
    pendingRemove: new Set(),
    emptySince: 0,
    botBrains: new Map(),
    botNextAct: new Map(),
    matchLogged: true, // 落库哨兵置位：测试零文件副作用
    gameStartedAt: NOW,
  } as unknown as Room;
}

/* ---------------- classic 请离 ---------------- */

function classicMidHand(): { mgr: RoomManager; room: Room; cg: GState; host: Session; guest: Session } {
  const mgr = new RoomManager();
  const host = mkSession('h0', 0);
  const guest = mkSession('p1', 1);
  const cg = createGame(
    { sb: 5, bb: 10, startChips: 1000 },
    4,
    [
      { id: 'h0', name: '房主', seat: 0, chips: 1000 },
      { id: 'p1', name: '乙', seat: 1, chips: 1000 },
    ],
  );
  startHand(cg, NOW);
  const room = mkRoom('classic', cg, [host, guest]);
  // RoomManager 构造后 tokenIndex 为空：补上被踢会话的映射，模拟真实入房状态
  (
    mgr as unknown as { tokenIndex: Map<string, { room: Room; sessionId: string }> }
  ).tokenIndex.set(guest.token, { room, sessionId: guest.id });
  return { mgr, room, cg, host, guest };
}

describe('classic 手牌进行中请离', () => {
  it('手牌进行中被请离：走 pendingRemove 延迟移除，不立即从引擎玩家中删除（底池筹码不消失）', () => {
    const { mgr, room, cg, host, guest } = classicMidHand();
    const guestPlayer = cg.players.find((p) => p.id === guest.id)!;
    expect(guestPlayer.inHand).toBe(true);
    expect(guestPlayer.committed).toBeGreaterThan(0); // 大盲已投入

    (
      mgr as unknown as { handleKickPlayer: (r: Room, s: Session, m: { t: 'kickPlayer'; seat: number }) => void }
    ).handleKickPlayer(room, host, { t: 'kickPlayer', seat: 1 });

    // 引擎玩家必须还在（其 committed 仍计入底池）；移除推迟到结算后（reconcileRemoved）
    expect(cg.players.some((p) => p.id === guest.id)).toBe(true);
    expect(room.pendingRemove.has(guest.id)).toBe(true);
    // 会话保留（等待结算清理）但令牌已断根：无法重连、无法经账号找回
    expect(room.sessions.has(guest.id)).toBe(true);
    expect(guest.token).toBe('');
    expect(guest.accountId).toBeUndefined();
    expect(guest.connected).toBe(false);
    expect(
      (mgr as unknown as { tokenIndex: Map<string, unknown> }).tokenIndex.has('tok-p1'),
    ).toBe(false);
  });

  it('等待阶段请离：无手牌纠葛，直接移除会话', () => {
    const { mgr, room, host, guest } = classicMidHand();
    room.game = null; // 未开局
    (
      mgr as unknown as { handleKickPlayer: (r: Room, s: Session, m: { t: 'kickPlayer'; seat: number }) => void }
    ).handleKickPlayer(room, host, { t: 'kickPlayer', seat: 1 });
    expect(room.sessions.has(guest.id)).toBe(false);
    expect(room.pendingRemove.size).toBe(0);
  });

  it('座位号 -1（观战者特征值）必须拒绝：不能误伤观战者', () => {
    const { mgr, room, host } = classicMidHand();
    expect(() =>
      (
        mgr as unknown as { handleKickPlayer: (r: Room, s: Session, m: { t: 'kickPlayer'; seat: number }) => void }
      ).handleKickPlayer(room, host, { t: 'kickPlayer', seat: -1 }),
    ).toThrow(GameError);
  });
});

/* ---------------- 同账号双开 ---------------- */

describe('同账号同房只允许一个落座会话', () => {
  it('addSession 对已落座账号拒绝重复加入；观战不受限', () => {
    const mgr = new RoomManager();
    const s0 = mkSession('a', 0, { accountId: 'acc-1' });
    const room = mkRoom('classic', null, [s0]);
    const addSession = (
      mgr as unknown as {
        addSession: (r: Room, name: unknown, spectator: boolean, accountId?: string) => Session;
      }
    ).addSession.bind(mgr);

    expect(() => addSession(room, '乙', false, 'acc-1')).toThrow(GameError);
    // 匿名与观战不查重
    expect(addSession(room, '乙', false, undefined).spectator).toBeFalsy();
    expect(addSession(room, '乙', true, 'acc-1').spectator).toBe(true);
  });
});

/* ---------------- 血色引擎 ---------------- */

function bloodGame(): BloodState {
  const gs = createBloodGame(
    2,
    [
      { id: 'p0', name: '甲', seat: 0 },
      { id: 'p1', name: '乙', seat: 1 },
    ],
    NOW,
  );
  for (const p of gs.players) {
    p.charOptions = ['dealer', 'noble'];
    bPickChar(gs, p.id, 'dealer', NOW);
  }
  for (const p of gs.players) bCrownBid(gs, p.id, 0, NOW);
  return gs;
}

function ownerSeatOf(cardId: string, holderSeat: number): number {
  const m = /^c(\d+)-/.exec(cardId);
  return m ? Number(m[1]) : holderSeat;
}

function ownedCount(gs: BloodState, seat: number): number {
  let n = 0;
  for (const p of gs.players) {
    for (const z of [p.draw, p.hand, p.discard, p.removed, p.play, p.setupHand, p.curseStash, p.undertakerStash]) {
      for (const c of z) {
        if (ownerSeatOf(c.id, p.seat) === seat) n++;
      }
    }
  }
  return n;
}

describe('拍卖得牌的发放不得顺延得牌者购买回合', () => {
  it('轮到得牌者时发放内联结算的秘密牌（对赌协议）但不轮转：其仍可正常跳过购买', () => {
    const gs = bloodGame();
    gs.phase = 'buy';
    gs.turnSeat = 0;
    for (const p of gs.players) p.buyPassed = false;
    // 拍卖已成交：乙以 1 血筹竞得「对赌协议」（rollDice，内联结算），发放留到其购买回合
    const winner = gs.players.find((p) => p.id === 'p1')!;
    gs.auction = { defId: 'betDeal', highest: 1, highestBy: 'p1', queue: [], by: 'p0' };
    const bloodBefore = winner.blood;

    bPassBuy(gs, 'p0', NOW); // 甲跳过 → 轮到乙并发放拍卖得牌

    expect(gs.auction).toBeNull();
    expect(gs.turnSeat).toBe(1); // 回合仍在得牌者手中（未被顺延给「下一位」）
    expect(gs.phase).toBe('buy');
    expect(gs.secretPending).toBeNull();
    expect(winner.buyPassed).toBe(false);
    expect(winner.blood).toBeGreaterThan(bloodBefore); // 对赌协议已结算（掷骰得血筹）

    bPassBuy(gs, 'p1', NOW); // 得牌者正常行使其购买回合
    expect(gs.phase).toBe('remove'); // 全员跳过后正常收尾进入删牌
  });
});

describe('清洁工删牌触发皇叔宿命胜利', () => {
  it('删除皇叔的第 54 张牌（分数过半）立即终局，不再推进回合', () => {
    const gs = bloodGame();
    const liu = gs.players[0];
    const cleaner = gs.players[1];
    liu.charId = 'liu';
    cleaner.charId = 'cleaner';
    // 皇叔：凑满 53 张已删（牌从双方牌堆调拨，胜利判定只看 removed 数量）+ 分数过半
    const pool = [
      ...liu.draw.splice(0),
      ...liu.discard.splice(0),
      ...liu.hand.splice(0),
      ...cleaner.draw.splice(0),
      ...cleaner.discard.splice(0),
      ...cleaner.hand.splice(0),
    ];
    liu.removed.push(...pool.splice(0, 53));
    liu.discard.push(pool[0]!); // 留 1 张在弃牌区给清洁工删
    expect(liu.removed.length).toBe(53);
    liu.tickets = 99;
    const target = liu.discard[0]!;
    gs.secretPending = { seat: cleaner.id, kind: 'cleanerDel', oppQueue: [] };

    bCleanerDel(gs, cleaner.id, liu.seat, target.id, NOW);

    expect(liu.removed.length).toBe(54);
    expect(gs.phase).toBe('gameover');
    expect(gs.final?.winnerSeat).toBe(liu.seat);
  });
});

describe('特工换牌的结算归还顺序', () => {
  it('先归还再删牌：换入牌不背枪手的删除，双方 54 张守恒、原牌各回其主', () => {
    const gs = bloodGame();
    const p0 = gs.players[0];
    const p1 = gs.players[1];
    p0.charId = 'agent';
    p1.charId = 'gunner';
    gs.phase = 'reveal';
    gs.turnSeat = 0;
    gs.deadline = NOW + 1000;
    // 从某玩家牌堆取 n 张非 4 的牌（4 只留给我们指定的那张，避免多张 4 干扰断言）
    const takeNonFour = (p: (typeof gs.players)[number], n: number) => {
      const out: (typeof p.draw)[number][] = [];
      for (const z of [p.draw, p.discard, p.hand]) {
        for (let i = z.length - 1; i >= 0 && out.length < n; i--) {
          if (z[i]!.r !== 4) out.push(z.splice(i, 1)[0]!);
        }
      }
      return out;
    };
    p0.play = takeNonFour(p0, 5);
    p1.play = takeNonFour(p1, 4);
    // 取一张属主为 p1 的 4 放进其出牌区（枪手结算删「本回合打出的4」）；p1 名下没有 4 时改造一张
    let four: (typeof p1.draw)[number] | undefined;
    for (const z of [p1.draw, p1.discard, p1.hand]) {
      const i = z.findIndex((c) => c.r === 4);
      if (i >= 0) {
        four = z.splice(i, 1)[0]!;
        break;
      }
    }
    if (!four) {
      for (const z of [p0.draw, p0.discard, p0.hand]) {
        const i = z.findIndex((c) => c.r === 4);
        if (i >= 0) {
          four = z.splice(i, 1)[0]!;
          four.id = four.id.replace(/^c0-/, 'c1-'); // id 前缀即属主座位
          break;
        }
      }
    }
    expect(four).toBeDefined();
    p1.play.push(four!);
    const aCards = p0.play.map((c) => c.id);
    const bCards = p1.play.map((c) => c.id);
    // 模拟 bAgentDecide 已接受的中间态：出牌区互换
    const tmp = p0.play;
    p0.play = p1.play;
    p1.play = tmp;
    gs.agentSwap = { a: 'p0', b: 'p1', aCards, bCards };

    // 超时托管走完双方宣告窗口 → 结算
    let guard = 0;
    while (gs.phase === 'reveal' && guard++ < 10) bloodTick(gs, NOW + guard * 10_000);
    expect(gs.phase).toBe('settle');

    // 守恒：双方名下仍是 54 张（此前错删会把甲的牌永久留在乙的 removed 里）
    expect(ownedCount(gs, 0)).toBe(54);
    expect(ownedCount(gs, 1)).toBe(54);
    // 枪手删的是「自己打出的4」，不是换入的甲的牌
    expect(p1.removed.some((c) => c.id === four!.id)).toBe(true);
    expect(p1.removed.every((c) => ownerSeatOf(c.id, p1.seat) === 1)).toBe(true);
    // 甲打出的牌全部回到甲的弃牌区（未被错删、未被滞留）
    expect(aCards.every((id) => p0.discard.some((c) => c.id === id))).toBe(true);
    // 乙其余打出的牌正常落回弃牌区
    expect(
      bCards.filter((id) => id !== four!.id).every((id) => p1.discard.some((c) => c.id === id)),
    ).toBe(true);
  });
});
