import type { LogLine, Suit } from './protocol';
import type { BloodEffect, MarketKind } from './bloodCards';

/* ---------------- 服务端 → 客户端：血色视图 ---------------- */

export interface BloodCardView {
  id: string;
  r: number; // 0 = 王牌
  s: Suit | null;
  chipIds: string[]; // 挂载的强化芯片 def id
}

export interface BloodSeatView {
  id: string;
  name: string;
  seat: number;
  blood: number;
  tickets: number;
  connected: boolean;
  privilege: boolean;
  /** 已选角色牌 id（选将完成前为 null） */
  charId: string | null;
  handCount: number;
  drawCount: number;
  itemCount: number;
  swapLeft: number;
  swapDone: boolean;
  locked: boolean;
  buyPassed: boolean;
  removeDone: boolean;
  reorgDone: boolean;
  lastAction: string | null;
  /** 对决展示是否已确认（settle 阶段全员确认后统一进入购买） */
  sdSeen: boolean;
  /** 对决/结算阶段公开的出牌与评估结果 */
  played?: BloodCardView[];
  handName?: string;
  pips?: number;
}

export interface BloodMarketSlotView {
  defId: string | null;
  name: string;
  kind: MarketKind;
  cost: number;
  text: string;
  bonus: number;
}

export interface BloodSettleCardView {
  id: string;
  r: number;
  s: Suit | null;
  chipIds: string[];
}

export interface BloodSettleRowView {
  seat: number;
  name: string;
  /** 牌型数值（服务端权威，含角色技能修正；客户端不再自行重算） */
  cat: number;
  catName: string;
  pips: number;
  rank: number;
  gainTickets: number;
  gainBlood: number;
  /** 摊牌亮出的牌（未亮牌场景为 null） */
  cards: BloodSettleCardView[] | null;
}

export interface BloodMyPrompt {
  k:
    | 'pick'
    | 'setup'
    | 'swap'
    | 'play'
    | 'revealItem'
    | 'steal'
    | 'sdConfirm'
    | 'buy'
    | 'insertChip'
    | 'secretDelete'
    | 'violentTarget'
    | 'refreshPick'
    | 'remove'
    | 'reorg'
    | 'wait'
    /** 拓展牌交互 */
    | 'poisonTarget'
    | 'freezeTarget'
    | 'amnesiaTarget'
    | 'boxRobTarget'
    | 'pinpointClaim'
    | 'pullChip'
    | 'preciseDel'
    | 'signalTarget'
    | 'demagTarget'
    | 'irisGuess'
    | 'eraserClaim'
    | 'revealDecide'
    | 'barrierAsk'
    | 'demagPick'
    | 'pinpointVictim';
  /** setup: 最多可删除张数；deleteUpTo/refreshPick: 上限；remove: 额外删除单价 */
  max?: number;
  cost?: number;
  defId?: string; // insertChip: 待插入芯片
  /** preciseDel: 抽到的 3 张牌 */
  cards?: { id: string; r: number; s: string | null }[];
  /** revealDecide：当前决策类型与决策牌 */
  decision?: { t: 'spring' | 'copy' | 'shield'; cardId: string };
  chipId?: string;
  /** barrierAsk：待反制效果描述 */
  eff?: string;
  /** demagPick / pinpointVictim：目标或受害者座位号 */
  targetSeat?: number;
  /** pinpointVictim：被宣称的点数 */
  rank?: number;
}

export interface BloodAnnounceView {
  defId: string;
  name: string;
  kind: MarketKind;
  text: string;
  cost: number;
  buyerSeat: number;
  buyerName: string;
  at: number;
  /** 附加结果说明（如对赌协议的掷骰点数） */
  extra?: string;
}

export interface BloodView {
  kind: 'blood';
  code: string;
  phase: 'pick' | 'setup' | 'draw' | 'swap' | 'play' | 'reveal' | 'settle' | 'buy' | 'remove' | 'reorg' | 'gameover';
  round: number;
  target: number;
  seatCount: number;
  hostId: string;
  serverTime: number;
  players: BloodSeatView[];
  market: BloodMarketSlotView[];
  supplyCount: number;
  recycleCount: number;
  turnSeat: number | null;
  deadline: number | null;
  comparePipsFirst: boolean;
  announce: BloodAnnounceView | null;
  /** 对决展示等待确认（settle 阶段非空：已确认数/总数） */
  showdownWait: { done: number; total: number } | null;
  result: { rows: BloodSettleRowView[]; winnerSeat: number; comparePipsFirst: boolean } | null;
  final: { winnerSeat: number; ranking: { seat: number; name: string; tickets: number; blood: number }[] } | null;
  log: LogLine[];
  logSeq: number;
  me: {
    seat: number;
    blood: number;
    tickets: number;
    /** 选将阶段：随机抽到的两张角色牌 id（选完或非选将阶段为空） */
    charOptions: string[];
    hand: BloodCardView[];
    discard: BloodCardView[];
    removed: BloodCardView[];
    drawCount: number;
    setupHand: BloodCardView[];
    items: { id: string; defId: string; name: string; text: string }[];
    swapLeft: number;
  };
  prompt: BloodMyPrompt;
}

/* ---------------- 客户端 → 服务端：血色动作 ---------------- */

export type BloodAction =
  | { t: 'bPickChar'; charId: string }
  | { t: 'bSetup'; removed: string[] }
  | { t: 'bSwap'; cardIds: string[] }
  | { t: 'bSwapStop' }
  | { t: 'bPlay'; cardIds: string[] }
  | { t: 'bUseItem'; itemId: string | null }
  | { t: 'bSteal'; seat: number }
  | { t: 'bShowdownDone' }
  | { t: 'bResign' }
  | { t: 'bSecretTarget'; seat: number }
  | { t: 'bPinpoint'; seat: number; rank: number }
  | { t: 'bIrisGuess'; seat: number; cat: number }
  | { t: 'bPreciseDel'; cardIds: string[] }
  | { t: 'bPullChip'; cardId: string }
  | { t: 'bEraserClaim'; cat: number }
  | { t: 'bSpringUse'; chipId: string; mod: number }
  | { t: 'bRevealChipTarget'; seat: number; cardId: string; defId: string }
  | { t: 'bSkipDecision' }
  | { t: 'bBarrierDecide'; use: boolean }
  | { t: 'bDemagPick'; cardId: string; defId: string }
  | { t: 'bPinpointVictimPick'; cardId: string }
  | { t: 'bBuy'; slot: number; insertInto?: string }
  | { t: 'bInsertChip'; cardId: string }
  | { t: 'bInsertSkip' }
  | { t: 'bSecretDelete'; cardIds: string[] }
  | { t: 'bViolent'; seat: number }
  | { t: 'bRefreshPick'; slots: number[] }
  | { t: 'bPassBuy' }
  | { t: 'bRemove'; cardIds: string[] }
  | { t: 'bRemoveDone' }
  | { t: 'bReorg'; choice: 'reshuffle' | 'blood' }
  | { t: 'bRematch' };

export type { BloodEffect };
