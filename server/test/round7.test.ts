/**
 * 第七轮深查回修回归测试：
 * - null 字面量消息不崩进程（第六轮修复锁定，此前两轮曾在此处引入回归）
 * - 未入局会话打对局动作被 NO_PLAYER 拒绝而非 INTERNAL（第五轮修复锁定）
 * - bBlufferDeclare 畸形宣告元素按 BAD_MSG 边界拒绝（本轮 arrOf 收紧）
 * - bRematch 按房间当前会话重建对局：对局中入座者进入新局（本轮）
 * - 房主断线（关标签页）时终局 backToRoom / bRematch / 经典 rematch 由在场者接任（本轮）
 * - handleSit 校验失败不留副作用（本轮）
 * - tickAll 按房间隔离异常：毒房间强制回收，不饿死其余房间（本轮）
 */
import { describe, expect, it } from 'vitest';
import { BloodError, bPickChar, createBloodGame } from '../src/blood/engine';
import type { BloodState } from '../src/blood/types';
import { createGame, startHand } from '../src/game/engine';
import type { GState } from '../src/game/types';
import { RoomManager, type Room, type Session } from '../src/rooms';

const NOW = 1000;

function fakeWs(): { sent: unknown[]; readyState: number; OPEN: number; send(x: string): void; close(): void } {
  const sent: unknown[] = [];
  return {
    sent,
    readyState: 1,
    OPEN: 1,
    send(x: string) {
      sent.push(JSON.parse(x) as unknown);
    },
    close() {
      /* noop */
    },
  };
}

function mkSession(
  id: string,
  seat: number,
  opts: { bot?: boolean; spectator?: boolean; connected?: boolean } = {},
): Session {
  const connected = opts.connected ?? true;
  return {
    id,
    token: `tok-${id}`,
    name: id,
    seat,
    connected,
    ws: connected ? (fakeWs() as unknown as Session['ws']) : null,
    lastEventSeq: 0,
    ...(opts.bot ? { bot: true } : {}),
    ...(opts.spectator ? { spectator: true } : {}),
  } as Session;
}

function mkRoom(
  code: string,
  mode: 'blood' | 'classic',
  game: BloodState | GState | null,
  sessions: Session[],
  maxPlayers = 4,
): Room {
  return {
    code,
    hostId: sessions[0]?.id ?? '',
    ownerIp: '',
    maxPlayers,
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

function bloodGame2p(): BloodState {
  const gs = createBloodGame(2, [{ id: 'p0', name: '甲', seat: 0 }, { id: 'p1', name: '乙', seat: 1 }], NOW);
  for (const p of gs.players) {
    p.charOptions = ['dealer', 'noble'];
    bPickChar(gs, p.id, 'dealer', NOW);
  }
  return gs;
}

function expectBloodError(fn: () => void, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BloodError);
    expect((e as BloodError).code).toBe(code);
    return;
  }
  throw new Error(`应当抛出 BloodError(${code})，但没有抛错`);
}

function expectGameError(fn: () => void, code: string): void {
  try {
    fn();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`应当抛出 GameError(${code})，但没有抛错`);
}

describe('第七轮 · 消息边界', () => {
  it('null 字面量与非对象消息按 BAD_MSG 拒绝且不抛出（进程不崩），合法 ping 不受影响', () => {
    const mgr = new RoomManager();
    const ws = fakeWs();
    for (const raw of ['null', '"x"', '123', '[1,2]', '{"t":42}', '{}']) {
      expect(() => (mgr as unknown as { onMessage: (w: unknown, r: string) => void }).onMessage(ws, raw)).not.toThrow();
      const last = ws.sent[ws.sent.length - 1] as { t: string; code?: string };
      expect(last?.t).toBe('error');
      expect(last?.code).toBe('BAD_MSG');
    }
    (mgr as unknown as { onMessage: (w: unknown, r: string) => void }).onMessage(ws, '{"t":"ping","n":7}');
    expect(ws.sent[ws.sent.length - 1]).toEqual({ t: 'pong', n: 7 });
  });
});

