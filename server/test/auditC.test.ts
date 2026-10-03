/**
 * 全面审查（2026-10-03）批次 C 的回归测试：房间/会话生命周期。
 *
 * C8 血色对局进行中「请离」不释放座位：被请离者的会话仍留在 room.sessions，
 * 于是它继续占用满员名额（加入判定按 session 数），而其令牌已被清空、无人可接管该座位 ——
 * 房间从此恒显示已满，替补永远进不来（德扑模式同场景是能释放的）。
 * 引擎侧其实并不需要这个会话：对局中的玩家由引擎的 bs.players 持有（断线即走超时托管）。
 */
import { describe, expect, it } from 'vitest';
import { createBloodGame } from '../src/blood/engine';
import { RoomManager, type Room, type Session } from '../src/rooms';
import type { BloodState } from '../src/blood/types';

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

function mkSession(id: string, seat: number, opts: { connected?: boolean } = {}): Session {
  const connected = opts.connected ?? true;
  return {
    id,
    token: `tok-${id}`,
    name: id,
    seat,
    connected,
    ws: connected ? (fakeWs() as unknown as Session['ws']) : null,
    lastEventSeq: 0,
  } as Session;
}

function mkRoom(code: string, game: BloodState, sessions: Session[], maxPlayers = 2): Room {
  return {
    code,
    hostId: sessions[0]?.id ?? '',
    ownerIp: '',
    maxPlayers,
    mode: 'blood',
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

/** 调用私有 handleKickPlayer（既有测试同样以类型断言触及私有方法） */
function kick(mgr: RoomManager, room: Room, host: Session, seat: number): void {
  (
    mgr as unknown as { handleKickPlayer: (r: Room, s: Session, m: { t: 'kickPlayer'; seat: number }) => void }
  ).handleKickPlayer(room, host, { t: 'kickPlayer', seat });
}

function newMidGame(): { mgr: RoomManager; room: Room; bs: BloodState; h0: Session; p1: Session } {
  const mgr = new RoomManager();
  const h0 = mkSession('h0', 0);
  const p1 = mkSession('p1', 1);
  const bs = createBloodGame(
    2,
    [
      { id: 'h0', name: '房主', seat: 0 },
      { id: 'p1', name: '乙', seat: 1 },
    ],
    NOW,
  );
  bs.phase = 'buy'; // 非安全阶段：对局进行中
  return { mgr, room: mkRoom('7K', bs, [h0, p1], 2), bs, h0, p1 };
}

describe('批次 C · 对局中请离必须释放座位', () => {
  it('被请离者的会话被移除（座位释放），引擎玩家保留交由超时托管', () => {
    const { mgr, room, bs, h0 } = newMidGame();
    kick(mgr, room, h0, 1);

    expect(room.sessions.has('p1')).toBe(false); // 修复前：仍占座
    expect(bs.players.length).toBe(2); // 对局不被打断（人数/座位数不变）
    expect(bs.seatCount).toBe(2);
    expect(bs.phase).toBe('buy');
    expect(bs.players.find((p) => p.id === 'p1')!.connected).toBe(false); // 引擎侧已离场 → 托管接手
  });

  it('释放后房间不再显示满员：座位数回到 maxPlayers 以下，替补可以进来', () => {
    const { mgr, room, h0 } = newMidGame();
    const seated = (): number => [...room.sessions.values()].filter((s) => !s.spectator).length;
    expect(seated()).toBe(2); // 请离前：满员（2/2）
    kick(mgr, room, h0, 1);
    expect(seated()).toBe(1); // 修复前仍是 2 → 加入路径按 ROOM_FULL 拒绝所有替补
    expect(seated() < room.maxPlayers).toBe(true);
  });

  it('请离后令牌失效且不可凭账号找回（防止被踢者占回座位）', () => {
    const { mgr, room, h0, p1 } = newMidGame();
    kick(mgr, room, h0, 1);
    expect(p1.token).toBe('');
    expect(room.sessions.has('p1')).toBe(false);
  });
});
