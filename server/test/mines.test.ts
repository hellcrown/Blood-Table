import { describe, expect, it } from 'vitest';
import {
  createMinesGame,
  mReveal,
  mLeave,
  minesTick,
  buildMinesView,
  type MinesState,
} from '../src/mines/engine';

const NOW = 1_700_000_000_000;
const PLAYERS = [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `玩家${i}`, seat: i }));

function setup(difficulty: 'easy' | 'medium' | 'hard' = 'easy'): MinesState {
  return createMinesGame(difficulty, PLAYERS, NOW);
}

function findSafeCell(state: MinesState, playerId: string): { r: number; c: number } | null {
  const p = state.players.find((x) => x.id === playerId)!;
  for (let i = 0; i < state.counts.length; i++) {
    if (state.counts[i] >= 0 && !p.revealed.includes(i)) {
      return { r: Math.floor(i / state.cols), c: i % state.cols };
    }
  }
  return null;
}

function findMineCell(state: MinesState, playerId: string): { r: number; c: number } {
  const p = state.players.find((x) => x.id === playerId)!;
  for (let i = 0; i < state.counts.length; i++) {
    if (state.counts[i] < 0 && !p.revealed.includes(i)) {
      return { r: Math.floor(i / state.cols), c: i % state.cols };
    }
  }
  throw new Error('没有未揭开的雷');
}

describe('扫雷 · 生成', () => {
  it('三档难度：雷数与雷位守恒，开局全覆盖', () => {
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const gs = setup(difficulty);
      expect(gs.minesSet.size).toBe(gs.mines);
      // 雷数守恒：记录的雷格数 = 难度雷数
      let mineCount = 0;
      for (let i = 0; i < gs.counts.length; i++) if (gs.counts[i] < 0) mineCount++;
      expect(mineCount).toBe(gs.mines);
      // 全覆盖开局：无人预揭任何格子
      for (const p of gs.players) {
        expect(p.status).toBe('playing');
        expect(p.revealed).toEqual([]);
      }
    }
  });

  it('自定义时限：deadline 按房间的秒数生效；缺省按难度预设', () => {
    const custom = createMinesGame('easy', PLAYERS, NOW, 120);
    expect(custom.deadline).toBe(NOW + 120_000);
    const fallback = createMinesGame('easy', PLAYERS, NOW, 0);
    expect(fallback.deadline).toBe(NOW + 180_000); // easy 预设 3 分钟
  });

  it('全员 revealed 初始为空（全覆盖口径）', () => {
    const gs = setup('easy');
    for (const p of gs.players) {
      expect(p.revealed).toEqual(gs.players[0].revealed);
    }
  });
});

describe('扫雷 · 揭开与出局', () => {
  it('揭开安全格：泛洪计入已揭开；重复揭开忽略', () => {
    const gs = setup('easy');
    const p0 = gs.players.find((x) => x.status === 'playing')!;
    const safe = findSafeCell(gs, p0.id)!;
    const before = p0.revealed.length;
    mReveal(gs, p0.id, safe.r, safe.c, NOW + 1);
    expect(p0.revealed.length).toBeGreaterThan(before);
    const count = p0.revealed.length;
    mReveal(gs, p0.id, safe.r, safe.c, NOW + 2); // 重复揭开忽略
    expect(p0.revealed.length).toBe(count);
  });

  it('点雷出局：状态转 out，本人可见全雷图；最后存活者直接获胜', () => {
    const gs = setup('easy');
    const [p0, p1, p2, p3] = gs.players;
    // p0/p1/p2 依次踩雷出局
    for (const p of [p0, p1, p2]) {
      const mine = findMineCell(gs, p.id);
      mReveal(gs, p.id, mine.r, mine.c, NOW + 1);
      expect(p.status).toBe('out');
    }
    // 只剩 p3 → 直接获胜终局
    expect(gs.phase).toBe('gameover');
    expect(gs.winnerId).toBe(p3.id);
    // 出局者视图揭示全雷图（含雷位 n=-1）
    const roomCode = 'T1';
    const view = buildMinesView(gs, false, p0.id, roomCode, 'host-1');
    expect(view.cells.length).toBe(gs.cols * gs.rows);
    expect(view.cells.some((c) => c.n === -1)).toBe(true);
    expect(view.winnerId).toBe(p3.id);
  });

  it('出局后其他人继续；通关者获胜', () => {
    const gs = setup('easy');
    const p0 = gs.players[0];
    const p1 = gs.players[1];
    // p0 踩雷出局
    const m0 = findMineCell(gs, p0.id);
    mReveal(gs, p0.id, m0.r, m0.c, NOW + 1);
    expect(p0.status).toBe('out');
    expect(gs.phase).toBe('playing'); // 还有 3 人存活，继续
    // p1 扫完全部安全格
    for (let i = 0; i < gs.counts.length; i++) {
      if (gs.counts[i] < 0 || p1.revealed.includes(i)) continue;
      mReveal(gs, p1.id, Math.floor(i / gs.cols), i % gs.cols, NOW + 2);
    }
    expect(gs.phase).toBe('gameover');
    expect(gs.winnerId).toBe(p1.id);
  });
});

