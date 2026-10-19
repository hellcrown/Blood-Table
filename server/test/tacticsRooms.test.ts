/**
 * 血色猎场 · RoomManager 接线回归：handler 守卫、动作广播、超时驱动、
 * 全员断线宽限、离场淘汰与删房、再来一局、房间设置与等待页视图。
 */
import { describe, expect, it } from 'vitest';
import { createTacticsGame, type TacticsState } from '../src/tactics/engine';
import { buildView } from '../src/views';
import { RoomManager, type Room, type Session } from '../src/rooms';

const NOW = 1_000;

interface FakeWs {
  sent: { t?: string; view?: Record<string, unknown> }[];
  readyState: number;
  OPEN: number;
  send(x: string): void;
  close(): void;
}

function fakeWs(): FakeWs {
  const sent: FakeWs['sent'] = [];
  return {
    sent,
    readyState: 1,
    OPEN: 1,
    send(x: string) {
      sent.push(JSON.parse(x) as FakeWs['sent'][number]);
    },
    close() {
      /* noop */
    },
  };
}

function mkSession(id: string, seat: number): { s: Session; ws: FakeWs } {
  const ws = fakeWs();
  const s = {
    id,
    token: `tok-${id}`,
    name: id,
    seat,
    connected: true,
    ws: ws as unknown as Session['ws'],
    lastEventSeq: 0,
  } as Session;
  return { s, ws };
}

function mkTacticsRoom(sessions: Session[], gs: TacticsState, code = 'T1'): Room {
  return {
    code,
    hostId: sessions[0]?.id ?? '',
    ownerIp: '',
    maxPlayers: 4,
    mode: 'tactics',
    settings: { sb: 5, bb: 10, startChips: 1000 },
    charExpansion: false,
    expansion: false,
    targetTickets: 0,
    minesDifficulty: 'easy',
    minesTimeSec: 0,
    minesEmptySince: 0,
    tacticsMapSize: 'small',
    tacticsTurnSec: 0,
    tacticsEmptySince: 0,
    sessions: new Map(sessions.map((x) => [x.id, x])),
    chatLog: [],
    game: gs,
    pendingRemove: new Set(),
    emptySince: 0,
    botBrains: new Map(),
    botNextAct: new Map(),
    matchLogged: false,
    gameStartedAt: NOW,
  } as unknown as Room;
}

function setup(n = 2, code = 'T1'): { mgr: RoomManager; room: Room; gs: TacticsState; conns: { s: Session; ws: FakeWs }[] } {
  const mgr = new RoomManager();
  const conns = Array.from({ length: n }, (_, i) => mkSession(`p${i}`, i));
  const gs = createTacticsGame(
    'small',
    conns.map(({ s }) => ({ id: s.id, name: s.name, seat: s.seat })),
    NOW,
  );
  const room = mkTacticsRoom(conns.map(({ s }) => s), gs, code);
  return { mgr, room, gs, conns };
}

interface Handlers {
  handleTMove(r: Room, s: Session, m: { t: 'tMove'; to?: { r: number; c: number } }): void;
  handleTEndTurn(r: Room, s: Session): void;
  handleLeave(r: Room, s: Session): void;
  handleTRematch(r: Room, s: Session): void;
  handleSettings(r: Room, s: Session, m: { t: 'settings'; tacticsMapSize?: string; tacticsTurnSec?: number }): void;
  tickRoom(r: Room, now: number): void;
}
const H = (mgr: RoomManager): Handlers => mgr as unknown as Handlers;
const roomsOf = (mgr: RoomManager) => (mgr as unknown as { rooms: Map<string, Room> }).rooms;

type ViewLike = { kind?: string; players?: { id: string; ap?: number; alive?: boolean }[]; phase?: string };
function lastState(ws: FakeWs): ViewLike | undefined {
  return [...ws.sent].reverse().find((m) => m.t === 'state')?.view as ViewLike | undefined;
}

/** 清成空白棋盘（白盒布子用） */
function clearBoard(gs: TacticsState): void {
  gs.grid = new Array(gs.rows * gs.cols).fill(0);
  gs.monsters = [];
}

