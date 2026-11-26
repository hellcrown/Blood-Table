import type { GameMode, LogLine } from './protocol';

/**
 * 勿停（drive）· 1-4 人共乘一辆车的无尽夜路合作逃生（v2：真弯道 + 驾驶/导航分工 + 会主动袭击的夜行者）
 * 核心规则（rulebook/RULES-DRIVE.md）：一切收益都要求慢下来，而一切慢都在喂养车后的东西——
 * - 车速低于勿停线喂养「猎影」（尾压）；猎影追上即撞损车尾；
 * - 真弯道：按住方向键转车头，弯道把车往外甩，不打方向就冲出路面；
 * - 开窗才能搜掠路肩补给，但窗爬者会爬开着的窗（灯亮吸引更多）；
 * - 夜行者平时在路上游荡；车一停稳，附近的全部被惊动冲向车，扒住撕扯、从开着的窗爬进来——
 *   唯一的解法是开起来（到甩脱车速全部甩飞）；加油站必须停车，所以每次加油都是一次赌博。
 * 信息不对称即玩法：驾驶员只有挡风玻璃（弯后被树林和黑暗挡住），副驾驶靠地图看，再用喊话/标记传达。
 * 服务器模拟制：客户端只发按键意图（vInt），15Hz tick、约 10Hz 全量视图帧。
 * 转向方程 stepSteering 与曲率 curvatureAt 是前后端同源的纯函数（客户端预测用），勿在两端各写一份。
 */

/* ---------------- 节奏 ---------------- */

/** 服务器模拟 tick：15Hz */
export const DRIVE_TICK_MS = 66;
/** 视图广播最小间隔；66ms tick 下全量帧 ≈ 10Hz */
export const DRIVE_BROADCAST_MS = 100;
/** 全员断线宽限：30s 就地终局（同扫雷/你画我猜口径） */
export const DRIVE_EMPTY_MS = 30_000;
/** 单拍 dt 钳制上限：事件循环卡顿后不做大幅追赶 */
export const DRIVE_MAX_DT_MS = 250;

/* ---------------- 道路几何（米） ---------------- */

export const LANE_W_M = 3.5; // 车道宽（三车道）
export const ROAD_HALF_M = 5.25; // 路面半宽
export const DRIVE_GUARD_M = 7.4; // 护栏（撞上即受损）
export const DRIVE_SHOULDER_M = 1.6; // 路肩宽（画面用）

/* ---------------- 车辆 ---------------- */

export const DRIVE_MAX_SPEED = 120; // km/h
/** 勿停线：低于此车速开始喂养猎影 */
export const DRIVE_IDLE_LINE = 30;
export const DRIVE_ACCEL = 25; // km/h 每秒（油门）
export const DRIVE_COAST = 15; // 松开自然滑行减速
export const DRIVE_BRAKE = 60; // 刹车减速
/** 油箱与油耗：油耗 = 0.6 + 0.6×(速度/120) %/s；空油时油门失效且速度上限锁死 */
export const DRIVE_FUEL_MAX = 100;
export const DRIVE_FUEL_BURN_BASE = 0.6;
export const DRIVE_FUEL_BURN_SCALE = 0.6;
export const DRIVE_EMPTY_MAX_SPEED = 15;
/** 车耐久选项（房间可调）：撞路障/猎影扑击/爬窗破窗/撞护栏/夜行者撕扯各 -1 */
export const DRIVE_DURABILITY_OPTIONS: readonly number[] = [2, 3, 5];
export const DRIVE_DEFAULT_DURABILITY = 3;

/* ---------------- 转向（键盘 Arcade 模型，v0 待调参） ---------------- */

/** 按住方向键时车头相对角的变化速率（rad/s；静止时打不动方向） */
export const DRIVE_STEER_RATE = 1.0;
/** 松键回正：不按键时车头相对角向 0 衰减的速率（/s）——键盘点按式操作的前置条件，不会替玩家过弯 */
export const DRIVE_REL_CENTER = 0.9;
/** 车头相对路切线的偏角上限（rad） */
export const DRIVE_REL_MAX = 0.5;
/** 路肩：额外减速（km/h/s）与刮擦噪音（猎影距离每秒衰减）。
 *  减速必须小于油门加速（25）——否则车一旦停在路肩上就再也开不动（静止打不了方向），必死 */
