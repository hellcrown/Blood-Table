/**
 * 血色猎场 · 对局引擎（服务端权威）
 *
 * 规则口径（RULES-TACTICS）：
 * - 移动：四向逐格 1 AP，墙/野怪/玩家均为障碍不可穿越（BFS 见 @shared/tacticsGrid，与客户端同源）；
 * - 距离/射程：曼哈顿距离（墙挡脚不挡手）；
 * - 野怪全静态守卫：被攻击未死即反击一次；玩家移动结束停在怪射程内被拦截一次；单次行动每怪至多反应一次；
 * - AP 归角色表（TACTICS_CHARACTERS），不跨回合累积，0 AP 自动结束回合；
 * - 大逃杀：HP≤0 立即淘汰，最后存活者获胜；进行中离场等同淘汰。
 */
import { randomInt } from 'node:crypto';
import type { LogLine } from '@shared/protocol';
import {
  TACTICS_CHARACTERS,
  TACTICS_DEFAULT_CHAR,
  TACTICS_DEFAULT_TURN_SEC,
  TACTICS_MAP_PRESETS,
  TACTICS_MONSTERS,
  TACTICS_SPAWN_MIN_DIST,
  TACTICS_TURN_SEC_MAX,
  TACTICS_TURN_SEC_MIN,
  TACTICS_WALL_DENSITY,
  type MonsterType,
  type TacticsMapSize,
  type TacticsMonsterState,
  type TacticsPlayerState,
  type TacticsRankRow,
  type TacticsState,
  type TacticsView,
} from '@shared/tacticsProtocol';
import { manhattan, shortestPath } from '@shared/tacticsGrid';

export type { TacticsState, TacticsView } from '@shared/tacticsProtocol';

/** 日志上限：战棋操作密度高，超出裁掉最旧（增量 event 已下发过，视图只带保留尾部） */
const LOG_MAX = 400;

function pushLog(state: TacticsState, kind: LogLine['kind'], text: string): void {
  state.log.push({ seq: ++state.logSeq, kind, text });
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
}

export interface TacticsPlayerInit {
  id: string;
  name: string;
  seat: number;
}

function turnMsOf(turnSec: number): number {
  const sec = turnSec >= TACTICS_TURN_SEC_MIN ? Math.min(turnSec, TACTICS_TURN_SEC_MAX) : TACTICS_DEFAULT_TURN_SEC;
  return sec * 1000;
}

/* ---------------- 地图生成（180° 中心对称，各家绝对公平） ---------------- */

/** 出生点：四角内收 1 格 + 3 人局中心补位（180° 对称轨道只有 1/2 元素，中心是唯一自对称点） */
function spawnCells(rows: number, cols: number, count: number): { r: number; c: number }[] {
  const tl = { r: 1, c: 1 };
  const tr = { r: 1, c: cols - 2 };
  const bl = { r: rows - 2, c: 1 };
  const br = { r: rows - 2, c: cols - 2 };
  const mid = (rows - 1) / 2;
  if (count <= 2) return [tl, br];
  if (count === 3) return [tl, br, { r: mid, c: mid }];
  return [tl, tr, bl, br];
}

