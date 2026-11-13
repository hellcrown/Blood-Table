/**
 * 你画我猜 · 房间层集成测试（RoomManager 真实入口 + 假 WebSocket 收件箱）
 *
 * 钉住接线口径：建房人数钳制与设置白名单、开局与消息路由、笔画只增量扇出给画手以外的人
 *（不触发整帧 state）、新进房/重连补整幅快照、笔画走专用令牌桶不触发洪泛断线（且伪造重复键
 * 绕不过普通限流）、作画中房间聊天答案打码、终局三件套（matchlog/房间记录/审计）各落一份、
 * 零回合的局不进战绩、再来一局/返回房间、不支持机器人。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DrawState } from '@shared/drawProtocol';

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
  vi.setSystemTime(new Date(2026, 10, 9, 12));
  vi.resetModules();
  const { initMatchStore, listMatches } = await import('../src/matchlog');
  cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'draw-rooms-'));
  initMatchStore(path.join(cleanupDir, 'matches.jsonl'));
  const { RoomManager } = await import('../src/rooms');
  const mgr = new RoomManager();
  const m = mgr as unknown as Handlers;
  const socks = Array.from({ length: n }, (_, i) => mkWs(`9.9.1.${i + 1}`));
  m.handleCreate(socks[0], { t: 'create', name: NAMES[0], maxPlayers, mode: 'draw' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const room: any = (mgr as unknown as { rooms: Map<string, unknown> }).rooms.values().next().value;
  for (let i = 1; i < n; i++) m.handleJoin(socks[i], { t: 'join', code: room.code, name: NAMES[i] });
  /** 走真实入口（令牌桶/前缀分流/JSON 解析/错误帧）发送原始报文 */
  const raw = (ws: FakeWs, msg: unknown): void => {
    m.onMessage(ws, Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)));
  };
  return { m, room, socks, raw, listMatches };
}

const game = (room: { game: unknown }): DrawState => room.game as DrawState;
const ofType = (ws: FakeWs, t: string) => ws.inbox.filter((x) => x.t === t);
const lastState = (ws: FakeWs) => ofType(ws, 'state').at(-1)?.view as Record<string, unknown> | undefined;

