/**
 * 勿停（drive）· 对局引擎 v2（服务端权威，服务器模拟制）
 *
 * 规则口径（rulebook/RULES-DRIVE.md）：
 * - 1-4 人共乘一辆车行驶在无尽夜路上，客户端只发按键意图（vInt），本引擎 15Hz 模拟一切；
 * - 真弯道：道路由曲率序列描述，车有横向位置与车头相对角——按住方向键转车头（松键回正），
 *   弯道把车往外甩，不打方向就冲出路面（路肩减速+刮擦噪音）乃至撞护栏（耐久 -1）；
 * - 车速低于勿停线喂养「猎影」（尾压），归零即撞损车尾；噪音事件额外喂养；
 * - 岗位：驾驶员（油门/刹车/转向）与副驾驶（车窗/大灯/标记/喊话）；单人局一人全占；
 * - 开窗才能搜掠路肩补给，但窗爬者会爬开着的窗；破窗时拖走当前开窗者，无人开窗则扣车耐久；
 * - 夜行者：平时在路上游荡；车一停稳，惊动范围内的全部冲向车，追上即扒车撕扯（持续扣耐久），
 *   扒车侧车窗开着则爬进来；车速到达甩脱线全部甩飞、没追上的放弃回位；
 * - 加油站要停稳才加得到油——每次加油都是一次赌博；
 * - targetSigns>0 时到达即全员逃生成功；纯无尽只有距离与路牌数。
 * 约定同其他引擎：纯函数直接修改传入 state，now/rng 由调用方注入；返回 boolean=有无变化。
 * 意图消息非法值一律静默钳制/丢弃（高频通道不报错，同 dStroke 口径）。
 */
import type { LogLine } from '@shared/protocol';
import {
  DRIVE_ACCEL,
  DRIVE_ATTACK_RESET,
  DRIVE_BARRIER_HALF,
  DRIVE_BARRIER_SLOW,
  DRIVE_BRAKE,
  DRIVE_CALLS,
  DRIVE_CALL_COOLDOWN_MS,
  DRIVE_CALL_TTL_MS,
  DRIVE_CLIMB_MS,
  DRIVE_COAST,
  DRIVE_CRASH_COOLDOWN_MS,
  DRIVE_CRASH_SLOW,
  DRIVE_CRAWL_BASE_MS,
  DRIVE_CRAWL_FIRST_MS,
  DRIVE_CRAWL_LAMP_MULT,
  DRIVE_CRAWL_MAX_MS,
  DRIVE_CRAWL_MIN_MS,
  DRIVE_CRAWL_OPTIONS,
  DRIVE_CRAWL_RATE_MULT,
  DRIVE_CRAWL_TIER_CAP,
  DRIVE_CRAWL_TIER_SCALE,
  DRIVE_CURVE_AHEAD_M,
  DRIVE_CURVE_CHAIN_MAX,
  DRIVE_CURVE_FIRST_STRAIGHT,
  DRIVE_CURVE_MULT,
  DRIVE_CURVE_OPTIONS,
  DRIVE_DEFAULT_CRAWL,
  DRIVE_DEFAULT_CURVE,
  DRIVE_DEFAULT_DURABILITY,
  DRIVE_DEFAULT_SIGN_GAP,
  DRIVE_DEFAULT_TARGET,
  DRIVE_DEFAULT_TAIL,
  DRIVE_DURABILITY_OPTIONS,
  DRIVE_EMPTY_MAX_SPEED,
  DRIVE_ESCAPE_SPEED,
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
  DRIVE_GUARD_M,
  DRIVE_HIT_HALF,
  DRIVE_HIT_SPEED,
  DRIVE_HUNT_RANGE,
  DRIVE_HUNT_SPEED,
  DRIVE_IDLE_LINE,
  DRIVE_LATCH_CLIMB_MS,
  DRIVE_LATCH_DLAT,
  DRIVE_LATCH_DRAG,
  DRIVE_LATCH_DS,
  DRIVE_LOOT_FUEL_MAX,
  DRIVE_LOOT_FUEL_MIN,
  DRIVE_LOOT_MAX_SPEED,
  DRIVE_LOOT_REPAIR_CHANCE,
  DRIVE_MAX_DT_MS,
  DRIVE_MAX_SPEED,
  DRIVE_MAUL_EVERY_MS,
  DRIVE_MAUL_FIRST_MS,
  DRIVE_MONSTER_FIRST_MIN,
  DRIVE_MONSTER_FIRST_SPAN,
  DRIVE_MONSTER_GAP_BASE,
  DRIVE_MONSTER_GAP_MIN,
  DRIVE_MONSTER_GAP_TIER,
  DRIVE_MONSTER_LAT_MAX,
  DRIVE_MONSTER_PAIR_CHANCE,
  DRIVE_MONSTER_PAIR_TIER,
  DRIVE_MONSTER_RUN,
  DRIVE_MONSTER_RUN_TIER,
  DRIVE_MONSTER_RUN_TIER_CAP,
  DRIVE_MONSTER_WALK,
  DRIVE_PING_TTL_MS,
  ROAD_HALF_M,
  DRIVE_SHOULDER_GAP,
  DRIVE_SHOULDER_DRAG,
  DRIVE_SIGN_GAP_OPTIONS,
  DRIVE_STATION_FUEL_RATE,
  DRIVE_STATION_GAP_BASE,
  DRIVE_STATION_LEN,
  DRIVE_STATION_MAX_SPEED,
  DRIVE_SWARM_HALF,
  DRIVE_SWARM_LEN,
  DRIVE_SWARM_MIN_SPEED,
  DRIVE_SWARM_SLOW,
  DRIVE_TAIL_DRAIN,
  DRIVE_TAIL_OPTIONS,
  DRIVE_TARGET_OPTIONS,
  DRIVE_THROW_MS,
  DRIVE_WARN_MS,
  LANE_W_M,
  curvatureAt,
  stepSteering,
  type DriveCall,
  type DriveCrawlRate,
  type DriveCurveSetting,
  type DriveEvent,
  type DriveIntent,
  type DriveInputs,
  type DriveMonsterState,
  type DrivePing,
  type DrivePlayerState,
  type DriveRole,
  type DriveSide,
  type DriveState,
  type DriveTail,
  type DriveView,
  type DriveViewMonster,
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
  /** 弯道凶度 */
  curves?: DriveCurveSetting;
}

