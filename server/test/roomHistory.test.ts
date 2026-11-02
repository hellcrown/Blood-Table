/**
 * 房间对局记录（roomMatchHistory）· 房间层集成测试
 *
 * 存在原因：用户需求「未离开房间之前，所有对局记录可回看」——记录必须与 matchLogged
 * 哨兵同频每局恰好一份，backToRoom 清掉 room.game 后仍可回看；离开房间（无绑定）即不可看。
 * 用 converge（快、可精确驱动终局）验证条目内容/再来一局累积/上限截断，用 mines 验证另一模式的名次行。
 */
import { describe, expect, it, vi } from 'vitest';
import type { RoomMatchEntry } from '@shared/protocol';

type Handlers = Record<string, (...a: unknown[]) => unknown>;
type AnyWs = { readyState: number; OPEN: number; send: (d: string) => void; on: () => void; close: () => void; ip: string };

function mkWs(ip: string, inbox?: unknown[]): AnyWs {
  return {
    readyState: 1,
    OPEN: 1,
    send: (d: string) => inbox?.push(JSON.parse(d)),
    on: () => {},
    close: () => {},
    ip,
  };
}

/** 建一个双人房（房主 wsA + 加入者 wsB），返回管理器、房间与两名会话 */
async function setupRoom(mode: 'converge' | 'mines', wsA: AnyWs, wsB: AnyWs) {
  const { RoomManager } = await import('../src/rooms');
  const mgr = new RoomManager();
  const m = mgr as unknown as Handlers;
  m.handleCreate(wsA, { t: 'create', name: '甲', maxPlayers: 2, mode });
  // 测试读私有字段：房间是 any 形状（与 converge.test 的最小 RoomManager 冒烟同口径）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const room: any = (mgr as unknown as { rooms: Map<string, unknown> }).rooms.values().next().value;
  m.handleJoin(wsB, { t: 'join', code: room.code, name: '乙' });
  const [host, guest] = [...room.sessions.values()];
  return { m, room, host, guest };
}

describe('房间对局记录', () => {
  it('converge：终局落一份含完整轮次的记录；再来一局累积；backToRoom 后仍在；快照新局在前', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 2, 12));
    vi.resetModules();
    const inboxA: unknown[] = [];
    const wsA = mkWs('8.8.8.1', inboxA);
    const wsB = mkWs('8.8.8.2');
    const { m, room, host } = await setupRoom('converge', wsA, wsB);

    // 第 1 局：第 1 轮不匹配、第 2 轮全角对半角相遇
    m.handleStart(room, host);
    m.dispatch(wsA, { t: 'cSubmit', text: '午睡' });
    m.dispatch(wsB, { t: 'cSubmit', text: '肥牛卷' });
    m.dispatch(wsA, { t: 'cSubmit', text: '６' });
    m.dispatch(wsB, { t: 'cSubmit', text: '6' });
    expect(room.game.phase).toBe('gameover');
    expect(room.matchHistory).toHaveLength(1);
    const first = room.matchHistory[0] as RoomMatchEntry;
    expect(first.mode).toBe('converge');
    expect(first.title).toContain('用 2 轮相遇「６」');
    expect(first.converge?.rounds).toHaveLength(2);
    expect(first.converge?.rounds[0].same).toBe(false);
    expect(first.converge?.rounds[1].same).toBe(true);
    expect(first.converge?.rounds[0].entries.map((e) => e.text)).toEqual(['午睡', '肥牛卷']);
    expect(first.ranks.map((r) => r.name)).toEqual(['甲', '乙']);

    // 终局后的重复广播（tick/聊天等触发）不得重复落记录：matchLogged 哨兵
    (m.broadcast as (r: unknown) => void).call(m, room);
    expect(room.matchHistory).toHaveLength(1);

    // 第 2 局：再来一局 + 1 轮相遇 → 记录累积为 2
    m.handleCRematch(room, host);
    m.dispatch(wsA, { t: 'cSubmit', text: '雪' });
    m.dispatch(wsB, { t: 'cSubmit', text: '雪' });
    expect(room.matchHistory).toHaveLength(2);

    // backToRoom：game 清空但历史保留
    m.handleBackToRoom(room, host);
    expect(room.game).toBeNull();
    expect(room.matchHistory).toHaveLength(2);

    // 快照：新局在前
    inboxA.length = 0;
    m.dispatch(wsA, { t: 'roomMatchHistory' });
    const logMsg = inboxA.find((x) => (x as { t: string }).t === 'roomMatchLog') as { entries: RoomMatchEntry[] };
    expect(logMsg).toBeTruthy();
    expect(logMsg.entries).toHaveLength(2);
    expect(logMsg.entries[0].title).toContain('相遇「雪」');
    expect(logMsg.entries[1].title).toContain('用 2 轮相遇「６」');
    vi.useRealTimers();
    vi.resetModules();
  });

  it('mines：一人中途离开即终局，记录存活者在前、离场者记「出局」', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 2, 12));
    vi.resetModules();
    const wsA = mkWs('9.9.9.1');
    const wsB = mkWs('9.9.9.2');
    const { m, room, host, guest } = await setupRoom('mines', wsA, wsB);
    m.handleStart(room, host);
    m.handleLeave(room, guest); // 乙离开 → mLeave 记出局 → 只剩甲存活即终局 → broadcast 落记录
    expect(room.game.phase).toBe('gameover');
    expect(room.matchHistory).toHaveLength(1);
    const entry = room.matchHistory[0] as RoomMatchEntry;
    expect(entry.mode).toBe('mines');
    expect(entry.title).toContain('初级');
    expect(entry.winnerSeat).toBe(host.seat);
    expect(entry.ranks[0]).toMatchObject({ name: '甲', text: '存活 · 已揭 0 格' });
    expect(entry.ranks[1]).toMatchObject({ name: '乙', text: '出局 · 已揭 0 格' });
    vi.useRealTimers();
    vi.resetModules();
  });

  it('未入房的连接请求记录回 NOT_IN_ROOM；记录上限 20 条丢最旧', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 2, 12));
    vi.resetModules();
    const { RoomManager } = await import('../src/rooms');
    const lone = new RoomManager() as unknown as Handlers;
    const strayInbox: unknown[] = [];
    const stray = mkWs('7.7.7.9', strayInbox);
    lone.dispatch(stray, { t: 'roomMatchHistory' });
    expect(strayInbox.some((x) => (x as { t: string; code?: string }).t === 'error' && (x as { code: string }).code === 'NOT_IN_ROOM')).toBe(true);

    const wsA = mkWs('7.7.7.10');
    const wsB = mkWs('7.7.7.11');
    const { m, room, host } = await setupRoom('converge', wsA, wsB);
    for (let i = 0; i < 21; i++) {
      if (room.game == null) m.handleStart(room, host);
      else m.handleCRematch(room, host);
      m.dispatch(wsA, { t: 'cSubmit', text: `词${i}` });
      m.dispatch(wsB, { t: 'cSubmit', text: `词${i}` });
      expect(room.game.phase).toBe('gameover');
    }
    expect(room.matchHistory).toHaveLength(20);
    expect(room.matchHistory[0].title).toContain('「词1」');
    expect(room.matchHistory[19].title).toContain('「词20」');
    vi.useRealTimers();
    vi.resetModules();
  });
});