/** 以墙为障碍的连通性校验：required 列表必须互相可达 */
function mapConnected(rows: number, cols: number, grid: number[], required: number[]): boolean {
  const seen = new Set<number>([required[0]]);
  const queue = [required[0]];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const r = Math.floor(i / cols);
    const c = i % cols;
    for (const [dr, dc] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const j = rr * cols + cc;
      if (seen.has(j) || grid[j] === 1) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  return required.every((i) => seen.has(i));
}

function generateMap(rows: number, cols: number, spawnIdx: number[]): number[] {
  const cells = rows * cols;
  const half = Math.floor((cells + 1) / 2);
  // 中心格永远留空（3 人局出生点）
  const reserved = new Set<number>(spawnIdx);
  reserved.add(Math.floor(cells / 2));
  for (let attempt = 0; attempt < 24; attempt++) {
    const grid = new Array<number>(cells).fill(0);
    const density =
      TACTICS_WALL_DENSITY.min + (randomInt(0, 100) / 100) * (TACTICS_WALL_DENSITY.max - TACTICS_WALL_DENSITY.min);
    for (let i = 0; i < half; i++) {
      const mi = cells - 1 - i;
      if (reserved.has(i) || reserved.has(mi)) continue;
      if (randomInt(0, 100) / 100 < density) {
        grid[i] = 1;
        if (mi !== i) grid[mi] = 1;
      }
    }
    if (mapConnected(rows, cols, grid, [...reserved])) return grid;
  }
  return new Array<number>(cells).fill(0); // 兜底：全平地必然连通
}

/** 地图+野怪一起生成并整体验证连通性：怪窝开凿可能打通也可能仍处墙中口袋，必须放完怪再查 */
function buildBattlefield(
  rows: number,
  cols: number,
  spawns: { r: number; c: number }[],
  preset: (typeof TACTICS_MAP_PRESETS)[TacticsMapSize],
  playerCount: number,
): { grid: number[]; monsters: TacticsMonsterState[] } {
  const cells = rows * cols;
  const spawnIdx = spawns.map((s) => s.r * cols + s.c);
  for (let attempt = 0; attempt < 24; attempt++) {
    const grid = generateMap(rows, cols, spawnIdx);
    const monsters = placeMonsters(preset, grid, rows, cols, spawns, playerCount);
    if (mapConnected(rows, cols, grid, [...spawnIdx, ...monsters.map((m) => m.r * cols + m.c)])) {
      return { grid, monsters };
    }
  }
  const grid = new Array<number>(cells).fill(0); // 兜底：全平地必然连通
  return { grid, monsters: placeMonsters(preset, grid, rows, cols, spawns, playerCount) };
}

/** 野怪布置：精英守中心附近，其余随机空格且离每个出生点 ≥ 保护距离（放不下逐级放宽） */
function placeMonsters(
  preset: (typeof TACTICS_MAP_PRESETS)[TacticsMapSize],
  grid: number[],
  rows: number,
  cols: number,
  spawns: { r: number; c: number }[],
  playerCount: number,
): TacticsMonsterState[] {
  const cells = rows * cols;
  const mid = (rows - 1) / 2;
  const taken = new Set<number>(spawns.map((s) => s.r * cols + s.c));
  const monsters: TacticsMonsterState[] = [];
  const put = (type: MonsterType, r: number, c: number) => {
    const def = TACTICS_MONSTERS[type];
    const i = r * cols + c;
    grid[i] = 0; // 怪窝开凿为平地（连带镜像格，保持对称）
    grid[cells - 1 - i] = 0;
    taken.add(i);
    monsters.push({ id: `m${monsters.length + 1}`, type, hp: def.hp, maxHp: def.hp, r, c, gold: def.gold });
  };
  const golemCount = preset.monsters.find((m) => m.type === 'golem')?.count ?? 0;
  if (golemCount >= 2) {
    put('golem', mid + 2, mid);
    put('golem', mid - 2, mid);
  } else if (golemCount === 1) {
    // 3 人局中心格是出生点 → 精英偏移仍守中心区
    put('golem', playerCount === 3 ? mid + 2 : mid, mid);
  }
  for (const entry of preset.monsters) {
    if (entry.type === 'golem') continue;
    for (let k = 0; k < entry.count; k++) {
      let minDist = TACTICS_SPAWN_MIN_DIST;
      for (let attempt = 0; attempt < 400; attempt++) {
        if (attempt === 200) minDist = 2;
        if (attempt === 300) minDist = 1;
        const i = randomInt(0, cells);
        if (grid[i] === 1 || taken.has(i)) continue;
        const r = Math.floor(i / cols);
        const c = i % cols;
        if (spawns.some((s) => manhattan(s.r, s.c, r, c) < minDist)) continue;
        put(entry.type, r, c);
        break;
      }
    }
  }
  return monsters;
}

/* ---------------- 开局 ---------------- */

export function createTacticsGame(
  mapSize: TacticsMapSize,
  players: TacticsPlayerInit[],
  now: number,
  turnSec = 0,
): TacticsState {
  const preset = TACTICS_MAP_PRESETS[mapSize] ?? TACTICS_MAP_PRESETS.medium;
  const rows = preset.rows;
  const cols = preset.cols;
  const ps = players.slice().sort((a, b) => a.seat - b.seat);
  const spawns = spawnCells(rows, cols, ps.length);
  const { grid, monsters } = buildBattlefield(rows, cols, spawns, preset, ps.length);
  const charDef = TACTICS_CHARACTERS[TACTICS_DEFAULT_CHAR] ?? Object.values(TACTICS_CHARACTERS)[0];
  const turnMs = turnMsOf(turnSec);

  const state: TacticsState = {
    mapSize: preset === TACTICS_MAP_PRESETS[mapSize] ? mapSize : 'medium',
    rows,
    cols,
    grid,
    phase: 'playing',
    players: ps.map((p, i) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      charId: charDef.id,
      hp: charDef.hp,
      maxHp: charDef.hp,
      ap: charDef.ap,
      maxAp: charDef.ap,
      r: spawns[i].r,
      c: spawns[i].c,
      alive: true,
      cooldowns: charDef.skills.map(() => 0),
      gold: 0,
      items: [],
    })),
    monsters,
    currentId: ps[0]?.id ?? '',
    turnNumber: 1,
    startedAt: now,
    deadline: now + turnMs,
    log: [],
    logSeq: 0,
    winnerId: null,
    ranking: [],
    turnMs,
  };
  pushLog(state, 'sys', `🏹 血色猎场开局：${ps.length} 名猎人入场，最后存活者获胜`);
  return state;
}