export const DRIVE_SHOULDER_DRAG = 15;
export const DRIVE_SHOULDER_GAP = 2;
/** 撞护栏：冷却、速度乘数 */
export const DRIVE_CRASH_COOLDOWN_MS = 1200;
export const DRIVE_CRASH_SLOW = 0.25;

/* ---------------- 弯道 ---------------- */

/** 弯道凶度（房间可调）：曲率乘数 */
export type DriveCurveSetting = 'lenient' | 'normal' | 'fierce';
export const DRIVE_CURVE_OPTIONS: readonly DriveCurveSetting[] = ['lenient', 'normal', 'fierce'];
export const DRIVE_DEFAULT_CURVE: DriveCurveSetting = 'normal';
export const DRIVE_CURVE_MULT: Record<DriveCurveSetting, number> = { lenient: 0.7, normal: 1, fierce: 1.3 };
/** 开局直路长度、进出弯曲率渐变长度、向前的生成距离 */
export const DRIVE_CURVE_FIRST_STRAIGHT = 200;
export const DRIVE_CURVE_RAMP_M = 20;
export const DRIVE_CURVE_AHEAD_M = 900;
/** 同向连续弯道的总转角上限（rad）——保证前方 300m 内的道路始终落在副驾驶地图里 */
export const DRIVE_CURVE_CHAIN_MAX = 1.6;

/** 一段弯道：at 起点里程、len 长度、k 曲率（rad/m，正=右弯），两端各 20m 线性渐变 */
export interface DriveCurve {
  at: number;
  len: number;
  k: number;
}

/** 里程 s 处的曲率（rad/m，正=右弯）；curves 按 at 升序 */
export function curvatureAt(curves: readonly DriveCurve[], s: number): number {
  for (const c of curves) {
    if (s < c.at) return 0;
    if (s <= c.at + c.len) {
      const t = Math.min((s - c.at) / DRIVE_CURVE_RAMP_M, (c.at + c.len - s) / DRIVE_CURVE_RAMP_M, 1);
      return c.k * Math.max(0, t);
    }
  }
  return 0;
}

/** 转向积分的载体：横向位置 lateral（米，正=路中心右侧）、车头相对角 rel（rad，正=车头偏右） */
export interface SteerBody {
  lateral: number;
  rel: number;
  speed: number;
}

/**
 * 转向积分（前后端同源；服务端 15Hz、客户端预测 60Hz 各自调用）：
 * - 按住方向键：rel 朝按键方向变化（静止打不动方向）；
 * - 松键：rel 向 0 回正；
 * - 弯道：道路在车下转动，rel 朝弯外变化（离心外甩，速度越快越狠）；
 * - 横向位置随车头角横移。
 */
export function stepSteering(b: SteerBody, steer: number, kappa: number, dt: number): void {
  const v = b.speed / 3.6;
  if (steer !== 0) b.rel += Math.sign(steer) * DRIVE_STEER_RATE * Math.min(1, v / 2) * dt;
  else b.rel *= Math.exp(-DRIVE_REL_CENTER * dt);
  b.rel -= kappa * v * dt;
  b.rel = Math.min(DRIVE_REL_MAX, Math.max(-DRIVE_REL_MAX, b.rel));
  b.lateral += v * Math.sin(b.rel) * dt;
}

/* ---------------- 猎影（尾压） ---------------- */

export const DRIVE_GAP_MAX = 100;
export const DRIVE_GAP_REGEN = 4;
export const DRIVE_GAP_DRAIN = 6;
export const DRIVE_GAP_NOISE = 8;
export const DRIVE_ATTACK_RESET = 50;
export type DriveTail = 'lenient' | 'normal' | 'fierce';
export const DRIVE_TAIL_OPTIONS: readonly DriveTail[] = ['lenient', 'normal', 'fierce'];
export const DRIVE_DEFAULT_TAIL: DriveTail = 'normal';
export const DRIVE_TAIL_DRAIN: Record<DriveTail, number> = { lenient: 4, normal: 6, fierce: 8 };

