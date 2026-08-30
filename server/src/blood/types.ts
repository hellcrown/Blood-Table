import type { Suit } from '@shared/protocol';
import type { LogLine } from '@shared/protocol';

/** 血色牌局基础牌（s=null 为大小王） */
export interface BCard {
  id: string;
  r: number; // 2..14，王牌为 0
  s: Suit | null;
}

/** 已购入的强化芯片实例（挂在某张牌上，随牌移动） */
export interface ChipInst {
  id: string;
  def: string; // BloodMarketDef.id
  on: string; // 挂载的 BCard.id
}

export interface ItemInst {
  id: string;
  def: string;
}

export interface BPlayer {
  id: string;
  name: string;
  seat: number;
  blood: number; // 血筹
  tickets: number; // 车票
  draw: BCard[]; // 抽牌堆（队尾出）
  hand: BCard[]; // 手牌（私有）
  discard: BCard[]; // 弃牌区（私有可见）
  removed: BCard[]; // 删牌区
  play: BCard[]; // 出牌区（亮牌前私有）
  chips: ChipInst[];
  items: ItemInst[];
  privilege: boolean;
  swapLeft: number;
  swapDone: boolean;
  locked: boolean;
  buyPassed: boolean;
  removeDone: boolean;
  reorgDone: boolean;
  setupRound: number;
  setupHand: BCard[];
  /** 已选角色牌 id（选将完成前为 null） */
  charId: string | null;
  /** 选将阶段随机抽到的两张角色牌 id */
  charOptions: string[];
  /** 主播：本回合是否已触发（每回合一次） */
  streamerUsed: boolean;
  /** 吉祥物：本回合是否已用首次购买优惠 */
  firstBuyUsed: boolean;
  /** 魏王：本回合购买阶段是否购买过黑市牌 */
  boughtAny: boolean;
  /** 编剧：本回合未达 50 点 → 跳过购买与删牌 */
  skipBuyRemove: boolean;
  /** 闭店礼：跳过本回合购买阶段 */
  skipBuy: boolean;
  /** 双重人格公主：true=常时人格（黑），false=躁狂人格（红） */
  princessDark: boolean;
  /** 对决展示确认（settle 阶段全员确认后统一进入购买） */
  sdSeen: boolean;
  lastAction: string | null;
  connected: boolean;
}

export interface MarketSlot {
  def: string | null; // BloodMarketDef.id
  bonus: number; // 叠加的血筹
}

export type BloodPhase =
  | 'pick' // 选将（随机抽2张角色牌选1）
  | 'setup' // 初始构筑
  | 'draw'
  | 'swap'
  | 'play'
  | 'reveal' // 对决宣告
  | 'settle' // 结算展示（短暂）
  | 'buy'
  | 'remove'
  | 'reorg'
  | 'gameover';

export interface SettleRow {
  seat: number;
  name: string;
  cat: number;
  catName: string;
  pips: number;
  rank: number;
  gainTickets: number;
  gainBlood: number;
  /** 核心牌数量（对决演示时长计算用，不对外下发） */
  cores: number;
  /** 摊牌亮出的牌（无人跟注获胜等未亮牌场景为 null） */
  cards: BCard[] | null;
}

export interface BloodResultView {
  rows: SettleRow[];
  winnerSeat: number;
  comparePipsFirst: boolean;
}

export interface BloodFinal {
  winnerSeat: number;
  ranking: { seat: number; name: string; tickets: number; blood: number }[];
}

export interface BloodState {
  phase: BloodPhase;
  round: number;
  players: BPlayer[];
  seatCount: number;
  supply: string[];
  market: MarketSlot[];
  recycle: string[];
  turnSeat: number | null;
  deadline: number | null;
  stealPending: { seat: string; blood: number } | null;
  secretPending: {
    seat: string;
    kind: 'deleteUpTo' | 'violentTarget' | 'insertChip' | 'refreshPick';
    max?: number;
    chipId?: string;
    defId?: string;
  } | null;
  comparePipsFirst: boolean;
  /** 黑市牌宣告（购买/使用时向所有人公示），由客户端展示数秒 */
  announce: { defId: string; buyerSeat: number; at: number; extra?: string } | null;
  revealed: { seat: number; cardIds: string[] }[];
  result: BloodResultView | null;
  resultAt: number | null;
  /** 换牌阶段：是否已有玩家宣告结束（白蔷薇判定） */
  swapStopSeen: boolean;
  final: BloodFinal | null;
  target: number;
  log: LogLine[];
  logSeq: number;
  privilegeSeat: number | null;
}

export const BLOOD_TURN_MS = 60_000;
export const BLOOD_SD_WAIT_MS = 30_000; // 对决展示确认等待上限（演示播完后起算，超时自动确认推进）
export const BLOOD_SETUP_KEEP = 4; // 每轮初始构筑最多删 4 张
export const BLOOD_HAND_CAP = 6;
export const BLOOD_PLAY_COUNT = 5;
