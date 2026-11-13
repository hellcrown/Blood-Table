import type { GameMode, LogLine } from './protocol';
import { normalizeText } from './convergeProtocol';

/**
 * 你画我猜（draw）· 2-4 人轮流作画猜词
 * 按座位轮流当画手：画手从简单/中等/困难各一个候选词里挑一个画（难词计分倍率更高），
 * 其他人在猜词框里猜，猜词框兼作本回合聊天。State 留服务端，View 按会话裁剪：
 * 答案与候选词只进画手视图，揭晓后才公开。画面不走 state 整帧——笔画走增量 dOps
 * 与整幅快照 dSnap（rooms 层按会话游标补发），词库只在服务端（本文件会打进前端包）。
 */

/** 虚拟画布（4:3）：坐标一律归一化为这个整数网格传输，客户端按实际像素缩放 */
export const DRAW_W = 1000;
export const DRAW_H = 750;

/** 画纸色：色板 0 号即橡皮（用画纸色描边覆盖） */
export const DRAW_PAPER = '#fdfaf3';
/** 色板（下标即协议里的 c）：0=橡皮，1-8 为画笔色 */
export const DRAW_COLORS: readonly string[] = [
  DRAW_PAPER,
  '#1f1a17', // 墨黑
  '#e03131', // 红
  '#f08c00', // 橙
  '#f5c518', // 黄
  '#2f9e44', // 绿
  '#1971c2', // 蓝
  '#7048e8', // 紫
  '#8b5a2b', // 棕
];
/** 笔宽（虚拟单位，下标即协议里的 w）：细 / 中 / 粗；橡皮按同档 ×2.5 渲染 */
export const DRAW_WIDTHS: readonly number[] = [4, 10, 22];
export const DRAW_ERASER_SCALE = 2.5;

/** 单条 dStroke 消息上限：20 个操作、合计 600 个坐标数（300 点）——远低于 16KB 报文上限 */
export const DRAW_OPS_PER_MSG = 20;
export const DRAW_NUMS_PER_MSG = 600;
/** 每回合画面上限：1500 笔 / 3 万点（超出静默丢弃，防快照无限膨胀） */
export const DRAW_MAX_STROKES = 1500;
export const DRAW_MAX_POINTS = 30_000;

/** 节奏：选词 15 秒（超时随机）、揭晓 5 秒、画手断线 10 秒作废本回合、掉线猜词者阻塞提前揭晓 10 秒宽限 */
export const DRAW_PICK_SEC = 15;
export const DRAW_REVEAL_SEC = 5;
export const DRAW_DRAWER_AWAY_MS = 10_000;
/** 在线猜词者全部猜对后，给掉线猜词者的重连宽限；超时按「在线全员猜对」提前揭晓 */
export const DRAW_GUESSER_AWAY_MS = 10_000;
/** 作画时限（房间可调；0=默认 80 秒） */
export const DRAW_DEFAULT_TURN_SEC = 80;
export const DRAW_TURN_SEC_OPTIONS: readonly number[] = [60, 80, 100, 120];
/** 每人画几次（房间可调；0=默认 2 次；上限 10 次 → 4 人局最多 40 回合） */
export const DRAW_DEFAULT_CYCLES = 2;
export const DRAW_CYCLE_OPTIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
/** 猜词/发言长度上限 */
export const DRAW_GUESS_MAX = 30;

export type DrawDifficulty = 1 | 2 | 3;
export const DRAW_DIFF_LABEL: Record<DrawDifficulty, string> = { 1: '简单', 2: '中等', 3: '困难' };
/** 难度倍率：猜对者与画手同乘 */
export const DRAW_DIFF_MULT: Record<DrawDifficulty, number> = { 1: 1, 2: 1.5, 3: 2 };

/** 猜对者得分：(40 + 60 × 剩余时间比例) × 倍率，取整（越快越多，最低 40×倍率） */
export function drawGuessPoints(remainingMs: number, turnMs: number, d: DrawDifficulty): number {
  const ratio = turnMs > 0 ? Math.min(1, Math.max(0, remainingMs / turnMs)) : 0;
  return Math.round((40 + 60 * ratio) * DRAW_DIFF_MULT[d]);
}

/** 画手分：每有一人猜对 +25 × 倍率 */
export function drawDrawerShare(d: DrawDifficulty): number {
  return Math.round(25 * DRAW_DIFF_MULT[d]);
}

/**
 * 猜词判同：心有灵犀口径（NFKC→去空白→小写）之上再去掉标点与符号——「苹果！」「苹果~」都等于「苹果」。
 * 只用于比较；猜词流展示保留原文。
 */
export function normalizeGuess(raw: string): string {
  return normalizeText(raw).replace(/[\p{P}\p{S}]/gu, '');
}

/** 画布操作：b=落笔（新一笔 + 首批点）a=给最后一笔续点 u=撤销最后一笔 x=清空 */
export type DrawOp =
  | { k: 'b'; id: number; c: number; w: number; p: number[] }
  | { k: 'a'; id: number; p: number[] }
  | { k: 'u' }
  | { k: 'x' };

/** 已落地的一笔：p 为平铺坐标 [x0,y0,x1,y1,…]（虚拟画布整数） */
export interface DrawStroke {
  id: number;
  c: number;
  w: number;
  p: number[];
}

/** 一个候选词（服务端词库条目；只下发给当回合画手） */
export interface DrawWord {
  word: string;
  cat: string;
  d: DrawDifficulty;
}