/* ---------------- 窗与窗爬者（侧压） ---------------- */

export const DRIVE_WARN_MS = 1_200;
export const DRIVE_CLIMB_MS = 3_000;
export const DRIVE_CRAWL_BASE_MS = 14_000;
export const DRIVE_CRAWL_MIN_MS = 4_000;
export const DRIVE_CRAWL_MAX_MS = 60_000;
export const DRIVE_CRAWL_FIRST_MS = 8_000;
export const DRIVE_CRAWL_TIER_SCALE = 0.15;
export const DRIVE_CRAWL_TIER_CAP = 3;
export const DRIVE_CRAWL_LAMP_MULT = 1.5;
export type DriveCrawlRate = 'low' | 'normal' | 'high';
export const DRIVE_CRAWL_OPTIONS: readonly DriveCrawlRate[] = ['low', 'normal', 'high'];
export const DRIVE_DEFAULT_CRAWL: DriveCrawlRate = 'normal';
export const DRIVE_CRAWL_RATE_MULT: Record<DriveCrawlRate, number> = { low: 0.6, normal: 1, high: 1.6 };

export type DriveSide = 'L' | 'R';

/* ---------------- 路面事件 ---------------- */

export const DRIVE_EVENT_HORIZON = 600;
export const DRIVE_EVENT_GAP_MIN = 120;
export const DRIVE_EVENT_GAP_MAX = 280;
export const DRIVE_EVENT_FIRST_AT = 150;
export const DRIVE_SIGN_GAP_OPTIONS: readonly number[] = [200, 300, 400, 600];
export const DRIVE_DEFAULT_SIGN_GAP = 400;
/** 尸群带：沿路长度 40m，横向半宽 3.6m（横跨两条车道） */
export const DRIVE_SWARM_LEN = 40;
export const DRIVE_SWARM_HALF = 3.6;
export const DRIVE_STATION_LEN = 30;
export const DRIVE_STATION_MAX_SPEED = 5;
export const DRIVE_STATION_FUEL_RATE = 30;
export const DRIVE_STATION_GAP_BASE = 500;
/** 搜掠：需在同侧外侧车道 + 该侧窗开 + 车速≤上限，驶过点即收取 */
export const DRIVE_LOOT_MAX_SPEED = 50;
export const DRIVE_LOOT_FUEL_MIN = 15;
export const DRIVE_LOOT_FUEL_MAX = 25;
export const DRIVE_LOOT_REPAIR_CHANCE = 0.3;
/** 路肩物件的横向位置（路面外 1.4m） */
export const DRIVE_SHOULDER_OBJ_M = ROAD_HALF_M + 1.4;
export const DRIVE_BARRIER_SLOW = 0.4;
export const DRIVE_SWARM_SLOW = 0.5;
export const DRIVE_SWARM_MIN_SPEED = 10;
/** 撞路障的横向判定半宽（车半宽 + 路障半宽） */
export const DRIVE_BARRIER_HALF = 2.2;

/* ---------------- 夜行者（会主动袭击停下的车） ---------------- */

/** 夜行者走独立的生成流（不与路障/搜掠抢事件槽）：第一只在第一块路牌之后这么远 */
export const DRIVE_MONSTER_FIRST_MIN = 40;
export const DRIVE_MONSTER_FIRST_SPAN = 120;
/** 之后每隔 330m 一只，每过一块路牌缩短 15m，最短 150m（±30% 抖动）——停车加油时方圆 90m 内多半有它 */
export const DRIVE_MONSTER_GAP_BASE = 330;
export const DRIVE_MONSTER_GAP_TIER = 15;
export const DRIVE_MONSTER_GAP_MIN = 150;
/** 第 4 号路牌起三成概率成对出现（相距 12~30m） */
export const DRIVE_MONSTER_PAIR_TIER = 4;
export const DRIVE_MONSTER_PAIR_CHANCE = 0.3;
/** 停车判定：车速低于此值即视为「停下」，惊动范围内的夜行者 */
export const DRIVE_HUNT_SPEED = 10;
/** 甩脱车速的下限（km/h）：实际甩脱线取 max(本值, 夜行者的奔跑车速)，见 engine 的 escapeSpeedOf */
export const DRIVE_ESCAPE_SPEED = 25;
export const DRIVE_HUNT_RANGE = 90;
/** 冲刺速度（m/s）：基础 9（约 32km/h）× (1 + 5%×路牌数，最多 +50%)。
 *  首版是 5.5（约 20km/h）——车开到 25 就永远追不上，停车时它从 60m 外要 11 秒才到，加满油都绰绰有余。 */
