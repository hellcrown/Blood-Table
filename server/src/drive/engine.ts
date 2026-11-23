/**
 * 勿停（drive）· 对局引擎（服务端权威，服务器模拟制）
 *
 * 规则口径（rulebook/RULES-DRIVE.md）：
 * - 1-4 人共乘一辆车行驶在无尽夜路上，客户端只发按键意图（vInt），本引擎 15Hz 模拟一切；
 * - 车速低于勿停线喂养「猎影」（尾压），归零即撞损车尾；噪音事件（撞路障/碾尸群）额外喂养；
 * - 开窗才能搜掠路肩补给，但窗爬者会爬开着的窗（灯亮吸引更多）；破窗时拖走当前开窗者，
 *   无人开窗则直接扣车耐久；被拖走者下个路牌复活；
 * - 加油站要停稳才加得到油——停车喂鬼也必须停；路牌间隔即难度 tier；
 * - 全员被拖走 = 无人驾驶自然滑停 → 猎影扑击 → 车毁，死亡螺旋无特判；
 * - targetSigns>0 时到达即全员逃生成功；纯无尽只有距离与路牌数。
 * 约定同其他引擎：纯函数直接修改传入 state，now/rng 由调用方注入；返回 boolean=有无变化。
 * 意图消息非法值一律静默钳制/丢弃（高频通道不报错，同 dStroke 口径）。
 */
import type { LogLine } from '@shared/protocol';
import {
  DRIVE_ACCEL,
  DRIVE_ATTACK_RESET,
  DRIVE_BARRIER_SLOW,
  DRIVE_BRAKE,
  DRIVE_CLIMB_MS,
  DRIVE_COAST,
  DRIVE_CRAWL_BASE_MS,
  DRIVE_CRAWL_FIRST_MS,
  DRIVE_CRAWL_LAMP_MULT,
  DRIVE_CRAWL_MIN_MS,
  DRIVE_CRAWL_MAX_MS,
  DRIVE_CRAWL_OPTIONS,
  DRIVE_CRAWL_RATE_MULT,
  DRIVE_CRAWL_TIER_CAP,
  DRIVE_CRAWL_TIER_SCALE,
  DRIVE_DEFAULT_CRAWL,
  DRIVE_DEFAULT_DURABILITY,
  DRIVE_DEFAULT_SIGN_GAP,
  DRIVE_DEFAULT_TAIL,
  DRIVE_DEFAULT_TARGET,
  DRIVE_DURABILITY_OPTIONS,
  DRIVE_EMPTY_MAX_SPEED,
  DRIVE_EVENT_FIRST_AT,
  DRIVE_EVENT_GAP_MAX,
  DRIVE_EVENT_GAP_MIN,
  DRIVE_EVENT_HORIZON,
  DRIVE_FUEL_BURN_BASE,
  DRIVE_FUEL_BURN_SCALE,
  DRIVE_FUEL_MAX,
  DRIVE_GAP_DRAIN,
  DRIVE_GAP_MAX,
  DRIVE_GAP_NOISE,
  DRIVE_GAP_REGEN,
  DRIVE_IDLE_LINE,
  DRIVE_LANE_COOLDOWN_MS,
  DRIVE_LOOT_FUEL_MAX,
  DRIVE_LOOT_FUEL_MIN,
  DRIVE_LOOT_MAX_SPEED,
  DRIVE_LOOT_REPAIR_CHANCE,
  DRIVE_MAX_DT_MS,
  DRIVE_MAX_SPEED,
  DRIVE_SIGN_GAP_OPTIONS,
  DRIVE_STATION_FUEL_RATE,
  DRIVE_STATION_GAP_BASE,
  DRIVE_STATION_LEN,
  DRIVE_STATION_MAX_SPEED,
  DRIVE_SWARM_LEN,
  DRIVE_SWARM_MIN_SPEED,
  DRIVE_SWARM_SLOW,
  DRIVE_TAIL_DRAIN,
  DRIVE_TAIL_OPTIONS,
  DRIVE_TARGET_OPTIONS,
  DRIVE_WARN_MS,
  type DriveCrawlRate,
  type DriveEvent,
  type DriveIntent,
  type DriveInputs,
  type DriveSide,
  type DriveState,
  type DriveTail,
  type DriveView,
} from '@shared/driveProtocol';