describe('第七轮 · handleBlood 边界', () => {
  it('未入局会话 bSwap 按 NO_PLAYER 拒绝（而非 find(...)! TypeError → INTERNAL）', () => {
    const mgr = new RoomManager();
    const p0 = mkSession('p0', 0);
    const late = mkSession('late', 2); // 对局开始后才入座，不在 bs.players
    const room = mkRoom('7A', 'blood', bloodGame2p(), [p0, late]);
    expectBloodError(
      () =>
        (
          mgr as unknown as {
            handleBlood: (r: Room, s: Session, m: { t: string; cardIds?: string[] }) => void;
          }
        ).handleBlood(room, late, { t: 'bSwap', cardIds: [] }),
      'NO_PLAYER',
    );
  });

  it('bBlufferDeclare 宣告列表含 null/非对象元素时按 BAD_MSG 拒绝，状态不变', () => {
    const mgr = new RoomManager();
    const p0 = mkSession('p0', 0);
    const p1 = mkSession('p1', 1);
    const bs = bloodGame2p();
    const room = mkRoom('7B', 'blood', bs, [p0, p1]);
    bs.secretPending = { seat: 'p0', kind: 'blufferDeclare', oppQueue: [], buyerId: 'p0' };
    bs.players[0].play = [bs.players[0].hand[0]];
    const h = (
      mgr as unknown as {
        handleBlood: (r: Room, s: Session, m: { t: string; declared?: unknown[] }) => void;
      }
    ).handleBlood;
    expectBloodError(() => h(room, p0, { t: 'bBlufferDeclare', declared: [null] }), 'BAD_MSG');
    expectBloodError(() => h(room, p0, { t: 'bBlufferDeclare', declared: [1] }), 'BAD_MSG');
    expect(bs.bluffer).toBeNull(); // 宣告未生效
    expect(bs.secretPending?.kind).toBe('blufferDeclare');
  });
});

describe('第七轮 · 重开与房主接任', () => {
  function gameover3pRoom(): { mgr: RoomManager; room: Room; bs: BloodState; s2: Session } {
    const mgr = new RoomManager();
    const p0 = mkSession('p0', 0);
    const bot = mkSession('bot', 1, { bot: true });
    const s2 = mkSession('s2', 2); // 对局中入座，不在旧局 players
    const bs = bloodGame2p();
    bs.phase = 'gameover';
    const room = mkRoom('7C', 'blood', bs, [p0, bot, s2], 3);
    return { mgr, room, bs, s2 };
  }

  it('bRematch：新房按房间会话重建，对局中入座者进入新局', () => {
    const { mgr, room, s2 } = gameover3pRoom();
    room.targetTickets = 10; // 自定义目标随重开保留
    (
      mgr as unknown as { handleBlood: (r: Room, s: Session, m: { t: string }) => void }
    ).handleBlood(room, room.sessions.get('p0')!, { t: 'bRematch' });
    const fresh = room.game as BloodState;
    // 3 人局角色不足时引擎直接随机分配进入构筑（charPool 4 < 每人 2），关键断言是入座者不再被排除
    expect(fresh.phase).not.toBe('gameover');
    expect(fresh.players.map((p) => p.id).sort()).toEqual(['bot', 'p0', 's2']); // s2 不再被排除
    expect(fresh.target).toBe(10);
    expect(room.hostId).toBe('p0');
    expect(s2.connected).toBe(true);
  });

  it('房主断线（关标签页）：终局 bRematch 由在场者接任，断线房主保留在新局（token 可重连）', () => {
    const { mgr, room } = gameover3pRoom();
    room.sessions.get('p0')!.connected = false;
    (
      mgr as unknown as { handleBlood: (r: Room, s: Session, m: { t: string }) => void }
    ).handleBlood(room, room.sessions.get('s2')!, { t: 'bRematch' });
    expect(room.hostId).toBe('s2'); // 接任
    const fresh = room.game as BloodState;
    expect(fresh.players.map((p) => p.id).sort()).toEqual(['bot', 'p0', 's2']);
  });

  it('非终局或房主在线时接任不发生：bRematch 保持 NOT_HOST / 静默口径', () => {
    const { mgr, room, bs } = gameover3pRoom();
    // 非终局 + 房主断线：不接任，NOT_HOST
    bs.phase = 'swap';
    room.sessions.get('p0')!.connected = false;
    expectGameError(
      () =>
        (
          mgr as unknown as { handleBlood: (r: Room, s: Session, m: { t: string }) => void }
        ).handleBlood(room, room.sessions.get('s2')!, { t: 'bRematch' }),
      'NOT_HOST',
    );
    expect(room.hostId).toBe('p0');
    // 终局 + 房主在线：非房主仍 NOT_HOST
    bs.phase = 'gameover';
    room.sessions.get('p0')!.connected = true;
    expectGameError(
      () =>
        (
          mgr as unknown as { handleBlood: (r: Room, s: Session, m: { t: string }) => void }
        ).handleBlood(room, room.sessions.get('s2')!, { t: 'bRematch' }),
      'NOT_HOST',
    );
    expect(room.hostId).toBe('p0');
  });

  it('房主断线：终局 backToRoom 由在场者接任回房间，断线真人会话被清理', () => {
    const { mgr, room, bs } = gameover3pRoom();
    room.sessions.get('p0')!.connected = false;
    // 未终局（final 空）：IN_GAME 且不接任
    expectGameError(
      () =>
        (
          mgr as unknown as { handleBlood: (r: Room, s: Session, m: { t: string }) => void }
        ).handleBlood(room, room.sessions.get('s2')!, { t: 'backToRoom' }),
      'IN_GAME',
    );
    expect(room.hostId).toBe('p0');
    expect(room.game).not.toBeNull();
    // 终局：接任 + 回房间 + 断线真人会话清理
    bs.final = { winnerSeat: 0, ranking: [] } as BloodState['final'];
    (
      mgr as unknown as { handleBlood: (r: Room, s: Session, m: { t: string }) => void }
    ).handleBlood(room, room.sessions.get('s2')!, { t: 'backToRoom' });
    expect(room.hostId).toBe('s2');
    expect(room.game).toBeNull();
    expect(room.sessions.has('p0')).toBe(false);
    expect(room.sessions.has('s2')).toBe(true);
  });
});

