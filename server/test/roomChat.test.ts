/**
 * 房间内对话回归测试：广播范围（含观战者/本人回显）、身份与 account 标记、文本清洗、
 * 80 条封顶、发言/历史限频、未入房拒绝、随房间销毁清空、连接全链路路由。
 */
import { describe, expect, it } from 'vitest';
import { RoomManager } from '../src/rooms';
import type { ChatMsg } from '@shared/protocol';

interface StubWs {
  readyState: number;
  OPEN: number;
  ip: string;
  send: (d: string) => void;
  on: (ev: string, fn: (...a: unknown[]) => void) => void;
  close: () => void;
  listeners: Record<string, ((...a: unknown[]) => void)[]>;
}

function makeWs(ip: string, sent: unknown[] = []): StubWs {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    ip,
    send: (d: string) => sent.push(JSON.parse(d)),
    on: (ev, fn) => {
      (listeners[ev] ??= []).push(fn);
    },
    close: () => {},
    listeners,
  };
}

/** 直呼私有方法（绕过 ws 消息令牌桶；清洗/限频/封顶/广播仍走真实路径） */
function chat(mgr: RoomManager, room: unknown, session: unknown, text: string): void {
  (mgr as unknown as { handleRoomChat: (r: unknown, s: unknown, msg: unknown) => void }).handleRoomChat(room, session, {
    t: 'roomChat',
    text,
  });
}

function chatHistory(mgr: RoomManager, room: unknown, session: unknown): void {
  (mgr as unknown as { handleRoomChatHistory: (r: unknown, s: unknown) => void }).handleRoomChatHistory(room, session);
}

/** 造一个 1 房主 + 1 玩家 + 1 观战者的血色等待房（未开局，game=null） */
type SessionLike = { id: string; ws: StubWs; accountId?: string };
type RoomLike = { code: string; chatLog: ChatMsg[]; game: unknown; sessions: Map<string, SessionLike> };

function setup(): {
  mgr: RoomManager;
  rooms: Map<string, RoomLike>;
  room: RoomLike;
  host: SessionLike;
  guest: SessionLike;
  spec: SessionLike;
  hostSent: unknown[];
  guestSent: unknown[];
  specSent: unknown[];
} {
  const mgr = new RoomManager();
  const m = mgr as unknown as Record<string, (...a: unknown[]) => unknown>;
  const rooms = (mgr as unknown as { rooms: Map<string, RoomLike> }).rooms;
  const hostSent: unknown[] = [];
  m.handleCreate(makeWs('9.9.9.1', hostSent), { t: 'create', name: '甲', maxPlayers: 3, mode: 'blood' });
  const room = [...rooms.values()][0]!;
  const host = [...room.sessions.values()][0]!;
  const guestSent: unknown[] = [];
  m.handleJoin(makeWs('9.9.9.2', guestSent), { t: 'join', code: room.code, name: '乙' });
  const guest = [...room.sessions.values()].at(-1)!;
  const specSent: unknown[] = [];
  m.handleSpectate(makeWs('9.9.9.3', specSent), { t: 'spectate', code: room.code, name: '围观群众' });
  const spec = [...room.sessions.values()].at(-1)!;
  return { mgr, rooms, room, host, guest, spec, hostSent, guestSent, specSent };
}

describe('房间内对话 · 广播与身份', () => {
  it('发言广播给房内全部会话（含观战者与本人回显），并进入房间历史', () => {
    const { mgr, room, hostSent, guestSent, specSent } = setup();
    chat(mgr, room, [...room.sessions.values()][0]!, '大家好');
    for (const sent of [hostSent, guestSent, specSent]) {
      const msgs = sent.filter((x) => (x as { t: string }).t === 'roomChatMsg') as {
        name: string;
        text: string;
        ts: number;
      }[];
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ name: '甲', text: '大家好' });
    }
    expect(room.chatLog).toHaveLength(1);
    expect(room.chatLog[0]).toMatchObject({ name: '甲', text: '大家好' });
  });

  it('观战者可以发言；登录会话（accountId）消息带 account 标记', () => {
    const { mgr, room, spec, specSent, guestSent } = setup();
    (spec as { accountId?: string }).accountId = 'acc-1';
    chat(mgr, room, spec, '观战也能说话');
    for (const sent of [specSent, guestSent]) {
      const msgs = sent.filter((x) => (x as { t: string }).t === 'roomChatMsg') as { name: string; account?: boolean }[];
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ name: '围观群众', account: true });
    }
  });

  it('清洗：控制/零宽字符剔除、trim、120 字截断、纯空白丢弃', () => {
    const { mgr, room, host, hostSent } = setup();
    const s = host as unknown as { ws: StubWs };
    s.ws.ip = '8.8.8.1';
    chat(mgr, room, host, '  hi\u0003\u200b ');
    chat(mgr, room, host, `${'x'.repeat(130)}!`);
    chat(mgr, room, host, '   ');
    const msgs = hostSent.filter((x) => (x as { t: string }).t === 'roomChatMsg') as { text: string }[];
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.text).toBe('hi');
    expect(msgs[1]!.text).toHaveLength(120);
    expect(room.chatLog).toHaveLength(2);
  });
});