export type { DriveState, DriveView } from '@shared/driveProtocol';

export interface DrivePlayerInit {
  id: string;
  name: string;
  seat: number;
}

export interface DriveOptions {
  signGap?: number;
  tail?: DriveTail;
  durability?: number;
  crawl?: DriveCrawlRate;
  /** 目标路牌数（0=纯无尽） */
  target?: number;
}

export type Rng = () => number;

/** 日志只留尾部：无尽模式日志持续增长，全量下发会随时间膨胀 */
const LOG_MAX = 120;

const LANES: readonly (0 | 1 | 2)[] = [0, 1, 2];

export function resolveSignGap(raw: number | undefined): number {
  return raw != null && DRIVE_SIGN_GAP_OPTIONS.includes(raw) ? raw : DRIVE_DEFAULT_SIGN_GAP;
}
export function resolveDurability(raw: number | undefined): number {
  return raw != null && DRIVE_DURABILITY_OPTIONS.includes(raw) ? raw : DRIVE_DEFAULT_DURABILITY;
}
export function resolveTail(raw: DriveTail | undefined): DriveTail {
  return raw != null && DRIVE_TAIL_OPTIONS.includes(raw) ? raw : DRIVE_DEFAULT_TAIL;
}
export function resolveCrawl(raw: DriveCrawlRate | undefined): DriveCrawlRate {
  return raw != null && DRIVE_CRAWL_OPTIONS.includes(raw) ? raw : DRIVE_DEFAULT_CRAWL;
}
export function resolveTarget(raw: number | undefined): number {
  return raw != null && DRIVE_TARGET_OPTIONS.includes(raw) ? raw : DRIVE_DEFAULT_TARGET;
}

function blankWindow(): DriveState['windows']['L'] {
  return { open: false, opener: null, warnAt: 0, climbDeadline: 0 };
}

function pushLog(state: DriveState, kind: LogLine['kind'], text: string): void {
  state.log.push({ seq: ++state.logSeq, kind, text });
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
}

function findPlayer(state: DriveState, id: string) {
  return state.players.find((p) => p.id === id);
}

function windowLen(ev: DriveEvent): number {
  return ev.kind === 'swarm' ? DRIVE_SWARM_LEN : ev.kind === 'station' ? DRIVE_STATION_LEN : 0;
}

/** 车头前方仍相关的事件（未完全驶过），最多下发 6 个 */
function liveEvents(state: DriveState): DriveEvent[] {
  return state.road.events.filter((ev) => ev.at + windowLen(ev) > state.pos).slice(0, 6);
}

export function createDriveGame(players: DrivePlayerInit[], now: number, opts: DriveOptions = {}, rng: Rng = Math.random): DriveState {
  const seated = [...players].sort((a, b) => a.seat - b.seat).slice(0, 4);
  const signGap = resolveSignGap(opts.signGap);
  const durability = resolveDurability(opts.durability);
  const state: DriveState = {
    phase: 'driving',
    players: seated.map((p) => ({ id: p.id, name: p.name, seat: p.seat, downed: false, left: false, loots: 0, dragged: 0 })),
    road: {
      generatedTo: DRIVE_EVENT_FIRST_AT,
      nextStationAt: DRIVE_STATION_GAP_BASE + Math.floor(rng() * 200),
      events: [],
    },
    speed: 0,
    lane: 1,
    laneChangedAt: 0,
    fuel: DRIVE_FUEL_MAX,
    durability,
    maxDurability: durability,
    lastTickAt: now,
    gap: DRIVE_GAP_MAX,
    pos: 0,
    signs: 0,
    nextSignAt: signGap,
    windows: { L: blankWindow(), R: blankWindow() },
    lamp: true,
    inputs: {},
    pings: [],
    nextCrawlAt: now + DRIVE_CRAWL_FIRST_MS,
    attacks: 0,
    crawls: 0,
    signGap,
    tail: resolveTail(opts.tail),
    crawlRate: resolveCrawl(opts.crawl),
    targetSigns: resolveTarget(opts.target),
    startedAt: now,
    result: null,
    log: [],
    logSeq: 0,
  };
  generateEvents(state, rng);
  pushLog(state, 'sys', `夜路开始了：别停（${state.signGap}m/牌${state.targetSigns > 0 ? ` · 目标 ${state.targetSigns} 号路牌` : ' · 无尽'}）`);
  return state;
}

