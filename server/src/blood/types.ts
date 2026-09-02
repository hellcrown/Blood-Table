import type { Suit } from '@shared/protocol';
import type { BloodEffect } from '@shared/bloodCards';
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
  /** 消磁枪/屏蔽器：本次对决失效 */
  off?: boolean;
  /** 弹簧夹层：本次对决临时点数修正（±X） */
  springMod?: number;
  /** 复制芯片：复制得到的效果快照 */
  copiedFx?: BloodEffect;
}

/** 亮牌决策队列条目 */
export interface RevealDecision {
  t: 'spring' | 'copy' | 'shield';
  chipId: string;
  cardId: string;
  defId: string;
}

/** 防护屏障待反制的序列化效果 */
export interface BarrierEffect {
  t: 'violent' | 'pinpoint' | 'boxRob' | 'poison' | 'freeze' | 'amnesia' | 'signal' | 'demag';
  by: string; // 发起者 playerId
  seat: string; // 受害者 playerId
  rank?: number; // pinpoint
  n?: number; // violent
  /** 结算后推进：market=购买轮推进 / reveal=对决窗口推进 / none=无 */
  after: 'market' | 'reveal' | 'none';
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
  /** 餐车投毒：下回合换牌次数 -N */
  swapMalus: number;
  /** 暂时失忆：下回合角色技能失效 */
  charOff: boolean;
  charOffNextRound: boolean;
  /** 冻结车厢 / 广播喇叭（失败）：跳过本回合重整 */
  skipReorg: boolean;
  /** 广播喇叭：本回合已宣称夺魁 */
  claimedWin: boolean;
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
    kind: 'deleteUpTo' | 'violentTarget' | 'insertChip' | 'refreshPick'
      | 'poisonTarget' | 'freezeTarget' | 'amnesiaTarget' | 'boxRobTarget'
      | 'pinpointClaim' | 'pullChip' | 'preciseDel' | 'signalTarget' | 'demagTarget'
      | 'irisGuess' | 'sharedInfo' | 'sharedInfoOpp' | 'eraserClaim'
      | 'revealDecide' | 'barrierAsk' | 'demagPick' | 'pinpointVictim';
    max?: number;
    chipId?: string;
    defId?: string;
    /** preciseDel: 抽到的 3 张牌 */
    cards?: BCard[];
    /** 共享信息等待顺序的对手队列 */
    oppQueue?: string[];
    buyerId?: string;
    /** revealDecide：决策队列与当前决策 */
    queue?: RevealDecision[];
    decision?: RevealDecision;
    /** barrierAsk：待反制效果与描述 */
    barrier?: BarrierEffect;
    eff?: string;
    /** demagPick：消磁目标座位；pinpointVictim：受害者座位 */
    targetSeat?: string;
    /** pinpointVictim：被宣称的点数 */
    rank?: number;
  } | null;
  /** 魔术橡皮：本回合被降为高牌的牌型 */
  eraserType: number | null;
  /** 赌徒虹膜：本回合的竞猜 */
  irisGuess: { by: string; seat: number; cat: number } | null;
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
