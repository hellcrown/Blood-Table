/**
 * 扫雷竞速 · 对局引擎（服务端权威，绝不下发雷位）
 *
 * 规则：全员相同雷位的独立棋盘竞速；开局自动揭开公共安全开场区；
 * 点雷出局；揭开全部安全格即通关获胜；只剩最后一名存活者时直接获胜；
 * 超时按当前进度排名结算。
 */
import { randomInt } from 'node:crypto';
import {
  MINES_PRESETS,
  type MinesCell,
  type MinesDifficulty,
  type MinesPlayerState,
  type MinesRankRow,
  type MinesState,
} from '@shared/minesProtocol';

export type { MinesState, MinesView } from '@shared/minesProtocol';

const DIRS = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface MinesPlayerInit {
  id: string;
  name: string;
  seat: number;
}

export function createMinesGame(
  difficulty: MinesDifficulty,
  players: MinesPlayerInit[],
  now: number,
  timeSec = 0,
): MinesState {
  const preset = MINES_PRESETS[difficulty] ?? MINES_PRESETS.easy;
  const cols = preset.cols;
  const rows = preset.rows;
  const cells = cols * rows;

  // 布雷：随机挑 mines 个格子（全覆盖开局，无自动揭开的安全区——首格由玩家自己抉择）
  const mineSet = new Set<number>(shuffle(Array.from({ length: cells }, (_, i) => i)).slice(0, preset.mines));

  // 相邻雷数
  const counts = new Array<number>(cells).fill(0);
  for (let i = 0; i < cells; i++) {
    if (mineSet.has(i)) {
      counts[i] = -1;
      continue;
    }
    const r = Math.floor(i / cols);
    const c = i % cols;
    let n = 0;
    for (const [dr, dc] of DIRS) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && mineSet.has(rr * cols + cc)) n++;
    }
    counts[i] = n;
  }

  const totalSafe = cells - mineSet.size;

  return {
    difficulty,
    cols,
    rows,
    mines: preset.mines,
    minesSet: mineSet,
    counts,
    totalSafe,
    phase: 'playing',
    players: shuffle(players).map((p) => ({
      ...p,
      status: 'playing' as const,
      revealed: [], // 全覆盖开局
    })),
    startedAt: now,
    log: [],
    logSeq: 0,
    deadline: now + (timeSec > 0 ? timeSec * 1000 : preset.timeMs), // 房间可自定义时限（0=按难度默认）
    winnerId: null,
    ranking: [],
    revealedAll: false,
  };
}

/** 泛洪揭开：从 cell 展开，数字格停住，空白格继续扩散 */
function floodReveal(
  minesSet: Set<number>,
  counts: number[],
  cols: number,
  rows: number,
  start: number,
): number[] {
  const revealed = new Set<number>();
  const queue = [start];
  revealed.add(start);
  while (queue.length > 0) {
    const i = queue.shift()!;
    if (counts[i] !== 0) continue; // 数字格不扩散
    const r = Math.floor(i / cols);
    const c = i % cols;
    for (const [dr, dc] of DIRS) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const j = rr * cols + cc;
      if (revealed.has(j) || minesSet.has(j)) continue;
      revealed.add(j);
      if (counts[j] === 0) queue.push(j);
    }
  }
  return [...revealed];
}

function findPlayer(state: MinesState, playerId: string): MinesPlayerState | undefined {
  return state.players.find((p) => p.id === playerId);
}

export function mReveal(
  state: MinesState,
  playerId: string,
  r: number,
  c: number,
  now: number,
): void {
  if (state.phase !== 'playing') return;
  const p = findPlayer(state, playerId);
  if (!p || p.status !== 'playing') return;
  // 整数校验：客户端可发任意 JSON，小数坐标会绕过范围检查产生垃圾索引（可刷满安全格作弊通关）
  if (!Number.isInteger(r) || !Number.isInteger(c)) return;
  if (r < 0 || r >= state.rows || c < 0 || c >= state.cols) return;
  const i = r * state.cols + c;
  if (p.revealed.includes(i)) return; // 已揭开：忽略

  if (state.minesSet.has(i)) {
    // 踩雷出局
    p.status = 'out';
    p.outAt = now;
    endIfOver(state, now);
    return;
  }

  const cells = floodReveal(state.minesSet, state.counts, state.cols, state.rows, i);
  for (const cell of cells) if (!p.revealed.includes(cell)) p.revealed.push(cell);

  if (p.revealed.length >= state.totalSafe) {
    // 揭开全部安全格：通关获胜
    p.status = 'done';
    p.doneAt = now;
    endGame(state, p.id, now);
  }
}