/* ---------------- 事件生成 ---------------- */

function generateEvents(state: DriveState, rng: Rng): void {
  while (state.road.generatedTo < state.pos + DRIVE_EVENT_HORIZON) {
    const at = state.road.generatedTo;
    if (at >= state.road.nextStationAt) {
      state.road.events.push({ at, kind: 'station', side: rng() < 0.5 ? 'L' : 'R' });
      state.road.nextStationAt = at + DRIVE_STATION_GAP_BASE + Math.floor(rng() * 200);
    } else {
      const r = rng();
      if (r < 0.34) {
        const ev: DriveEvent = { at, kind: 'barrier', lane: LANES[Math.floor(rng() * LANES.length)] };
        // tier 3 起可能出现双车道路障（留一条活路）
        if (state.signs >= 3 && rng() < 0.4) {
          const rest = LANES.filter((l) => l !== ev.lane);
          ev.lane2 = rest[Math.floor(rng() * rest.length)];
        }
        state.road.events.push(ev);
      } else if (r < 0.54) {
        const a = Math.floor(rng() * LANES.length);
        const rest = LANES.filter((l) => l !== a);
        state.road.events.push({
          at,
          kind: 'swarm',
          lane: LANES[a]!,
          lane2: rest[Math.floor(rng() * rest.length)],
        });
      } else {
        state.road.events.push({
          at,
          kind: 'loot',
          side: rng() < 0.5 ? 'L' : 'R',
          content: rng() < DRIVE_LOOT_REPAIR_CHANCE ? 'repair' : 'fuel',
        });
      }
    }
    state.road.generatedTo = at + DRIVE_EVENT_GAP_MIN + rng() * (DRIVE_EVENT_GAP_MAX - DRIVE_EVENT_GAP_MIN);
  }
}

/* ---------------- 意图 ---------------- */

function aliveInCar(state: DriveState, id: string): boolean {
  const p = findPlayer(state, id);
  return !!p && !p.left && !p.downed && state.phase === 'driving';
}

function ensureInputs(state: DriveState, id: string): DriveInputs {
  let inp = state.inputs[id];
  if (!inp) {
    inp = { gas: false, brake: false, spot: false };
    state.inputs[id] = inp;
  }
  return inp;
}

/**
 * 按键意图（仅 drivable 玩家）：持键置位/清除，边沿立即生效。
 * 非法值静默丢弃，返回 true=状态有变化。高频通道不抛错（同 dStroke 三不口径）。
 */
export function driveIntent(state: DriveState, playerId: string, raw: unknown, now: number, rng: Rng = Math.random): boolean {
  if (state.phase !== 'driving' || !aliveInCar(state, playerId)) return false;
  if (raw == null || typeof raw !== 'object') return false;
  const it = raw as Record<string, unknown>;
  switch (it.k) {
    case 'gas':
    case 'brake':
    case 'spot': {
      ensureInputs(state, playerId)[it.k] = it.on === true;
      return true;
    }
    case 'lane': {
      const dir = it.dir === -1 ? -1 : it.dir === 1 ? 1 : 0;
      if (!dir) return false;
      if (now - state.laneChangedAt < DRIVE_LANE_COOLDOWN_MS) return false;
      const next = Math.min(2, Math.max(0, state.lane + dir));
      if (next === state.lane) return false;
      state.lane = next as 0 | 1 | 2;
      state.laneChangedAt = now;
      return true;
    }
    case 'window': {
      const side = it.side === 'L' || it.side === 'R' ? it.side : null;
      if (!side) return false;
      const w = state.windows[side];
      if (w.open) {
        // 关窗：顺带挫败该侧正在进行的爬窗（预警/爬入中拉上窗都来得及——这就是「快关窗！」）
        w.open = false;
        w.opener = null;
        w.warnAt = 0;
        w.climbDeadline = 0;
        scheduleNextCrawl(state, now, rng);
        return true;
      }
      w.open = true;
      w.opener = playerId;
      return true;
    }
    case 'lamp': {
      state.lamp = !state.lamp;
      return true;
    }
    case 'ping': {
      const lane = typeof it.lane === 'number' && Number.isInteger(it.lane) ? Math.min(2, Math.max(0, Math.round(it.lane))) : null;
      const at = typeof it.at === 'number' && Number.isFinite(it.at) ? Math.max(0, Math.round(it.at)) : null;
      if (lane == null || at == null) return false;
      const me = findPlayer(state, playerId)!;
      state.pings.push({ lane, at, ts: now, by: me.name });
      if (state.pings.length > 8) state.pings.splice(0, state.pings.length - 8);
      return true;
    }
    default:
      return false;
  }
}

