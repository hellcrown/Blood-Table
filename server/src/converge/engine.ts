/**
 * 心有灵犀 · 对局引擎（服务端权威）
 *
 * 规则口径（RULES-CONVERGE）：
 * - 双人各写一个文本（≤60 字、非空白），提交后在对方提交前可反复覆写；
 * - 双方都已提交即揭示本轮：宽松归一化（NFKC→去空白→小写，@shared/convergeProtocol 与客户端同源）
 *   相同 → 相遇终局，用时轮数；不同 → 进入下一轮；
 * - 对手当轮未揭示的文本绝不下发（视图只带自己 myText 与双方 submitted 标记）；
 * - 终局：相遇 / 房主终止 / 玩家离场 / 全员断线超时，后三者记「未相遇」；
 * - 不限时：纯回合制，挂机兜底交给 rooms 层的全员断线 30s 宽限与空房回收。
 */
import type { LogLine } from '@shared/protocol';
import {
  CONVERGE_TEXT_MAX,
  normalizeText,
  type ConvergePlayerState,
  type ConvergeResult,
  type ConvergeRound,
  type ConvergeState,
  type ConvergeView,
} from '@shared/convergeProtocol';
import { GameError } from '../game/types';

export type { ConvergeState, ConvergeView } from '@shared/convergeProtocol';

export interface ConvergePlayerInit {
  id: string;
  name: string;
  seat: number;
}

export function createConvergeGame(players: ConvergePlayerInit[], now: number): ConvergeState {
  const seated = players.slice(0, 2).map((p) => ({
    ...p,
    text: null,
    submitted: false,
  }));
  return {
    phase: 'playing',
    round: 1,
    players: seated,
    rounds: [],
    startedAt: now,
    result: null,
    log: [],
    logSeq: 0,
  };
}

function pushLog(state: ConvergeState, kind: LogLine['kind'], text: string): void {
  state.log.push({ seq: ++state.logSeq, kind, text });
}

function findPlayer(state: ConvergeState, playerId: string): ConvergePlayerState | undefined {
  return state.players.find((p) => p.id === playerId);
}

function endGame(state: ConvergeState, result: ConvergeResult, logText: string): void {
  state.phase = 'gameover';
  state.result = result;
  pushLog(state, result.matched ? 'win' : 'sys', logText);
}

/** 提交（或覆写）自己当轮的文本；双方都已提交时揭示本轮 */
export function cSubmit(state: ConvergeState, playerId: string, rawText: unknown, now: number): void {
  void now;
  if (state.phase !== 'playing') return;
  const p = findPlayer(state, playerId);
  if (!p) return;
  if (typeof rawText !== 'string') throw new GameError('BAD_MSG', '文本格式错误');
  // 控制字符折成空格后清理首尾（防 \n 注入日志/视图）；中间空白在归一化时忽略，展示原样保留
  const text = rawText.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CONVERGE_TEXT_MAX);
  if (!text) throw new GameError('BAD_TEXT', '先写点什么再提交');
  p.text = text;
  p.submitted = true;

  if (state.players.every((x) => x.submitted)) {
    // 双方都提交：揭示本轮
    const [a, b] = state.players;
    const same = normalizeText(a.text ?? '') === normalizeText(b.text ?? '');
    const round: ConvergeRound = {
      n: state.round,
      entries: state.players.map((x) => ({ seat: x.seat, text: x.text ?? '' })),
      same,
    };
    state.rounds.push(round);
    if (same) {
      endGame(
        state,
        { matched: true, rounds: state.round, word: round.entries[0]?.text ?? '', reason: 'match' },
        `第 ${state.round} 轮相遇：「${round.entries[0]?.text ?? ''}」`,
      );
    } else {
      pushLog(
        state,
        'sys',
        `第 ${state.round} 轮：${a.name}「${a.text}」 × ${b.name}「${b.text}」`,
      );
      state.round += 1;
      for (const x of state.players) {
        x.text = null;
        x.submitted = false;
      }
    }
  }
}

/** 房主终止本局（未相遇散局） */
export function convergeAbort(state: ConvergeState, now: number): boolean {
  void now;
  if (state.phase !== 'playing') return false;
  endGame(
    state,
    { matched: false, rounds: state.rounds.length, word: '', reason: 'abort' },
    '房主终止了本局：未相遇',
  );
  return true;
}

/** 全员断线就地终局（宽限期由 rooms 层控制）：防双人局挂机占房 */
export function convergeForceEnd(state: ConvergeState, now: number): boolean {
  void now;
  if (state.phase !== 'playing') return false;
  endGame(
    state,
    { matched: false, rounds: state.rounds.length, word: '', reason: 'idle' },
    '全员断线，本局就地结束：未相遇',
  );
  return true;
}

/** 玩家中途退出：本局就地作未相遇终局（无替补概念，双人局少一人即无法继续） */
export function cLeave(state: ConvergeState, playerId: string, now: number): boolean {
  void now;
  if (state.phase !== 'playing') return false;
  const p = findPlayer(state, playerId);
  if (!p) return false;
  endGame(
    state,
    { matched: false, rounds: state.rounds.length, word: '', reason: 'leave' },
    `${p.name} 离开，本局未相遇`,
  );
  return true;
}

/** 会话视图：玩家=自己的当轮文本；对手/观战者只见 submitted 标记与已揭示历史 */
export function buildConvergeView(
  state: ConvergeState,
  viewerId: string,
  roomCode: string,
  hostIdOf: string,
): ConvergeView {
  const me = findPlayer(state, viewerId);
  return {
    kind: 'converge',
    mode: 'converge',
    code: roomCode,
    hostId: hostIdOf,
    phase: state.phase,
    round: state.round,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      submitted: p.submitted,
    })),
    rounds: state.rounds,
    // 未提交时 text 恒为 null（引擎保证），此处再兜一层防外泄
    myText: me && me.submitted ? me.text : null,
    result: state.result,
    spectator: !me,
    startedAt: state.startedAt,
    log: state.log,
    logSeq: state.logSeq,
  };
}