/** 只剩最后一名存活者时直接获胜；其余按排名结算 */
function endIfOver(state: MinesState, now: number): void {
  const alive = state.players.filter((p) => p.status === 'playing');
  if (state.players.some((p) => p.status === 'out') && alive.length <= 1) {
    endGame(state, alive[0]?.id ?? null, now);
  }
}

function endGame(state: MinesState, winnerId: string | null, now: number): void {
  state.phase = 'gameover';
  state.winnerId = winnerId;
  state.revealedAll = true;
  state.deadline = now;
  state.ranking = computeRanking(state, winnerId);
}

/** 排名：通关者按完成时间；存活者按已揭开格数；出局者按出局顺序倒序 */
function computeRanking(state: MinesState, winnerId: string | null): MinesRankRow[] {
  const done = state.players
    .filter((p) => p.status === 'done')
    .sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0));
  const alive = state.players
    .filter((p) => p.status === 'playing')
    .sort((a, b) => b.revealed.length - a.revealed.length);
  const out = state.players
    .filter((p) => p.status === 'out')
    .sort((a, b) => (b.outAt ?? 0) - (a.outAt ?? 0));
  const order = [...done.map((p) => p.id), ...alive.map((p) => p.id), ...out.map((p) => p.id)];
  if (winnerId) {
    // 冠军置顶
    const idx = order.indexOf(winnerId);
    if (idx > 0) order.splice(idx, 1);
    else if (idx < 0) order.unshift(winnerId);
  }
  return order.map((id, i) => {
    const p = state.players.find((x) => x.id === id)!;
    return { seat: p.seat, name: p.name, status: p.status, revealed: p.revealed.length, rank: i + 1 };
  });
}

/** 超时结算：按当前进度排名并终局 */
export function minesTick(state: MinesState, now: number): boolean {
  if (state.phase !== 'playing') return false;
  if (state.deadline && now < state.deadline) return false;
  endGame(state, null, now);
  return true;
}

/** 玩家中途退出：立即出局并结算（幽灵玩家不得参与排名/判胜） */
export function mLeave(state: MinesState, playerId: string, now: number): void {
  const p = findPlayer(state, playerId);
  if (!p || p.status !== 'playing' || state.phase !== 'playing') return;
  p.status = 'out';
  p.outAt = now;
  endIfOver(state, now);
}

/** 会话视图：玩家=自己的棋盘；出局=全雷图；观战=全员已证实安全格合并 */
export function buildMinesView(
  state: MinesState,
  spectator: boolean,
  viewerId: string,
  roomCode: string,
  hostIdOf: string,
): import('@shared/minesProtocol').MinesView {
  const revealAll = state.phase === 'gameover' || state.revealedAll;
  const me = findPlayer(state, viewerId);
  const cells: import('@shared/minesProtocol').MinesCell[] = [];
  const showSolution = revealAll || me?.status === 'out';
  if (me) {
    for (const i of me.revealed) cells.push({ i, n: Math.max(0, state.counts[i]) });
  } else {
    // 观战者：全员已证实安全格合并
    const seen = new Set<number>();
    for (const p of state.players) {
      for (const i of p.revealed) {
        if (!seen.has(i)) {
          seen.add(i);
          cells.push({ i, n: Math.max(0, state.counts[i]) });
        }
      }
    }
  }
  if (showSolution) {
    // 揭示全部雷位与全部数字
    for (let i = 0; i < state.counts.length; i++) {
      if (!cells.some((c) => c.i === i)) cells.push({ i, n: state.minesSet.has(i) ? -1 : state.counts[i] });
    }
    cells.sort((a, b) => a.i - b.i);
  }
  return {
    kind: 'mines',
    mode: 'mines',
    code: roomCode,
    hostId: hostIdOf,
    difficulty: state.difficulty,
    cols: state.cols,
    rows: state.rows,
    totalSafe: state.totalSafe,
    mines: state.mines,
    phase: state.phase,
    startedAt: state.startedAt,
    log: state.log,
    logSeq: state.logSeq,
    deadline: state.phase === 'playing' ? state.deadline : null,
    ...(me
      ? { status: me.status, cells }
      : { status: 'playing' as const, cells }),
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      status: p.status,
      revealed: p.revealed.length,
    })),
    spectator: !me,
    ranking: state.ranking,
    winnerId: state.winnerId,
  };
}
