import type { GameMode, LogLine } from './protocol';

/**
 * 勿停（drive）· 1-4 人共乘一辆车的无尽夜路合作逃生
 * 核心规则（rulebook/RULES-DRIVE.md）：一切收益都要求慢下来，而一切慢都在喂养车后的东西——
 * - 车速低于勿停线会喂养「猎影」（尾压）；猎影追上即撞损车尾；
 * - 开窗才能搜掠路肩补给，但窗爬者会从开窗爬进来（灯亮吸引更多）；
 * - 加油站要停稳才加得到油——明知停车喂鬼也必须停。
 * 服务器模拟制：客户端只发按键意图（vInt），车速/油量/尾压/事件全部服务端权威模拟，
 * 15Hz tick、约 10Hz 全量视图帧广播（事件级变化立即发）。数值均为 v0 待调参口径。
 */

/* ---------------- 节奏 ---------------- */

/** 服务器模拟 tick：15Hz */
export const DRIVE_TICK_MS = 66;
/** 视图广播最小间隔（事件级变化不受此限）；66ms tick 下全量帧 ≈ 10Hz */
export const DRIVE_BROADCAST_MS = 100;
/** 全员断线宽限：30s 就地终局（同扫雷/你画我猜口径） */
export const DRIVE_EMPTY_MS = 30_000;
/** 单拍 dt 钳制上限：事件循环卡顿后不做大幅追赶（防一拍内连吃多次扑击） */
export const DRIVE_MAX_DT_MS = 250;

/* ---------------- 车辆 ---------------- */

export const DRIVE_MAX_SPEED = 120; // km/h
/** 勿停线：低于此车速开始喂养猎影 */
export const DRIVE_IDLE_LINE = 30;
export const DRIVE_ACCEL = 25; // km/h 每秒（油门）
export const DRIVE_COAST = 15; // 松开自然滑行减速
export const DRIVE_BRAKE = 60; // 刹车减速
/** 换道冷却（服务端钳制） */
export const DRIVE_LANE_COOLDOWN_MS = 400;
/** 油箱与油耗：油耗 = 0.6 + 0.6×(速度/120) %/s；空油时油门失效且速度上限锁死 */
export const DRIVE_FUEL_MAX = 100;
export const DRIVE_FUEL_BURN_BASE = 0.6;
export const DRIVE_FUEL_BURN_SCALE = 0.6;
export const DRIVE_EMPTY_MAX_SPEED = 15;
/** 车耐久选项（房间可调）：撞路障/猎影扑击/爬窗破窗各 -1 */
export const DRIVE_DURABILITY_OPTIONS: readonly number[] = [2, 3, 5];
export const DRIVE_DEFAULT_DURABILITY = 3;

/* ---------------- 猎影（尾压） ---------------- */

export const DRIVE_GAP_MAX = 100;
/** 速度≥勿停线每秒回升 / 低于每秒衰减 */
export const DRIVE_GAP_REGEN = 4;
export const DRIVE_GAP_DRAIN = 6;
/** 噪音事件（撞路障/碾尸群）额外衰减 */
export const DRIVE_GAP_NOISE = 8;
/** 归零扑击后回置的距离 */
export const DRIVE_ATTACK_RESET = 50;
/** 猎影凶度（房间可调）：衰减速率 缓/标准/凶 */
export type DriveTail = 'lenient' | 'normal' | 'fierce';
export const DRIVE_TAIL_OPTIONS: readonly DriveTail[] = ['lenient', 'normal', 'fierce'];
export const DRIVE_DEFAULT_TAIL: DriveTail = 'normal';
export const DRIVE_TAIL_DRAIN: Record<DriveTail, number> = { lenient: 4, normal: 6, fierce: 8 };

/* ---------------- 窗与窗爬者（侧压） ---------------- */

