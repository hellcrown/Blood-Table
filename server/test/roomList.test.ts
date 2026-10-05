/**
 * 公开房间列表回归测试：
 * - listPublicRooms：密码房过滤、players=非观战会话数（含 bot/断线、不含观战）、
 *   排序（等待中→对局中→已结束，同状态人数多在前）、100 上限
 * - handleListRooms：未入房 ws 可请求；每 IP 12 次/分限流
 */
import { describe, expect, it } from 'vitest';
import { RoomManager } from '../src/rooms';

type AnyRoom = Parameters<RoomManager['broadcast']>[0];

/** 构造最小 Room 形状（listPublicRooms 只读这些字段） */
function makeRoom(overrides: {
  code: string;
  password?: string;
  mode?: 'blood' | 'classic';
  game?: { phase: string } | null;
  maxPlayers?: number;
  hostId?: string;
  sessions?: { id: string; bot?: boolean; spectator?: boolean; connected?: boolean; name?: string }[];
}): AnyRoom {
  return {
    code: overrides.code,
    mode: overrides.mode ?? 'blood',
    maxPlayers: overrides.maxPlayers ?? 4,
    hostId: overrides.hostId ?? '',
    password: overrides.password,
    game: overrides.game ?? null,
    sessions: new Map(
      (overrides.sessions ?? []).map((x) => [
        x.id,
        { id: x.id, name: x.name ?? x.id, seat: x.spectator ? -1 : 0, connected: x.connected ?? true, bot: x.bot, spectator: x.spectator },
      ]),
    ),
    botBrains: new Map(),
    pendingRemove: new Set(),
  } as unknown as AnyRoom;
}

/** 调私有方法（列表逻辑即将成为公开契约，直接经实例桥调用） */
function listPublic(m: RoomManager): ReturnType<RoomManager['listPublicRooms']> {
  return (m as unknown as { listPublicRooms: () => ReturnType<RoomManager['listPublicRooms']> }).listPublicRooms();
}

describe('listPublicRooms · 过滤与口径', () => {
  it('密码房不进列表；players=非观战会话数（含 bot/断线、不含观战）', () => {
    const m = new RoomManager();
    const priv = (m as unknown as { rooms: Map<string, AnyRoom> }).rooms;
    priv.set('PUB1', makeRoom({
      code: 'PUB1',
      hostId: 'h1',
      sessions: [
        { id: 'h1', name: '房主' },
        { id: 'b1', bot: true },
        { id: 'off1', connected: false },
        { id: 'w1', spectator: true },
      ],
    }));
    priv.set('PW1', makeRoom({ code: 'PW1', password: '1234' }));
    const list = listPublic(m);
    expect(list.map((r) => r.code)).toEqual(['PUB1']);
    const r = list[0]!;
    expect(r.players).toBe(3); // 房主 + bot + 断线座位；观战者不计
    expect(r.maxPlayers).toBe(4);
    expect(r.host).toBe('房主');
    expect(r.phase).toBe('waiting');
  });

  it('排序：等待中 → 对局中 → 已结束；同状态人数多在前', () => {
    const m = new RoomManager();
    const priv = (m as unknown as { rooms: Map<string, AnyRoom> }).rooms;
    priv.set('G1', makeRoom({ code: 'G1', game: { phase: 'reveal' }, sessions: [{ id: 'a' }] }));
    priv.set('W1', makeRoom({ code: 'W1', sessions: [{ id: 'a' }, { id: 'b' }] }));
    priv.set('G2', makeRoom({ code: 'G2', game: { phase: 'swap' }, sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
    priv.set('E1', makeRoom({ code: 'E1', game: { phase: 'gameover' }, sessions: [{ id: 'a' }] }));
    priv.set('W2', makeRoom({ code: 'W2', sessions: [{ id: 'a' }] }));
    const codes = listPublic(m).map((r) => r.code);
    expect(codes).toEqual(['W1', 'W2', 'G2', 'G1', 'E1']);
  });

  it('封顶 100 条', () => {
    const m = new RoomManager();
    const priv = (m as unknown as { rooms: Map<string, AnyRoom> }).rooms;
    for (let i = 0; i < 120; i++) priv.set(`R${i}`, makeRoom({ code: `R${i}` }));
    expect(listPublic(m)).toHaveLength(100);
  });
});

describe('handleListRooms · 限流与未入房可用', () => {
  function fakeWs(ip: string): { ip: string; sent: unknown[]; readyState: number; OPEN: number; send: (d: string) => void } {
    return { ip, sent: [], readyState: 1, OPEN: 1, send(d: string) { this.sent.push(JSON.parse(d)); } };
  }

  it('未入房 ws 发 listRooms 收到 roomList 快照；超过 12 次/分被拒', () => {
    const m = new RoomManager();
    const priv = (m as unknown as { rooms: Map<string, AnyRoom> }).rooms;
    priv.set('PUB1', makeRoom({ code: 'PUB1', sessions: [{ id: 'a' }] }));
    const ws = fakeWs('1.2.3.4');
    const h = (m as unknown as { handleListRooms: Function }).handleListRooms.bind(m);
    h(ws);
    expect((ws.sent[0] as { t: string; rooms: { code: string }[] }).t).toBe('roomList');
    expect((ws.sent[0] as { rooms: { code: string }[] }).rooms.map((r) => r.code)).toContain('PUB1');
    for (let i = 0; i < 11; i++) h(ws);
    expect(ws.sent).toHaveLength(12);
    expect(() => h(ws)).toThrow(/频繁/);
    // 另一 IP 不受影响
    const ws2 = fakeWs('5.6.7.8');
    h(ws2);
    expect(ws2.sent).toHaveLength(1);
  });
});
