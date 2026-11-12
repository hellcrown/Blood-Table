/**
 * matchlog 全模式落库 · 房间层集成测试
 *
 * 存在原因：扫雷/猎场/心有灵犀终局此前只写审计与房间内记录，从不进 matchlog，
 * 管理端对局统计/近期对局只见血色+德州。本测试驱动三个模式各自终局，
 * 断言 listMatches 恰好各多一条对应模式摘要（与血色/经典同库同哨兵）。
 * 驱动方式照 roomHistory.test.ts（handleCreate/Join/Start + dispatch/Leave 到终局）。
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
async function setupRoom(mode: 'converge' | 'mines' | 'tactics', wsA: AnyWs, wsB: AnyWs) {
  const { RoomManager } = await import('../src/rooms');
  const mgr = new RoomManager();
  const m = mgr as unknown as Handlers;
  m.handleCreate(wsA, { t: 'create', name: '甲', maxPlayers: 2, mode });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const room: any = (mgr as unknown as { rooms: Map<string, unknown> }).rooms.values().next().value;
  m.handleJoin(wsB, { t: 'join', code: room.code, name: '乙' });
  const [host, guest] = [...room.sessions.values()];
  return { m, room, host, guest };
}

describe('matchlog 全模式落库（房间层）', () => {
  it('converge：相遇终局落一条 rank 双 1 的记录，重复广播不重复落库', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 7, 12));
    vi.resetModules();
    const { initMatchStore, listMatches } = await import('../src/matchlog');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matchlog-rooms-'));
    initMatchStore(path.join(dir, 'matches.jsonl'));
    const wsA = mkWs('8.8.8.1', []);
    const wsB = mkWs('8.8.8.2', []);
    const { m, room, host, guest } = await setupRoom('converge', wsA, wsB);

    m.handleStart(room, host);
    // 第 1 轮不匹配（全角 vs 半角不相遇）、第 2 轮相遇
    m.dispatch(wsA, { t: 'cSubmit', text: '午睡' });
    m.dispatch(wsB, { t: 'cSubmit', text: '肥牛卷' });
    m.dispatch(wsA, { t: 'cSubmit', text: '６' });
    m.dispatch(wsB, { t: 'cSubmit', text: '6' });
    expect(room.game.phase).toBe('gameover');

    const entries = listMatches().filter((x) => x.mode === 'converge');
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.room).toBe(room.code);
    expect(e.startedAt).toBe(room.gameStartedAt);
    expect(e.seatCount).toBe(2);
    expect(e.winnerSeat).toBe(-1); // 合作制无胜负概念
    expect(e.converge?.matched).toBe(true);
    expect(e.converge?.rounds).toBe(2);
    expect(e.converge?.word).toBe('６');
    expect(e.players.map((p) => [p.name, p.rank])).toEqual([
      ['甲', 1],
      ['乙', 1],
    ]);

    // matchLogged 哨兵：重复广播不得再落一条
    (m.broadcast as (r: unknown) => void).call(m, room);
    expect(listMatches().filter((x) => x.mode === 'converge')).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.resetModules();
  });

  it('mines：离场终局落一条带 revealed/status/difficulty 的记录', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 7, 12));
    vi.resetModules();
    const { initMatchStore, listMatches } = await import('../src/matchlog');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matchlog-rooms-'));
    initMatchStore(path.join(dir, 'matches.jsonl'));
    const wsA = mkWs('9.9.9.1', []);
    const wsB = mkWs('9.9.9.2', []);
    const { m, room, host, guest } = await setupRoom('mines', wsA, wsB);

    m.handleStart(room, host);
    m.handleLeave(room, guest); // 乙离场记出局 → 只剩甲存活即终局 → broadcast 落库
    expect(room.game.phase).toBe('gameover');

    const entries = listMatches().filter((x) => x.mode === 'mines');
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.seatCount).toBe(2);
    expect(e.winnerSeat).toBe(host.seat);
    expect(e.settings?.difficulty).toBe(room.minesDifficulty);
    expect(e.players[0]).toMatchObject({ name: '甲', rank: 1, revealed: 0, status: 'playing' });
    expect(e.players[1]).toMatchObject({ name: '乙', rank: 2, revealed: 0, status: 'out' });

    (m.broadcast as (r: unknown) => void).call(m, room);
    expect(listMatches().filter((x) => x.mode === 'mines')).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.resetModules();
  });

  it('tactics：离场终局落一条带 hp/alive/mapSize 的记录', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 7, 12));
    vi.resetModules();
    const { initMatchStore, listMatches } = await import('../src/matchlog');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matchlog-rooms-'));
    initMatchStore(path.join(dir, 'matches.jsonl'));
    const wsA = mkWs('9.9.9.3', []);
    const wsB = mkWs('9.9.9.4', []);
    const { m, room, host, guest } = await setupRoom('tactics', wsA, wsB);

    m.handleStart(room, host);
    m.handleLeave(room, guest); // 进行中离场：2 人局对手获胜、退出者留排名
    expect(room.game.phase).toBe('gameover');

    const entries = listMatches().filter((x) => x.mode === 'tactics');
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.seatCount).toBe(2);
    expect(e.winnerSeat).toBe(host.seat);
    expect(e.settings?.mapSize).toBe(room.tacticsMapSize);
    expect(e.players[0]).toMatchObject({ name: '甲', rank: 1, alive: true });
    expect(e.players[1]).toMatchObject({ name: '乙', rank: 2, alive: false });

    (m.broadcast as (r: unknown) => void).call(m, room);
    expect(listMatches().filter((x) => x.mode === 'tactics')).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.resetModules();
  });
});
