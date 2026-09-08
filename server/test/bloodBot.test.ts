import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { bloodTick, createBloodGame } from '../src/blood/engine';
import { promptFor } from '../src/blood/view';
import { botAct, createBrain, updateBrains, type BotBrain } from '../src/blood/botAI';
import type { BCard, BloodState } from '../src/blood/types';

const NOW = 1000;

type BCardLike = BCard;

/** 用 bot 决策驱动对局直到目标阶段或终局 */
function driveBots(gs: BloodState, botIds: string[], until: 'gameover' | BloodState['phase'], maxSteps = 200_000): void {
  const brains = new Map<string, BotBrain>(botIds.map((id) => [id, createBrain()]));
  let now = NOW;
  let guard = 0;
  while (gs.phase !== 'gameover' && gs.phase !== until && guard++ < maxSteps) {
    updateBrains(brains, botIds, gs);
    let acted = false;
    for (const id of botIds) {
      const p = gs.players.find((x) => x.id === id);
      if (!p) continue;
      const prompt = promptFor(gs, p);
      if (prompt.k === 'wait') continue;
      try {
        acted = botAct(brains.get(id)!, gs, id, now) || acted;
      } catch {
        /* 异常回退：交给超时托管 */
      }
    }
    now += acted ? 1500 : 61_000;
    bloodTick(gs, now);
  }
  expect(guard).toBeLessThan(maxSteps);
}

function makePlayers(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `玩家${i}`, seat: i }));
}

describe('血色机器人 · 完整对局', () => {
  it('2 人局全 bot（拓展池）打到终局且满足守恒', () => {
    const gs = createBloodGame(2, makePlayers(2), NOW, true);
    driveBots(gs, ['p0', 'p1'], 'gameover');
    expect(gs.phase).toBe('gameover');
    expect(gs.final).not.toBeNull();
    const champ = gs.players.find((p) => p.seat === gs.final!.winnerSeat)!;
    expect(champ.tickets).toBeGreaterThanOrEqual(gs.target);
  }, 60_000);

  it('3 人局全 bot（基础池）打到终局', () => {
    const gs = createBloodGame(3, makePlayers(3), NOW);
    driveBots(gs, ['p0', 'p1', 'p2'], 'gameover');
    expect(gs.phase).toBe('gameover');
    expect(gs.final).not.toBeNull();
  }, 60_000);

  it('出牌决策（含推演）单次 < 50ms', () => {
    const gs = createBloodGame(2, makePlayers(2), NOW, true);
    driveBots(gs, ['p0', 'p1'], 'play');
    const brains = new Map([['p0', createBrain()]]);
    const p0 = gs.players[0];
    if (gs.phase === 'play' && !p0.locked) {
      const t0 = performance.now();
      botAct(brains.get('p0')!, gs, 'p0', NOW);
      const cost = performance.now() - t0;
      expect(cost).toBeLessThan(50);
    }
  });
});