/** 预警（抓挠声+红光）→ 爬入计时 → 未关窗则破窗 */
export const DRIVE_WARN_MS = 1_200;
export const DRIVE_CLIMB_MS = 3_000;
/** 爬窗调度基准间隔：随爬窗档位 / tier / 灯光缩放，钳制在 min-max 之间 */
export const DRIVE_CRAWL_BASE_MS = 14_000;
export const DRIVE_CRAWL_MIN_MS = 4_000;
export const DRIVE_CRAWL_MAX_MS = 60_000;
export const DRIVE_CRAWL_FIRST_MS = 8_000; // 开局宽限
/** tier 每级爬窗频率乘数（封顶） */
export const DRIVE_CRAWL_TIER_SCALE = 0.15;
export const DRIVE_CRAWL_TIER_CAP = 3;
/** 灯亮时爬窗频率乘数（光吸引） */
export const DRIVE_CRAWL_LAMP_MULT = 1.5;
/** 爬窗档位（房间可调）：低/标准/高（频率乘数倒数口径） */
export type DriveCrawlRate = 'low' | 'normal' | 'high';
export const DRIVE_CRAWL_OPTIONS: readonly DriveCrawlRate[] = ['low', 'normal', 'high'];
export const DRIVE_DEFAULT_CRAWL: DriveCrawlRate = 'normal';
export const DRIVE_CRAWL_RATE_MULT: Record<DriveCrawlRate, number> = { low: 0.6, normal: 1, high: 1.6 };

export type DriveSide = 'L' | 'R';

/* ---------------- 路面事件 ---------------- */

/** 事件生成视距：车头前方 600m 内保持有事件 */
export const DRIVE_EVENT_HORIZON = 600;
/** 相邻事件间距（米） */
export const DRIVE_EVENT_GAP_MIN = 120;
export const DRIVE_EVENT_GAP_MAX = 280;
/** 首个事件里程（开局直路宽限） */
export const DRIVE_EVENT_FIRST_AT = 150;
/** 路牌间隔选项（房间可调；每过一块路牌 tier+1、复活被拖走者） */
export const DRIVE_SIGN_GAP_OPTIONS: readonly number[] = [200, 300, 400, 600];
export const DRIVE_DEFAULT_SIGN_GAP = 400;
/** 尸群横穿区长度（米） */
export const DRIVE_SWARM_LEN = 40;
/** 加油站区长度（米）与加注条件 */
export const DRIVE_STATION_LEN = 30;
export const DRIVE_STATION_MAX_SPEED = 5;
export const DRIVE_STATION_FUEL_RATE = 30; // 每秒加注
export const DRIVE_STATION_GAP_BASE = 500;
/** 搜掠：需对应侧窗开 + 车速≤上限，驶过点即收取 */
export const DRIVE_LOOT_MAX_SPEED = 50;
export const DRIVE_LOOT_FUEL_MIN = 15;
export const DRIVE_LOOT_FUEL_MAX = 25;
export const DRIVE_LOOT_REPAIR_CHANCE = 0.3;
/** 撞击后的速度乘数 */
export const DRIVE_BARRIER_SLOW = 0.4;
export const DRIVE_SWARM_SLOW = 0.5;
/** 碾尸群的最低车速（低于此速不算碾） */
export const DRIVE_SWARM_MIN_SPEED = 10;

export type DriveEventKind = 'barrier' | 'swarm' | 'loot' | 'station';
/** 路面事件（服务端权威生成，视图只下发车头前方未消费的部分） */
export interface DriveEvent {
  /** 触发里程（米；swarm/station 为区起点） */
  at: number;
  kind: DriveEventKind;
  /** barrier/swarm 占用的车道（0=左 1=中 2=右） */
  lane?: 0 | 1 | 2;
  /** swarm 第二条占用车道 */
  lane2?: 0 | 1 | 2;
  /** loot/station 所在路肩 */
  side?: DriveSide;
  /** loot 内容（生成即定，视图可见——瞭望可以喊「右边有油」） */
  content?: 'fuel' | 'repair';
  /** 已被撞/碾/搜过（一次性判定） */
  hit?: boolean;
}

/* ---------------- 目标模式 ---------------- */

/** 目标路牌（房间可调）：0=纯无尽（冲距离），N=到达即全员逃生成功 */
export const DRIVE_TARGET_OPTIONS: readonly number[] = [0, 5, 10, 15];
export const DRIVE_DEFAULT_TARGET = 0;

/* ---------------- 意图（客户端 → 服务端，按键级） ---------------- */

