/**
 * 勿停 · 房间层集成测试（RoomManager 真实入口 + 假 WebSocket 收件箱）
 *
 * 钉住接线口径：mode 白名单、设置只认界面选项（对局中拒绝）、solo 可开局、意图走专用令牌桶
 * （洪流不断线且不触发整帧广播、伪造重复键绕不过）、66ms 快拍驱动与 10Hz 广播节流、
 * 全员断线 30s 就地终局、离开经 removeSession→driveLeave、终局三件套（matchlog/房间记录/
 * 审计 end）各落一份、再来一局/返回房间、不支持机器人、matchlog 重启重载保留 drive。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DriveState } from '@shared/driveProtocol';

type Handlers = Record<string, (...a: unknown[]) => unknown>;
interface FakeWs {
  readyState: number;
  OPEN: number;
  ip: string;
  inbox: Record<string, unknown>[];
  closedWith: number | null;
  send: (d: string) => void;
  on: () => void;
  close: (code?: number) => void;
}

function mkWs(ip: string): FakeWs {
  const ws: FakeWs = {
    readyState: 1,
    OPEN: 1,
    ip,
    inbox: [],
    closedWith: null,
    send: (d: string) => ws.inbox.push(JSON.parse(d) as Record<string, unknown>),
    on: () => {},
    close: (code?: number) => {
      ws.closedWith = code ?? 0;
    },
  };
  return ws;
}

const NAMES = ['甲', '乙', '丙', '丁'];
let cleanupDir: string | null = null;

afterEach(() => {
  if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
  cleanupDir = null;
  vi.useRealTimers();
  vi.resetModules();
});

async function setup(n = 2, maxPlayers = 4) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 22, 12));
  vi.resetModules();
  const { initMatchStore, listMatches } = await import('../src/matchlog');
  cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-rooms-'));
  initMatchStore(path.join(cleanupDir, 'matches.jsonl'));
  const { RoomManager } = await import('../src/rooms');
  const mgr = new RoomManager();
  const m = mgr as unknown as Handlers;
  const socks = Array.from({ length: n }, (_, i) => mkWs(`9.9.2.${i + 1}`));
  m.handleCreate(socks[0], { t: 'create', name: NAMES[0], maxPlayers, mode: 'drive' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const room: any = (mgr as unknown as { rooms: Map<string, unknown> }).rooms.values().next().value;
  for (let i = 1; i < n; i++) m.handleJoin(socks[i], { t: 'join', code: room.code, name: NAMES[i] });
  /** 走真实入口（令牌桶/前缀分流/JSON 解析/错误帧）发送原始报文 */
  const raw = (ws: FakeWs, msg: unknown): void => {
    m.onMessage(ws, Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)));
  };
  return { m, room, socks, raw, listMatches };
}

const game = (room: { game: unknown }): DriveState => room.game as DriveState;
const ofType = (ws: FakeWs, t: string) => ws.inbox.filter((x) => x.t === t);
const lastState = (ws: FakeWs) => ofType(ws, 'state').at(-1)?.view as Record<string, unknown> | undefined;
const host = (room: { sessions: Map<string, unknown> }) => [...room.sessions.values()][0] as { id: string };

