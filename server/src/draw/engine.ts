/**
 * 你画我猜 · 对局引擎（服务端权威）
 *
 * 规则口径（rulebook/RULES-DRAW.md）：
 * - 2-4 人按座位轮转当画手，每人画 cycles 次；离场者剩余回合跳过；
 * - 回合：选词（三档各一个候选，15s 超时随机）→ 作画（turnSec）→ 揭晓（5s）→ 下一回合；
 * - 猜词框兼作回合聊天：猜对只广播「猜对了」、接近（包含答案/差一字）只给本人、猜错公开；
 *   猜对后的发言只对画手与已猜对者可见（回合结束后公开）；画手作画时不能发言；
 * - 计分：猜对 (40+60×剩余比例)×倍率，画手每有一人猜对 +25×倍率；全员猜对提前结束；
 * - 答案与候选词绝不进非画手视图，揭晓前绝不写进对局日志（日志全员可见）；
 * - 画面：strokes 是当回合画面，每批操作 drawRev+1；增量扇出与快照补发在 rooms 层。
 * 约定同其他引擎：纯函数直接修改传入 state，now/rng 由调用方注入；返回 boolean=有无变化。
 */
import type { LogLine } from '@shared/protocol';
import {
  DRAW_COLORS,
  DRAW_CYCLE_OPTIONS,
  DRAW_DEFAULT_CYCLES,
  DRAW_DEFAULT_TURN_SEC,
  DRAW_DIFF_LABEL,
  DRAW_DRAWER_AWAY_MS,
  DRAW_GUESS_MAX,
  DRAW_H,
  DRAW_MAX_POINTS,
  DRAW_MAX_STROKES,
  DRAW_NUMS_PER_MSG,
  DRAW_OPS_PER_MSG,
  DRAW_PICK_SEC,
  DRAW_REVEAL_SEC,
  DRAW_TURN_SEC_OPTIONS,
  DRAW_W,
  DRAW_WIDTHS,
  drawDrawerShare,
  drawGuessPoints,
  normalizeGuess,
  type DrawDifficulty,
  type DrawFeedEntry,
  type DrawFeedItem,
  type DrawOp,
  type DrawPlayerState,
  type DrawRankRow,
  type DrawResult,
  type DrawState,
  type DrawTurnState,
  type DrawView,
  type DrawWord,
} from '@shared/drawProtocol';
import { cleanChatText } from '../chat';
import { GameError } from '../game/types';
import { DRAW_WORDS, type DrawBankWord } from './words';

export type { DrawState, DrawView } from '@shared/drawProtocol';

export interface DrawPlayerInit {
  id: string;
  name: string;
  seat: number;
}

export interface DrawOptions {
  /** 作画时限秒数（0/非选项值 → 默认 80） */
  turnSec?: number;
  /** 每人画几次（0/非选项值 → 默认 2） */
  cycles?: number;
}

export type Rng = () => number;

/** 服务端保留的猜词流条数 / 每次下发条数 */
const FEED_MAX = 120;
const FEED_VIEW_MAX = 60;

const END_REASON_TEXT: Record<NonNullable<DrawTurnState['endReason']>, string> = {
  all: '全员猜对',
  time: '时间到',
  away: '画手掉线，本回合作废',
  left: '画手离开，本回合作废',
};

/** 词 → 词库条目（取别称用；候选词只携带 word/cat/d） */
const BANK_BY_WORD = new Map<string, DrawBankWord>(DRAW_WORDS.map((w) => [w.w, w]));

export function resolveTurnSec(raw: number | undefined): number {
  return raw != null && DRAW_TURN_SEC_OPTIONS.includes(raw) ? raw : DRAW_DEFAULT_TURN_SEC;
}

export function resolveCycles(raw: number | undefined): number {
  return raw != null && DRAW_CYCLE_OPTIONS.includes(raw) ? raw : DRAW_DEFAULT_CYCLES;
}

/** 按码点拆字（防代理对/生僻字被拆成两半） */
function charsOf(s: string): string[] {
  return [...s];
}

