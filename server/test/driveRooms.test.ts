/**
 * 勿停 · 房间层集成测试（RoomManager 真实入口 + 假 WebSocket 收件箱）
 *
 * 钉住接线口径：mode 白名单、设置只认界面选项（对局中拒绝）、solo 可开局、意图走专用令牌桶
 * （洪流不断线且不触发整帧广播、伪造重复键绕不过）、66ms 快拍驱动与 10Hz 广播节流与瘦身、
 * 岗位权限经 WS 生效（非驾驶位的油门被静默忽略、切岗位后可驾驶）、全员断线 30s 就地终局、
 * 离开经 removeSession→driveLeave、终局三件套（matchlog/房间记录/审计 end）各落一份、
 * 再来一局/返回房间、不支持机器人、matchlog 重启重载保留 drive。
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
  vi.setSystemTime(new Date(2026, 10, 23, 12));
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
  /** 以 66ms 一拍驱动快拍 */
  const step = (ticks: number): void => {
    for (let i = 0; i < ticks; i++) {
      vi.setSystemTime(new Date(Date.now() + 66));
      m.tickDriveRooms();
    }
  };
  return { m, room, socks, raw, listMatches, step };
}

const game = (room: { game: unknown }): DriveState => room.game as DriveState;
const ofType = (ws: FakeWs, t: string) => ws.inbox.filter((x) => x.t === t);
const lastState = (ws: FakeWs) => ofType(ws, 'state').at(-1)?.view as Record<string, unknown> | undefined;
const lastDrive = (ws: FakeWs) =>
  ofType(ws, 'state')
    .filter((x) => (x.view as { kind?: string }).kind === 'drive')
    .at(-1)?.view as Record<string, unknown> | undefined;