describe('房间内对话 · 限频与封顶', () => {
  it('发言限频 10 秒 5 条/IP：第 6 条静默丢弃（无广播、不入历史）', () => {
    const { mgr, room, host, hostSent, guestSent } = setup();
    for (let i = 1; i <= 6; i++) chat(mgr, room, host, `m${i}`);
    const sent = hostSent.filter((x) => (x as { t: string }).t === 'roomChatMsg');
    expect(sent).toHaveLength(5);
    expect(guestSent.filter((x) => (x as { t: string }).t === 'roomChatMsg')).toHaveLength(5);
    expect(room.chatLog.map((c) => c.text)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('历史封顶 80 条：保留最近 80（每条换源 IP 绕开发言限频，只验证封顶）', () => {
    const { mgr, room, host } = setup();
    const ws = (host as unknown as { ws: StubWs }).ws;
    for (let i = 1; i <= 85; i++) {
      ws.ip = `10.0.0.${i}`;
      chat(mgr, room, host, `m${i}`);
    }
    expect(room.chatLog).toHaveLength(80);
    expect(room.chatLog[0]).toMatchObject({ text: 'm6' });
    expect(room.chatLog[79]).toMatchObject({ text: 'm85' });
  });

  it('历史快照下发全量；限频 6 次/分/IP，第 7 次静默', () => {
    const { mgr, room, guest, guestSent } = setup();
    chat(mgr, room, guest, '第一条');
    for (let i = 0; i < 7; i++) chatHistory(mgr, room, guest);
    const logs = guestSent.filter((x) => (x as { t: string }).t === 'roomChatLog') as { msgs: ChatMsg[] }[];
    expect(logs).toHaveLength(6);
    expect(logs[0]!.msgs).toHaveLength(1);
    expect(logs[0]!.msgs[0]).toMatchObject({ text: '第一条' });
  });
});

describe('房间内对话 · 边界与生命周期', () => {
  it('未入房会话发 roomChat → NOT_IN_ROOM（进入绑定检查之后的分发分支）', () => {
    const mgr = new RoomManager();
    const sent: unknown[] = [];
    const ws = makeWs('1.1.1.1', sent);
    (mgr as unknown as { dispatch: (ws: unknown, msg: unknown) => void }).dispatch(ws, { t: 'roomChat', text: 'hi' });
    expect(sent).toEqual([{ t: 'error', code: 'NOT_IN_ROOM', msg: '尚未加入房间' }]);
  });

  it('连接全链路：handleConnection → onMessage → dispatch → 历史与广播（防路由接错分支）', () => {
    const { mgr, room, guest, guestSent } = setup();
    (mgr as unknown as { handleConnection: (ws: unknown) => void }).handleConnection(guest.ws);
    guest.ws.listeners.message![0]!(JSON.stringify({ t: 'roomChat', text: '全链路' }));
    expect(room.chatLog).toHaveLength(1);
    expect(room.chatLog[0]).toMatchObject({ name: '乙', text: '全链路' });
    // 经真实 send 路径回显到本连接（onMessage 全链路）
    const echo = guestSent.filter((x) => (x as { t: string }).t === 'roomChatMsg');
    expect(echo).toHaveLength(1);
  });

  it('房间销毁（全员离开）后历史随房间对象一并丢弃', () => {
    const { mgr, rooms, room, host, guest, spec } = setup();
    chat(mgr, room, host, '要解散了');
    expect(room.chatLog).toHaveLength(1);
    const d = mgr as unknown as { dispatch: (ws: unknown, msg: unknown) => void };
    d.dispatch(host.ws, { t: 'leave' });
    d.dispatch(guest.ws, { t: 'leave' });
    d.dispatch(spec.ws, { t: 'leave' });
    expect(rooms.size).toBe(0); // chatLog 挂在 Room 上，房间删除即清空
  });

  it('房内有 bot（ws=null）会话时广播不炸：bot 跳过、真人正常收到', () => {
    const { mgr, room, host, guestSent } = setup();
    const m = mgr as unknown as Record<string, (...a: unknown[]) => unknown>;
    m.handleAddBot(room, host);
    const botCount = [...room.sessions.values()].filter((s) => (s as { bot?: boolean }).bot).length;
    expect(botCount).toBe(1);
    chat(mgr, room, host, '机器人听得见吗');
    expect(room.chatLog).toHaveLength(1);
    const guestMsgs = guestSent.filter((x) => (x as { t: string }).t === 'roomChatMsg');
    expect(guestMsgs).toHaveLength(1); // bot 无连接被 send 跳过，真人广播不受影响
  });

  it('与对局状态机隔离：聊天不触发 state 帧、不推动 lastEventSeq', () => {
    const { mgr, room, host, guest, hostSent } = setup();
    const m = mgr as unknown as Record<string, (...a: unknown[]) => unknown>;
    m.handleStart(room, host); // 开血色对局（2 名已入座玩家）
    expect(room.game).not.toBeNull();
    const before = hostSent.length;
    const seqBefore = (guest as unknown as { lastEventSeq: number }).lastEventSeq;
    chat(mgr, room, host, '对局中聊天');
    const extra = hostSent.slice(before) as { t: string }[];
    expect(extra.length).toBeGreaterThan(0);
    expect(extra.every((x) => x.t === 'roomChatMsg')).toBe(true); // 只有聊天回显，无 state
    expect((guest as unknown as { lastEventSeq: number }).lastEventSeq).toBe(seqBefore);
  });
});
