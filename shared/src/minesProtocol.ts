import type { GameMode } from './protocol';

/** 扫雷难度预设 */
export type MinesDifficulty = 'easy' | 'medium' | 'hard';

export interface MinesPreset {
  cols: number;
  rows: number;
  mines: number;
  /** 回合时限（毫秒），超时按当前进度结算排名 */
  timeMs: number;
}

export const MINES_PRESETS: Record<MinesDifficulty, MinesPreset> = {
  easy: { cols: 9, rows: 9, mines: 10, timeMs: 180_000 },
  medium: { cols: 16, rows: 16, mines: 40, timeMs: 360_000 },
  hard: { cols: 30, rows: 16, mines: 99, timeMs: 600_000 },
};

/** 玩家回合状态：playing=进行中 / out=踩雷出局 / done=扫完全部安全格 */
export type MinesPlayerStatus = 'playing' | 'out' | 'done';

export interface MinesPlayerState {
  id: string;
  name: string;
  seat: number;
  status: MinesPlayerStatus;
  /** 已揭开的格子索引（服务端权威，各玩家独立） */
  revealed: number[];
  /** 出局时间（仅 out） */
  outAt?: number;
  /** 完成时间（仅 done） */
  doneAt?: number;
}

export interface MinesRankRow {
  seat: number;
  name: string;
  status: MinesPlayerStatus;
  /** 已揭开格数 */
  revealed: number;
  rank: number;
}

/** 服务端权威对局状态（绝不下发雷位） */
export interface MinesState {
  difficulty: MinesDifficulty;
  cols: number;
  rows: number;
  mines: number;
  /** 安全格总数（格数 - 雷数），玩家揭开满即通关 */
  totalSafe: number;
  phase: 'playing' | 'gameover';
  players: MinesPlayerState[];
  startedAt: number;
  /** ——以下为服务端内部字段，绝不下发—— */
  /** 每格是否为雷 */
  minesSet: Set<number>;
  /** 每格相邻雷数（雷格为 -1） */
  counts: number[];
  /** 是否已揭示全雷图 */
  revealedAll: boolean;
  /** 牌局记录（与血色/德州同一广播与面板机制） */
  log: import('./protocol').LogLine[];
  logSeq: number;
  /** 回合时限截止 */
  deadline: number;
  winnerId: string | null;
  /** 终局排名（gameover 后） */
  ranking: MinesRankRow[];
}

/** 已揭开格子：索引 + 相邻雷数（0 = 空白） */
export interface MinesCell {
  i: number;
  n: number;
}

/** 单个玩家的棋盘视图 */
export interface MinesPlayerView {
  status: MinesPlayerStatus;
  /** 我已揭开的格子（含数字） */
  cells: MinesCell[];
  /** 踩雷的格子（出局时高亮） */
  hitMine?: number;
}

/** 下发给会话的扫雷视图：kind='mines' */
export interface MinesView extends MinesPlayerView {
  kind: 'mines';
  mode: GameMode;
  /** 房间码 */
  code: string;
  /** 房主会话 id（再来一局按钮用） */
  hostId: string;
  difficulty: MinesDifficulty;
  cols: number;
  rows: number;
  mines: number;
  totalSafe: number;
  phase: 'playing' | 'gameover';
  startedAt: number;
  /** 牌局记录（同一广播面板机制） */
  log: import('./protocol').LogLine[];
  logSeq: number;
  deadline: number | null;
  /** 全员列表与进度（观战/出局也能看到） */
  players: { id: string; name: string; seat: number; status: MinesPlayerStatus; revealed: number }[];
  /** 我是观战者（不占座位） */
  spectator: boolean;
  /** 终局排名（gameover 后） */
  ranking: MinesRankRow[];
  winnerId: string | null;
}