/* ---------------- 爬窗调度 ---------------- */

function scheduleNextCrawl(state: DriveState, now: number, rng: Rng): void {
  const tierMult = Math.min(DRIVE_CRAWL_TIER_CAP, 1 + DRIVE_CRAWL_TIER_SCALE * state.signs);
  const lampMult = state.lamp ? DRIVE_CRAWL_LAMP_MULT : 1;
  const rateMult = DRIVE_CRAWL_RATE_MULT[state.crawlRate];
  const base = DRIVE_CRAWL_BASE_MS / (rateMult * tierMult * lampMult);
  const jitter = 0.75 + rng() * 0.5;
  state.nextCrawlAt = now + Math.min(DRIVE_CRAWL_MAX_MS, Math.max(DRIVE_CRAWL_MIN_MS, base * jitter));
}

/** 任意一侧爬窗事件进行中（预警或爬入计时） */
function anyCrawlActive(state: DriveState): boolean {
  return state.windows.L.warnAt > 0 || state.windows.R.warnAt > 0 || state.windows.L.climbDeadline > 0 || state.windows.R.climbDeadline > 0;
}

function tickCrawlers(state: DriveState, now: number, rng: Rng): boolean {
  // 同一时间只进行一只窗爬者：另一侧未结束时顺延（nextCrawlAt 停在过去时刻，下拍重试）
  if (state.nextCrawlAt > 0 && now >= state.nextCrawlAt && !anyCrawlActive(state)) {
    const open = (['L', 'R'] as DriveSide[]).filter((s) => state.windows[s].open);
    if (open.length === 0) {
      // 没有开着的窗就没得爬：短延迟重试，等玩家开窗（「开窗搜掠」的风险由此而来）
      state.nextCrawlAt = now + 2_000;
    } else {
      const side = open[Math.floor(rng() * open.length)]!;
      state.windows[side].warnAt = now;
      state.nextCrawlAt = 0;
      return true;
    }
  }
  let changed = false;
  for (const side of ['L', 'R'] as DriveSide[]) {
    const w = state.windows[side];
    if (w.warnAt > 0 && now - w.warnAt >= DRIVE_WARN_MS) {
      w.warnAt = 0;
      w.climbDeadline = now + DRIVE_CLIMB_MS;
      changed = true;
    }
    if (w.climbDeadline > 0 && now >= w.climbDeadline) {
      resolveCrawlEvent(state, side, now, rng);
      changed = true;
    }
  }
  return changed;
}

/** 破窗结算：有活着的开窗者 → 拖走；无人值守 → 直接扣车耐久；窗已被关上 → 无事发生 */
function resolveCrawlEvent(state: DriveState, side: DriveSide, now: number, rng: Rng): void {
  const w = state.windows[side];
  if (!w.open) {
    // 防御：爬入计时只应由「关窗意图」挫败，走到这里说明窗已在别处被关上
    w.climbDeadline = 0;
    scheduleNextCrawl(state, now, rng);
    return;
  }
  state.crawls += 1;
  const opener = w.opener ? findPlayer(state, w.opener) : undefined;
  if (opener && !opener.left && !opener.downed) {
    opener.downed = true;
    opener.dragged += 1;
    pushLog(state, 'sys', `${opener.name} 被${side === 'L' ? '左' : '右'}侧的窗爬者拖出了车外！`);
  } else {
    state.durability -= 1;
    pushLog(state, 'sys', `窗爬者破窗而入，车耐久 -1（${state.durability}/${state.maxDurability}）`);
  }
  w.open = false;
  w.opener = null;
  w.warnAt = 0;
  w.climbDeadline = 0;
  scheduleNextCrawl(state, now, rng);
}