describe('血色猎场 · RoomManager 接线', () => {
  it('移动走 handler：按路径扣 AP 并向全会话广播战棋视图', () => {
    const { mgr, room, gs, conns } = setup();
    clearBoard(gs); // p0 出生 (1,1)
    H(mgr).handleTMove(room, conns[0].s, { t: 'tMove', to: { r: 1, c: 3 } });
    expect(gs.players[0]!.ap).toBe(2); // 2 步 = 2 AP
    for (const { ws } of conns) {
      const v = lastState(ws);
      expect(v?.kind).toBe('tactics');
      expect(v?.players?.[0]?.ap).toBe(2);
    }
  });

  it('畸形消息静默忽略：无 to / 非战棋房均不抛不移动', () => {
    const { mgr, room, gs, conns } = setup();
    clearBoard(gs);
    expect(() => H(mgr).handleTMove(room, conns[0].s, { t: 'tMove' })).not.toThrow();
    expect(gs.players[0]!.ap).toBe(4);

    room.mode = 'mines';
    expect(() => H(mgr).handleTMove(room, conns[0].s, { t: 'tMove', to: { r: 1, c: 3 } })).not.toThrow();
    expect(gs.players[0]!.r).toBe(1);
  });

  it('观战者操作显式报错', () => {
    const { mgr, room, conns } = setup();
    const spec = mkSession('w1', -1);
    spec.s.spectator = true;
    room.sessions.set('w1', spec.s);
    expect(() => H(mgr).handleTMove(room, spec.s, { t: 'tMove', to: { r: 1, c: 3 } })).toThrowError(/观战/);
    expect(conns[0].ws.sent.length).toBe(0);
  });

  it('结束回合与超时驱动：tickRoom 超时自动移交并广播', () => {
    const { mgr, room, gs, conns } = setup();
    H(mgr).handleTEndTurn(room, conns[0].s);
    expect(gs.currentId).toBe('p1');
    expect(tacticsTickQuiet(mgr, room, gs.deadline - 1)).toBe(false); // 未超时
    expect(tacticsTickQuiet(mgr, room, gs.deadline + 1)).toBe(true); // deadline 已过
    expect(gs.currentId).toBe('p0');
    expect(lastState(conns[0].ws)?.players?.[0]).toBeDefined();
  });

  it('全员断线 30s 宽限后就地终局并落 matchLogged 哨兵', () => {
    const { mgr, room, gs, conns } = setup();
    for (const { s } of conns) s.connected = false;
    H(mgr).tickRoom(room, NOW + 1000); // 记录 tacticsEmptySince
    expect(gs.phase).toBe('playing');
    H(mgr).tickRoom(room, NOW + 31_000);
    expect(gs.phase).toBe('gameover');
    expect(room.matchLogged).toBe(true); // 终局审计只写一次
  });

  it('进行中离场：立即淘汰、2 人局对手获胜；末人离开删房', () => {
    const { mgr, room, gs, conns } = setup();
    H(mgr).handleLeave(room, conns[1].s);
    expect(gs.phase).toBe('gameover');
    expect(gs.winnerId).toBe('p0');
    expect(room.sessions.has('p1')).toBe(false);
    expect(gs.players.find((p) => p.id === 'p1')?.alive).toBe(false); // 退出者留在排名
    H(mgr).handleLeave(room, conns[0].s);
    expect(roomsOf(mgr).has('T1')).toBe(false);
  });

  it('再来一局：房主终局后重开新局；非房主拒绝', () => {
    const { mgr, room, gs, conns } = setup();
    gs.phase = 'gameover';
    gs.winnerId = 'p0';
    expect(() => H(mgr).handleTRematch(room, conns[1].s)).toThrowError(/房主/);
    H(mgr).handleTRematch(room, conns[0].s);
    const g2 = room.game as TacticsState;
    expect(g2).not.toBe(gs);
    expect(g2.phase).toBe('playing');
    expect(g2.players.length).toBe(2);
  });

  it('房间设置：房主可改尺寸/时限，非法值按白名单与钳制处理，对局中拒绝', () => {
    const { mgr, room, conns } = setup();
    room.game = null; // 设置仅等待期可改
    H(mgr).handleSettings(room, conns[0].s, { t: 'settings', tacticsMapSize: 'large', tacticsTurnSec: 90 });
    expect(room.tacticsMapSize).toBe('large');
    expect(room.tacticsTurnSec).toBe(90);
    H(mgr).handleSettings(room, conns[0].s, { t: 'settings', tacticsMapSize: 'giant', tacticsTurnSec: 5 });
    expect(room.tacticsMapSize).toBe('large'); // 白名单外忽略
    expect(room.tacticsTurnSec).toBe(10); // 钳到下限
    expect(() => H(mgr).handleSettings(room, conns[1].s, { t: 'settings', tacticsTurnSec: 60 })).toThrowError(/房主/);

    room.game = createTacticsGame('small', [
      { id: 'p0', name: 'p0', seat: 0 },
      { id: 'p1', name: 'p1', seat: 1 },
    ], NOW);
    expect(() => H(mgr).handleSettings(room, conns[0].s, { t: 'settings', tacticsTurnSec: 60 })).toThrowError(/对局进行中/);
  });

  it('等待页视图携带战棋设置字段', () => {
    const { mgr, room, conns } = setup();
    room.game = null;
    H(mgr).handleSettings(room, conns[0].s, { t: 'settings', tacticsMapSize: 'large', tacticsTurnSec: 90 });
    const view = buildView(room, 'p0');
    expect(view.mode).toBe('tactics');
    expect(view.tacticsMapSize).toBe('large');
    expect(view.tacticsTurnSec).toBe(90);
  });
});

/** tickRoom 的战棋分支是否有状态变化（changed 返回值经 bridge 不可见，用 currentId 变化间接断言） */
function tacticsTickQuiet(mgr: RoomManager, room: Room, now: number): boolean {
  const gs = room.game as TacticsState;
  const before = gs.currentId;
  H(mgr).tickRoom(room, now);
  return gs.currentId !== before;
}