function blankTurn(turnMs: number): DrawTurnState {
  return {
    id: -1,
    no: 0,
    drawerId: '',
    choices: [],
    word: null,
    deadline: 0,
    drawStartedAt: 0,
    turnMs,
    hintAt: 0,
    revealed: [],
    solved: [],
    drawerPoints: 0,
    endReason: null,
  };
}

export function createDrawGame(
  players: DrawPlayerInit[],
  now: number,
  opts: DrawOptions = {},
  rng: Rng = Math.random,
): DrawState {
  const seated: DrawPlayerState[] = [...players]
    .sort((a, b) => a.seat - b.seat)
    .slice(0, 4)
    .map((p) => ({ id: p.id, name: p.name, seat: p.seat, score: 0, left: false }));
  const cycles = resolveCycles(opts.cycles);
  const turnSec = resolveTurnSec(opts.turnSec);
  const schedule: string[] = [];
  for (let c = 0; c < cycles; c++) schedule.push(...seated.map((p) => p.id));
  const state: DrawState = {
    phase: 'choosing',
    players: seated,
    schedule,
    cycles,
    turnSec,
    turn: blankTurn(turnSec * 1000),
    strokes: [],
    drawRev: 0,
    pointCount: 0,
    feed: [],
    feedSeq: 0,
    usedWords: [],
    history: [],
    awaySince: 0,
    startedAt: now,
    ranking: [],
    result: null,
    log: [],
    logSeq: 0,
  };
  startTurn(state, 0, now, rng);
  return state;
}

function pushLog(state: DrawState, kind: LogLine['kind'], text: string): void {
  state.log.push({ seq: ++state.logSeq, kind, text });
}

function pushFeed(
  state: DrawState,
  e: Pick<DrawFeedEntry, 'kind' | 'vis' | 'text'> & { by?: DrawPlayerState },
): void {
  state.feed.push({
    id: ++state.feedSeq,
    turnId: state.turn.id,
    kind: e.kind,
    vis: e.vis,
    by: e.by?.id ?? '',
    seat: e.by?.seat ?? -1,
    name: e.by?.name ?? '',
    text: e.text,
  });
  if (state.feed.length > FEED_MAX) state.feed.splice(0, state.feed.length - FEED_MAX);
}

function findPlayer(state: DrawState, id: string): DrawPlayerState | undefined {
  return state.players.find((p) => p.id === id);
}

/** 三档各抽一个本局未出过的词；某档抽空则该档重新洗回（上限 40 回合 × 每档 300+ 词，正常不会发生） */
function pickChoices(state: DrawState, rng: Rng): DrawWord[] {
  const used = new Set(state.usedWords);
  const out: DrawWord[] = [];
  for (const d of [1, 2, 3] as DrawDifficulty[]) {
    let pool = DRAW_WORDS.filter((w) => w.d === d && !used.has(w.w));
    if (pool.length === 0) pool = DRAW_WORDS.filter((w) => w.d === d);
    const w = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!;
    out.push({ word: w.w, cat: w.c, d: w.d });
    state.usedWords.push(w.w);
  }
  return out;
}

/** 从 schedule[fromIdx] 起找下一个未离场的画手开回合；排期用完即终局 */
function startTurn(state: DrawState, fromIdx: number, now: number, rng: Rng): void {
  let idx = fromIdx;
  while (idx < state.schedule.length && findPlayer(state, state.schedule[idx]!)?.left !== false) idx++;
  if (idx >= state.schedule.length) {
    finishGame(state, 'done', now);
    return;
  }
  const drawer = findPlayer(state, state.schedule[idx]!)!;
  const no = state.history.length + 1;
  state.turn = {
    ...blankTurn(state.turnSec * 1000),
    id: idx,
    no,
    drawerId: drawer.id,
    choices: pickChoices(state, rng),
    deadline: now + DRAW_PICK_SEC * 1000,
  };
  state.phase = 'choosing';
  state.strokes = [];
  state.pointCount = 0;
  state.drawRev += 1; // 换回合必触发一次快照（清空所有人的画布）
  state.awaySince = 0;
  pushFeed(state, { kind: 'sys', vis: 'all', text: `第 ${no} 回合：轮到 ${drawer.name} 作画` });
  pushLog(state, 'sys', `第 ${no} 回合：轮到 ${drawer.name} 作画`);
}

