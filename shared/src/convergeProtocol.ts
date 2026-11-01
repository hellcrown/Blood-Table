import type { GameMode, LogLine } from './protocol';

/**
 * 心有灵犀（converge）· 双人填词趋同
 * 两人不交流，每轮各写一个文本；两边都提交后揭示比对，宽松归一化相同即「相遇」，
 * 记录用轮数。流程参照扫雷：State 留服务端，View 按会话个性化下发。
 */

/** 单条文本长度上限（服务端钳制；WS 整条消息另有 16KB 上限） */
export const CONVERGE_TEXT_MAX = 60;

/**
 * 宽松判同归一化：NFKC（全角→半角等兼容分解）→ 去掉全部空白 → 小写。
 * 只用于比较；历史与展示保留原文。引擎与客户端测试共用同一实现，口径不会漂移。
 */
export function normalizeText(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** 已揭示的一轮：n 从 1 起；entries 与 players 顺序一致（seat 升序） */
export interface ConvergeRound {
  n: number;
  entries: { seat: number; text: string }[];
  /** 归一化后相同（相遇轮） */
  same: boolean;
}

/** 服务端权威的玩家状态；text 是当轮已提交文本，对方未揭示前绝不外泄 */
export interface ConvergePlayerState {
  id: string;
  name: string;
  seat: number;
  /** 当轮已提交文本（submitted=false 时为 null；提交后可覆写直至双方都提交） */
  text: string | null;
  submitted: boolean;
}

/** 终局摘要：相遇 / 房主终止 / 对方离场 / 全员断线超时 */
export interface ConvergeResult {
  matched: boolean;
  /** 相遇用时轮数；未相遇散局为已揭示的轮数 */
  rounds: number;
  /** 相遇的词（取相遇轮首个原文）；未相遇为空串 */
  word: string;
  reason: 'match' | 'abort' | 'leave' | 'idle';
}

export interface ConvergeState {
  phase: 'playing' | 'gameover';
  /** 当前轮（从 1 起；本轮揭示比对完成后 +1） */
  round: number;
  players: ConvergePlayerState[];
  /** 已揭示轮次历史（当轮未揭示的双方文本不在其中） */
  rounds: ConvergeRound[];
  startedAt: number;
  result: ConvergeResult | null;
  /** 与血色/扫雷同一广播与审计机制（每揭示一轮记一条） */
  log: LogLine[];
  logSeq: number;
}

/** 下发给会话的玩家条目：绝不携带当轮文本，只有「是否已提交」 */
export interface ConvergeViewPlayer {
  id: string;
  name: string;
  seat: number;
  submitted: boolean;
}

/** 下发给会话的视图：kind='converge'；view 是整包全量替换 */
export interface ConvergeView {
  kind: 'converge';
  mode: GameMode;
  code: string;
  /** 房主会话 id（再来一局/终止本局按钮用） */
  hostId: string;
  phase: 'playing' | 'gameover';
  /** 当前轮（从 1 起） */
  round: number;
  players: ConvergeViewPlayer[];
  rounds: ConvergeRound[];
  /** 我当轮已提交的文本（可修改；null=未提交）。对手的当轮文本绝不下发 */
  myText: string | null;
  result: ConvergeResult | null;
  /** 我是观战者（不占座位，无输入框） */
  spectator: boolean;
  startedAt: number;
  log: LogLine[];
  logSeq: number;
}