describe('勿停 · 房间接线', () => {
  it('设置只认界面选项并进等待页视图；对局中拒绝；不能加机器人', async () => {
    const { room, socks, raw } = await setup(2);
    raw(socks[0], { t: 'settings', driveSignGap: 300, driveDurability: 5, driveTail: 'fierce', driveCrawl: 'high', driveTarget: 10 });
    expect([room.driveSignGap, room.driveDurability, room.driveTail, room.driveCrawl, room.driveTarget]).toEqual([300, 5, 'fierce', 'high', 10]);
    raw(socks[0], { t: 'settings', driveSignGap: 777, driveDurability: 4, driveTail: 'absurd', driveCrawl: 'absurd', driveTarget: 9 });
    // 非选项值全部忽略
    expect([room.driveSignGap, room.driveDurability, room.driveTail, room.driveCrawl, room.driveTarget]).toEqual([300, 5, 'fierce', 'high', 10]);
    expect(lastState(socks[1])).toMatchObject({ mode: 'drive', driveSignGap: 300, driveDurability: 5, driveTail: 'fierce' });
    raw(socks[0], { t: 'addBot' });
    expect(ofType(socks[0], 'error').at(-1)).toMatchObject({ code: 'BAD_MODE' });
    raw(socks[0], { t: 'start' });
    expect(game(room).phase).toBe('driving');
    expect(game(room).signGap).toBe(300);
    expect(game(room).maxDurability).toBe(5);
    raw(socks[0], { t: 'settings', driveSignGap: 600 });
    expect(ofType(socks[0], 'error').at(-1)).toMatchObject({ code: 'IN_GAME' });
  });

  it('solo 可开局；意图驱动车辆由 66ms 快拍模拟；广播按 ~10Hz 节流', async () => {
    const { m, room, socks, raw } = await setup(1);
    raw(socks[0], { t: 'start' });
    expect(game(room).phase).toBe('driving');
    expect(lastState(socks[0])).toMatchObject({ kind: 'drive', speed: 0 });
    raw(socks[0], { t: 'vInt', intent: { k: 'gas', on: true } });
    const t0 = Date.now();
    // 快拍 20 拍（66ms/拍），跨过 100ms 广播节流窗口
    for (let i = 1; i <= 20; i++) {
      vi.setSystemTime(new Date(t0 + i * 66));
      m.tickDriveRooms();
    }
    expect(game(room).speed).toBeGreaterThan(0);
    expect(game(room).pos).toBeGreaterThan(0);
    const states = ofType(socks[0], 'state');
    expect(states.length).toBeGreaterThanOrEqual(10); // ~10Hz：20 拍 ≈ 1.3s → ≥10 帧
    expect(states.length).toBeLessThan(20); // 且明显少于拍数（节流生效）
    // 广播瘦身：驾驶首帧带日志尾部，后续帧不再重复捎带（增量走 event 通道，客户端不渲染全量日志）
    const driveStates = states.filter((x) => (x.view as { kind?: string }).kind === 'drive');
    expect((driveStates[0]!.view as { log: unknown[] }).log.length).toBeGreaterThan(0);
    expect((driveStates[driveStates.length - 1]!.view as { log: unknown[] }).log).toEqual([]);
    // 静默意图：非法值不报错不广播
    raw(socks[0], { t: 'vInt', intent: { k: 'nope' } });
    expect(ofType(socks[0], 'error')).toHaveLength(0);
  });

  it('意图洪流走专用令牌桶：不断线、不占普通桶；伪造重复键绕不过', async () => {
    const { m, room, socks, raw } = await setup(2);
    raw(socks[0], { t: 'start' });
    const statesBefore = ofType(socks[1], 'state').length;
    for (let i = 0; i < 200; i++) raw(socks[0], { t: 'vInt', intent: { k: 'ping', lane: 1, at: 100 } });
    expect(socks[0].closedWith).toBeNull(); // 超速静默丢弃，不断线
    // 意图不触发整帧广播（状态只由快拍发）
    expect(ofType(socks[1], 'state').length).toBe(statesBefore);
    // 普通桶完好：洪流后房主仍能正常操作（终止本局）
    raw(socks[0], { t: 'vAbort' });
    expect(game(room).phase).toBe('gameover');
    // ping 上限 8 条环形截断（意图风暴里只留 8 条）
    expect(game(room).pings.length).toBeLessThanOrEqual(8);

    // 伪造：前缀是 vInt、实际 t 是别的（JSON 重复键取后者）→ 直接丢弃，不派发
    const { room: room2, socks: s2, raw: raw2 } = await setup(2);
    raw2(s2[0], '{"t":"vInt","t":"start"}');
    expect(room2.game).toBeNull();
  });

  it('全员断线 30s 就地终局（快拍驱动）', async () => {
    const { m, room } = await setup(2);
    m.handleStart(room, host(room));
    for (const s of room.sessions.values()) s.connected = false;
    const t0 = Date.now();
    vi.setSystemTime(new Date(t0 + 1000));
    m.tickDriveRooms();
    expect(game(room).phase).toBe('driving'); // 宽限期内不动
    vi.setSystemTime(new Date(t0 + 31_000));
    m.tickDriveRooms();
    expect(game(room).phase).toBe('gameover');
    expect(game(room).result?.reason).toBe('idle');
    expect(room.matchLogged).toBe(true);
  });

  it('离开经 removeSession→driveLeave：清持键、全员离开即终局', async () => {
    const { room, socks, raw } = await setup(2);
    raw(socks[0], { t: 'start' });
    raw(socks[0], { t: 'vInt', intent: { k: 'gas', on: true } });
    raw(socks[1], { t: 'leave' });
    expect(game(room).players[1]!.left).toBe(true);
    raw(socks[0], { t: 'leave' });
    expect(game(room).phase).toBe('gameover');
    expect(game(room).result?.reason).toBe('leave');
    expect(game(room).inputs[game(room).players[0]!.id]?.gas).toBe(false);
  });

  it('终局三件套各落一份；重复广播不重复；再来一局/返回房间', async () => {
    const { m, room, socks, raw, listMatches } = await setup(2);
    raw(socks[0], { t: 'start' });
    raw(socks[0], { t: 'vAbort' });
    expect(game(room).phase).toBe('gameover');
    // 终局块在 broadcast 内：abort 后 handleVAbort 已广播一次
    const entries = listMatches().filter((e) => e.mode === 'drive');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ seatCount: 2, winnerSeat: -1, settings: { signGap: 400, durability: 3, tail: 'normal', crawl: 'normal', target: 0 } });
    expect(entries[0]!.players.every((p) => p.rank === 2)).toBe(true); // 未逃生全员 rank 2
    expect(room.matchHistory).toHaveLength(1);
    expect(room.matchHistory[0]).toMatchObject({ mode: 'drive', drive: { signs: 0 } });
    (m.broadcast as (r: unknown) => void).call(m, room);
    expect(listMatches().filter((e) => e.mode === 'drive')).toHaveLength(1); // 哨兵防重
    expect(room.matchHistory).toHaveLength(1);

    // 再来一局：非房主拒绝、房主可开；返回房间清局
    raw(socks[1], { t: 'vRematch' });
    expect(ofType(socks[1], 'error').at(-1)).toMatchObject({ code: 'NOT_HOST' });
    raw(socks[0], { t: 'vRematch' });
    expect(game(room).phase).toBe('driving');
    expect(room.matchHistory).toHaveLength(1); // 新局未终局，不新增
    raw(socks[0], { t: 'vAbort' });
    raw(socks[0], { t: 'backToRoom' });
    expect(room.game).toBeNull();
  });

  it('重连收到完整对局视图；被拖走状态保留', async () => {
    const { m, room, socks, raw } = await setup(2);
    raw(socks[0], { t: 'start' });
    const guest = [...room.sessions.values()][1] as { token: string; id: string };
    socks[1].inbox = [];
    const ws2b = mkWs('9.9.2.9');
    m.handleRejoin(ws2b, { t: 'rejoin', token: guest.token });
    expect(lastState(ws2b)).toMatchObject({ kind: 'drive', phase: 'driving' });
  });

  it('matchlog 重启重载保留 drive 记录（KNOWN_MODES 含 drive）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 22, 12));
    vi.resetModules();
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-rooms-'));
    const file = path.join(cleanupDir, 'matches.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({ endedAt: 1, mode: 'drive', seatCount: 2, winnerSeat: -1, settings: { signGap: 300 }, players: [{ name: '甲', seat: 0, rank: 1 }] }) + '\n',
    );
    const { initMatchStore, listMatches } = await import('../src/matchlog');
    initMatchStore(file);
    expect(listMatches().filter((e) => e.mode === 'drive')).toHaveLength(1);
  });
});