/* ---------------- 事件消费 ---------------- */

/** 通过路牌：tier+1、复活被拖走者（离场者不复活） */
function passSign(state: DriveState, now: number): boolean {
  state.signs += 1;
  let revived = 0;
  for (const p of state.players) {
    if (p.downed && !p.left) {
      p.downed = false;
      revived += 1;
    }
  }
  pushLog(state, 'sys', `路牌 ${state.signs} · ${Math.floor(state.pos)}m${revived > 0 ? `（${revived} 人回到车上）` : ''}`);
  state.nextSignAt += state.signGap;
  return true;
}

function consumeEvents(state: DriveState, prevPos: number, dtSec: number, rng: Rng): boolean {
  let changed = false;
  for (const ev of state.road.events) {
    if (ev.at > state.pos + DRIVE_EVENT_HORIZON) break;
    switch (ev.kind) {
      case 'barrier': {
        if (!ev.hit && prevPos < ev.at && state.pos >= ev.at) {
          ev.hit = true;
          if (state.lane === ev.lane || (ev.lane2 != null && state.lane === ev.lane2)) {
            state.speed = Math.max(0, state.speed * DRIVE_BARRIER_SLOW);
            state.gap = Math.max(0, state.gap - DRIVE_GAP_NOISE);
            state.durability -= 1;
            pushLog(state, 'sys', `撞上路障！车耐久 -1（${state.durability}/${state.maxDurability}）`);
            changed = true;
          }
        }
        break;
      }
      case 'swarm': {
        if (
          !ev.hit &&
          state.pos >= ev.at &&
          state.pos <= ev.at + DRIVE_SWARM_LEN &&
          (state.lane === ev.lane || (ev.lane2 != null && state.lane === ev.lane2)) &&
          state.speed >= DRIVE_SWARM_MIN_SPEED
        ) {
          ev.hit = true;
          state.speed = Math.max(0, state.speed * DRIVE_SWARM_SLOW);
          state.gap = Math.max(0, state.gap - DRIVE_GAP_NOISE);
          pushLog(state, 'sys', '碾过尸群——引擎的轰鸣引来了后面那个东西');
          changed = true;
        }
        break;
      }
      case 'loot': {
        if (!ev.hit && prevPos < ev.at && state.pos >= ev.at) {
          ev.hit = true;
          const w = state.windows[ev.side!];
          if (w.open && state.speed <= DRIVE_LOOT_MAX_SPEED) {
            const opener = w.opener ? findPlayer(state, w.opener) : undefined;
            if (ev.content === 'repair') {
              state.durability = Math.min(state.maxDurability, state.durability + 1);
              pushLog(state, 'sys', `搜到修补工具：车耐久 ${state.durability}/${state.maxDurability}`);
            } else {
              state.fuel = Math.min(DRIVE_FUEL_MAX, state.fuel + DRIVE_LOOT_FUEL_MIN + Math.floor(rng() * (DRIVE_LOOT_FUEL_MAX - DRIVE_LOOT_FUEL_MIN + 1)));
              pushLog(state, 'sys', `搜到一桶油：油量 ${Math.round(state.fuel)}%`);
            }
            if (opener && !opener.left) opener.loots += 1;
            changed = true;
          }
        }
        break;
      }
      case 'station': {
        if (state.pos >= ev.at && state.pos <= ev.at + DRIVE_STATION_LEN && state.speed < DRIVE_STATION_MAX_SPEED && state.fuel < DRIVE_FUEL_MAX) {
          state.fuel = Math.min(DRIVE_FUEL_MAX, state.fuel + DRIVE_STATION_FUEL_RATE * dtSec);
          changed = true;
        }
        break;
      }
    }
  }
  // 清掉已完全驶过的事件（防队列无限增长）
  if (state.road.events.length > 12) {
    state.road.events = state.road.events.filter((ev) => ev.at + windowLen(ev) > state.pos - 20);
  }
  return changed;
}