describe('你画我猜 · 房间接线', () => {
  it('建房人数钳在 2-4；等待页带设置；设置只认白名单；对局中拒绝改设置', async () => {
    const { m, room, socks, raw } = await setup(2, 8);
    expect(room.maxPlayers).toBe(4);
    raw(socks[0], { t: 'settings', drawTurnSec: 100, drawCycles: 3 });
    expect([room.drawTurnSec, room.drawCycles]).toEqual([100, 3]);
    raw(socks[0], { t: 'settings', drawTurnSec: 77, drawCycles: 11 });
    expect([room.drawTurnSec, room.drawCycles]).toEqual([100, 3]); // 非选项值忽略
    expect(lastState(socks[1])).toMatchObject({ mode: 'draw', drawTurnSec: 100, drawCycles: 3 });
    raw(socks[1], { t: 'settings', drawTurnSec: 60 });
    expect(ofType(socks[1], 'error').at(-1)).toMatchObject({ code: 'NOT_HOST' });
    m.handleStart(room, [...room.sessions.values()][0]);
    expect(game(room).turnSec).toBe(100);
    expect(game(room).cycles).toBe(3);
    raw(socks[0], { t: 'settings', drawTurnSec: 60 });
    expect(ofType(socks[0], 'error').at(-1)).toMatchObject({ code: 'IN_GAME' });
  });

  it('开局：画手先收到候选、猜词者看不到；选词后视图切到作画；不能加机器人', async () => {
    const { room, socks, raw } = await setup(2);
    raw(socks[0], { t: 'addBot' });
    expect(ofType(socks[0], 'error').at(-1)).toMatchObject({ code: 'BAD_MODE' });
    raw(socks[0], { t: 'start' });
    expect(game(room).phase).toBe('choosing');
    expect((lastState(socks[0])?.choices as unknown[]).length).toBe(3);
    expect(lastState(socks[1])?.choices).toBeNull();
    raw(socks[0], { t: 'dPick', index: 1 });
    expect(game(room).phase).toBe('drawing');
    const word = game(room).turn.word!.word;
    expect(lastState(socks[0])?.word).toBe(word);
    expect(lastState(socks[1])?.word).toBeNull();
    expect(JSON.stringify(socks[1].inbox)).not.toContain(`「${word}」`);
  });

  it('笔画只增量扇出给其他人、不触发整帧 state；新进房与重连补整幅快照', async () => {
    const { m, room, socks, raw } = await setup(2);
    raw(socks[0], { t: 'start' });
    raw(socks[0], { t: 'dPick', index: 0 });
    const statesBefore = [ofType(socks[0], 'state').length, ofType(socks[1], 'state').length];
    raw(socks[0], { t: 'dStroke', ops: [{ k: 'b', id: 1, c: 1, w: 1, p: [10, 10, 20, 20] }] });
    raw(socks[0], { t: 'dStroke', ops: [{ k: 'a', id: 1, p: [30, 30] }] });
    expect([ofType(socks[0], 'state').length, ofType(socks[1], 'state').length]).toEqual(statesBefore);
    expect(ofType(socks[0], 'dOps')).toHaveLength(0); // 画手不回显
    const ops = ofType(socks[1], 'dOps');
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ turn: game(room).turn.id, rev: game(room).drawRev, ops: [{ k: 'a', id: 1, p: [30, 30] }] });

    // 第三人进房（对局中进房=本局只能看）：补整幅快照
    const ws3 = mkWs('9.9.1.3');
    m.handleJoin(ws3, { t: 'join', code: room.code, name: '丙' });
    const snap = ofType(ws3, 'dSnap').at(-1);
    expect(snap).toMatchObject({ rev: game(room).drawRev, strokes: [{ id: 1, p: [10, 10, 20, 20, 30, 30] }] });
    expect(lastState(ws3)?.spectator).toBe(true);
    // 之后的增量他也能收到（游标已对齐）
    raw(socks[0], { t: 'dStroke', ops: [{ k: 'u' }] });
    expect(ofType(ws3, 'dOps').at(-1)).toMatchObject({ ops: [{ k: 'u' }] });

    // 猜词者重连：新连接拿整幅快照
    const guest = [...room.sessions.values()][1];
    const ws2b = mkWs('9.9.1.2');
    m.handleRejoin(ws2b, { t: 'rejoin', token: guest.token });
    expect(ofType(ws2b, 'dSnap').at(-1)).toMatchObject({ rev: game(room).drawRev, strokes: [] });
  });

  it('高频笔画走专用令牌桶：超速静默丢弃不断线、不占普通限流；伪造重复键绕不过普通桶', async () => {
    const { room, socks, raw } = await setup(2);
    raw(socks[0], { t: 'start' });
    raw(socks[0], { t: 'dPick', index: 0 });
    raw(socks[0], { t: 'dStroke', ops: [{ k: 'b', id: 1, c: 1, w: 0, p: [1, 1] }] });
    for (let i = 0; i < 200; i++) raw(socks[0], { t: 'dStroke', ops: [{ k: 'a', id: 1, p: [i % 900, 5] }] });
    expect(socks[0].closedWith).toBeNull();
    const delivered = ofType(socks[1], 'dOps').length;
    expect(delivered).toBeGreaterThanOrEqual(30);
    expect(delivered).toBeLessThan(201); // 桶容量 40：一瞬间的 201 条必然有丢弃
    // 普通桶完好：笔画洪流后画手仍能正常操作（房主终止本局）
    raw(socks[0], { t: 'dAbort' });
    expect(game(room).phase).toBe('gameover');

    // 伪造：前缀是 dStroke、实际 t 是别的（JSON 重复键取后者）→ 直接丢弃，不派发
    const { room: room2, socks: s2, raw: raw2 } = await setup(2);
    raw2(s2[0], '{"t":"dStroke","t":"start"}');
    expect(room2.game).toBeNull();
  });

  it('猜词：错的公开、对的只广播「猜对了」；全员猜对进入揭晓；作画中房间聊天把答案打码', async () => {
    const { room, socks, raw } = await setup(3);
    raw(socks[0], { t: 'start' });
    raw(socks[0], { t: 'dPick', index: 0 });
    const word = game(room).turn.word!.word;
    raw(socks[1], { t: 'roomChat', text: `我猜是${word}` });
    const chat = ofType(socks[2], 'roomChatMsg').at(-1) as { text: string };
    expect(chat.text).not.toContain(word);
    expect(chat.text).toContain('＊');
    raw(socks[1], { t: 'dGuess', text: '肯定不是这个词呀' });
    expect((lastState(socks[2])?.feed as { text: string }[]).some((f) => f.text === '肯定不是这个词呀')).toBe(true);
    raw(socks[1], { t: 'dGuess', text: word });
    const feed2 = lastState(socks[2])?.feed as { kind: string; text: string }[];
    expect(feed2.some((f) => f.kind === 'solved')).toBe(true);
    expect(feed2.some((f) => f.text === word)).toBe(false);
    raw(socks[2], { t: 'dGuess', text: word });
    expect(game(room).phase).toBe('reveal');
    expect(lastState(socks[1])?.word).toBe(word);
    // 观战者不能猜
    const spec = mkWs('9.9.1.9');
    raw(spec, { t: 'spectate', name: '路人', code: room.code });
    raw(spec, { t: 'dGuess', text: word });
    expect(ofType(spec, 'error').at(-1)).toMatchObject({ code: 'SPECTATING' });
  });

  it('终局三件套各落一份；重复广播不重复；零回合的局只进房间记录不进战绩', async () => {
    const { m, room, socks, raw, listMatches } = await setup(2);
    raw(socks[0], { t: 'start' });
    raw(socks[0], { t: 'dPick', index: 0 });
    raw(socks[1], { t: 'dGuess', text: game(room).turn.word!.word }); // 唯一猜词者猜中 → 揭晓（第 1 回合完成）
    expect(game(room).phase).toBe('reveal');
    raw(socks[0], { t: 'dAbort' });
    expect(game(room).phase).toBe('gameover');
    const entries = listMatches().filter((e) => e.mode === 'draw');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ seatCount: 2, settings: { turnSec: 80, cycles: 2 } });
    expect(entries[0]!.players.map((p) => [p.name, p.rank, p.score! > 0])).toEqual([
      ['乙', 1, true],
      ['甲', 2, true],
    ]);
    expect(room.matchHistory).toHaveLength(1);
    expect(room.matchHistory[0]).toMatchObject({ mode: 'draw', draw: { turns: [{ no: 1, drawer: '甲', solved: 1, end: 'all' }] } });
    (m.broadcast as (r: unknown) => void).call(m, room);
    expect(listMatches().filter((e) => e.mode === 'draw')).toHaveLength(1);
    expect(room.matchHistory).toHaveLength(1);

    // 再来一局（房主）→ 开局即终止：零回合
    raw(socks[1], { t: 'dRematch' });
    expect(ofType(socks[1], 'error').at(-1)).toMatchObject({ code: 'NOT_HOST' });
    raw(socks[0], { t: 'dRematch' });
    expect(game(room).phase).toBe('choosing');
    expect(ofType(socks[1], 'dSnap').at(-1)).toMatchObject({ strokes: [] });
    raw(socks[0], { t: 'dAbort' });
    expect(listMatches().filter((e) => e.mode === 'draw')).toHaveLength(1); // 零回合不进战绩
    expect(room.matchHistory).toHaveLength(2);
    // 返回房间
    raw(socks[0], { t: 'backToRoom' });
    expect(room.game).toBeNull();
  });

  it('时间推进：选词超时随机选词；画手离开作废本回合；只剩 1 人终局', async () => {
    const { m, room, socks, raw } = await setup(3);
    raw(socks[0], { t: 'start' });
    vi.setSystemTime(Date.now() + 15_000);
    m.tickRoom(room, Date.now());
    expect(game(room).phase).toBe('drawing');
    raw(socks[0], { t: 'leave' });
    expect(game(room).phase).toBe('reveal');
    expect(game(room).turn.endReason).toBe('left');
    raw(socks[1], { t: 'leave' });
    expect(game(room).phase).toBe('gameover');
    expect(game(room).result?.reason).toBe('leave');
  });

  it('全员断线 30 秒就地终局', async () => {
    const { m, room } = await setup(2);
    m.handleStart(room, [...room.sessions.values()][0]);
    for (const s of room.sessions.values()) s.connected = false;
    const t0 = Date.now();
    m.tickRoom(room, t0 + 1000);
    expect(game(room).phase).toBe('choosing');
    m.tickRoom(room, t0 + 31_000);
    expect(game(room).phase).toBe('gameover');
    expect(game(room).result?.reason).toBe('idle');
    expect(room.matchLogged).toBe(true);
  });
});
