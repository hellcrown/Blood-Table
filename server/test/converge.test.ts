/**
 * 心有灵犀（converge）· 引擎单测 + 房间层分发冒烟
 *
 * 存在原因：这是第五个游戏模式，判同口径（宽松归一化）与「双方都提交才揭示」的同步点
 * 是全新逻辑；隐私红线（对手当轮未揭示文本绝不下发）一旦破口即毁玩法。
 * 全部用例围绕三条主线：归一化判同、覆写与揭示时机、三种未相遇终局 + 视图隐私。
 * 房间层用例验证 mode 接线：容量钳 2、dispatch 路由、离场终局（照 mines.test.ts 惯例）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createConvergeGame,
  cSubmit,
  cLeave,
  convergeAbort,
  convergeForceEnd,
  buildConvergeView,
} from '../src/converge/engine';
import { GameError } from '../src/game/types';
import type { ConvergeState } from '@shared/convergeProtocol';

const NOW = 1_700_000_000_000;
const PLAYERS = [
  { id: 'pa', name: '甲', seat: 0 },
  { id: 'pb', name: '乙', seat: 1 },
];

function setup(): ConvergeState {
  return createConvergeGame(PLAYERS, NOW);
}

describe('心有灵犀 · 建局', () => {
  it('双人成局：round=1、无人预提交、players 保持座位序', () => {
    const gs = setup();
    expect(gs.phase).toBe('playing');
    expect(gs.round).toBe(1);
    expect(gs.rounds).toEqual([]);
    expect(gs.result).toBeNull();
    expect(gs.players.map((p) => p.id)).toEqual(['pa', 'pb']);
    for (const p of gs.players) {
      expect(p.submitted).toBe(false);
      expect(p.text).toBeNull();
    }
  });

  it('超编输入钳为 2 人（房间层已钳容量，引擎兜底）', () => {
    const gs = createConvergeGame([...PLAYERS, { id: 'pc', name: '丙', seat: 2 }], NOW);
    expect(gs.players).toHaveLength(2);
  });
});

describe('心有灵犀 · 提交与揭示', () => {
  it('提交后可覆写：直到对方也提交才揭示', () => {
    const gs = setup();
    cSubmit(gs, 'pa', '苹果', NOW + 1);
    expect(gs.players[0].submitted).toBe(true);
    cSubmit(gs, 'pa', '梨', NOW + 2); // 覆写
    expect(gs.players[0].text).toBe('梨');
    expect(gs.phase).toBe('playing'); // 对方未提交：不揭示
    expect(gs.rounds).toHaveLength(0);
  });

  it('双方提交不匹配：揭示一轮并进入下一轮，文本清空待重写', () => {
    const gs = setup();
    cSubmit(gs, 'pa', '午睡', NOW + 1);
    cSubmit(gs, 'pb', '肥牛卷', NOW + 2);
    expect(gs.phase).toBe('playing');
    expect(gs.round).toBe(2);
    expect(gs.rounds).toHaveLength(1);
    expect(gs.rounds[0]).toMatchObject({
      n: 1,
      same: false,
      entries: [
        { seat: 0, text: '午睡' },
        { seat: 1, text: '肥牛卷' },
      ],
    });
    for (const p of gs.players) {
      expect(p.submitted).toBe(false);
      expect(p.text).toBeNull();
    }
    expect(gs.log.at(-1)?.text).toContain('第 1 轮');
  });

  it('相遇即终局：归一化判同（全角/半角、大小写、空白不敏感），相遇轮计入', () => {
    const cases: [string, string][] = [
      ['６', '6'], // 全角 vs 半角
      ['Apple Pie', 'apple  pie'], // 大小写 + 多空格
      ['看病去', '看病 去'], // 中文内嵌空格
    ];
    for (const [a, b] of cases) {
      const gs = setup();
      cSubmit(gs, 'pa', a, NOW + 1);
      cSubmit(gs, 'pb', b, NOW + 2);
      expect(gs.phase).toBe('gameover');
      expect(gs.result?.matched).toBe(true);
      expect(gs.result?.reason).toBe('match');
      expect(gs.result?.rounds).toBe(1);
      expect(gs.result?.word).toBe(a); // 展示保留原文（seat 0 的原样文本）
      expect(gs.rounds[0].same).toBe(true);
      expect(gs.log.at(-1)?.kind).toBe('win');
    }
  });

  it('第二轮才相遇：rounds 累计、结果轮数=2', () => {
    const gs = setup();
    cSubmit(gs, 'pa', '午睡', NOW + 1);
    cSubmit(gs, 'pb', '肥牛卷', NOW + 2); // 第 1 轮不匹配
    cSubmit(gs, 'pa', '日本', NOW + 3);
    cSubmit(gs, 'pb', '日本', NOW + 4); // 第 2 轮相遇
    expect(gs.phase).toBe('gameover');
    expect(gs.result?.rounds).toBe(2);
    expect(gs.rounds).toHaveLength(2);
    expect(gs.rounds[1].same).toBe(true);
  });

  it('空文本/纯空白拒绝（BAD_TEXT）；非字符串拒绝（BAD_MSG）；超长钳到 60 字', () => {
    const gs = setup();
    expect(() => cSubmit(gs, 'pa', '', NOW + 1)).toThrow(GameError);
    expect(() => cSubmit(gs, 'pa', '   \n\t ', NOW + 1)).toThrow(GameError);
    expect(() => cSubmit(gs, 'pa', 42 as unknown as string, NOW + 1)).toThrow(GameError);
    const long = '啊'.repeat(61);
    cSubmit(gs, 'pa', long, NOW + 1);
    expect(gs.players[0].text).toHaveLength(60);
    // 控制字符折空格、首尾清理
    const gs2 = setup();
    cSubmit(gs2, 'pa', '  甲\n乙  ', NOW + 1);
    expect(gs2.players[0].text).toBe('甲 乙');
  });

  it('终局后提交静默忽略；gameover 后 abort/forceEnd/leave 均为 no-op', () => {
    const gs = setup();
    cSubmit(gs, 'pa', '6', NOW + 1);
    cSubmit(gs, 'pb', '６', NOW + 2);
    expect(gs.phase).toBe('gameover');
    cSubmit(gs, 'pa', '再来', NOW + 3); // 静默
    expect(gs.result?.reason).toBe('match');
    expect(convergeAbort(gs, NOW + 4)).toBe(false);
    expect(convergeForceEnd(gs, NOW + 4)).toBe(false);
    expect(cLeave(gs, 'pa', NOW + 4)).toBe(false);
  });
});

describe('心有灵犀 · 未相遇终局', () => {
  it('房主终止：reason=abort，已揭示轮数保留', () => {
    const gs = setup();
    cSubmit(gs, 'pa', 'a', NOW + 1);
    cSubmit(gs, 'pb', 'b', NOW + 2); // 1 轮不匹配
    expect(convergeAbort(gs, NOW + 3)).toBe(true);
    expect(gs.phase).toBe('gameover');
    expect(gs.result).toMatchObject({ matched: false, rounds: 1, reason: 'abort' });
  });

  it('中途离场：reason=leave，本局未相遇终局', () => {
    const gs = setup();
    cSubmit(gs, 'pa', 'a', NOW + 1);
    expect(cLeave(gs, 'pb', NOW + 2)).toBe(true);
    expect(gs.phase).toBe('gameover');
    expect(gs.result).toMatchObject({ matched: false, reason: 'leave' });
    expect(gs.log.at(-1)?.text).toContain('离开');
  });

  it('全员断线超时：reason=idle', () => {
    const gs = setup();
    expect(convergeForceEnd(gs, NOW + 30_000)).toBe(true);
    expect(gs.result?.reason).toBe('idle');
  });
});

describe('心有灵犀 · 视图隐私', () => {
  it('对手当轮未揭示文本绝不下发：players 无 text 字段、myText 只回自己', () => {
    const gs = setup();
    cSubmit(gs, 'pa', '秘密答案', NOW + 1);
    const va = buildConvergeView(gs, 'pa', 'T1', 'pa');
    expect(va.myText).toBe('秘密答案');
    expect(va.spectator).toBe(false);
    const vb = buildConvergeView(gs, 'pb', 'T1', 'pa');
    expect(vb.myText).toBeNull();
    expect(vb.spectator).toBe(false);
    for (const v of [va, vb]) {
      expect(JSON.stringify(v.players)).not.toContain('秘密答案');
      expect(JSON.stringify(v)).not.toContain('"text"'); // 视图玩家条目根本不带文本字段
    }
  });

  it('揭示后历史全量可见（含双方原文）；观战者 myText=null 且 spectator=true', () => {
    const gs = setup();
    cSubmit(gs, 'pa', '午睡', NOW + 1);
    cSubmit(gs, 'pb', '肥牛卷', NOW + 2);
    const vs = buildConvergeView(gs, 'spectator-1', 'T1', 'pa');
    expect(vs.spectator).toBe(true);
    expect(vs.myText).toBeNull();
    expect(vs.rounds[0].entries.map((e) => e.text)).toEqual(['午睡', '肥牛卷']);
    expect(vs.round).toBe(2);
  });

  it('相遇终局视图：result 与相遇词下发，历史保留原文', () => {
    const gs = setup();
    cSubmit(gs, 'pa', '６', NOW + 1);
    cSubmit(gs, 'pb', '6', NOW + 2);
    const va = buildConvergeView(gs, 'pa', 'T1', 'pa');
    expect(va.phase).toBe('gameover');
    expect(va.result).toMatchObject({ matched: true, rounds: 1, word: '６' });
    expect(va.rounds[0].entries.map((e) => e.text)).toEqual(['６', '6']);
  });
});

/* ---------------- 房间层接线（照 mines.test.ts 的最小 RoomManager 冒烟） ---------------- */