/* ---------------- 终局 ---------------- */

function finish(state: DriveState, reason: NonNullable<DriveState['result']>['reason'], now: number): void {
  state.phase = 'gameover';
  state.result = {
    reason,
    distance: Math.floor(state.pos),
    signs: state.signs,
    durationMs: Math.max(0, now - state.startedAt),
    attacks: state.attacks,
    crawls: state.crawls,
    loots: state.players.reduce((s, p) => s + p.loots, 0),
  };
  const m = Math.floor(state.result.distance);
  if (reason === 'won') {
    pushLog(state, 'win', `全员逃出夜路！${state.signs} 号路牌 · ${m}m`);
  } else if (reason === 'dead') {
    pushLog(state, 'win', `车毁人亡：坚持到了 ${state.signs} 号路牌 · ${m}m`);
  } else {
    pushLog(state, 'sys', `本局结束：${m}m · ${state.signs} 号路牌`);
  }
}

/** 房主终止 */
export function driveAbort(state: DriveState, now: number): boolean {
  if (state.phase === 'gameover') return false;
  finish(state, 'abort', now);
  return true;
}

/** 全员断线就地终局（宽限期由 rooms 层控制） */
export function driveForceEnd(state: DriveState, now: number): boolean {
  if (state.phase === 'gameover') return false;
  finish(state, 'idle', now);
  return true;
}

/** 玩家中途离开：清输入、清开窗归因，留在结算里；无人在车上则终局 */
export function driveLeave(state: DriveState, playerId: string, now: number): boolean {
  if (state.phase === 'gameover') return false;
  const p = findPlayer(state, playerId);
  if (!p || p.left) return false;
  p.left = true;
  p.downed = false;
  const inp = state.inputs[playerId];
  if (inp) {
    inp.gas = false;
    inp.brake = false;
    inp.spot = false;
  }
  for (const w of [state.windows.L, state.windows.R]) {
    if (w.opener === playerId) w.opener = null;
  }
  pushLog(state, 'sys', `${p.name} 离开了对局`);
  if (!state.players.some((x) => !x.left)) {
    finish(state, 'leave', now);
  }
  return true;
}

/* ---------------- 主循环 ---------------- */

/**
 * 时间驱动（rooms 层 66ms 一拍）：dt 积分车速/油量/里程，猎影尾压、爬窗、
 * 事件消费、路牌、耐久与胜负判定。返回 true=状态有变化（drive 中恒 true，gameover 后恒 false）。
 */