function beginDrawing(state: DrawState, word: DrawWord, now: number, auto: boolean): void {
  const t = state.turn;
  const drawer = findPlayer(state, t.drawerId);
  t.word = word;
  t.drawStartedAt = now;
  t.deadline = now + t.turnMs;
  t.hintAt = charsOf(word.word).length >= 3 ? now + Math.floor(t.turnMs / 2) : 0;
  t.revealed = [];
  state.phase = 'drawing';
  const len = charsOf(word.word).length;
  pushFeed(state, {
    kind: 'sys',
    vis: 'all',
    text: `${drawer?.name ?? '画手'}${auto ? '（超时随机选词）' : ''}开始作画：${len} 字 · ${word.cat} · ${DRAW_DIFF_LABEL[word.d]}`,
  });
  // 日志全员可见：只写难度，绝不写词
  pushLog(state, 'sys', `${drawer?.name ?? '画手'} 选好了${DRAW_DIFF_LABEL[word.d]}词，开始作画`);
}

/** 画手选词（下标 0-2）；非画手/非选词阶段静默忽略 */
export function dPick(state: DrawState, playerId: string, index: unknown, now: number): boolean {
  if (state.phase !== 'choosing' || playerId !== state.turn.drawerId) return false;
  const i = typeof index === 'number' ? index : NaN;
  if (!Number.isInteger(i) || i < 0 || i >= state.turn.choices.length) throw new GameError('BAD_MSG', '选词参数错误');
  beginDrawing(state, state.turn.choices[i]!, now, false);
  return true;
}

/** 坐标清洗：非数组/含非有限数整条作废；取整并钳进画布；最多取 maxNums 个数（偶数） */
function cleanPoints(raw: unknown, maxNums: number): number[] | null {
  if (!Array.isArray(raw)) return null;
  const n = Math.min(raw.length, maxNums) & ~1;
  if (n < 2) return null;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const max = i % 2 === 0 ? DRAW_W : DRAW_H;
    out[i] = Math.min(max, Math.max(0, Math.round(v)));
  }
  return out;
}

function asIndex(v: unknown, size: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < size ? v : null;
}

/**
 * 画面操作（仅当回合画手、作画阶段）：逐条清洗后应用，返回实际生效的操作（供 rooms 扇出），
 * 无一生效返回 null。非法操作一律静默丢弃——作画是高频流，每条报错都会弹提示。
 */
export function dStroke(state: DrawState, playerId: string, rawOps: unknown, now: number): DrawOp[] | null {
  void now;
  if (state.phase !== 'drawing' || playerId !== state.turn.drawerId || !Array.isArray(rawOps)) return null;
  const out: DrawOp[] = [];
  let numBudget = DRAW_NUMS_PER_MSG;
  for (const raw of rawOps.slice(0, DRAW_OPS_PER_MSG)) {
    if (raw == null || typeof raw !== 'object') continue;
    const op = raw as Record<string, unknown>;
    if (op.k === 'b' || op.k === 'a') {
      const pointBudget = (DRAW_MAX_POINTS - state.pointCount) * 2;
      const p = cleanPoints(op.p, Math.min(numBudget, pointBudget));
      if (!p) continue;
      if (op.k === 'b') {
        if (state.strokes.length >= DRAW_MAX_STROKES) continue;
        const id = typeof op.id === 'number' && Number.isInteger(op.id) && op.id >= 0 ? op.id : null;
        const c = asIndex(op.c, DRAW_COLORS.length);
        const w = asIndex(op.w, DRAW_WIDTHS.length);
        if (id == null || c == null || w == null || state.strokes.some((s) => s.id === id)) continue;
        state.strokes.push({ id, c, w, p });
        out.push({ k: 'b', id, c, w, p: [...p] });
      } else {
        const last = state.strokes[state.strokes.length - 1];
        if (!last || op.id !== last.id) continue; // 只能给最后一笔续点（保持叠放顺序）
        last.p.push(...p);
        out.push({ k: 'a', id: last.id, p });
      }
      numBudget -= p.length;
      state.pointCount += p.length / 2;
    } else if (op.k === 'u') {
      const last = state.strokes.pop();
      if (!last) continue;
      state.pointCount -= last.p.length / 2;
      out.push({ k: 'u' });
    } else if (op.k === 'x') {
      if (state.strokes.length === 0) continue;
      state.strokes = [];
      state.pointCount = 0;
      out.push({ k: 'x' });
    }
  }
  if (out.length === 0) return null;
  state.drawRev += 1;
  return out;
}