describe('心有灵犀 · 房间层', () => {
  it('容量钳 2、dispatch 路由 cSubmit、相遇广播对局视图、离场即终局', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 10, 12));
    vi.resetModules();
    const { RoomManager } = await import('../src/rooms');
    const mgr = new RoomManager();
    const m = mgr as unknown as Record<string, (...a: unknown[]) => unknown>;

    const mkWs = (ip: string) => ({
      readyState: 1,
      OPEN: 1,
      send: () => {},
      on: () => {},
      close: () => {},
      ip,
    });
    const wsA = mkWs('7.7.7.1');
    const wsB = mkWs('7.7.7.2');
    m.handleCreate(wsA, { t: 'create', name: '甲', maxPlayers: 8, mode: 'converge' });
    const room = (
      mgr as unknown as { rooms: Map<string, { code: string; sessions: Map<string, { id: string; spectator?: boolean }>; game: ConvergeState | null; hostId: string }> }
    ).rooms.values().next().value!;
    if (!room) throw new Error('room missing');
    // 容量钳 2（即使 create 传了 8）
    expect((room as unknown as { maxPlayers: number }).maxPlayers).toBe(2);
    expect((room as unknown as { mode: string }).mode).toBe('converge');

    m.handleJoin(wsB, { t: 'join', code: room.code, name: '乙' });
    const [host, guest] = [...room.sessions.values()] as { id: string; spectator?: boolean }[];
    expect(room.hostId).toBe(host.id);

    // 未开局提交：静默忽略（无 game）
    expect(() => m.dispatch(wsA, { t: 'cSubmit', text: '早' })).not.toThrow();
    expect(room.game).toBeNull();

    // 开局 → 双人成局
    m.handleStart(room, host);
    expect(room.game?.players).toHaveLength(2);

    // 观战者提交：显式报错
    expect(() => m.handleCSubmit(room, { id: 'sp', spectator: true }, { t: 'cSubmit', text: 'x' })).toThrow(/观战/);

    // 相遇：双方经 dispatch 提交归一化相同的文本
    m.dispatch(wsA, { t: 'cSubmit', text: '６' });
    m.dispatch(wsB, { t: 'cSubmit', text: '6' });
    expect(room.game?.phase).toBe('gameover');
    expect(room.game?.result?.matched).toBe(true);

    // 再来一局（房主）：round 重置为 1
    m.handleCRematch(room, host);
    expect(room.game?.phase).toBe('playing');
    expect(room.game?.round).toBe(1);
    // 非房主再来一局：拒绝
    expect(() => m.handleCRematch(room, guest)).toThrow(/房主/);

    // 进行中离场：未相遇终局（cLeave 在 removeSession 内统一触发）
    m.handleLeave(room, guest);
    expect(room.game?.phase).toBe('gameover');
    expect(room.game?.result?.reason).toBe('leave');
    vi.useRealTimers();
    vi.resetModules();
  });
});
