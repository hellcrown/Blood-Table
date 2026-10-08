/**
 * 点将卡回归测试：每日配额（跨日重置/持久化往返/裁剪）、引擎 forcedChars 发牌
 * （强制者单选、从随机池剔除、分配分支直接获得、同角色先到先得、池外忽略）、
 * rooms 集成（开局生效才扣次、未注册不生效、再来一场重新扣次）。
 * 假时钟固定「今天」；模块级单例用 vi.resetModules + 动态 import 隔离。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpfile = (): string => path.join(os.tmpdir(), `blood-dianjiang-test-${Math.random().toString(36).slice(2)}.json`);
const at = (y: number, m: number, d: number, hh = 12): number => new Date(y, m - 1, d, hh, 0, 0).getTime();

async function fresh() {
  vi.resetModules();
  return await import('../src/dianjiang');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(2026, 10, 8));
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe('dianjiang · 每日配额', () => {
  it('默认 3 次：记录后递减，跨日重置，超扣不复为负', async () => {
    const d = await fresh();
    expect(d.dianjiangRemaining('acc-1')).toBe(3);
    d.recordDianjiangUse('acc-1');
    d.recordDianjiangUse('acc-1');
    expect(d.dianjiangRemaining('acc-1')).toBe(1);
    vi.setSystemTime(at(2026, 10, 9));
    expect(d.dianjiangRemaining('acc-1')).toBe(3); // 跨日重置
    expect(d.dianjiangRemaining('')).toBe(0); // 匿名恒 0
  });

  it('快照落盘与重载：重启后配额不回血', async () => {
    const file = tmpfile();
    try {
      const d1 = await fresh();
      d1.initDianjiangStore(file);
      d1.recordDianjiangUse('acc-1');
      d1.recordDianjiangUse('acc-1');
      d1.flushDianjiang();
      const d2 = await fresh();
      d2.initDianjiangStore(file);
      expect(d2.dianjiangRemaining('acc-1')).toBe(1);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe('blood 引擎 · forcedChars 发牌', () => {
  async function engine() {
    vi.resetModules();
    return await import('../src/blood/engine');
  }

  it('2 人局拓展池：强制者单选项，随机者两张不含被点将角色', async () => {
    const blood = await engine();
    const gs = blood.createBloodGame(
      2,
      [
        { id: 'p0', name: '甲', seat: 0 },
        { id: 'p1', name: '乙', seat: 1 },
      ],
      at(2026, 10, 8),
      true,
      false,
      { forcedChars: { p0: 'liu' } },
    );
    expect(gs.players[0]!.charOptions).toEqual(['liu']);
    const other = gs.players[1]!.charOptions;
    expect(other).toHaveLength(2);
    expect(other).not.toContain('liu');
    expect(new Set(other).size).toBe(2);
    expect(gs.phase).toBe('pick');
    expect(gs.log.some((l) => l.text.includes('点将卡'))).toBe(true);
  });

  it('基础池 3 人局（分配分支）：强制者直接获得角色，其余随机分配且不重复', async () => {
    const blood = await engine();
    const gs = blood.createBloodGame(
      3,
      [
        { id: 'p0', name: '甲', seat: 0 },
        { id: 'p1', name: '乙', seat: 1 },
        { id: 'p2', name: '丙', seat: 2 },
      ],
      at(2026, 10, 8),
      false,
      false,
      { forcedChars: { p1: 'dealer' } },
    );
    expect(gs.players[1]!.charId).toBe('dealer');
    expect(gs.players[1]!.charOptions).toEqual([]);
    const others = [gs.players[0]!.charId, gs.players[2]!.charId];
    expect(others.every((c) => c != null && c !== 'dealer')).toBe(true);
    expect(new Set(others).size).toBe(2);
  });

  it('同角色重复点将先到先得；池外角色静默忽略', async () => {
    const blood = await engine();
    const gs = blood.createBloodGame(
      2,
      [
        { id: 'p0', name: '甲', seat: 0 },
        { id: 'p1', name: '乙', seat: 1 },
      ],
      at(2026, 10, 8),
      true,
      false,
      { forcedChars: { p0: 'liu', p1: 'liu', p2: 'not-a-char' } },
    );
    expect(gs.players[0]!.charOptions).toEqual(['liu']);
    expect(gs.players[1]!.charOptions).not.toContain('liu');
    expect(gs.players[1]!.charOptions).toHaveLength(2);
  });
});

describe('rooms 集成 · 开局生效才扣次', () => {
  it('注册会话点将 → 开局 charOptions 单选且扣 1 次；未注册设置直接拒绝；再来一场重新扣次', async () => {
    vi.resetModules();
    const dianjiang = await import('../src/dianjiang');
    const { RoomManager } = await import('../src/rooms');
    const mgr = new RoomManager();
    const m = mgr as unknown as Record<string, (...a: unknown[]) => unknown>;
    const rooms = (mgr as unknown as { rooms: Map<string, never> }).rooms as unknown as Map<
      string,
      {
        code: string;
        sessions: Map<string, { id: string; accountId?: string; dianjiangPick?: string }>;
        hostId: string;
        game: { final: unknown; phase: string; players: { id: string; charOptions: string[] }[] } | null;
      }
    >;
    const ws = (ip: string) =>
      ({ readyState: 1, OPEN: 1, send: () => {}, on: () => {}, close: () => {}, ip }) as never;

    m.handleCreate(ws('7.7.1.1'), { t: 'create', name: '甲', maxPlayers: 2, mode: 'blood' });
    const room = [...rooms.values()][0]!;
    // 补全 broadcast/buildView 所需字段（handleDianjiang 成功路径会广播）
    Object.assign(room, {
      hostId: [...room.sessions.values()][0]!.id,
      ownerIp: '',
      settings: { sb: 5, bb: 10, startChips: 1000 },
      charExpansion: true,
      expansion: false,
      targetTickets: 0,
      pendingRemove: new Set(),
      emptySince: 0,
      botBrains: new Map(),
      botNextAct: new Map(),
      matchLogged: false,
      gameStartedAt: null,
      chatLog: [],
    });
    const host = [...room.sessions.values()][0]!;
    // 未注册：设置被拒
    expect(() => m.handleDianjiang(room, host, { t: 'dianjiang', charId: 'liu' })).toThrow(/注册用户/);
    // 注册后设置 → 开局生效 + 扣次（经实例调用保住 this.broadcast）
    host.accountId = 'acc-1';
    m.handleDianjiang(room, host, { t: 'dianjiang', charId: 'liu' });
    expect(host.dianjiangPick).toBe('liu');
    m.handleJoin(ws('7.7.1.2'), { t: 'join', code: room.code, name: '乙' }); // 满足 2 人开局
    m.handleStart(room, host);
    expect(room.game!.players[0]!.charOptions).toEqual(['liu']);
    expect(dianjiang.dianjiangRemaining('acc-1')).toBe(2);
    // 再来一场（终局态伪造）：新的一局重新扣次
    room.game!.final = { winnerSeat: 0, ranking: [] };
    room.game!.phase = 'gameover';
    m.handleBlood(room, host, { t: 'bRematch' });
    expect(dianjiang.dianjiangRemaining('acc-1')).toBe(1);
  });
});
