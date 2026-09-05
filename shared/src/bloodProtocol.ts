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
  /** 捣蛋鬼：其弃牌区对所有人公开（本人视图不含，直接看 me.discard） */
  impDiscard?: BloodCardView[];
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
    | 'pinpointVictim'
    /** 拓展角色交互 */
    | 'gamblerGuess'
    | 'bomberClaim'
    | 'succubusSteal'
    | 'scalperDeal'
    | 'studentDump'
    | 'studentRemove'
    | 'designerDiscard'
    | 'dogTarget'
    | 'generalChoice'
    | 'vagrantDraw'
    | 'fryerDel'
    | 'curseTake'
    | 'godPeek'
    | 'detectivePick'
    | 'hackerSetup'
    | 'smugglerMark'
    | 'pirateRob'
    | 'pirateDecide'
    | 'auctionPick'
    | 'auctionBid'
    | 'impDraw'
    | 'impRedeem'
    | 'facelessPick'
    | 'blufferDeclare'
    | 'blufferChallenge'
    | 'ceoGive'
    | 'ceoDecide'
    | 'agentAsk'
    | 'agentDecide'
    | 'mynameSet'
    | 'cleanerDel';
  /** setup: 最多可删除张数；deleteUpTo/refreshPick: 上限；remove: 额外删除单价 */
  max?: number;
  cost?: number;
  defId?: string; // insertChip: 待插入芯片
  /** preciseDel: 抽到的 3 张牌；hackerSetup: 自己抽牌堆；detectivePick: 自己弃牌区 */
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
  /** succubusSteal：本次抢夺金额 */
  blood?: number;
  /** auctionBid：当前最高价 */
  amount?: number;
  /** auctionPick：可暗置的两张黑市牌 defId；facelessPick：两张候选角色 id */
  options?: string[];
  /** ceoGive：已给出的累计血筹 */
  given?: number;
  /** cleanerDel：所有玩家的弃牌区（全牌库自选删除用） */
  zones?: { seat: number; cards: { id: string; r: number; s: string | null }[] }[];
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
    /** 2人局选将阶段：随机抽到的两张角色牌 id（选完或非选将阶段为空；3/4人局随机分配不经过选将） */
    charOptions: string[];
    hand: BloodCardView[];
    discard: BloodCardView[];
    removed: BloodCardView[];
    drawCount: number;
    setupHand: BloodCardView[];
    items: { id: string; defId: string; name: string; text: string }[];
    swapLeft: number;
    /** 自己的出牌区（designer/student/agent/bluffer 等交互需要） */
    playCards?: BloodCardView[];
    /** 咒术师/入殓师：角色牌下的藏牌 */
    stash?: { curse: BloodCardView[]; undertaker: BloodCardView[] };
    /** 窥天师：自己抽牌堆顶 1 张 */
    seerTop?: BloodCardView | null;
    /** 窥天师：天意（可购买的黑市牌，价格为原价-2） */
    seerZone?: { defId: string; name: string; cost: number; text: string }[];
    /** 赌神：换牌结束查看的所有玩家手牌 */
    peekHands?: { seat: number; cards: BloodCardView[] }[];
    /** 赌狗：本回合是否已发动掷骰删牌 */
    dogUsed?: boolean;
    /** 无面人：临时持有的角色技能 */
    tempChar?: string | null;
    /** 走私客：本回合被标记的黑市栏位（-1 无） */
    smugglerSlot?: number;
  };
  prompt: BloodMyPrompt;
}

/* ---------------- 客户端 → 服务端：血色动作 ---------------- */

export type BloodAction =
  | { t: 'bPickChar'; charId: string }
  | { t: 'bSetup'; removed: string[] }
  | { t: 'bSwap'; cardIds: string[]; drawCount?: number }
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
  | { t: 'bReorg'; choice: 'reshuffle' | 'blood'; pickCardId?: string }
  | { t: 'bRematch' }
  /* 拓展角色 */
  | { t: 'bGamblerGuess'; seat: number }
  | { t: 'bBomberClaim'; x: number }
  | { t: 'bSuccubusSteal'; seat: number }
  | { t: 'bScalperDeal'; accept: boolean }
  | { t: 'bStudentDump'; accept: boolean; cardId?: string }
  | { t: 'bDesignerDiscard'; cardIds: string[] }
  | { t: 'bDogTarget'; seat: number }
  | { t: 'bGeneralChoice'; mode: 'gift' | 'extra' | 'skip'; seat?: number }
  | { t: 'bVagrantDraw'; seat: number }
  | { t: 'bFryerDraw' }
  | { t: 'bFryerDel'; cardIds: string[]; done: boolean }
  | { t: 'bCurseHide'; cardId: string }
  | { t: 'bCurseTake'; cardIds: string[] }
  | { t: 'bUndertakerSwap'; cardIds: string[] }
  | { t: 'bGodPeekChoice'; mode: 'extra' | 'blood' }
  | { t: 'bDetectivePick'; mode: 'top' | 'bottom' | 'skip'; cardIds: string[] }
  | { t: 'bHackerSetup'; removed: string[] }
  | { t: 'bSmugglerMark'; slot: number }
  | { t: 'bPirateRob'; seat: number }
  | { t: 'bPirateDecide'; resist: boolean }
  | { t: 'bAuctionPick'; idx: number }
  | { t: 'bAuctionBid'; amount: number }
  | { t: 'bBuySeer'; idx: number }
  | { t: 'bImpDraw'; seat: number }
  | { t: 'bImpRedeem'; accept: boolean }
  | { t: 'bFacelessPick'; charId: string }
  | { t: 'bFacelessConvert' }
  | { t: 'bBlufferDeclare'; declared: { id: string; r: number; s: import('./protocol').Suit | null }[] }
  | { t: 'bBlufferChallenge'; challenge: boolean }
  | { t: 'bCeoGive'; seat: number; amount: number }
  | { t: 'bCeoDone' }
  | { t: 'bCeoDecide'; accept: boolean }
  | { t: 'bAgentAsk'; seat: number }
  | { t: 'bAgentDecide'; accept: boolean }
  | { t: 'bMynameSet'; cat: number; name: string }
  | { t: 'bCleanerDel'; seat: number; cardId: string };

export type { BloodEffect };