export const DRIVE_MONSTER_RUN = 9;
export const DRIVE_MONSTER_RUN_TIER = 0.05;
export const DRIVE_MONSTER_RUN_TIER_CAP = 0.5;
export const DRIVE_MONSTER_WALK = 2.2;
/** 游荡的横向活动范围上限 */
export const DRIVE_MONSTER_LAT_MAX = 4.2;
/** 扒车撕扯：首次 2.0s 后开始，之后每 2.5s 耐久 -1（多只共用节奏）。
 *  2.0s 是给「立刻满油门」留的活路：被扒着时加速 17.5km/h/s，不到 2 秒冲过基础档的甩脱线（32km/h）——
 *  反应够快一下都不挨，稍有犹豫就先掉一格；路牌多了它跑得更快，甩脱线跟着抬高，停在不该停的地方必然挨一下 */
export const DRIVE_MAUL_FIRST_MS = 2_000;
export const DRIVE_MAUL_EVERY_MS = 2_500;
/** 扒车侧车窗开着：持续 2.5s 即爬进来（关窗即打断） */
export const DRIVE_LATCH_CLIMB_MS = 2_500;
/** 扒着时车的加速打折（×0.7） */
export const DRIVE_LATCH_DRAG = 0.3;
/** 车速≥20km/h 撞上=车受损、夜行者被撞飞；更低速接触=直接扒车 */
export const DRIVE_HIT_SPEED = 20;
export const DRIVE_HIT_HALF = 1.7;
/** 追上车的判定：沿路距离 / 横向距离 */
export const DRIVE_LATCH_DS = 2.8;
export const DRIVE_LATCH_DLAT = 2.3;
/** 被甩飞后的翻滚展示时长（之后移除） */
export const DRIVE_THROW_MS = 1_200;

export type DriveMonsterMode = 'wander' | 'hunt' | 'latched' | 'return' | 'thrown';

/** 夜行者（仅服务端持有） */
export interface DriveMonsterState {
  id: number;
  /** 原位里程（放弃后走回这里） */
  home: number;
  /** 当前里程与横向位置 */
  at: number;
  lat: number;
  /** 游荡参数：lat = center + amp × sin(w × t + phase) */
  center: number;
  amp: number;
  w: number;
  phase: number;
  mode: DriveMonsterMode;
  /** 扒车所在侧 */
  side: DriveSide | null;
  /** 该侧车窗持续开着的起点（0=没在爬窗；关窗清零） */
  climbSince: number;
  thrownAt: number;
  /** 当前速度（m/s，客户端插值外推用） */
  vs: number;
  vx: number;
}

/** 下发给客户端的夜行者 */
export interface DriveViewMonster {
  id: number;
  at: number;
  lat: number;
  mode: DriveMonsterMode;
  side: DriveSide | null;
  vs: number;
  vx: number;
  /** 正在爬窗时的剩余毫秒（null=没在爬） */
  climbLeft: number | null;
}

export type DriveEventKind = 'barrier' | 'swarm' | 'loot' | 'station';
/** 路面事件（服务端权威生成，视图只下发车附近未消费的部分） */
export interface DriveEvent {
  /** 触发里程（swarm/station 为区起点） */
  at: number;
  kind: DriveEventKind;
  /** barrier/swarm 的横向中心（米）；swarm 配 half */
  lat?: number;
  half?: number;
  /** loot/station 所在路肩 */
  side?: DriveSide;
  /** loot 内容（生成即定，地图可见） */
  content?: 'fuel' | 'repair';
  /** 已被撞/碾/搜过（一次性判定） */
  hit?: boolean;
}

/* ---------------- 目标模式 ---------------- */

export const DRIVE_TARGET_OPTIONS: readonly number[] = [0, 5, 10, 15];
export const DRIVE_DEFAULT_TARGET = 0;