/** 编辑距离（按码点；猜词「差一个字」判定用，词长 ≤ 6 开销可忽略） */
function editDistance(a: string, b: string): number {
  const x = charsOf(a);
  const y = charsOf(b);
  const dp = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[y.length]!;
}

/** 正确答案（归一化）：词本身 + 别称 */
function answersOf(word: DrawWord): string[] {
  const bank = BANK_BY_WORD.get(word.word);
  return [word.word, ...(bank?.a ?? [])].map(normalizeGuess).filter(Boolean);
}

/**
 * 很接近：包含答案（「黑猫」之于「猫」）、是答案的两字以上片段（「长颈」之于「长颈鹿」）、
 * 或与两字以上的答案只差一个字。单字别称不参与包含判定（「鸡蛋」不该因别称「鸡」提示接近「公鸡」）。
 */
function isClose(g: string, word: DrawWord): boolean {
  const canonical = normalizeGuess(word.word);
  for (const a of answersOf(word)) {
    const aLen = charsOf(a).length;
    if ((a === canonical || aLen >= 2) && g.includes(a)) return true;
    if (charsOf(g).length >= 2 && a.includes(g)) return true;
    if (aLen >= 2 && editDistance(g, a) === 1) return true;
  }
  return false;
}

function guessersOf(state: DrawState): DrawPlayerState[] {
  return state.players.filter((p) => !p.left && p.id !== state.turn.drawerId);
}

function allGuessersSolved(state: DrawState): boolean {
  const solved = new Set(state.turn.solved.map((s) => s.id));
  const guessers = guessersOf(state);
  return guessers.length > 0 && guessers.every((p) => solved.has(p.id));
}

/**
 * 猜词 / 回合聊天。作画阶段非画手：猜对计分、接近只给本人、猜错公开；已猜对者发言只对画手与已猜对者可见。
 * 选词/揭晓阶段：公开聊天。画手作画中发言直接拒绝（防直接报答案）。
 */
export function dGuess(state: DrawState, playerId: string, rawText: unknown, now: number): boolean {
  if (state.phase === 'gameover') return false;
  const p = findPlayer(state, playerId);
  if (!p || p.left) return false;
  if (typeof rawText !== 'string') throw new GameError('BAD_MSG', '文本格式错误');
  const text = cleanChatText(rawText).slice(0, DRAW_GUESS_MAX);
  if (!text) throw new GameError('BAD_TEXT', '先写点什么再发送');
  const t = state.turn;
  // 画手在选词阶段就已看到候选词：选词+作画全程禁言（防直接报答案/候选）
  if (p.id === t.drawerId && (state.phase === 'choosing' || state.phase === 'drawing')) {
    throw new GameError('DRAWER_SILENT', '你是本回合的画手，专心画吧');
  }
  if (state.phase !== 'drawing' || !t.word) {
    pushFeed(state, { kind: 'chat', vis: 'all', by: p, text });
    return true;
  }
  if (t.solved.some((s) => s.id === p.id)) {
    pushFeed(state, { kind: 'chat', vis: 'solved', by: p, text });
    return true;
  }
  const g = normalizeGuess(text);
  if (g && answersOf(t.word).includes(g)) {
    solve(state, p, now);
    return true;
  }
  if (g && isClose(g, t.word)) {
    pushFeed(state, { kind: 'close', vis: 'self', by: p, text: `${text}（很接近了！）` });
    return true;
  }
  pushFeed(state, { kind: 'guess', vis: 'all', by: p, text });
  return true;
}