/* ---------------- 查找与结算辅助 ---------------- */

function findPlayer(state: TacticsState, playerId: string): TacticsPlayerState | undefined {
  return state.players.find((p) => p.id === playerId);
}

function inBounds(state: TacticsState, r: number, c: number): boolean {
  return Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < state.rows && c >= 0 && c < state.cols;
}

/** 移动障碍：存活玩家 + 野怪（墙在 grid 里，BFS 单独判） */
function blockedSet(state: TacticsState, exceptId?: string): Set<number> {
  const set = new Set<number>();
  for (const p of state.players) {
    if (!p.alive || p.id === exceptId) continue;
    set.add(p.r * state.cols + p.c);
  }
  for (const m of state.monsters) set.add(m.r * state.cols + m.c);
  return set;
}

function eliminate(state: TacticsState, p: TacticsPlayerState, now: number, by: string): void {
  p.hp = 0;
  p.alive = false;
  p.deadAt = now;
  pushLog(state, 'win', `💀 ${p.name} 被 ${by} 淘汰`);
  endIfOver(state, now);
}

function endIfOver(state: TacticsState, now: number): void {
  if (state.phase !== 'playing') return;
  const alive = state.players.filter((p) => p.alive);
  if (alive.length <= 1) endGame(state, alive[0]?.id ?? null, now);
}

function computeRanking(state: TacticsState, winnerId: string | null): TacticsRankRow[] {
  const alive = state.players.filter((p) => p.alive).sort((a, b) => b.hp - a.hp || a.seat - b.seat);
  const dead = state.players.filter((p) => !p.alive).sort((a, b) => (b.deadAt ?? 0) - (a.deadAt ?? 0));
  const order = [...alive.map((p) => p.id), ...dead.map((p) => p.id)];
  if (winnerId) {
    const idx = order.indexOf(winnerId);
    if (idx > 0) {
      order.splice(idx, 1);
      order.unshift(winnerId);
    }
  }
  return order.map((id, i) => {
    const p = state.players.find((x) => x.id === id)!;
    return { seat: p.seat, name: p.name, rank: i + 1, hp: p.hp, alive: p.alive };
  });
}

function endGame(state: TacticsState, winnerId: string | null, now: number): void {
  state.phase = 'gameover';
  state.winnerId = winnerId;
  state.deadline = now;
  state.ranking = computeRanking(state, winnerId);
  const winner = winnerId ? findPlayer(state, winnerId) : undefined;
  pushLog(state, 'win', winner ? `👑 ${winner.name} 笑到最后，成为猎场之王` : '🏁 对局结束');
}

/** 怪攻击玩家：verb 区分「拦截」（移动进射程）与「反击」（被打未死） */
function hitPlayer(state: TacticsState, monster: TacticsMonsterState, target: TacticsPlayerState, verb: string, now: number): void {
  const def = TACTICS_MONSTERS[monster.type];
  target.hp -= def.atk;
  pushLog(state, 'action', `👹 ${def.name} ${verb} ${target.name}（-${def.atk}HP）`);
  if (target.hp <= 0) eliminate(state, target, now, def.name);
}

/** 攻击结算（普攻与打击技能共用）：power 为本次伤害 */
function resolveStrike(state: TacticsState, p: TacticsPlayerState, r: number, c: number, power: number, now: number): void {
  const i = r * state.cols + c;
  const monster = state.monsters.find((m) => m.r * state.cols + m.c === i);
  if (monster) {
    const mdef = TACTICS_MONSTERS[monster.type];
    monster.hp -= power;
    pushLog(state, 'action', `⚔️ ${p.name} 攻击 ${mdef.name}（-${power}HP）`);
    if (monster.hp <= 0) {
      state.monsters = state.monsters.filter((m) => m !== monster);
      pushLog(state, 'action', `☠️ ${mdef.name} 被 ${p.name} 击杀`);
    } else if (manhattan(monster.r, monster.c, p.r, p.c) <= mdef.range) {
      hitPlayer(state, monster, p, '反击', now);
    }
    return;
  }
  const victim = state.players.find((q) => q.alive && q.id !== p.id && q.r * state.cols + q.c === i);
  if (victim) {
    victim.hp -= power;
    pushLog(state, 'action', `⚔️ ${p.name} 攻击 ${victim.name}（-${power}HP）`);
    if (victim.hp <= 0) eliminate(state, victim, now, p.name);
  }
}