describe('扫雷 · 超时排名', () => {
  it('超时：按已揭开格数排名存活者，终局揭示全图', () => {
    const gs = setup('easy');
    // p0 揭 10 格，p1 揭 3 格
    let revealed0 = 0;
    for (let i = 0; i < gs.counts.length && revealed0 < 10; i++) {
      if (gs.counts[i] < 0 || gs.players[0].revealed.includes(i)) continue;
      mReveal(gs, gs.players[0].id, Math.floor(i / gs.cols), i % gs.cols, NOW + 1);
      revealed0++;
    }
    let revealed1 = 0;
    for (let i = 0; i < gs.counts.length && revealed1 < 3; i++) {
      if (gs.counts[i] < 0 || gs.players[1].revealed.includes(i)) continue;
      mReveal(gs, gs.players[1].id, Math.floor(i / gs.cols), i % gs.cols, NOW + 1);
      revealed1++;
    }
    minesTick(gs, NOW + 10 * 60_000); // 超时
    expect(gs.phase).toBe('gameover');
    expect(gs.ranking.length).toBe(gs.players.length);
    // 存活者按揭开数排前
    expect(gs.ranking[0].revealed).toBeGreaterThanOrEqual(gs.ranking[1].revealed);
  });
});

describe('扫雷 · 观战视图', () => {
  it('观战者：合并全员已证实安全格，不含雷位', () => {
    const gs = setup('easy');
    const target = gs.players[0];
    const safe = findSafeCell(gs, target.id)!;
    mReveal(gs, target.id, safe.r, safe.c, NOW + 1);
    const view = buildMinesView(gs, true, 'spectator-1', 'T1', 'host-1');
    expect(view.spectator).toBe(true);
    expect(view.cells.length).toBeGreaterThan(0);
    for (const c of view.cells) {
      expect(gs.minesSet.has(c.i)).toBe(false); // 合并视图只有已证实安全格
    }
  });

  it('小数坐标静默忽略（防绕过范围检查刷安全格作弊）', () => {
    const gs = setup('easy');
    const p0 = gs.players[0];
    const before = p0.revealed.length;
    mReveal(gs, p0.id, 0.1, 0, NOW + 1);
    mReveal(gs, p0.id, 0, 2.5, NOW + 1);
    expect(p0.revealed.length).toBe(before);
  });

  it('单人局：1 人即可成局，踩雷出局即终局（无胜者），通关即胜', () => {
    const gs = createMinesGame('easy', PLAYERS.slice(0, 1), NOW);
    expect(gs.players).toHaveLength(1);
    // 通关路径
    for (let i = 0; i < gs.counts.length; i++) {
      if (gs.counts[i] < 0 || gs.players[0].revealed.includes(i)) continue;
      mReveal(gs, gs.players[0].id, Math.floor(i / gs.cols), i % gs.cols, NOW + 1);
    }
    expect(gs.phase).toBe('gameover');
    expect(gs.winnerId).toBe(gs.players[0].id);
    // 踩雷路径：1 人踩雷 → 终局无胜者
    const gs2 = createMinesGame('easy', PLAYERS.slice(0, 1), NOW);
    const mine = findMineCell(gs2, gs2.players[0].id);
    mReveal(gs2, gs2.players[0].id, mine.r, mine.c, NOW + 1);
    expect(gs2.phase).toBe('gameover');
    expect(gs2.winnerId).toBeNull();
    expect(gs2.ranking).toHaveLength(1);
  });

  it('中途退出：立即出局并结算（最后存活者获胜，退出者不判胜）', () => {
    const gs = createMinesGame('easy', PLAYERS.slice(0, 3), NOW); // 3 人局：1 踩雷 + 1 退出 → 剩 1 人即终局
    const [a, b, c] = gs.players;
    const mine = findMineCell(gs, a.id);
    mReveal(gs, a.id, mine.r, mine.c, NOW + 1); // a 踩雷出局
    mLeave(gs, b.id, NOW + 2); // b 中途退出
    expect(b.status).toBe('out');
    expect(gs.phase).toBe('gameover');
    expect(gs.winnerId).toBe(c.id); // 胜利归真存活者，不归已退场者
  });
});