function solve(state: DrawState, p: DrawPlayerState, now: number): void {
  const t = state.turn;
  const d = t.word!.d;
  const points = drawGuessPoints(t.deadline - now, t.turnMs, d);
  t.solved.push({ id: p.id, at: now, points });
  p.score += points;
  const share = drawDrawerShare(d);
  t.drawerPoints += share;
  const drawer = findPlayer(state, t.drawerId);
  if (drawer) drawer.score += share;
  pushFeed(state, { kind: 'solved', vis: 'all', by: p, text: `猜对了！+${points}` });
  pushLog(state, 'sys', `${p.name} 猜对了（+${points}）`);
  if (allGuessersSolved(state)) endTurn(state, 'all', now);
}

/** 结束本回合进入揭晓（此刻起答案公开，才写进日志） */
function endTurn(state: DrawState, reason: NonNullable<DrawTurnState['endReason']>, now: number): void {
  if (state.phase !== 'choosing' && state.phase !== 'drawing') return;
  const t = state.turn;
  t.endReason = reason;
  state.phase = 'reveal';
  t.deadline = now + DRAW_REVEAL_SEC * 1000;
  state.awaySince = 0;
  const drawer = findPlayer(state, t.drawerId);
  const guessers = guessersOf(state).length;
  state.history.push({
    turnId: t.id,
    no: t.no,
    drawerId: t.drawerId,
    drawerName: drawer?.name ?? '',
    word: t.word?.word ?? '',
    d: t.word?.d ?? 1,
    solvedIds: t.solved.map((s) => s.id),
    endReason: reason,
  });
  if (t.word) {
    pushFeed(state, { kind: 'sys', vis: 'all', text: `答案是「${t.word.word}」（${END_REASON_TEXT[reason]}）` });
    pushLog(
      state,
      'sys',
      `第 ${t.no} 回合：${drawer?.name ?? '画手'} 画「${t.word.word}」，${t.solved.length}/${guessers} 人猜对`,
    );
  } else {
    pushFeed(state, { kind: 'sys', vis: 'all', text: `${drawer?.name ?? '画手'} 没来得及选词（${END_REASON_TEXT[reason]}）` });
    pushLog(state, 'sys', `第 ${t.no} 回合作废：${END_REASON_TEXT[reason]}`);
  }
}

/** 排名：在场者按总分降序（同分并列 1,1,3），中途离开者排在后面（保留得分） */
function rankPlayers(players: DrawPlayerState[]): DrawRankRow[] {
  const sorted = [...players].sort((a, b) => Number(a.left) - Number(b.left) || b.score - a.score || a.seat - b.seat);
  let rank = 0;
  let prev: string | null = null;
  return sorted.map((p, i) => {
    const key = `${p.left}:${p.score}`;
    if (key !== prev) {
      rank = i + 1;
      prev = key;
    }
    return { seat: p.seat, name: p.name, score: p.score, rank, left: p.left };
  });
}

function finishGame(state: DrawState, reason: DrawResult['reason'], now: number): void {
  void now;
  const t = state.turn;
  // 中途结束时仍在进行的回合：公开答案（不计入回合摘要）
  if ((state.phase === 'choosing' || state.phase === 'drawing') && t.word) {
    pushFeed(state, { kind: 'sys', vis: 'all', text: `本回合答案是「${t.word.word}」` });
  }
  state.phase = 'gameover';
  t.deadline = 0;
  state.awaySince = 0;
  state.ranking = rankPlayers(state.players);
  state.result = { reason, turns: state.history.length };
  const top = state.ranking.filter((r) => r.rank === 1 && !r.left);
  const reasonText =
    reason === 'done' ? '全部回合画完' : reason === 'abort' ? '房主终止了本局' : reason === 'leave' ? '人数不足' : '全员断线';
  if (top.length > 0 && top[0]!.score > 0) {
    pushLog(state, 'win', `本局结束（${reasonText}）：${top.map((r) => r.name).join('、')} 以 ${top[0]!.score} 分夺冠`);
  } else {
    pushLog(state, 'sys', `本局结束（${reasonText}）`);
  }
  pushFeed(state, { kind: 'sys', vis: 'all', text: `本局结束：${reasonText}` });
}