/* ---------------- 岗位 · 喊话 · 标记 ---------------- */

export type DriveRole = 'drive' | 'navigate';

/** 副驾驶快捷喊话（导航位按 1-9；服务端只存下标，文案只在这里——不走自由文本） */
export const DRIVE_CALLS = [
  '左弯！',
  '右弯！',
  '急弯！减速',
  '前方有东西！',
  '它冲过来了！快走',
  '它追上来了！加速',
  '左窗！',
  '右窗！',
  '停车加油',
] as const;
export const DRIVE_CALL_COOLDOWN_MS = 1_200;
/** 喊话在视图里保留的时长（驾驶员大字显示 3 秒） */
export const DRIVE_CALL_TTL_MS = 6_000;
export const DRIVE_PING_TTL_MS = 8_000;

export interface DriveCall {
  id: number;
  by: string;
  i: number;
  ts: number;
}

export interface DrivePing {
  id: number;
  /** 地图上的世界位置：里程与横向米数 */
  at: number;
  lat: number;
  ts: number;
  by: string;
}

/* ---------------- 意图（客户端 → 服务端） ---------------- */

/**
 * 按键意图。gas/brake/steer 为持键（按下发、松开发；掉线由服务器清零）；
 * window/lamp/role/call/ping 为边沿。非法值一律静默钳制/丢弃（高频通道不报错）。
 */
export type DriveIntent =
  | { k: 'gas'; on: boolean }
  | { k: 'brake'; on: boolean }
  | { k: 'steer'; dir: -1 | 0 | 1 }
  | { k: 'window'; side: DriveSide }
  | { k: 'lamp' }
  | { k: 'ping'; at: number; lat: number }
  | { k: 'role'; role: DriveRole }
  | { k: 'call'; i: number };

export interface DriveInputs {
  gas: boolean;
  brake: boolean;
  steer: -1 | 0 | 1;
}

/* ---------------- 状态（仅服务端持有） ---------------- */

export interface DriveWindowState {
  open: boolean;
  /** 开窗者（爬窗破窗时拖走归因；关窗清空） */
  opener: string | null;
  /** 预警开始时刻（>0 且 climbDeadline=0 表示预警中） */
  warnAt: number;
  /** 爬入截止时刻（>0 表示爬入计时中） */
  climbDeadline: number;
}

export interface DrivePlayerState {
  id: string;
  name: string;
  seat: number;
  /** 被拖走/离场：不响应输入，下个路牌复活（left 则不再复活） */
  downed: boolean;
  left: boolean;
  loots: number;
  dragged: number;
  role: DriveRole;
}

export interface DriveResult {
  /** won=到达目标路牌 dead=车毁人亡 abort=房主终止 leave=无人在场 idle=全员断线 */
  reason: 'won' | 'dead' | 'abort' | 'leave' | 'idle';
  distance: number;
  signs: number;
  durationMs: number;
  attacks: number;
  crawls: number;
  loots: number;
}

