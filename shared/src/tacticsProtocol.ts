/**
 * 血色猎场（格子战棋大逃杀）· 前后端共享协议
 * 玩法：2~4 人在随机对称地图上回合制行动，狩猎静态野怪、互相厮杀，最后存活者获胜。
 * 口径：移动按 BFS 真实路径逐格 1 AP（墙/棋子阻挡）；距离与射程一律为曼哈顿距离（墙挡脚不挡手）。
 */
import type { GameMode, LogLine } from './protocol';

/** 地图尺寸档位（房间内可调） */
export type TacticsMapSize = 'small' | 'medium' | 'large';

export interface TacticsMapPreset {
  rows: number;
  cols: number;
  /** 野怪编成（精英石像守卫镇守中心附近） */
  monsters: { type: MonsterType; count: number }[];
}

export const TACTICS_MAP_PRESETS: Record<TacticsMapSize, TacticsMapPreset> = {
  small: {
    rows: 11,
    cols: 11,
    monsters: [
      { type: 'golem', count: 1 },
      { type: 'crossbow', count: 1 },
      { type: 'leech', count: 1 },
    ],
  },
  medium: {
    rows: 15,
    cols: 15,
    monsters: [
      { type: 'golem', count: 1 },
      { type: 'crossbow', count: 2 },
      { type: 'leech', count: 2 },
    ],
  },
  large: {
    rows: 19,
    cols: 19,
    monsters: [
      { type: 'golem', count: 2 },
      { type: 'crossbow', count: 3 },
      { type: 'leech', count: 3 },
    ],
  },
};

/** 回合时限（秒）：0=默认；房间可选档位与钳制范围 */
export const TACTICS_DEFAULT_TURN_SEC = 60;
export const TACTICS_TURN_SEC_OPTIONS = [30, 60, 90];
export const TACTICS_TURN_SEC_MIN = 10;
export const TACTICS_TURN_SEC_MAX = 300;

/** 墙密度随机区间（180° 中心对称生成） */
export const TACTICS_WALL_DENSITY = { min: 0.25, max: 0.33 };
/** 野怪出生点保护：野怪离每个出生点的最小曼哈顿距离 */
export const TACTICS_SPAWN_MIN_DIST = 3;

/* ---------------- 野怪（全静态守卫：不移动、无怪回合） ---------------- */

export type MonsterType = 'leech' | 'crossbow' | 'golem';

export interface TacticsMonsterDef {
  name: string;
  hp: number;
  atk: number;
  /** 攻击射程（曼哈顿距离） */
  range: number;
  /** 击杀掉落金币（局内经济二期开放，字段先行预留） */
  gold: number;
}

export const TACTICS_MONSTERS: Record<MonsterType, TacticsMonsterDef> = {
  leech: { name: '血蛭', hp: 3, atk: 1, range: 1, gold: 2 },
  crossbow: { name: '废墟弩手', hp: 4, atk: 1, range: 2, gold: 3 },
  golem: { name: '石像守卫', hp: 6, atk: 2, range: 1, gold: 5 },
};

/* ---------------- 角色（数值全在表里，引擎只读表；二期多角色直接扩表） ---------------- */

export type TacticsSkillKind = 'strike' | 'heal';

export interface TacticsSkillDef {
  id: string;
  name: string;
  kind: TacticsSkillKind;
  /** 射程（曼哈顿距离）；heal 固定 0=仅自身 */
  range: number;
  /** strike=伤害 / heal=回复量 */
  power: number;
  /** 冷却：使用后需经过的自己回合数（回合开始递减，减到 0 可再用） */
  cooldown: number;
}

export interface TacticsCharacterDef {
  id: string;
  name: string;
  hp: number;
  /** 每回合行动点（角色属性，永不做房间可调参数） */
  ap: number;
  atk: number;
  atkRange: number;
  skills: TacticsSkillDef[];
}