/** 目标格上是否存在可攻击对象（野怪或他人）；无则 null */
function targetAt(state: TacticsState, p: TacticsPlayerState, r: number, c: number): 'monster' | 'player' | null {
  const i = r * state.cols + c;
  if (state.monsters.some((m) => m.r * state.cols + m.c === i)) return 'monster';
  if (state.players.some((q) => q.alive && q.id !== p.id && q.r * state.cols + q.c === i)) return 'player';
  return null;
}

/** 玩家移动结束后：停在怪射程内被拦截（单次行动每怪至多反应一次，循环天然满足） */
function provokeMonsters(state: TacticsState, p: TacticsPlayerState, now: number): void {
  for (const m of state.monsters) {
    const def = TACTICS_MONSTERS[m.type];
    if (manhattan(m.r, m.c, p.r, p.c) > def.range) continue;
    hitPlayer(state, m, p, '拦截', now);
    if (!p.alive) return;
  }
}

/** 行动收尾：行动者死亡则移交回合（淘汰结算已跑），AP 耗尽自动结束回合 */
function afterAction(state: TacticsState, p: TacticsPlayerState, now: number): void {
  if (state.phase !== 'playing') return;
  if (!p.alive) {
    advanceTurn(state, now);
    return;
  }
  if (p.ap <= 0) advanceTurn(state, now);
}

/** 移交下一位存活玩家：回合开始冷却递减、AP 重置 */
function advanceTurn(state: TacticsState, now: number): void {
  if (state.phase !== 'playing') return;
  const order = state.players;
  const curIdx = Math.max(0, order.findIndex((x) => x.id === state.currentId));
  for (let step = 1; step <= order.length; step++) {
    const next = order[(curIdx + step) % order.length];
    if (!next.alive) continue;
    if (next.id === state.currentId) {
      endGame(state, next.id, now); // 绕场一周只剩自己（endIfOver 兜底，防御性终局）
      return;
    }
    state.currentId = next.id;
    state.turnNumber += 1;
    for (let i = 0; i < next.cooldowns.length; i++) {
      if (next.cooldowns[i] > 0) next.cooldowns[i] -= 1;
    }
    next.ap = next.maxAp;
    state.deadline = now + state.turnMs;
    return;
  }
}

/* ---------------- 玩家动作（非法输入一律静默忽略：真实 UI 不会发出，重复刷是作弊探针进审计） ---------------- */

export function tMove(state: TacticsState, playerId: string, toR: number, toC: number, now: number): void {
  if (state.phase !== 'playing' || state.currentId !== playerId) return;
  const p = findPlayer(state, playerId);
  if (!p || !p.alive || !inBounds(state, toR, toC)) return;
  const start = p.r * state.cols + p.c;
  const goal = toR * state.cols + toC;
  if (start === goal) return;
  const path = shortestPath(state.rows, state.cols, state.grid, blockedSet(state, playerId), start, goal);
  if (!path || path.length > p.ap) return;
  p.ap -= path.length;
  p.r = toR;
  p.c = toC;
  pushLog(state, 'action', `🚶 ${p.name} 移动（-${path.length}AP）`);
  provokeMonsters(state, p, now);
  afterAction(state, p, now);
}

export function tAttack(state: TacticsState, playerId: string, r: number, c: number, now: number): void {
  if (state.phase !== 'playing' || state.currentId !== playerId) return;
  const p = findPlayer(state, playerId);
  if (!p || !p.alive || !inBounds(state, r, c) || p.ap < 1) return;
  const charDef = TACTICS_CHARACTERS[p.charId] ?? Object.values(TACTICS_CHARACTERS)[0];
  if (!targetAt(state, p, r, c)) return;
  if (manhattan(p.r, p.c, r, c) > charDef.atkRange) return;
  p.ap -= 1;
  resolveStrike(state, p, r, c, charDef.atk, now);
  afterAction(state, p, now);
}

