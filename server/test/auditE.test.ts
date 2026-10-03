/**
 * 全面审查（2026-10-03）批次 E 的回归测试：广播体积。
 *
 * 原先 `broadcast` 做两件重复的事：把新增日志按 `event` 逐条发一遍（客户端**根本不处理**），
 * 又把**整局日志**塞进每一条 state 帧里重发。实测 4 人局日志 497 行 ≈ 29.5KB，
 * 占整条 state 的 84%；4 玩家 + 10 观战 = 14 个 socket × 35KB ≈ 490KB/广播。
 * 现在：首帧（入房/重连）或落后超窗口时下发全量并置 `logFull`，其余帧只带尾部 200 行。
 */
import { describe, expect, it } from 'vitest';
import { createBloodGame } from '../src/blood/engine';
import { RoomManager, type Room, type Session } from '../src/rooms';
import { LOG_TAIL_LINES } from '../src/blood/view';
import type { BloodState } from '../src/blood/types';

const NOW = 1000;

interface FakeWs {
  sent: { t?: string; line?: unknown; view?: { log?: unknown[]; logFull?: boolean } }[];
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

function mkSession(id: string, seat: number, lastEventSeq = 0): { s: Session; ws: FakeWs } {
  const ws = fakeWs();
  const s = {
    id,
    token: `tok-${id}`,
    name: id,
    seat,
    connected: true,
    ws: ws as unknown as Session['ws'],
    lastEventSeq,
  } as Session;
  return { s, ws };
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
    sessions: new Map(sessions.map((x) => [x.id, x])),
    game,
    pendingRemove: new Set(),
    emptySince: 0,
    botBrains: new Map(),
    botNextAct: new Map(),
    matchLogged: true,
    gameStartedAt: NOW,
  } as unknown as Room;
}

/** 往牌局日志里塞 n 行（引擎的 pushLog 未导出，这里按同样形状直接追加） */
function addLogLines(gs: BloodState, n: number): void {
  for (let i = 0; i < n; i++) {
    gs.log.push({ seq: ++gs.logSeq, kind: 'action', text: `第 ${gs.logSeq} 条日志：某某玩家做了一件很长的事情以拉长单行体积` });
  }
}

function lastState(ws: FakeWs): { log?: unknown[]; logFull?: boolean } | undefined {
  return [...ws.sent].reverse().find((m) => m.t === 'state')?.view;
}

function setup(lines: number): { mgr: RoomManager; room: Room; gs: BloodState; a: FakeWs; b: FakeWs } {
  const mgr = new RoomManager();
  const { s: s0, ws: a } = mkSession('p0', 0);
  const { s: s1, ws: b } = mkSession('p1', 1);
  const gs = createBloodGame(
    2,
    [
      { id: 'p0', name: '甲', seat: 0 },
      { id: 'p1', name: '乙', seat: 1 },
    ],
    NOW,
  );
  addLogLines(gs, lines);
  return { mgr, room: mkRoom('E1', gs, [s0, s1]), gs, a, b };
}

describe('批次 E · 广播不再每帧重发整局日志', () => {
  it('首帧（lastEventSeq=0，即入房/重连）下发全量日志并标记 logFull', () => {
    const { mgr, room, gs, a } = setup(300);
    mgr.broadcast(room);
    const v = lastState(a);
    expect(v?.logFull).toBe(true);
    expect(v?.log?.length).toBe(gs.log.length); // 300 行全给
  });

  it('后续帧只带尾部窗口，新增行由 event 增量下发', () => {
    const { mgr, room, gs, a } = setup(300);
    mgr.broadcast(room); // 首帧全量
    a.sent.length = 0;
    addLogLines(gs, 5);
    mgr.broadcast(room);
    const v = lastState(a);
    expect(v?.logFull).toBe(false);
    expect(v?.log?.length).toBe(LOG_TAIL_LINES); // 只带尾部
    const events = a.sent.filter((m) => m.t === 'event');
    expect(events.length).toBe(5); // 5 条新增行逐条以 event 下发（不再依赖 state 重发）
  });

  it('单帧体积显著下降（日志不再占据 state 的主体）', () => {
    const { mgr, room, gs, a } = setup(500);
    mgr.broadcast(room);
    const fullLen = JSON.stringify(lastState(a)).length;
    a.sent.length = 0;
    addLogLines(gs, 3);
    mgr.broadcast(room);
    const tailLen = JSON.stringify(lastState(a)).length;
    // 实测（500 行日志）：全量帧 35802 B → 尾部帧 15503 B，降 56.7%；且帧体积不再随对局时长增长
    expect(tailLen).toBeLessThan(fullLen / 2);
  });

  it('观战者同样只收尾部；其首次下发仍是全量（首帧语义与身份无关）', () => {
    const { mgr, room, gs, b } = setup(400);
    mgr.broadcast(room);
    expect(lastState(b)?.logFull).toBe(true);
    b.sent.length = 0;
    addLogLines(gs, 2);
    mgr.broadcast(room);
    expect(lastState(b)?.logFull).toBe(false);
    expect(lastState(b)?.log?.length).toBe(LOG_TAIL_LINES);
  });

  it('落后超过尾部窗口的会话会被重新下发全量（离线回来不漏历史）', () => {
    const mgr = new RoomManager();
    const { s: s0, ws: a } = mkSession('p0', 0);
    const { s: s1, ws: b } = mkSession('p1', 1, 0);
    const gs = createBloodGame(
      2,
      [
        { id: 'p0', name: '甲', seat: 0 },
        { id: 'p1', name: '乙', seat: 1 },
      ],
      NOW,
    );
    const room = mkRoom('E2', gs, [s0, s1]);
    mgr.broadcast(room); // 双方首帧全量
    // 精确构造：p0 跟得上（游标=最新），p1 落后 250 条（超过尾部窗口 200）
    addLogLines(gs, LOG_TAIL_LINES + 50);
    s0.lastEventSeq = gs.logSeq;
    s1.lastEventSeq = gs.logSeq - (LOG_TAIL_LINES + 50);
    addLogLines(gs, 1);
    b.sent.length = 0;
    a.sent.length = 0;
    mgr.broadcast(room);
    expect(lastState(b)?.logFull).toBe(true); // 落后太多 → 全量补齐，历史不漏
    expect(lastState(a)?.logFull).toBe(false); // 跟得上的会话仍只收尾部
  });
});