export type Rng = () => number;

/** 日志只留尾部：无尽模式日志持续增长，全量下发会随时间膨胀 */
const LOG_MAX = 120;
const SIDES: readonly DriveSide[] = ['L', 'R'];
const BARRIER_LATS: readonly number[] = [-LANE_W_M, 0, LANE_W_M];
/** 视图里下发夜行者/弯道的范围（副驾驶地图前方 400m） */
const MONSTER_VIEW_BACK = 160;
const MONSTER_VIEW_AHEAD = 480;
const CURVE_VIEW_BACK = 130;
const CURVE_VIEW_AHEAD = 450;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

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
export function resolveCurveSetting(raw: DriveCurveSetting | undefined): DriveCurveSetting {
  return raw != null && DRIVE_CURVE_OPTIONS.includes(raw) ? raw : DRIVE_DEFAULT_CURVE;
}

function blankWindow(): DriveState['windows']['L'] {
  return { open: false, opener: null, warnAt: 0, climbDeadline: 0 };
}

function pushLog(state: DriveState, kind: LogLine['kind'], text: string): void {
  state.log.push({ seq: ++state.logSeq, kind, text });
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
}

function findPlayer(state: DriveState, id: string): DrivePlayerState | undefined {
  return state.players.find((p) => p.id === id);
}

/** 单人局（在场玩家 ≤1）：一人全占，驾驶与导航权限皆有 */
export function isSolo(state: DriveState): boolean {
  return state.players.filter((p) => !p.left).length <= 1;
}

function eventLen(ev: DriveEvent): number {
  return ev.kind === 'swarm' ? DRIVE_SWARM_LEN : ev.kind === 'station' ? DRIVE_STATION_LEN : 0;
}

/** 车头附近未消费的事件 */
function liveEvents(state: DriveState): DriveEvent[] {
  return state.road.events.filter((ev) => ev.at + eventLen(ev) > state.pos - 10 && ev.at < state.pos + MONSTER_VIEW_AHEAD).slice(0, 10);
}

/**
 * 全体驾驶员的持键汇总（刹车/油门取或，转向求和钳 -1..1）。
 * 只计在场、未被拖走、在线且（非单人局时）在驾驶位的玩家。
 */
export function aggregateInputs(state: DriveState, connectedIds: ReadonlySet<string>): DriveInputs {
  const solo = isSolo(state);
  let gas = false;
  let brake = false;
  let steer = 0;
  for (const p of state.players) {
    if (p.left || p.downed || !connectedIds.has(p.id) || (!solo && p.role !== 'drive')) continue;
    const inp = state.inputs[p.id];
    if (!inp) continue;
    gas = gas || inp.gas;
    brake = brake || inp.brake;
    steer += inp.steer;
  }
  return { gas, brake, steer: clamp(steer, -1, 1) as -1 | 0 | 1 };
}

export function createDriveGame(players: DrivePlayerInit[], now: number, opts: DriveOptions = {}, rng: Rng = Math.random): DriveState {
  const seated = [...players].sort((a, b) => a.seat - b.seat).slice(0, 4);
  const signGap = resolveSignGap(opts.signGap);
  const durability = resolveDurability(opts.durability);
  const state: DriveState = {
    phase: 'driving',
    // 岗位默认：座位最靠前的是驾驶员，其余副驾驶
    players: seated.map((p, i) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      downed: false,
      left: false,
      loots: 0,
      dragged: 0,
      role: (i === 0 ? 'drive' : 'navigate') as DriveRole,
    })),
    road: {
      generatedTo: DRIVE_EVENT_FIRST_AT,
      nextStationAt: DRIVE_STATION_GAP_BASE + Math.floor(rng() * 200),
      nextMonsterAt: signGap + DRIVE_MONSTER_FIRST_MIN + rng() * DRIVE_MONSTER_FIRST_SPAN, // 第一只在第一块路牌之后
      events: [],
      curves: [],
      curvesTo: DRIVE_CURVE_FIRST_STRAIGHT,
      chainTurn: 0,
    },
    monsters: [],
    monsterSeq: 0,
    speed: 0,
    lateral: 0,
    rel: 0,
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
    pingSeq: 0,
    calls: [],
    callSeq: 0,
    callAt: {},
    nextCrawlAt: now + DRIVE_CRAWL_FIRST_MS,
    attacks: 0,
    crawls: 0,
    mauls: 0,
    maulAt: 0,
    offRoad: false,
    crashAt: 0,
    moved: false,
    signGap,
    tail: resolveTail(opts.tail),
    crawlRate: resolveCrawl(opts.crawl),
    curveSetting: resolveCurveSetting(opts.curves),
    targetSigns: resolveTarget(opts.target),
    startedAt: now,
    result: null,
    log: [],
    logSeq: 0,
  };
  generateCurves(state, rng);
  generateEvents(state, rng);
  pushLog(state, 'sys', `夜路开始了：别停（${state.signGap}m/牌${state.targetSigns > 0 ? ` · 目标 ${state.targetSigns} 号路牌` : ' · 无尽'}）`);
  return state;
}

