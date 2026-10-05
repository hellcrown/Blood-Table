/**
 * 血色牌局 · 前后端共享协议（纯类型，无运行时代码）
 * 服务端与客户端均只 import type 使用。
 */

/* ---------------- 扑克牌 ---------------- */

export type Suit = 's' | 'h' | 'd' | 'c'; // 黑桃 红心 方块 梅花
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14; // 14 = A

export interface Card {
  r: Rank;
  s: Suit;
}

/* ---------------- 房间与对局 ---------------- */

export type Phase =
  | 'waiting' // 房间等待中（未开始/已重置）
  | 'preflop'
  | 'flop'
  | 'turn'
  | 'river'
  | 'result' // 本手结算（亮牌/赢池展示）
  | 'gameover'; // 整场结束（仅剩一名有筹码玩家）

export interface RoomSettings {
  sb: number; // 小盲
  bb: number; // 大盲
  startChips: number; // 初始筹码
}

export interface LogLine {
  seq: number;
  kind: 'hand' | 'action' | 'street' | 'win' | 'sys';
  text: string;
}

export interface SeatView {
  id: string;
  name: string;
  seat: number;
  chips: number;
  isHost: boolean;
  connected: boolean;
  /** 服务端机器人（客户端据此渲染「移除机器人」，不得用昵称启发式——人类可取 🤖 开头昵称） */
  isBot: boolean;
  sittingOut: boolean; // 已出局或等待下场
  inHand: boolean; // 本手牌中且未弃牌
  folded: boolean;
  allIn: boolean;
  bet: number; // 本轮街已投入
  committed: number; // 本手总投入
  isButton: boolean;
  role: 'sb' | 'bb' | null;
  lastAction: string | null;
  /** 本街是否已行动（短全下限制判定用） */
  acted?: boolean;
  hasCards: boolean;
  /** 自己的底牌，或摊牌后公开的底牌；其余情况为 null */
  hole: Card[] | null;
  handName: string | null;
  won: number;
}

/** 全服聊天消息（实时广播与历史快照共用；account=true 表示昵称经登录验证） */
export interface ChatMsg {
  name: string;
  text: string;
  ts: number;
  account?: boolean;
}

/** 公开房间列表项（大厅展示；仅无密码房进入此列表） */
export interface PublicRoomInfo {
  code: string;
  mode: GameMode;
  /** 原始阶段值：waiting / 各对局阶段 / gameover */
  phase: string;
  /** 坐席数（非观战会话，含 bot 与断线座位——与满员判定同口径） */
  players: number;
  maxPlayers: number;
  host: string;
}

export interface HandResultRow {
  seat: number;
  name: string;
  hole: Card[] | null;
  handName: string | null;
  won: number;
  net: number;
  foldedOut: boolean;
}

export interface HandResultView {
  rows: HandResultRow[];
  pots: { amount: number; winners: number[] }[];
  nextIn: number; // 自动下一局秒数
}

export interface GameOverView {
  ranking: { seat: number; name: string; chips: number; wasAuto?: boolean }[];
}

export interface TableView {
  kind?: 'classic';
  code: string;
  mode: GameMode;
  phase: Phase;
  handNumber: number;
  maxPlayers: number;
  settings: RoomSettings;
  hostId: string;
  /** 房间是否设置了密码（不下发密码本体） */
  hasPassword?: boolean;
  /** 血色模式：拓展选将开关（选将始终进行；开=角色池并入拓展角色，关=仅基础4角色） */
  charExpansion: boolean;
  /** 血色模式：拓展黑市开关（开=牌库并入拓展牌；默认关） */
  expansion: boolean;
  /** 血色模式：自定义目标票数（0=按人数默认 24/20/16，钳制 8-30） */
  targetTickets: number;
  players: SeatView[];
  community: Card[];
  pot: number; // 总池（含本轮未收入注）
  currentBet: number;
  minRaiseTo: number; // 最小加注到的额度（当前注 + 最小加注幅度）
  toActSeat: number | null;
  deadline: number | null; // 行动截止 epoch ms
  /** 短全下限制：已行动者只能跟/弃（客户端下注控件据此收起加注） */
  shortAllIn?: boolean;
  log: LogLine[];
  result: HandResultView | null;
  final: GameOverView | null;
  serverTime: number;
}

/* ---------------- 客户端 → 服务端 ---------------- */

export type GameMode = 'classic' | 'blood';

export interface PlayerActionFold {
  k: 'fold';
}
export interface PlayerActionCheck {
  k: 'check';
}
export interface PlayerActionCall {
  k: 'call';
}
export interface PlayerActionRaise {
  k: 'raise';
  to: number; // 本街目标总注（含已投入）
}
export interface PlayerActionAllIn {
  k: 'allin';
}

export type PlayerAction =
  | PlayerActionFold
  | PlayerActionCheck
  | PlayerActionCall
  | PlayerActionRaise
  | PlayerActionAllIn;

export type C2S =
  | { t: 'create'; name: string; maxPlayers: number; mode?: GameMode; password?: string; auth?: string }
  | { t: 'join'; name: string; code: string; password?: string; auth?: string; adminToken?: string }
  | { t: 'spectate'; name: string; code: string; password?: string; auth?: string; adminToken?: string }
  | { t: 'enterSpectate' }
  | { t: 'replaceBot'; seat: number }
  | { t: 'backToRoom' }
  | { t: 'rejoin'; token: string; auth?: string }
  | { t: 'leave' }
  | { t: 'start' }
  | { t: 'settings'; sb?: number; bb?: number; startChips?: number; maxPlayers?: number; charExpansion?: boolean; expansion?: boolean; targetTickets?: number; password?: string }
  | { t: 'sit'; seat: number }
  | { t: 'addBot' }
  | { t: 'kickBot'; seat: number }
  | { t: 'kickPlayer'; seat: number }
  | { t: 'act'; action: PlayerAction }
  | { t: 'nextHand' }
  | { t: 'rematch' }
  | { t: 'react'; seat: number; kind: 'flower' | 'egg' }
  | { t: 'ping'; n: number }
  | { t: 'listRooms' }
  | { t: 'chat'; text: string; name?: string; auth?: string }
  | { t: 'chatHistory' }
  | import('./bloodProtocol').BloodAction;

/* ---------------- 服务端 → 客户端 ---------------- */

export type S2C =
  | { t: 'hello'; token: string; playerId: string; account?: { id: string; name: string } }
  | { t: 'state'; view: TableView | import('./bloodProtocol').BloodView }
  | { t: 'event'; line: LogLine }
  | { t: 'fx'; kind: 'flower' | 'egg'; from: number; to: number }
  | { t: 'error'; code: string; msg: string }
  | { t: 'pong'; n: number }
  | { t: 'roomList'; rooms: PublicRoomInfo[] }
  | { t: 'chatMsg'; name: string; text: string; ts: number; account?: boolean }
  | { t: 'chatLog'; msgs: ChatMsg[] };