describe('第七轮 · 经典模式与座位', () => {
  it('经典 rematch：终局断线房主由在场者接任，重开回到等待态', () => {
    const mgr = new RoomManager();
    const h0 = mkSession('h0', 0);
    const p1 = mkSession('p1', 1);
    const cg = createGame({ sb: 5, bb: 10, startChips: 1000 }, 2, [
      { id: 'h0', name: '房主', seat: 0, chips: 1000 },
      { id: 'p1', name: '乙', seat: 1, chips: 1000 },
    ]);
    startHand(cg, NOW);
    cg.phase = 'gameover'; // 模拟 bust-out 终局（advanceAfterResult 的产物）
    cg.result = null;
    cg.resultAt = null;
    cg.final = { ranking: [{ seat: 0, name: '房主', chips: 1000, wasAuto: false }] };
    const room = mkRoom('7D', 'classic', cg, [h0, p1]);
    h0.connected = false;
    (
      mgr as unknown as { handleRematch: (r: Room, s: Session) => void }
    ).handleRematch(room, p1);
    expect(room.hostId).toBe('p1');
    expect((room.game as GState).phase).toBe('waiting');
    expect((room.game as GState).players.find((p) => p.id === 'p1')!.chips).toBe(1000);
  });

  it('handleSit：座位非法时观战标志与座位不被副作用翻转，合法入座照常', () => {
    const mgr = new RoomManager();
    const host = mkSession('host', 0);
    const spec = mkSession('spec', -1, { spectator: true });
    const room = mkRoom('7E', 'blood', null, [host, spec]);
    const sit = (s: Session, seat: number): void =>
      (mgr as unknown as { handleSit: (r: Room, x: Session, m: { t: string; seat: number }) => void }).handleSit(
        room,
        s,
        { t: 'sit', seat },
      );
    expectGameError(() => sit(spec, 9), 'BAD_SEAT');
    expect(spec.spectator).toBe(true); // 失败无副作用
    expect(spec.seat).toBe(-1);
    expectGameError(() => sit(spec, 0), 'SEAT_TAKEN');
    expect(spec.spectator).toBe(true);
    sit(spec, 1);
    expect(spec.spectator).toBe(false);
    expect(spec.seat).toBe(1);
  });
});

describe('第七轮 · tickAll 房间隔离', () => {
  it('毒房间连续异常被强制回收并通知在线会话，其余房间照常驱动；瞬时异常自愈不回收', () => {
    const mgr = new RoomManager();
    const poison = mkSession('poison', 0);
    const poisonWs = poison.ws as unknown as ReturnType<typeof fakeWs>; // mkSession 内部即 fakeWs，直接取其 sent
    const poisonGame = new Proxy(
      {},
      {
        get() {
          throw new Error('poison');
        },
      },
    );
    const roomA = mkRoom('A', 'blood', poisonGame as unknown as BloodState, [poison]);
    const healthy = mkSession('ok', 0);
    const roomB = mkRoom('B', 'blood', null, [healthy]);
    const transient = mkSession('t', 0);
    let blows = 2;
    const transientGame = {
      get phase(): string {
        if (blows > 0) {
          blows--;
          throw new Error('temp');
        }
        return 'gameover';
      },
    };
    const roomC = mkRoom('C', 'blood', transientGame as unknown as BloodState, [transient]);
    const rooms = (mgr as unknown as { rooms: Map<string, Room> }).rooms;
    rooms.set('A', roomA);
    rooms.set('B', roomB);
    rooms.set('C', roomC);

    const tick = (): void => (mgr as unknown as { tickAll: () => void }).tickAll();
    tick();
    tick();
    expect(rooms.has('A')).toBe(true); // 未达阈值：仍保留
    expect(rooms.has('C')).toBe(true); // 瞬时异常未达阈值
    tick();
    expect(rooms.has('A')).toBe(false); // 连续 3 次异常：强制回收
    expect(rooms.has('B')).toBe(true); // 其余房间不受影响
    expect(rooms.has('C')).toBe(true);
    const lastMsg = poisonWs.sent[poisonWs.sent.length - 1] as { t: string; code?: string };
    expect(lastMsg?.code).toBe('ROOM_CLOSED'); // 在线会话收到通知
    // 毒房间回收后 C 恢复正常驱动（异常计数清零，不再累计）
    roomC.game = null;
    tick();
    tick();
    expect(rooms.has('C')).toBe(true);
    expect(roomC.tickFails ?? 0).toBe(0);
  });
});