describe('血色机器人 · AI 行为', () => {
  /** 建立一局并推进到 swap（强制角色），返回 gs */
  function toSwap(c0: string, c1: string): BloodState {
    const gs = createBloodGame(2, makePlayers(2), NOW);
    gs.players[0].charOptions = [c0, 'dealer'];
    gs.players[1].charOptions = [c1, 'clerk'];
    driveBots(gs, ['p0', 'p1'], 'swap');
    return gs;
  }

  it('换牌：保留成对牌，弃孤立低牌', () => {
    const gs = toSwap('clerk', 'clerk');
    const p0 = gs.players[0];
    // 布置手牌：K 对 + 孤立低牌
    const pool = [...p0.draw, ...p0.hand, ...p0.discard, ...p0.setupHand];
    const used = new Set<string>();
    const pick = (r: number): BCardLike => {
      const found = pool.find((c) => c.r === r && !used.has(c.id));
      if (!found) throw new Error(`no rank ${r}`);
      used.add(found.id);
      return found;
    };
    const hand = [pick(13), pick(13), pick(5), pick(4), pick(3), pick(2)];
    for (const c of hand) if (!used.has(c.id)) used.delete(c.id);
    p0.hand = hand;
    p0.draw = pool.filter((c) => !used.has(c.id));
    p0.discard = [];
    p0.setupHand = [];
    const before = p0.hand.length;
    botAct(createBrain(), gs, 'p0', NOW);
    // 弃掉的牌不含 K 对
    const discarded = hand.filter((h) => p0.discard.some((d) => d.id === h.id));
    expect(discarded.length).toBeGreaterThan(0);
    expect(discarded.every((d) => d.r !== 13)).toBe(true);
    expect(p0.hand.length).toBe(before);
  });

  it('购买：对手接近目标时优先买破坏类', () => {
    const gs = toSwap('clerk', 'clerk');
    driveBots(gs, ['p0', 'p1'], 'buy');
    const p0 = gs.players[0];
    // 强制轮到 p0 购买
    gs.turnSeat = 0;
    p0.buyPassed = false;
    p0.blood = 20;
    p0.tickets = 0;
    gs.players[1].tickets = 16; // 目标 24 - 8：接近目标
    gs.market[0] = { def: 'betDeal', bonus: 0 };
    gs.market[1] = { def: 'violentDel', bonus: 0 };
    botAct(createBrain(), gs, 'p0', NOW);
    expect(gs.secretPending?.kind).toBe('violentTarget'); // 买了暴力删除
  });

  it('删牌：删孤立低牌，保留成对高牌', () => {
    const gs = toSwap('clerk', 'clerk');
    driveBots(gs, ['p0', 'p1'], 'buy');
    // 直接构造删牌阶段
    gs.phase = 'remove';
    for (const p of gs.players) p.removeDone = false;
    const p0 = gs.players[0];
    const pool = [...p0.draw, ...p0.hand, ...p0.discard];
    const used = new Set<string>();
    const pick = (r: number) => {
      const f = pool.find((c) => c.r === r && !used.has(c.id));
      if (!f) throw new Error(`no rank ${r}`);
      used.add(f.id);
      return f;
    };
    const sevenA = pick(7);
    const sevenB = pick(7);
    const three = pick(3);
    void sevenB;
    p0.discard = [sevenA, sevenB, three];
    p0.hand = [];
    p0.draw = pool.filter((c) => !used.has(c.id));
    p0.blood = 7; // 只够免费额度：恰好删 1 张（最孤立的低牌 3）
    botAct(createBrain(), gs, 'p0', NOW);
    expect(p0.removed.some((c) => c.id === three.id)).toBe(true);
    expect(p0.discard.some((c) => c.r === 7)).toBe(true);
  });

  it('跨回合记忆：对决亮牌后 Brain 记录对手出牌', () => {
    const gs = toSwap('clerk', 'clerk');
    const brain = createBrain();
    driveBots(gs, ['p0', 'p1'], 'settle');
    updateBrains(new Map([['p0', brain]]), ['p0'], gs);
    const p1 = gs.players[1];
    const seen = brain.seen.get(1);
    expect(seen).toBeTruthy();
    expect(seen!.size).toBeGreaterThan(0);
    void p1;
  });
});

/* ---------------- RoomManager 级：添加/移除/回收 ---------------- */

import { RoomManager } from '../src/rooms';

function stubWs() {
  return { readyState: 0, OPEN: 0, send: () => {}, on: () => {} } as never;
}

describe('血色机器人 · 房间管理', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  interface TestRoom {
    sessions: Map<string, { id: string; bot?: boolean; seat: number; connected: boolean }>;
    hostId: string;
    game: BloodState | null;
    botBrains: Map<string, BotBrain>;
    botNextAct: Map<string, number>;
  }
  type TestMgr = { rooms: Map<string, TestRoom> } & Record<string, (...args: unknown[]) => unknown>;

  function makeRoomWithBot(): { mgr: RoomManager; m: TestMgr; room: TestRoom; host: { id: string; bot?: boolean; seat: number; connected: boolean } } {
    const mgr = new RoomManager();
    const m = mgr as unknown as TestMgr;
    const ws = stubWs();
    (m.handleCreate as (w: unknown, msg: unknown) => void)(ws, { t: 'create', name: '甲', maxPlayers: 4, mode: 'blood' });
    const room = [...m.rooms.values()][0];
    const host = [...room.sessions.values()].find((s) => !s.bot)!;
    return { mgr, m, room, host };
  }

  it('房主可添加/移除机器人，开局包含 bot', () => {
    const { m, room, host } = makeRoomWithBot();
    (m.handleAddBot as (r: unknown, s: unknown) => void)(room, host);
    expect(room.sessions.size).toBe(2);
    expect([...room.sessions.values()].filter((s) => s.bot).length).toBe(1);
    const bot = [...room.sessions.values()].find((s) => s.bot)!;
    (m.handleKickBot as (r: unknown, s: unknown, msg: unknown) => void)(room, host, { t: 'kickBot', seat: bot.seat });
    expect(room.sessions.size).toBe(1);
    (m.handleAddBot as (r: unknown, s: unknown) => void)(room, host);
    (m.handleStart as (r: unknown, s: unknown) => void)(room, host);
    expect(room.game!.players.length).toBe(2);
  });

  it('真人全部离开后 5 分钟，房间连同 bot 一起回收', () => {
    const { mgr, m, room, host } = makeRoomWithBot();
    (m.handleAddBot as (r: unknown, s: unknown) => void)(room, host);
    expect(room.sessions.size).toBe(2);
    (m.handleLeave as (r: unknown, s: unknown) => void)(room, host);
    // 离开后的第一次 tick 记录空房时间，5 分钟后的 tick 执行删除
    mgr.tickAll();
    vi.setSystemTime(new Date(NOW + 6 * 60_000));
    mgr.tickAll();
    expect(m.rooms.size).toBe(0);
  });
});