/* ---------------- 弯道生成 ---------------- */

/**
 * 弯道序列惰性生成（车头前方 900m）：直道 110-230m，弯道 80-180m，半径随路牌数递减（210→115m）。
 * 65% 概率交替换向；同向连续弯道的总转角不超过上限（保证前方道路始终落在副驾驶地图里）。
 */
function generateCurves(state: DriveState, rng: Rng): void {
  const mult = DRIVE_CURVE_MULT[state.curveSetting];
  const road = state.road;
  while (road.curvesTo < state.pos + DRIVE_CURVE_AHEAD_M) {
    const at = road.curvesTo + 110 + rng() * 120;
    const len = 80 + rng() * 100;
    const radius = Math.max(115, 210 - 14 * state.signs) * (0.85 + rng() * 0.3);
    const turn = (len * mult) / radius;
    const prev = road.curves[road.curves.length - 1];
    let dir: number;
    if (!prev) dir = rng() < 0.5 ? -1 : 1;
    else {
      const prevDir = Math.sign(prev.k);
      const same = rng() >= 0.65 && Math.abs(road.chainTurn + prevDir * turn) <= DRIVE_CURVE_CHAIN_MAX;
      dir = same ? prevDir : -prevDir;
    }
    road.chainTurn = Math.sign(road.chainTurn) === dir ? road.chainTurn + dir * turn : dir * turn;
    road.curves.push({ at, len, k: (dir * mult) / radius });
    road.curvesTo = at + len;
  }
  // 已驶过很远的弯道移除（留 500m 余量：客户端后视镜/地图还要画身后的路）
  if (road.curves.length > 24) road.curves = road.curves.filter((c) => c.at + c.len > state.pos - 500);
}

/* ---------------- 事件生成 ---------------- */

/** 放一只夜行者（在路上缓慢横移的那个点；位置与游荡参数由 rng 决定） */
function spawnMonster(state: DriveState, at: number, rng: Rng): void {
  state.monsters.push({
    id: ++state.monsterSeq,
    home: at,
    at,
    lat: 0,
    center: clamp((rng() - 0.5) * 5, -2.5, 2.5),
    amp: 1.5 + rng() * 1.5,
    w: (2 * Math.PI) / (12 + rng() * 13),
    phase: rng() * 2 * Math.PI,
    mode: 'wander',
    side: null,
    climbSince: 0,
    thrownAt: 0,
    vs: 0,
    vx: 0,
  });
}