export function driveTick(state: DriveState, now: number, connectedIds: ReadonlySet<string>, rng: Rng = Math.random): boolean {
  if (state.phase === 'gameover') return false;
  const dtMs = Math.min(DRIVE_MAX_DT_MS, Math.max(0, now - state.lastTickAt));
  state.lastTickAt = now;
  const dtSec = dtMs / 1000;
  if (dtMs === 0) return false;

  // 断线玩家的持键清零（重连后由客户端重新上报），被拖走/离场者不响应
  for (const [id, inp] of Object.entries(state.inputs)) {
    const p = findPlayer(state, id);
    if (!p || p.left || p.downed || !connectedIds.has(id)) {
      inp.gas = false;
      inp.brake = false;
      inp.spot = false;
    }
  }
  const drivable = state.players.filter((p) => !p.left && !p.downed && connectedIds.has(p.id));
  const held = (k: keyof DriveInputs): boolean => drivable.some((p) => state.inputs[p.id]?.[k] === true);

  // 瞭望标记只留 5s 内的（广播瘦身：过期 ping 不再随每帧视图重复下发）
  if (state.pings.length > 0) {
    state.pings = state.pings.filter((p) => now - p.ts < 5_000);
  }

  const prevPos = state.pos;

  // 车速：刹车优先于油门；空油时油门失效且速度上限锁死
  const braking = held('brake');
  const gassing = !braking && held('gas') && state.fuel > 0;
  if (braking) state.speed = Math.max(0, state.speed - DRIVE_BRAKE * dtSec);
  else if (gassing) state.speed = Math.min(DRIVE_MAX_SPEED, state.speed + DRIVE_ACCEL * dtSec);
  else state.speed = Math.max(0, state.speed - DRIVE_COAST * dtSec);
  if (state.fuel <= 0) state.speed = Math.min(state.speed, DRIVE_EMPTY_MAX_SPEED);

  // 油耗
  if (state.fuel > 0) {
    state.fuel = Math.max(0, state.fuel - (DRIVE_FUEL_BURN_BASE + DRIVE_FUEL_BURN_SCALE * (state.speed / DRIVE_MAX_SPEED)) * dtSec);
  }

  // 里程
  state.pos += (state.speed / 3.6) * dtSec;
  generateEvents(state, rng);

  // 猎影尾压
  const drain = DRIVE_TAIL_DRAIN[state.tail] ?? DRIVE_GAP_DRAIN;
  if (state.speed >= DRIVE_IDLE_LINE) state.gap = Math.min(DRIVE_GAP_MAX, state.gap + DRIVE_GAP_REGEN * dtSec);
  else state.gap = Math.max(0, state.gap - drain * dtSec);
  if (state.gap <= 0) {
    state.attacks += 1;
    state.durability -= 1;
    state.gap = DRIVE_ATTACK_RESET;
    pushLog(state, 'sys', `猎影追上了车尾！车耐久 -1（${state.durability}/${state.maxDurability}）`);
  }

  const changed = consumeEvents(state, prevPos, dtSec, rng) || tickCrawlers(state, now, rng);

  // 路牌（while：dt 大或间隔小可能一次跨两块）
  while (state.phase === 'driving' && state.pos >= state.nextSignAt) {
    passSign(state, now);
    if (state.targetSigns > 0 && state.signs >= state.targetSigns) {
      finish(state, 'won', now);
      return true;
    }
  }

  // 车毁人亡
  if (state.durability <= 0) {
    finish(state, 'dead', now);
    return true;
  }
  return true;
}

/* ---------------- 视图 ---------------- */

/**
 * 会话视图：车辆状态全队公开（共乘一辆车没有秘密），按会话裁剪的只有
 * 自己的持键状态与被拖走标记；观战者/局中入座者 spectator=true。
 */
export function buildDriveView(
  state: DriveState,
  viewerId: string,
  roomCode: string,
  hostIdOf: string,
  connectedIds: ReadonlySet<string>,
  now: number = Date.now(),
): DriveView {
  const me = findPlayer(state, viewerId);
  const spectator = !me || me.left;
  const win = (w: DriveState['windows']['L']) => ({
    open: w.open,
    warn: w.warnAt > 0 || w.climbDeadline > 0,
    climbLeft: w.climbDeadline > 0 ? Math.max(0, w.climbDeadline - now) : null,
  });
  return {
    kind: 'drive',
    mode: 'drive',
    code: roomCode,
    hostId: hostIdOf,
    phase: state.phase,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      downed: p.downed,
      left: p.left,
      connected: connectedIds.has(p.id),
      isHost: p.id === hostIdOf,
      loots: p.loots,
      dragged: p.dragged,
    })),
    speed: state.speed,
    lane: state.lane,
    fuel: state.fuel,
    durability: state.durability,
    maxDurability: state.maxDurability,
    gap: state.gap,
    pos: state.pos,
    signs: state.signs,
    targetSigns: state.targetSigns,
    signGap: state.signGap,
    tail: state.tail,
    crawlRate: state.crawlRate,
    windows: { L: win(state.windows.L), R: win(state.windows.R) },
    lamp: state.lamp,
    events: liveEvents(state),
    pings: [...state.pings],
    myInputs: me && !spectator && !me.downed && state.phase === 'driving' ? { ...(state.inputs[me.id] ?? { gas: false, brake: false, spot: false }) } : null,
    iDowned: !!me && me.downed,
    spectator,
    serverTime: now,
    startedAt: state.startedAt,
    result: state.result,
    log: state.log,
    logSeq: state.logSeq,
  };
}