export interface DriveState {
  phase: 'driving' | 'gameover';
  players: DrivePlayerState[];
  /** 状态识别字段（rooms 层以 'road' in g 识别 drive 对局） */
  road: {
    /** 事件已生成到的里程 */
    generatedTo: number;
    nextStationAt: number;
    /** 下一只夜行者的里程（独立生成流的游标） */
    nextMonsterAt: number;
    /** 未消费事件队列（按 at 升序） */
    events: DriveEvent[];
    /** 弯道序列（按 at 升序）与已生成到的里程 */
    curves: DriveCurve[];
    curvesTo: number;
    /** 当前同向弯道链的累计转角（rad，带符号；换向即重置）——保证链总转角不超上限 */
    chainTurn: number;
  };
  monsters: DriveMonsterState[];
  monsterSeq: number;
  /** 车速 km/h */
  speed: number;
  /** 横向位置（米，正=路中心右侧）与车头相对角（rad，正=偏右） */
  lateral: number;
  rel: number;
  fuel: number;
  durability: number;
  maxDurability: number;
  lastTickAt: number;
  /** 猎影距离 0-100（满=安全，归零=扑击） */
  gap: number;
  /** 车头里程（米） */
  pos: number;
  signs: number;
  nextSignAt: number;
  windows: { L: DriveWindowState; R: DriveWindowState };
  lamp: boolean;
  /** 持键（按玩家 id；downed/left/断线者不计入） */
  inputs: Record<string, DriveInputs>;
  pings: DrivePing[];
  pingSeq: number;
  calls: DriveCall[];
  callSeq: number;
  /** 上次喊话时刻（按玩家 id，冷却用） */
  callAt: Record<string, number>;
  nextCrawlAt: number;
  attacks: number;
  crawls: number;
  /** 扒车撕扯的累计扣血次数（客户端据此放拍打音/震动） */
  mauls: number;
  /** 下一次撕扯扣耐久的时刻（0=当前没有扒着的） */
  maulAt: number;
  /** 是否在路肩上 */
  offRoad: boolean;
  /** 撞护栏冷却截止 */
  crashAt: number;
  /** 发车宽限：车第一次跑起来之前不会惊动夜行者 */
  moved: boolean;
  signGap: number;
  tail: DriveTail;
  crawlRate: DriveCrawlRate;
  curveSetting: DriveCurveSetting;
  targetSigns: number;
  startedAt: number;
  result: DriveResult | null;
  /** 日志只留尾部（无尽模式日志会持续增长） */
  log: LogLine[];
  logSeq: number;
}

/* ---------------- 视图（服务端 → 客户端，全量帧） ---------------- */

export interface DriveViewPlayer {
  id: string;
  name: string;
  seat: number;
  downed: boolean;
  left: boolean;
  connected: boolean;
  isHost: boolean;
  loots: number;
  dragged: number;
  role: DriveRole;
}

export interface DriveViewWindow {
  open: boolean;
  /** 预警中 / 爬入剩余毫秒（null=无事件） */
  warn: boolean;
  climbLeft: number | null;
}

export interface DriveView {
  kind: 'drive';
  mode: GameMode;
  code: string;
  hostId: string;
  phase: DriveState['phase'];
  players: DriveViewPlayer[];
  speed: number;
  /** 横向位置（米）与车头相对角（rad） */
  lateral: number;
  rel: number;
  fuel: number;
  durability: number;
  maxDurability: number;
  gap: number;
  pos: number;
  signs: number;
  targetSigns: number;
  signGap: number;
  nextSignAt: number;
  tail: DriveTail;
  crawlRate: DriveCrawlRate;
  windows: { L: DriveViewWindow; R: DriveViewWindow };
  lamp: boolean;
  offRoad: boolean;
  /** 车头前方的未消费事件 */
  events: DriveEvent[];
  /** 附近的夜行者（含被甩飞后翻滚中的） */
  monsters: DriveViewMonster[];
  /** 车附近的弯道序列（客户端据此积分出道路中心线） */
  curves: DriveCurve[];
  pings: DrivePing[];
  calls: DriveCall[];
  /** 服务器当前采纳的总转向输入（全体驾驶员之和，钳 -1..1）——客户端预测用 */
  steerIn: -1 | 0 | 1;
  /** 我自己的持键状态（观战者/被拖走者为 null）——重连同步用 */
  myInputs: DriveInputs | null;
  myRole: DriveRole;
  /** 我当前能否驾驶 / 能否导航（岗位权限；单人局两者皆可） */
  canDrive: boolean;
  canNavigate: boolean;
  /** 单人局（一人全占） */
  solo: boolean;
  /** 在线且在驾驶位的玩家数（0=无人驾驶） */
  drivers: number;
  /** 当前甩脱线（km/h，取整）：车速到了，扒着的夜行者才会被甩飞 */
  escapeSpeed: number;
  iDowned: boolean;
  spectator: boolean;
  mauls: number;
  attacks: number;
  serverTime: number;
  startedAt: number;
  result: DriveResult | null;
  log: LogLine[];
  logSeq: number;
}

/* ---------------- 结算文案 ---------------- */

export const DRIVE_RESULT_TEXT: Record<DriveResult['reason'], string> = {
  won: '全员逃出夜路！',
  dead: '车毁人亡',
  abort: '房主终止了本局',
  leave: '无人继续驾驶',
  idle: '全员断线',
};