/**
 * 按键意图。gas/brake/spot 为持键（按下发 on、松开发 off，掉线由服务器清零）；
 * lane/window/lamp 为边沿（单次触发）；ping 为瞭望标记（服务端随视图转发，全队可见）。
 * 非法值一律静默钳制/丢弃（高频通道不报错）。
 */
export type DriveIntent =
  | { k: 'gas'; on: boolean }
  | { k: 'brake'; on: boolean }
  | { k: 'spot'; on: boolean }
  | { k: 'lane'; dir: -1 | 1 }
  | { k: 'window'; side: DriveSide }
  | { k: 'lamp' }
  | { k: 'ping'; lane: number; at: number };

export interface DriveInputs {
  gas: boolean;
  brake: boolean;
  spot: boolean;
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
  /** 主动离场：留在结算里，不参与归因 */
  left: boolean;
  /** 本局搜掠次数 */
  loots: number;
  /** 被拖走次数 */
  dragged: number;
}

export interface DriveResult {
  /** won=到达目标路牌 abort=房主终止 leave=无人在场 idle=全员断线 dead=车毁人亡 */
  reason: 'won' | 'dead' | 'abort' | 'leave' | 'idle';
  /** 里程（米） */
  distance: number;
  /** 通过的路牌数 */
  signs: number;
  /** 局时长（毫秒） */
  durationMs: number;
  /** 猎影扑击次数 */
  attacks: number;
  /** 搏斗过的窗爬者次数 */
  crawls: number;
  /** 全队搜掠次数 */
  loots: number;
}

export interface DriveState {
  phase: 'driving' | 'gameover';
  players: DrivePlayerState[];
  /** 状态识别字段（rooms 层以 'road' in g 识别 drive 对局） */
  road: {
    /** 事件已生成到的里程 */
    generatedTo: number;
    /** 下一座加油站的里程 */
    nextStationAt: number;
    /** 未消费事件队列（按 at 升序） */
    events: DriveEvent[];
  };
  /** 车速 km/h */
  speed: number;
  lane: 0 | 1 | 2;
  /** 上次换道时刻（换道冷却） */
  laneChangedAt: number;
  fuel: number;
  durability: number;
  /** 耐久上限（开局设置快照；搜掠修复封顶） */
  maxDurability: number;
  /** 上次 tick 时刻（dt 积分用；rooms 层 66ms 一拍） */
  lastTickAt: number;
  /** 猎影距离 0-100（满=安全，归零=扑击） */
  gap: number;
  /** 车头里程（米） */
  pos: number;
  /** 已通过的路牌数 = tier */
  signs: number;
  /** 下一个路牌里程 */
  nextSignAt: number;
  windows: { L: DriveWindowState; R: DriveWindowState };
  lamp: boolean;
  /** 持键（按玩家 id；downed/left/断线者不计入） */
  inputs: Record<string, DriveInputs>;
  /** 瞭望标记（最近 8 条；客户端按 ts 渲染 2.5s） */
  pings: { lane: number; at: number; ts: number; by: string }[];
  /** 下一只窗爬者的预警时刻（0=未调度） */
  nextCrawlAt: number;
  /** 统计 */
  attacks: number;
  crawls: number;
  /* 房间设置快照（开局时由 rooms 层传入） */
  signGap: number;
  tail: DriveTail;
  crawlRate: DriveCrawlRate;
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
  lane: number;
  fuel: number;
  durability: number;
  /** 耐久上限（渲染耐久灯用） */
  maxDurability: number;
  gap: number;
  pos: number;
  signs: number;
  targetSigns: number;
  signGap: number;
  tail: DriveTail;
  crawlRate: DriveCrawlRate;
  windows: { L: DriveViewWindow; R: DriveViewWindow };
  lamp: boolean;
  /** 车头前方的未消费事件（含正在穿过的区），客户端渲染用 */
  events: DriveEvent[];
  pings: DriveState['pings'];
  /** 我自己的持键状态（观战者/被拖走者为 null）——重连同步用 */
  myInputs: DriveInputs | null;
  /** 我是否被拖走 */
  iDowned: boolean;
  spectator: boolean;
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