export function tSkill(
  state: TacticsState,
  playerId: string,
  skillIdx: number,
  r: number | undefined,
  c: number | undefined,
  now: number,
): void {
  if (state.phase !== 'playing' || state.currentId !== playerId) return;
  const p = findPlayer(state, playerId);
  if (!p || !p.alive || p.ap < 1) return;
  const charDef = TACTICS_CHARACTERS[p.charId] ?? Object.values(TACTICS_CHARACTERS)[0];
  if (!Number.isInteger(skillIdx) || skillIdx < 0 || skillIdx >= charDef.skills.length) return;
  const skill = charDef.skills[skillIdx];
  if ((p.cooldowns[skillIdx] ?? 0) > 0) return;
  if (skill.kind === 'heal') {
    p.ap -= 1;
    p.cooldowns[skillIdx] = skill.cooldown;
    const healed = Math.min(p.maxHp - p.hp, skill.power);
    p.hp += healed;
    pushLog(state, 'action', `✦ ${p.name} 使用【${skill.name}】回复 ${healed}HP`);
  } else {
    if (!inBounds(state, r ?? NaN, c ?? NaN) || !targetAt(state, p, r!, c!)) return;
    if (manhattan(p.r, p.c, r!, c!) > skill.range) return;
    p.ap -= 1;
    p.cooldowns[skillIdx] = skill.cooldown;
    pushLog(state, 'action', `✦ ${p.name} 发动【${skill.name}】`);
    resolveStrike(state, p, r!, c!, skill.power, now);
  }
  afterAction(state, p, now);
}

export function tEndTurn(state: TacticsState, playerId: string, now: number): void {
  if (state.phase !== 'playing' || state.currentId !== playerId) return;
  const p = findPlayer(state, playerId);
  if (!p || !p.alive) return;
  advanceTurn(state, now);
}

/* ---------------- 周期驱动与终局 ---------------- */

/** 回合超时自动结束（只做超时跳过，不做托管代操作）；顺带兜底当前行动者已死的局面 */
export function tacticsTick(state: TacticsState, now: number): boolean {
  if (state.phase !== 'playing') return false;
  const cur = findPlayer(state, state.currentId);
  if (!cur || !cur.alive) {
    advanceTurn(state, now);
    return true;
  }
  if (now < state.deadline) return false;
  pushLog(state, 'sys', `⏰ ${cur.name} 超时，自动结束回合`);
  advanceTurn(state, now);
  return true;
}

/** 全员断线就地终局（宽限期由 rooms 层控制）：存活者按剩余 HP 排名 */
export function tacticsForceEnd(state: TacticsState, now: number): boolean {
  if (state.phase !== 'playing') return false;
  const alive = state.players.filter((p) => p.alive).sort((a, b) => b.hp - a.hp || a.seat - b.seat);
  endGame(state, alive[0]?.id ?? null, now);
  return true;
}

/** 玩家中途退出：立即淘汰（幽灵玩家不得参与排名/判胜） */
export function tLeave(state: TacticsState, playerId: string, now: number): void {
  const p = findPlayer(state, playerId);
  if (!p || !p.alive || state.phase !== 'playing') return;
  eliminate(state, p, now, '离场');
  if (state.phase === 'playing' && state.currentId === playerId) advanceTurn(state, now);
}

/* ---------------- 视图 ---------------- */

/** 会话视图：地形/野怪全量公开，玩家见全员状态；淘汰者与观战者同样收完整视图 */
export function buildTacticsView(
  state: TacticsState,
  viewerId: string,
  roomCode: string,
  hostIdOf: string,
  connectedIds?: Set<string>,
): TacticsView {
  const me = findPlayer(state, viewerId);
  return {
    kind: 'tactics',
    mode: 'tactics',
    code: roomCode,
    hostId: hostIdOf,
    mapSize: state.mapSize,
    rows: state.rows,
    cols: state.cols,
    grid: state.grid,
    phase: state.phase,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      charId: p.charId,
      hp: p.hp,
      maxHp: p.maxHp,
      ap: p.ap,
      maxAp: p.maxAp,
      r: p.r,
      c: p.c,
      alive: p.alive,
      cooldowns: [...p.cooldowns],
      gold: p.gold,
      items: [...p.items],
      connected: connectedIds ? connectedIds.has(p.id) : true,
    })),
    monsters: state.monsters.map((m) => ({ id: m.id, type: m.type, hp: m.hp, maxHp: m.maxHp, r: m.r, c: m.c })),
    currentId: state.currentId,
    turnNumber: state.turnNumber,
    startedAt: state.startedAt,
    deadline: state.phase === 'playing' ? state.deadline : null,
    log: state.log,
    logSeq: state.logSeq,
    youId: me ? viewerId : null,
    spectator: !me,
    ranking: state.ranking,
    winnerId: state.winnerId,
    serverTime: Date.now(),
  };
}