/**
 * 时间驱动（rooms.tickRoom 每 500ms 调用）：画手断线 10s 作废本回合、选词超时随机、
 * 半程揭一个字（三字及以上）、作画超时、揭晓结束后开下一回合。返回 true=视图有变化。
 */
export function drawTick(state: DrawState, now: number, connectedIds: ReadonlySet<string>, rng: Rng = Math.random): boolean {
  if (state.phase === 'gameover') return false;
  const t = state.turn;
  if (state.phase === 'choosing' || state.phase === 'drawing') {
    if (!connectedIds.has(t.drawerId)) {
      if (!state.awaySince) state.awaySince = now;
      else if (now - state.awaySince >= DRAW_DRAWER_AWAY_MS) {
        endTurn(state, 'away', now);
        return true;
      }
    } else {
      state.awaySince = 0;
    }
  }
  if (state.phase === 'choosing' && now >= t.deadline) {
    beginDrawing(state, t.choices[Math.min(t.choices.length - 1, Math.floor(rng() * t.choices.length))]!, now, true);
    return true;
  }
  if (state.phase === 'drawing') {
    let changed = false;
    if (t.hintAt && now >= t.hintAt && t.revealed.length === 0 && t.word) {
      const len = charsOf(t.word.word).length;
      t.revealed.push(Math.min(len - 1, Math.floor(rng() * len)));
      pushFeed(state, { kind: 'sys', vis: 'all', text: '提示：揭开了一个字' });
      changed = true;
    }
    if (now >= t.deadline) {
      endTurn(state, 'time', now);
      return true;
    }
    return changed;
  }
  if (state.phase === 'reveal' && now >= t.deadline) {
    startTurn(state, t.id + 1, now, rng);
    return true;
  }
  return false;
}

/** 房主终止 */
export function drawAbort(state: DrawState, now: number): boolean {
  if (state.phase === 'gameover') return false;
  finishGame(state, 'abort', now);
  return true;
}

/** 全员断线就地终局（宽限期由 rooms 层控制） */
export function drawForceEnd(state: DrawState, now: number): boolean {
  if (state.phase === 'gameover') return false;
  finishGame(state, 'idle', now);
  return true;
}

/** 玩家中途离开：标记离场；不足 2 人终局；画手离开作废本回合；剩余猜词者都已猜对则提前揭晓 */
export function dLeave(state: DrawState, playerId: string, now: number): boolean {
  if (state.phase === 'gameover') return false;
  const p = findPlayer(state, playerId);
  if (!p || p.left) return false;
  p.left = true;
  pushFeed(state, { kind: 'sys', vis: 'all', text: `${p.name} 离开了对局` });
  pushLog(state, 'sys', `${p.name} 离开了对局`);
  if (state.players.filter((x) => !x.left).length < 2) {
    finishGame(state, 'leave', now);
    return true;
  }
  if ((state.phase === 'choosing' || state.phase === 'drawing') && state.turn.drawerId === p.id) {
    endTurn(state, 'left', now);
    return true;
  }
  if (state.phase === 'drawing' && allGuessersSolved(state)) endTurn(state, 'all', now);
  return true;
}

/**
 * 房间聊天防泄题：作画阶段把答案（及两字以上的中文别称）原文打码成「＊」；
 * 选词阶段画手已看到三个候选，三个一起打码。只是轻量拦截（拆字/谐音拦不住，场外更拦不住）。
 */