function generateEvents(state: DriveState, rng: Rng): void {
  while (state.road.generatedTo < state.pos + DRIVE_EVENT_HORIZON) {
    const at = state.road.generatedTo;
    if (at >= state.road.nextStationAt) {
      state.road.events.push({ at, kind: 'station', side: rng() < 0.5 ? 'L' : 'R' });
      state.road.nextStationAt = at + DRIVE_STATION_GAP_BASE + Math.floor(rng() * 200);
    } else {
      const r = rng();
      if (r < 0.34) {
        // 路障：占一条车道；tier 3 起 35% 是横跨两条车道的宽路障（留一条活路）
        const wide = state.signs >= 3 && rng() < 0.35;
        state.road.events.push({ at, kind: 'barrier', lat: BARRIER_LATS[wide ? 1 : Math.floor(rng() * BARRIER_LATS.length)]!, half: wide ? 3.4 : 1.3 });
      } else if (r < 0.54) {
        // 尸群带：横跨两条车道（左+中 或 中+右）
        state.road.events.push({ at, kind: 'swarm', lat: rng() < 0.5 ? -LANE_W_M / 2 : LANE_W_M / 2, half: DRIVE_SWARM_HALF });
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
  // 夜行者走独立的生成流（不与路障/搜掠抢事件槽——那样密度太低，停车加油时方圆 90m 内常常一只都没有）。
  // 难度按「车开到这里时已过了几块路牌」算：间隔随路牌数缩短，第 4 号路牌起会成对出现
  while (state.road.nextMonsterAt < state.pos + DRIVE_EVENT_HORIZON) {
    const at = state.road.nextMonsterAt;
    const tierHere = at >= state.nextSignAt ? state.signs + 1 : state.signs;
    spawnMonster(state, at, rng);
    if (tierHere >= DRIVE_MONSTER_PAIR_TIER && rng() < DRIVE_MONSTER_PAIR_CHANCE) spawnMonster(state, at + 12 + rng() * 18, rng);
    state.road.nextMonsterAt =
      at + Math.max(DRIVE_MONSTER_GAP_MIN, DRIVE_MONSTER_GAP_BASE - DRIVE_MONSTER_GAP_TIER * tierHere) * (0.7 + rng() * 0.6);
  }
}

/* ---------------- 意图 ---------------- */

function alivePlayer(state: DriveState, id: string): DrivePlayerState | undefined {
  const p = findPlayer(state, id);
  return p && !p.left && !p.downed ? p : undefined;
}

function ensureInputs(state: DriveState, id: string): DriveInputs {
  let inp = state.inputs[id];
  if (!inp) {
    inp = { gas: false, brake: false, steer: 0 };
    state.inputs[id] = inp;
  }
  return inp;
}

/**
 * 按键意图（仅在场玩家）：持键置位/清除，边沿立即生效；按岗位校验权限（单人局全放行）。
 * 非法值静默丢弃，返回 true=状态有变化。高频通道不抛错（同 dStroke 三不口径）。
 */
export function driveIntent(state: DriveState, playerId: string, raw: unknown, now: number, rng: Rng = Math.random): boolean {
  if (state.phase !== 'driving') return false;
  const p = alivePlayer(state, playerId);
  if (!p || raw == null || typeof raw !== 'object') return false;
  const it = raw as Record<string, unknown>;
  const solo = isSolo(state);
  const asDriver = solo || p.role === 'drive';
  const asNavigator = solo || p.role === 'navigate';
  switch (it.k) {
    case 'gas':
    case 'brake': {
      if (!asDriver) return false;
      const inp = ensureInputs(state, playerId);
      const on = it.on === true;
      if (inp[it.k as 'gas' | 'brake'] === on) return false;
      inp[it.k as 'gas' | 'brake'] = on;
      return true;
    }
    case 'steer': {
      if (!asDriver) return false;
      const dir = it.dir === -1 ? -1 : it.dir === 1 ? 1 : it.dir === 0 ? 0 : null;
      if (dir == null) return false;
      const inp = ensureInputs(state, playerId);
      if (inp.steer === dir) return false;
      inp.steer = dir as -1 | 0 | 1;
      return true;
    }
    case 'window': {
      if (!asNavigator) return false;
      const side = it.side === 'L' || it.side === 'R' ? it.side : null;
      if (!side) return false;
      const w = state.windows[side];
      if (w.open) {
        // 关窗：顺带挫败该侧正在进行的爬窗/夜行者爬入（预警/计时中拉上窗都来得及——这就是「快关窗！」）
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
      if (!asNavigator) return false;
      state.lamp = !state.lamp;
      return true;
    }
    case 'ping': {
      if (!asNavigator) return false;
      const at = typeof it.at === 'number' && Number.isFinite(it.at) ? clamp(Math.round(it.at), state.pos - 60, state.pos + 600) : null;
      const lat = typeof it.lat === 'number' && Number.isFinite(it.lat) ? clamp(Math.round(it.lat), -40, 40) : null;
      if (at == null || lat == null) return false;
      state.pings.push({ id: ++state.pingSeq, at, lat, ts: now, by: p.name });
      if (state.pings.length > 6) state.pings.splice(0, state.pings.length - 6);
      return true;
    }
    case 'role': {
      if (it.role !== 'drive' && it.role !== 'navigate') return false;
      if (p.role === it.role) return false;
      p.role = it.role;
      // 切岗位即松手：原岗位的持键全部清零（换到导航位的人不能再踩着油门）
      const inp = state.inputs[playerId];
      if (inp) {
        inp.gas = false;
        inp.brake = false;
        inp.steer = 0;
      }
      pushLog(state, 'sys', `${p.name} ${it.role === 'drive' ? '接过了方向盘' : '切换到了导航位'}`);
      return true;
    }
    case 'call': {
      if (!asNavigator) return false;
      const i = typeof it.i === 'number' && Number.isInteger(it.i) ? it.i : -1;
      if (i < 0 || i >= DRIVE_CALLS.length) return false;
      if (now - (state.callAt[playerId] ?? 0) < DRIVE_CALL_COOLDOWN_MS) return false;
      state.callAt[playerId] = now;
      state.calls.push({ id: ++state.callSeq, by: p.name, i, ts: now });
      if (state.calls.length > 4) state.calls.splice(0, state.calls.length - 4);
      return true;
    }
    default:
      return false;
  }
}

/* ---------------- 窗爬者调度 ---------------- */

function scheduleNextCrawl(state: DriveState, now: number, rng: Rng): void {
  const tierMult = Math.min(DRIVE_CRAWL_TIER_CAP, 1 + DRIVE_CRAWL_TIER_SCALE * state.signs);
  const lampMult = state.lamp ? DRIVE_CRAWL_LAMP_MULT : 1;
  const base = DRIVE_CRAWL_BASE_MS / (DRIVE_CRAWL_RATE_MULT[state.crawlRate] * tierMult * lampMult);
  const jitter = 0.75 + rng() * 0.5;
  state.nextCrawlAt = now + Math.min(DRIVE_CRAWL_MAX_MS, Math.max(DRIVE_CRAWL_MIN_MS, base * jitter));
}

/** 任意一侧爬窗事件进行中（预警或爬入计时） */
function anyCrawlActive(state: DriveState): boolean {
  return state.windows.L.warnAt > 0 || state.windows.R.warnAt > 0 || state.windows.L.climbDeadline > 0 || state.windows.R.climbDeadline > 0;
}

/**
 * 爬进车内（窗爬者计时走满 / 夜行者扒窗爬入）：拖走活着的开窗者，无人认领则破窗扣车耐久。
 * 该侧窗随之关上。
 */
function breakIn(state: DriveState, side: DriveSide, now: number, what: string): void {
  void now;
  const w = state.windows[side];
  state.crawls += 1;
  const sideName = side === 'L' ? '左' : '右';
  const opener = w.opener ? findPlayer(state, w.opener) : undefined;
  if (opener && !opener.left && !opener.downed) {
    opener.downed = true;
    opener.dragged += 1;
    pushLog(state, 'sys', `${opener.name} 被${sideName}侧的${what}拖出了车外！`);
  } else {
    state.durability -= 1;
    pushLog(state, 'sys', `${what}从${sideName}侧破窗而入，车耐久 -1（${state.durability}/${state.maxDurability}）`);
  }
  w.open = false;
  w.opener = null;
  w.warnAt = 0;
  w.climbDeadline = 0;
}

function tickCrawlers(state: DriveState, now: number, rng: Rng): boolean {
  // 同一时间只进行一只窗爬者，且不爬已有夜行者扒着的那一侧（那一侧归夜行者）
  const taken = new Set(state.monsters.filter((m) => m.mode === 'latched').map((m) => m.side));
  if (state.nextCrawlAt > 0 && now >= state.nextCrawlAt && !anyCrawlActive(state)) {
    const open = SIDES.filter((s) => state.windows[s].open && !taken.has(s));
    if (open.length === 0) {
      // 没有开着的窗就没得爬：短延迟重试，等玩家开窗（「开窗搜掠」的风险由此而来）
      state.nextCrawlAt = now + 2_000;
    } else {
      const side = open[Math.min(open.length - 1, Math.floor(rng() * open.length))]!;
      state.windows[side].warnAt = now;
      state.nextCrawlAt = 0;
      return true;
    }
  }
  let changed = false;
  for (const side of SIDES) {
    const w = state.windows[side];
    if (w.warnAt > 0 && now - w.warnAt >= DRIVE_WARN_MS) {
      w.warnAt = 0;
      w.climbDeadline = now + DRIVE_CLIMB_MS;
      changed = true;
    }
    if (w.climbDeadline > 0 && now >= w.climbDeadline) {
      if (w.open) breakIn(state, side, now, '窗爬者');
      w.climbDeadline = 0;
      scheduleNextCrawl(state, now, rng);
      changed = true;
    }
  }
  return changed;
}

/* ---------------- 夜行者 ---------------- */

/** 被甩飞/撞飞：保留一小段翻滚展示后移除（计入搏斗） */
function throwMonster(state: DriveState, m: DriveMonsterState, now: number, text: string): void {
  m.mode = 'thrown';
  m.thrownAt = now;
  m.side = null;
  m.climbSince = 0;
  m.vs = Math.max(4, state.speed / 3.6); // 惯性继续向前，随后减速落到车后
  m.vx = m.lat >= state.lateral ? 2.5 : -2.5;
  m.lat += m.vx * 0.2;
  state.crawls += 1;
  pushLog(state, 'sys', text);
}

/** 夜行者的奔跑速度（m/s）：随路牌数加快，封顶 +50% */
export function monsterRunSpeed(signs: number): number {
  return DRIVE_MONSTER_RUN * Math.min(1 + DRIVE_MONSTER_RUN_TIER_CAP, 1 + DRIVE_MONSTER_RUN_TIER * signs);
}

/** 甩脱线（km/h）：跑得比车还快的夜行者，车得开得比它更快才甩得掉 */
export function escapeSpeedOf(signs: number): number {
  return Math.max(DRIVE_ESCAPE_SPEED, monsterRunSpeed(signs) * 3.6);
}

function tickMonsters(state: DriveState, now: number, dtSec: number, prevPos: number, escape: number): void {
  const hunt = state.moved && state.speed < DRIVE_HUNT_SPEED;
  const escaping = state.speed >= escape;
  const run = monsterRunSpeed(state.signs);
  const t = (now - state.startedAt) / 1000;
  const homeLat = (m: DriveMonsterState): number =>
    clamp(m.center + m.amp * Math.sin(m.w * t + m.phase), -DRIVE_MONSTER_LAT_MAX, DRIVE_MONSTER_LAT_MAX);
  let latched = false;
  for (const m of state.monsters) {
    if (m.mode === 'thrown') {
      m.at += m.vs * dtSec;
      m.lat += m.vx * dtSec;
      m.vs = Math.max(0, m.vs - 14 * dtSec);
      m.vx *= Math.exp(-3 * dtSec);
      continue;
    }
    if (m.mode === 'latched') {
      if (escaping) {
        throwMonster(state, m, now, '车一加速，扒在车门上的夜行者被甩了出去');
        continue;
      }
      latched = true;
      m.at = state.pos;
      m.lat = state.lateral + (m.side === 'R' ? DRIVE_LATCH_DLAT : -DRIVE_LATCH_DLAT);
      m.vs = state.speed / 3.6;
      m.vx = 0;
      const side = m.side ?? 'L';
      const w = state.windows[side];
      if (w.open) {
        // 扒车侧车窗开着：持续 2.5s 即爬进来（关窗打断——climbSince 清零）
        if (!m.climbSince) m.climbSince = now;
        else if (now - m.climbSince >= DRIVE_LATCH_CLIMB_MS) {
          m.mode = 'thrown';
          m.thrownAt = now - DRIVE_THROW_MS; // 已进车：立即移除
          m.vs = 0;
          m.vx = 0;
          breakIn(state, side, now, '夜行者');
        }
      } else {
        m.climbSince = 0;
      }
      continue;
    }
    if (m.mode === 'wander') {
      if (hunt && Math.abs(m.at - state.pos) <= DRIVE_HUNT_RANGE) {
        m.mode = 'hunt'; // 车停了：被惊动，冲向车
      } else {
        const target = homeLat(m);
        m.vx = dtSec > 0 ? (target - m.lat) / dtSec : 0;
        m.lat = target;
        m.vs = 0;
      }
    }
    if (m.mode === 'hunt') {
      if (escaping) m.mode = 'return'; // 车跑起来了：放弃，走回原位
      else {
        const d = Math.hypot(m.at - state.pos, m.lat - state.lateral) || 1;
        m.vs = ((state.pos - m.at) / d) * run;
        m.vx = ((state.lateral - m.lat) / d) * run;
      }
    }
    if (m.mode === 'return') {
      const hs = m.home - m.at;
      const hl = homeLat(m) - m.lat;
      const d = Math.hypot(hs, hl);
      if (d < 0.6) {
        m.mode = 'wander';
        m.at = m.home;
        m.vs = 0;
        m.vx = 0;
      } else {
        m.vs = (hs / d) * DRIVE_MONSTER_WALK;
        m.vx = (hl / d) * DRIVE_MONSTER_WALK;
      }
    }
    if (m.mode !== 'wander') {
      m.at += m.vs * dtSec;
      m.lat += m.vx * dtSec;
    }
    // 追上车：扒住（按它相对车的方位决定左右侧）
    if (
      m.mode === 'hunt' &&
      Math.abs(m.at - state.pos) <= DRIVE_LATCH_DS &&
      Math.abs(m.lat - state.lateral) <= DRIVE_LATCH_DLAT
    ) {
      m.mode = 'latched';
      m.side = m.lat >= state.lateral ? 'R' : 'L';
      m.climbSince = 0;
      pushLog(state, 'sys', `一只夜行者扒住了${m.side === 'L' ? '左' : '右'}侧车门！开到 ${Math.round(escape)}km/h 才能甩掉它`);
      continue;
    }
    // 行驶中撞上：车扫过它所在的位置且横向重叠
    const crossed = (prevPos < m.at && state.pos >= m.at) || Math.abs(m.at - state.pos) < 1.2;
    if (crossed && Math.abs(m.lat - state.lateral) < DRIVE_HIT_HALF) {
      if (state.speed >= DRIVE_HIT_SPEED) {
        state.durability -= 1;
        state.speed = Math.max(0, state.speed * 0.35);
        state.gap = Math.max(0, state.gap - DRIVE_GAP_NOISE);
        throwMonster(state, m, now, `撞飞了一只夜行者！车耐久 -1（${state.durability}/${state.maxDurability}）`);
      } else {
        state.speed *= 0.7;
        throwMonster(state, m, now, '低速撞开了一只夜行者');
      }
    }
  }
  // 撕扯节奏（多只共用）：首次 DRIVE_MAUL_FIRST_MS 后开始，之后每 2.5s 耐久 -1
  if (latched) {
    if (!state.maulAt) state.maulAt = now + DRIVE_MAUL_FIRST_MS;
    else if (now >= state.maulAt) {
      state.maulAt = now + DRIVE_MAUL_EVERY_MS;
      state.durability -= 1;
      state.mauls += 1;
      pushLog(state, 'sys', `夜行者在外面疯狂撕扯！车耐久 -1（${state.durability}/${state.maxDurability}）`);
    }
  } else {
    state.maulAt = 0;
  }
  // 清理：翻滚结束的、早已驶过的
  if (state.monsters.length > 0) {
    state.monsters = state.monsters.filter((m) =>
      m.mode === 'thrown' ? now - m.thrownAt < DRIVE_THROW_MS : m.home > state.pos - 220,
    );
  }
}

/* ---------------- 事件消费 ---------------- */

/** 通过路牌：tier+1、复活被拖走者（离场者不复活） */
function passSign(state: DriveState): void {
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
}

function consumeEvents(state: DriveState, prevPos: number, dtSec: number, rng: Rng): boolean {
  let changed = false;
  for (const ev of state.road.events) {
    if (ev.at > state.pos + DRIVE_EVENT_HORIZON) break;
    switch (ev.kind) {
      case 'barrier': {
        const crossed = (prevPos < ev.at && state.pos >= ev.at) || Math.abs(ev.at - state.pos) < 0.8;
        if (!ev.hit && crossed && Math.abs(state.lateral - (ev.lat ?? 0)) < (ev.half ?? 1.3) + 0.9) {
          ev.hit = true;
          state.speed = Math.max(0, state.speed * DRIVE_BARRIER_SLOW);
          state.gap = Math.max(0, state.gap - DRIVE_GAP_NOISE);
          state.durability -= 1;
          pushLog(state, 'sys', `撞上路障！车耐久 -1（${state.durability}/${state.maxDurability}）`);
          changed = true;
        }
        break;
      }
      case 'swarm': {
        if (
          !ev.hit &&
          state.pos >= ev.at &&
          state.pos <= ev.at + DRIVE_SWARM_LEN &&
          Math.abs(state.lateral - (ev.lat ?? 0)) < (ev.half ?? DRIVE_SWARM_HALF) + 0.9 &&
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
        const crossed = (prevPos < ev.at && state.pos >= ev.at) || Math.abs(ev.at - state.pos) < 0.8;
        // 收取条件：同侧外侧车道 + 该侧窗开 + 车速≤50
        const outerLane = ev.side === 'R' ? state.lateral > LANE_W_M / 2 : state.lateral < -LANE_W_M / 2;
        if (!ev.hit && crossed && outerLane && Math.abs(state.lateral) <= ROAD_HALF_M) {
          ev.hit = true;
          const w = state.windows[ev.side ?? 'R'];
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
  if (state.road.events.length > 14) {
    state.road.events = state.road.events.filter((ev) => ev.at + eventLen(ev) > state.pos - 80);
  }
  return changed;
}

/* ---------------- 终局与离场 ---------------- */

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

/** 玩家中途离开：清输入与开窗归因，留在结算里；无人在车上则终局 */
export function driveLeave(state: DriveState, playerId: string, now: number): boolean {
  if (state.phase === 'gameover') return false;
  const p = findPlayer(state, playerId);
  if (!p || p.left) return false;
  p.left = true;
  p.downed = false;
  delete state.inputs[playerId];
  delete state.callAt[playerId];
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
 * 时间驱动（rooms 层 66ms 一拍）：dt 积分车速/转向/里程，出路面与护栏、弯道与事件生成、
 * 夜行者、猎影尾压、爬窗、路牌、耐久与胜负判定。返回 true=状态有变化（driving 中恒 true）。
 */
export function driveTick(state: DriveState, now: number, connectedIds: ReadonlySet<string>, rng: Rng = Math.random): boolean {
  if (state.phase === 'gameover') return false;
  const dtMs = Math.min(DRIVE_MAX_DT_MS, Math.max(0, now - state.lastTickAt));
  state.lastTickAt = now;
  if (dtMs === 0) return false;
  const dtSec = dtMs / 1000;

  // 掉线/被拖走/离场玩家的持键清零（重连后由客户端重新上报）
  for (const [id, inp] of Object.entries(state.inputs)) {
    if (!alivePlayer(state, id) || !connectedIds.has(id)) {
      inp.gas = false;
      inp.brake = false;
      inp.steer = 0;
    }
  }
  const held = aggregateInputs(state, connectedIds);
  const mauled = state.monsters.some((m) => m.mode === 'latched');

  // 车速：刹车优先于油门；被扒着时加速打折；空油时油门失效且速度上限锁死
  const braking = held.brake;
  const gassing = !braking && held.gas && state.fuel > 0;
  if (braking) state.speed = Math.max(0, state.speed - DRIVE_BRAKE * dtSec);
  else if (gassing) state.speed = Math.min(DRIVE_MAX_SPEED, state.speed + DRIVE_ACCEL * (mauled ? 1 - DRIVE_LATCH_DRAG : 1) * dtSec);
  else state.speed = Math.max(0, state.speed - DRIVE_COAST * dtSec);
  if (state.offRoad) state.speed = Math.max(0, state.speed - DRIVE_SHOULDER_DRAG * dtSec);
  if (state.fuel <= 0) state.speed = Math.min(state.speed, DRIVE_EMPTY_MAX_SPEED);

  // 油耗
  if (state.fuel > 0) {
    state.fuel = Math.max(0, state.fuel - (DRIVE_FUEL_BURN_BASE + DRIVE_FUEL_BURN_SCALE * (state.speed / DRIVE_MAX_SPEED)) * dtSec);
  }

  // 转向：同源积分 + 出路面/护栏
  const prevPos = state.pos;
  stepSteering(state, held.steer, curvatureAt(state.road.curves, state.pos), dtSec);
  state.pos += (state.speed / 3.6) * dtSec;
  if (state.speed >= DRIVE_ESCAPE_SPEED) state.moved = true; // 发车宽限结束

  const offRoad = Math.abs(state.lateral) > ROAD_HALF_M;
  if (offRoad) {
    state.gap = Math.max(0, state.gap - DRIVE_SHOULDER_GAP * dtSec); // 刮擦噪音
    if (!state.offRoad) pushLog(state, 'sys', '驶出了路面！路肩的刮擦声把它招来了');
  }
  state.offRoad = offRoad;
  if (Math.abs(state.lateral) >= DRIVE_GUARD_M && now >= state.crashAt) {
    const dir = Math.sign(state.lateral);
    state.durability -= 1;
    state.speed *= DRIVE_CRASH_SLOW;
    // 弹回路面内侧（而不是停在护栏边的路肩上）：路肩减速会吃掉全部油门，停在那就再也开不出来
    state.lateral = dir * (ROAD_HALF_M - 0.9);
    state.offRoad = false;
    // 弹回时车头明显朝向路面：弯道每秒都在把车往外甩，偏角太小的话不到两秒就会再撞一次
    state.rel = -dir * 0.28;
    state.gap = Math.max(0, state.gap - DRIVE_GAP_NOISE);
    state.crashAt = now + DRIVE_CRASH_COOLDOWN_MS;
    pushLog(state, 'sys', `撞上护栏！车耐久 -1（${state.durability}/${state.maxDurability}）`);
  }

  generateCurves(state, rng);
  generateEvents(state, rng);

  // 瞭望标记/喊话过期清理（广播瘦身：过期的不再随每帧视图重复下发）
  if (state.pings.length > 0) state.pings = state.pings.filter((p) => now - p.ts < DRIVE_PING_TTL_MS);
  if (state.calls.length > 0) state.calls = state.calls.filter((c) => now - c.ts < DRIVE_CALL_TTL_MS);

  consumeEvents(state, prevPos, dtSec, rng);
  tickMonsters(state, now, dtSec, prevPos, escapeSpeedOf(state.signs));

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

  tickCrawlers(state, now, rng);

  // 路牌（while：dt 大或间隔小可能一次跨两块）
  while (state.pos >= state.nextSignAt) passSign(state);
  if (state.targetSigns > 0 && state.signs >= state.targetSigns) {
    finish(state, 'won', now);
    return true;
  }

  // 车毁人亡
  if (state.durability <= 0) {
    finish(state, 'dead', now);
    return true;
  }
  return true;
}

/* ---------------- 视图 ---------------- */

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * 会话视图：车辆状态全队公开（共乘一辆车没有秘密），按会话裁剪的只有
 * 自己的持键状态、岗位权限与被拖走标记；观战者/局中入座者 spectator=true。
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
  const alive = !!me && !me.left && !me.downed;
  const spectator = !me || me.left;
  const solo = isSolo(state);
  const win = (w: DriveState['windows']['L']): DriveView['windows']['L'] => ({
    open: w.open,
    warn: w.warnAt > 0 || w.climbDeadline > 0,
    climbLeft: w.climbDeadline > 0 ? Math.max(0, w.climbDeadline - now) : null,
  });
  const drivers = solo
    ? state.players.some((p) => !p.left && !p.downed)
      ? 1
      : 0
    : state.players.filter((p) => !p.left && !p.downed && p.role === 'drive' && connectedIds.has(p.id)).length;
  const monsters: DriveViewMonster[] = [];
  for (const m of state.monsters) {
    if (m.at < state.pos - MONSTER_VIEW_BACK || m.at > state.pos + MONSTER_VIEW_AHEAD) continue;
    monsters.push({
      id: m.id,
      at: round2(m.at),
      lat: round2(m.lat),
      mode: m.mode,
      side: m.side,
      vs: round2(m.vs),
      vx: round2(m.vx),
      climbLeft: m.mode === 'latched' && m.climbSince > 0 ? Math.max(0, m.climbSince + DRIVE_LATCH_CLIMB_MS - now) : null,
    });
  }
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
      role: p.role,
    })),
    speed: round2(state.speed),
    lateral: round2(state.lateral),
    rel: round2(state.rel),
    fuel: round2(state.fuel),
    durability: state.durability,
    maxDurability: state.maxDurability,
    gap: round2(state.gap),
    pos: round2(state.pos),
    signs: state.signs,
    targetSigns: state.targetSigns,
    signGap: state.signGap,
    nextSignAt: state.nextSignAt,
    tail: state.tail,
    crawlRate: state.crawlRate,
    windows: { L: win(state.windows.L), R: win(state.windows.R) },
    lamp: state.lamp,
    offRoad: state.offRoad,
    events: liveEvents(state),
    monsters,
    curves: state.road.curves.filter((c) => c.at + c.len > state.pos - CURVE_VIEW_BACK && c.at < state.pos + CURVE_VIEW_AHEAD),
    pings: state.pings.map((p) => ({ ...p })),
    calls: state.calls.map((c) => ({ ...c })),
    steerIn: aggregateInputs(state, connectedIds).steer,
    myInputs: me && !spectator && !me.downed && state.phase === 'driving'
      ? { ...(state.inputs[me.id] ?? { gas: false, brake: false, steer: 0 as const }) }
      : null,
    myRole: me?.role ?? 'navigate',
    canDrive: alive && state.phase === 'driving' && (solo || me!.role === 'drive'),
    canNavigate: alive && state.phase === 'driving' && (solo || me!.role === 'navigate'),
    solo,
    drivers,
    escapeSpeed: Math.round(escapeSpeedOf(state.signs)),
    iDowned: !!me && me.downed,
    spectator,
    mauls: state.mauls,
    attacks: state.attacks,
    serverTime: now,
    startedAt: state.startedAt,
    result: state.result,
    log: state.log,
    logSeq: state.logSeq,
  };
}