export const TACTICS_CHARACTERS: Record<string, TacticsCharacterDef> = {
  hunter: {
    id: 'hunter',
    name: '猎血人',
    hp: 10,
    ap: 4,
    atk: 2,
    atkRange: 1,
    skills: [
      { id: 'smash', name: '重击', kind: 'strike', range: 1, power: 4, cooldown: 3 },
      { id: 'bandage', name: '包扎', kind: 'heal', range: 0, power: 3, cooldown: 4 },
    ],
  },
};

/** 首版唯一角色；开局统一使用 */
export const TACTICS_DEFAULT_CHAR = 'hunter';

/* ---------------- 服务端权威状态 ---------------- */

export interface TacticsPlayerState {
  id: string;
  name: string;
  seat: number;
  charId: string;
  hp: number;
  maxHp: number;
  ap: number;
  maxAp: number;
  r: number;
  c: number;
  alive: boolean;
  /** 淘汰时刻（仅阵亡者） */
  deadAt?: number;
  /** 技能剩余冷却（按技能下标；0=可用） */
  cooldowns: number[];
  /** ——预留：局内经济（首版恒 0/空）—— */
  gold: number;
  items: string[];
}

export interface TacticsMonsterState {
  id: string;
  type: MonsterType;
  hp: number;
  maxHp: number;
  r: number;
  c: number;
  /** 击杀掉落金币（二期） */
  gold: number;
}

export interface TacticsRankRow {
  seat: number;
  name: string;
  rank: number;
  hp: number;
  alive: boolean;
}

/**
 * 服务端权威对局状态。除「内部字段」段外均为公开信息（本作无隐藏信息，地形/野怪全量下发）。
 */
export interface TacticsState {
  mapSize: TacticsMapSize;
  rows: number;
  cols: number;
  /** 地形格（0=平地 1=墙），行优先展开 */
  grid: number[];
  phase: 'playing' | 'gameover';
  /** 座位序 = 行动顺序 */
  players: TacticsPlayerState[];
  monsters: TacticsMonsterState[];
  /** 当前行动玩家 */
  currentId: string;
  /** 已开始的回合数（每人行动一次 +1） */
  turnNumber: number;
  startedAt: number;
  /** 当前回合截止时刻 */
  deadline: number;
  /** 牌局记录（与血色/扫雷同一广播与面板机制） */
  log: LogLine[];
  logSeq: number;
  winnerId: string | null;
  /** 终局排名（gameover 后） */
  ranking: TacticsRankRow[];
  /** ——以下为服务端内部字段，绝不下发—— */
  /** 回合时限毫秒（advanceTurn 重置 deadline 用） */
  turnMs: number;
}

/* ---------------- 下发视图 ---------------- */

export interface TacticsPlayerRow {
  id: string;
  name: string;
  seat: number;
  charId: string;
  hp: number;
  maxHp: number;
  ap: number;
  maxAp: number;
  r: number;
  c: number;
  alive: boolean;
  cooldowns: number[];
  gold: number;
  items: string[];
  connected: boolean;
}

export interface TacticsMonsterRow {
  id: string;
  type: MonsterType;
  hp: number;
  maxHp: number;
  r: number;
  c: number;
}

/** 下发给会话的战棋视图：kind='tactics' */
export interface TacticsView {
  kind: 'tactics';
  mode: GameMode;
  /** 房间码 */
  code: string;
  /** 房主会话 id（再来一局按钮用） */
  hostId: string;
  mapSize: TacticsMapSize;
  rows: number;
  cols: number;
  grid: number[];
  phase: 'playing' | 'gameover';
  players: TacticsPlayerRow[];
  monsters: TacticsMonsterRow[];
  currentId: string;
  turnNumber: number;
  startedAt: number;
  /** 当前回合截止（gameover 后为 null） */
  deadline: number | null;
  /** 牌局记录 */
  log: LogLine[];
  logSeq: number;
  /** 自己在对局内的玩家 id（观战为 null） */
  youId: string | null;
  spectator: boolean;
  ranking: TacticsRankRow[];
  winnerId: string | null;
  serverTime: number;
}