export function maskDrawAnswer(state: DrawState, text: string): string {
  const t = state.turn;
  const words =
    state.phase === 'drawing' && t.word ? [t.word.word] : state.phase === 'choosing' ? t.choices.map((c) => c.word) : [];
  const targets: string[] = [];
  for (const w of words) {
    targets.push(w);
    for (const a of BANK_BY_WORD.get(w)?.a ?? []) {
      if (charsOf(a).length >= 2 && /[^\x00-\x7f]/.test(a)) targets.push(a);
    }
  }
  if (targets.length === 0) return text;
  // 按字覆盖而非逐个替换：别称与词互相重叠时（「小猫咪」=「小猫」+「猫咪」）整段都要打掉
  const cs = charsOf(text);
  const lower = cs.map((c) => c.toLowerCase());
  const covered = new Array<boolean>(cs.length).fill(false);
  for (const a of targets) {
    const tc = charsOf(a.toLowerCase());
    for (let i = 0; i + tc.length <= lower.length; i++) {
      if (tc.every((c, j) => lower[i + j] === c)) for (let j = 0; j < tc.length; j++) covered[i + j] = true;
    }
  }
  return covered.some(Boolean) ? cs.map((c, i) => (covered[i] ? '＊' : c)).join('') : text;
}

function feedFor(state: DrawState, viewerId: string, insider: boolean, ended: boolean): DrawFeedItem[] {
  const out: DrawFeedItem[] = [];
  for (const e of state.feed) {
    const visible =
      e.vis === 'all' ||
      e.by === viewerId ||
      (e.vis === 'solved' && (e.turnId !== state.turn.id || ended || insider));
    if (visible) out.push({ id: e.id, kind: e.kind, seat: e.seat, name: e.name, text: e.text });
  }
  return out.slice(-FEED_VIEW_MAX);
}

/**
 * 会话视图：答案只给画手（及本回合已猜对者），候选词只给选词中的画手；揭晓/终局后全员可见答案。
 * 观战者与猜词者同口径（看不到答案）。
 */
export function buildDrawView(
  state: DrawState,
  viewerId: string,
  roomCode: string,
  hostIdOf: string,
  connectedIds: ReadonlySet<string>,
  now: number = Date.now(),
): DrawView {
  const me = findPlayer(state, viewerId);
  const t = state.turn;
  const isDrawer = !!me && me.id === t.drawerId;
  const solvedIds = new Set(t.solved.map((s) => s.id));
  const iSolved = !!me && solvedIds.has(me.id);
  const ended = state.phase === 'reveal' || state.phase === 'gameover';
  const word = t.word;
  const knowsWord = !!word && (isDrawer || iSolved || ended);
  const future = state.schedule.slice(t.id + 1).filter((id) => findPlayer(state, id)?.left === false).length;
  return {
    kind: 'draw',
    mode: 'draw',
    code: roomCode,
    hostId: hostIdOf,
    phase: state.phase,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      score: p.score,
      left: p.left,
      connected: connectedIds.has(p.id),
      solved: solvedIds.has(p.id),
      gained: p.id === t.drawerId ? t.drawerPoints : (t.solved.find((s) => s.id === p.id)?.points ?? 0),
    })),
    turnId: t.id,
    drawRev: state.drawRev,
    turnNo: t.no,
    totalTurns: state.phase === 'gameover' ? state.history.length : t.no + future,
    cycles: state.cycles,
    turnSec: state.turnSec,
    drawerId: t.drawerId,
    choices: isDrawer && state.phase === 'choosing' ? t.choices : null,
    word: knowsWord ? word.word : null,
    hint:
      state.phase === 'drawing' && word && !knowsWord
        ? charsOf(word.word)
            .map((ch, i) => (t.revealed.includes(i) ? ch : '＿'))
            .join('')
        : null,
    wordLen: word ? charsOf(word.word).length : 0,
    category: word ? word.cat : null,
    difficulty: word ? word.d : null,
    deadline: state.phase === 'gameover' ? null : t.deadline,
    serverTime: now,
    endReason: t.endReason,
    feed: feedFor(state, viewerId, isDrawer || iSolved, ended),
    iSolved,
    spectator: !me,
    ranking: state.ranking,
    result: state.result,
    startedAt: state.startedAt,
    log: state.log,
    logSeq: state.logSeq,
  };
}