describe('勿停 · 房间接线', () => {
  it('设置只认界面选项并进等待页视图；对局中拒绝；不能加机器人', async () => {
    const { room, socks, raw } = await setup(2);
    raw(socks[0], { t: 'settings', driveSignGap: 300, driveDurability: 5, driveTail: 'fierce', driveCrawl: 'high', driveCurves: 'lenient', driveTarget: 10 });
    expect([room.driveSignGap, room.driveDurability, room.driveTail, room.driveCrawl, room.driveCurves, room.driveTarget]).toEqual([300, 5, 'fierce', 'high', 'lenient', 10]);
    raw(socks[0], { t: 'settings', driveSignGap: 777, driveDurability: 4, driveTail: 'absurd', driveCrawl: 'absurd', driveCurves: 'absurd', driveTarget: 9 });
    // 非选项值全部忽略
    expect([room.driveSignGap, room.driveDurability, room.driveTail, room.driveCrawl, room.driveCurves, room.driveTarget]).toEqual([300, 5, 'fierce', 'high', 'lenient', 10]);
    expect(lastState(socks[1])).toMatchObject({ mode: 'drive', driveSignGap: 300, driveDurability: 5, driveCurves: 'lenient' });
    raw(socks[0], { t: 'addBot' });
    expect(ofType(socks[0], 'error').at(-1)).toMatchObject({ code: 'BAD_MODE' });
    raw(socks[0], { t: 'start' });
    expect(game(room).phase).toBe('driving');
    expect([game(room).signGap, game(room).maxDurability, game(room).curveSetting]).toEqual([300, 5, 'lenient']);
    raw(socks[0], { t: 'settings', driveSignGap: 600 });
    expect(ofType(socks[0], 'error').at(-1)).toMatchObject({ code: 'IN_GAME' });
  });

  it('solo 可开局；油门与转向意图由 66ms 快拍模拟；广播按 ~10Hz 节流且不重复捎带日志', async () => {
    const { room, socks, raw, step } = await setup(1);
    raw(socks[0], { t: 'start' });
    expect(game(room).phase).toBe('driving');
    expect(lastState(socks[0])).toMatchObject({ kind: 'drive', speed: 0, solo: true, canDrive: true, canNavigate: true });
    const statesBefore = ofType(socks[0], 'state').length;
    raw(socks[0], { t: 'vInt', intent: { k: 'gas', on: true } });
    // 意图本身不触发整帧广播（状态只由快拍发）
    expect(ofType(socks[0], 'state').length).toBe(statesBefore);
    step(20); // 20 拍 ≈ 1.3s，跨过 100ms 广播节流窗口
    expect(game(room).speed).toBeGreaterThan(0);
    expect(game(room).pos).toBeGreaterThan(0);
    expect(game(room).lateral).toBe(0);
    const states = ofType(socks[0], 'state');
    expect(states.length - statesBefore).toBeGreaterThanOrEqual(10); // ~10Hz
    expect(states.length - statesBefore).toBeLessThan(20); // 且明显少于拍数（节流生效）
    // 广播瘦身：驾驶首帧带日志尾部，后续帧不再重复捎带（增量走 event 通道）
    const driveStates = states.filter((x) => (x.view as { kind?: string }).kind === 'drive');
    expect((driveStates[0]!.view as { log: unknown[] }).log.length).toBeGreaterThan(0);
    expect((driveStates.at(-1)!.view as { log: unknown[] }).log).toEqual([]);
    // 转向：按住右 → 车向右横移；松开 → 车头角回落
    raw(socks[0], { t: 'vInt', intent: { k: 'steer', dir: 1 } });
    step(10);
    const relPeak = game(room).rel;
    expect(game(room).lateral).toBeGreaterThan(0.5);
    raw(socks[0], { t: 'vInt', intent: { k: 'steer', dir: 0 } });
    step(10);
    expect(game(room).rel).toBeLessThan(relPeak);
    // 视图帧保留两位小数且受 100ms 广播节流（最多落后一两拍）：与引擎值按容差比对
    const frame = lastDrive(socks[0]) as { steerIn: number; myRole: string; drivers: number; lateral: number; rel: number };
    expect([frame.steerIn, frame.myRole, frame.drivers]).toEqual([0, 'drive', 1]);
    expect(Math.abs(frame.lateral - game(room).lateral)).toBeLessThan(1);
    expect(Math.abs(frame.rel - game(room).rel)).toBeLessThan(0.1);
    // 静默意图：非法值不报错不广播
    const before = ofType(socks[0], 'state').length;
    raw(socks[0], { t: 'vInt', intent: { k: 'nope' } });
    raw(socks[0], { t: 'vInt', intent: { k: 'steer', dir: 7 } });
    expect(ofType(socks[0], 'error')).toHaveLength(0);
    expect(ofType(socks[0], 'state').length).toBe(before);
  });

  it('岗位权限经 WS：非驾驶位的油门被静默忽略；切到驾驶位后可驾驶，切回即松手', async () => {
    const { room, socks, raw, step } = await setup(2);
    raw(socks[0], { t: 'start' });
    expect(game(room).players.map((p) => p.role)).toEqual(['drive', 'navigate']);
    expect(lastDrive(socks[1])).toMatchObject({ myRole: 'navigate', canDrive: false, canNavigate: true, solo: false });
    raw(socks[1], { t: 'vInt', intent: { k: 'gas', on: true } });
    step(10);
    expect(game(room).speed).toBe(0); // 副驾驶踩不动油门
    expect(game(room).inputs[game(room).players[1]!.id]).toBeUndefined();
    expect(ofType(socks[1], 'error')).toHaveLength(0); // 静默忽略，不弹错

    raw(socks[1], { t: 'vInt', intent: { k: 'role', role: 'drive' } });
    raw(socks[1], { t: 'vInt', intent: { k: 'gas', on: true } });
    step(10);
    expect(game(room).speed).toBeGreaterThan(0);
    expect(game(room).players[1]!.role).toBe('drive');
    expect(lastDrive(socks[1])).toMatchObject({ myRole: 'drive', canDrive: true, canNavigate: false, drivers: 2 });

    // 导航位专属：开窗 / 喊话 / 地图标记——驾驶员发会被静默忽略，副驾驶发生效并随帧下发
    raw(socks[0], { t: 'vInt', intent: { k: 'window', side: 'L' } });
    raw(socks[0], { t: 'vInt', intent: { k: 'call', i: 4 } });
    expect(game(room).windows.L.open).toBe(false);
    expect(game(room).calls).toHaveLength(0);
    raw(socks[1], { t: 'vInt', intent: { k: 'role', role: 'navigate' } });
    expect(game(room).inputs[game(room).players[1]!.id]).toMatchObject({ gas: false, steer: 0 }); // 切岗位即松手
    raw(socks[1], { t: 'vInt', intent: { k: 'window', side: 'L' } });
    raw(socks[1], { t: 'vInt', intent: { k: 'call', i: 4 } });
    raw(socks[1], { t: 'vInt', intent: { k: 'ping', at: 260, lat: 3.5 } });
    step(2);
    expect(lastDrive(socks[0])).toMatchObject({
      windows: { L: { open: true } },
      calls: [{ by: '乙', i: 4 }],
      pings: [{ at: 260, lat: 4, by: '乙' }], // 横向位置取整到米
    });
  });

  it('意图洪流走专用令牌桶：不断线、不占普通桶；伪造重复键绕不过', async () => {
    const { room, socks, raw } = await setup(2);
    raw(socks[0], { t: 'start' });
    const statesBefore = ofType(socks[1], 'state').length;
    for (let i = 0; i < 200; i++) raw(socks[0], { t: 'vInt', intent: { k: 'steer', dir: i % 2 ? 1 : -1 } });
    expect(socks[0].closedWith).toBeNull(); // 超速静默丢弃，不断线
    // 意图不触发整帧广播（状态只由快拍发）
    expect(ofType(socks[1], 'state').length).toBe(statesBefore);
    expect([-1, 0, 1]).toContain(game(room).inputs[game(room).players[0]!.id]?.steer ?? 0);
    // 普通桶完好：洪流后房主仍能正常操作（终止本局）
    raw(socks[0], { t: 'vAbort' });
    expect(game(room).phase).toBe('gameover');

    // 伪造：前缀是 vInt、实际 t 是别的（JSON 重复键取后者）→ 直接丢弃，不派发
    const { room: room2, socks: s2, raw: raw2 } = await setup(2);
    raw2(s2[0], '{"t":"vInt","t":"start"}');
    expect(room2.game).toBeNull();
  });

  it('终局那一帧无视广播节流：对局结束的拍落在 100ms 窗口里也必须立刻发出', async () => {
    const { room, socks, raw, step } = await setup(1);
    raw(socks[0], { t: 'start' });
    step(1); // 正常一拍：广播并记下时刻（此后 100ms 内的拍会被节流）
    const g = game(room);
    const me = [...room.sessions.values()][0] as { id: string };
    // 把车摆到「下一拍必死」的位置：耐久 1，正前方贴着一条路障
    g.durability = 1;
    g.speed = 60;
    g.road.events = [{ at: g.pos + 0.2, kind: 'barrier', lat: 0, half: 1.3 }];
    socks[0].inbox = [];
    step(1); // +66ms：撞上路障车毁——离上一次广播不到 100ms
    expect(game(room).phase).toBe('gameover');
    const frames = ofType(socks[0], 'state');
    expect(frames.length).toBeGreaterThan(0); // 没有被节流吞掉
    expect((frames.at(-1)!.view as { phase: string }).phase).toBe('gameover');
    // 之后不再重复广播（终局帧只发这一次）
    const count = frames.length;
    step(10);
    expect(ofType(socks[0], 'state').length).toBe(count);
  });

  it('全员断线 30s 就地终局（快拍驱动）', async () => {
    const { m, room } = await setup(2);
    m.handleStart(room, [...room.sessions.values()][0]);
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
    const { m, room, socks, raw } = await setup(2);
    raw(socks[0], { t: 'start' });
    raw(socks[0], { t: 'vInt', intent: { k: 'gas', on: true } });
    raw(socks[1], { t: 'leave' });
    expect(game(room).players[1]!.left).toBe(true);
    raw(socks[0], { t: 'leave' });
    expect(game(room).phase).toBe('gameover');
    expect(game(room).result?.reason).toBe('leave');
    expect(game(room).inputs[game(room).players[0]!.id]).toBeUndefined();
    // 末人离开：房间就地删除（不留在房间列表里当僵尸）
    expect((m as unknown as { rooms: Map<string, unknown> }).rooms.has(room.code)).toBe(false);
  });

  it('终局三件套各落一份；重复广播不重复；再来一局/返回房间', async () => {
    const { m, room, socks, raw, listMatches } = await setup(2);
    raw(socks[0], { t: 'settings', driveCurves: 'fierce' });
    raw(socks[0], { t: 'start' });
    raw(socks[0], { t: 'vAbort' });
    expect(game(room).phase).toBe('gameover');
    // 终局块在 broadcast 内：abort 后 handleVAbort 已广播一次
    const entries = listMatches().filter((e) => e.mode === 'drive');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      seatCount: 2,
      winnerSeat: -1,
      settings: { signGap: 400, durability: 3, tail: 'normal', crawl: 'normal', curve: 'fierce', target: 0 },
    });
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
    expect(game(room).players.map((p) => p.role)).toEqual(['drive', 'navigate']); // 新局岗位重置为默认
    expect(room.matchHistory).toHaveLength(1); // 新局未终局，不新增
    raw(socks[0], { t: 'vAbort' });
    raw(socks[0], { t: 'backToRoom' });
    expect(room.game).toBeNull();
  });

  it('重连收到完整对局视图（含岗位与权限）', async () => {
    const { m, room, socks, raw } = await setup(2);
    raw(socks[0], { t: 'start' });
    const guest = [...room.sessions.values()][1] as { token: string; id: string };
    socks[1].inbox = [];
    const ws2b = mkWs('9.9.2.9');
    m.handleRejoin(ws2b, { t: 'rejoin', token: guest.token });
    expect(lastState(ws2b)).toMatchObject({ kind: 'drive', phase: 'driving', myRole: 'navigate', canNavigate: true });
  });

  it('matchlog 重启重载保留 drive 记录（KNOWN_MODES 含 drive）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 23, 12));
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