export interface DrawPlayerState {
  id: string;
  name: string;
  seat: number;
  score: number;
  /** 中途离开：保留在排名里，不再轮到作画 */
  left: boolean;
}

/** 猜词流条目（服务端全量）：vis 决定谁能看见 */
export interface DrawFeedEntry {
  id: number;
  /** 所属回合（schedule 下标；系统条目同样带上） */
  turnId: number;
  kind: 'guess' | 'solved' | 'close' | 'chat' | 'sys';
  /** 发言者 id（系统条目为空串） */
  by: string;
  seat: number;
  name: string;
  text: string;
  /** all=所有人；self=只有发言者（很接近了）；solved=画手+本回合已猜对者（回合结束后对所有人公开） */
  vis: 'all' | 'self' | 'solved';
}

/** 下发给会话的猜词流条目（已按观看者裁剪） */
export interface DrawFeedItem {
  id: number;
  kind: DrawFeedEntry['kind'];
  seat: number;
  name: string;
  text: string;
}

/** 本回合（服务端权威）：word/choices 绝不外泄给非画手 */
export interface DrawTurnState {
  /** schedule 下标（跨回合单调递增；客户端据此识别画面所属回合） */
  id: number;
  /** 本局第几个实际进行的回合（从 1 起；被跳过的离场者回合不计） */
  no: number;
  drawerId: string;
  choices: DrawWord[];
  word: DrawWord | null;
  deadline: number;
  /** 作画开始时刻与时长（计分按剩余比例） */
  drawStartedAt: number;
  turnMs: number;
  /** 半程揭字时刻（0=不揭：两字词）与已揭示的字下标 */
  hintAt: number;
  revealed: number[];
  solved: { id: string; at: number; points: number }[];
  drawerPoints: number;
  /** 回合结束原因：all=全员猜对 time=时间到 away=画手断线作废 left=画手离开作废 awayGuess=在线全员猜对（掉线者宽限超时） */
  endReason: 'all' | 'time' | 'away' | 'left' | 'awayGuess' | null;
}

/** 每回合摘要（揭晓时写入；房间记录与审计用） */
export interface DrawTurnSummary {
  turnId: number;
  no: number;
  drawerId: string;
  drawerName: string;
  word: string;
  d: DrawDifficulty;
  solvedIds: string[];
  endReason: NonNullable<DrawTurnState['endReason']>;
}

export interface DrawRankRow {
  seat: number;
  name: string;
  score: number;
  /** 名次（同分并列：1,1,3） */
  rank: number;
  left: boolean;
}

export interface DrawResult {
  /** done=全部回合画完 abort=房主终止 leave=人数不足 idle=全员断线 */
  reason: 'done' | 'abort' | 'leave' | 'idle';
  /** 实际进行的回合数 */
  turns: number;
}

export interface DrawState {
  phase: 'choosing' | 'drawing' | 'reveal' | 'gameover';
  players: DrawPlayerState[];
  /** 画手排期（玩家 id，按座位轮转 × 每人次数）；离场者的剩余回合跳过 */
  schedule: string[];
  cycles: number;
  turnSec: number;
  turn: DrawTurnState;
  /** 当前回合画面（本模式的状态识别字段） */
  strokes: DrawStroke[];
  /** 画面修订号：每批操作与每次换回合 +1（会话游标对比它决定是否补快照） */
  drawRev: number;
  pointCount: number;
  feed: DrawFeedEntry[];
  feedSeq: number;
  /** 本局已出过的词（候选不重复） */
  usedWords: string[];
  history: DrawTurnSummary[];
  /** 画手断线起点（0=在线） */
  awaySince: number;
  /** 在线猜词者全部猜对后等待掉线猜词者的宽限起点（0=未等待） */
  guessWaitSince: number;
  startedAt: number;
  ranking: DrawRankRow[];
  result: DrawResult | null;
  log: LogLine[];
  logSeq: number;
}

export interface DrawViewPlayer {
  id: string;
  name: string;
  seat: number;
  score: number;
  left: boolean;
  connected: boolean;
  /** 本回合已猜对 */
  solved: boolean;
  /** 本回合得分（揭晓面板用） */
  gained: number;
}

/** 下发给会话的视图：kind='draw'；整包全量替换（画面另走 dOps/dSnap） */
export interface DrawView {
  kind: 'draw';
  mode: GameMode;
  code: string;
  hostId: string;
  phase: DrawState['phase'];
  players: DrawViewPlayer[];
  /** 当前画面所属回合（schedule 下标）与修订号 */
  turnId: number;
  drawRev: number;
  /** 第几回合 / 共几回合（离场者的剩余回合不计入总数） */
  turnNo: number;
  totalTurns: number;
  cycles: number;
  turnSec: number;
  drawerId: string;
  /** 候选词：仅画手且选词阶段 */
  choices: DrawWord[] | null;
  /** 答案：画手全程可见；其他人揭晓/终局后可见 */
  word: string | null;
  /** 猜词者提示：「＿＿果」式掩码（作画阶段）；画手/揭晓后为 null */
  hint: string | null;
  wordLen: number;
  category: string | null;
  difficulty: DrawDifficulty | null;
  deadline: number | null;
  serverTime: number;
  endReason: DrawTurnState['endReason'];
  feed: DrawFeedItem[];
  /** 我本回合已猜对 */
  iSolved: boolean;
  spectator: boolean;
  ranking: DrawRankRow[];
  result: DrawResult | null;
  startedAt: number;
  log: LogLine[];
  logSeq: number;
}
