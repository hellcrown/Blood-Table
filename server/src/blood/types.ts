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
  /** 咒术师：藏在角色牌下的【5】（视为在游戏外） */
  curseStash: BCard[];
  /** 入殓师：特殊换牌置于角色牌上的牌 */
  undertakerStash: BCard[];
  /** 入殓师：本回合是否用过特殊换牌 */
  undertakerUsed: boolean;
  /** 赌狗：本回合是否已发动掷骰删牌 */
  dogUsed: boolean;
  /** 将军/赌神：额外换牌次数不兑换成血筹 */
  extraSwapProtected: boolean;
  /** 炸鸡店老板：本回合结算期已删除的本回合打出牌张数（≤3） */
  fryerDelCount: number;
  /** 咖啡师：本回合购买后待发放的免费黑市牌 */
  baristaPending: boolean;
  /** 无面人：临时持有的角色技能（持续至下个抽牌阶段开始前） */
  tempChar: string | null;
  /** 无面人：是否已永久转化（转化后不再抽角色牌） */
  facelessDone: boolean;
  /** 特工：本回合是否已发动询问交换（含放弃） */
  agentUsed: boolean;
  /** 换牌结束互动（赌神/将军/总裁/咒术师/无业游民）每回合只入队一次 */
  swapEndPrompted: boolean;
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
      | 'revealDecide' | 'barrierAsk' | 'demagPick' | 'pinpointVictim'
      /* 拓展角色交互 */
      | 'gamblerGuess' | 'bomberClaim' | 'succubusSteal' | 'scalperDeal'
      | 'studentDump' | 'studentRemove' | 'designerDiscard' | 'dogTarget'
      | 'generalChoice' | 'vagrantDraw' | 'fryerDel' | 'curseTake'
      | 'godPeek' | 'detectivePick' | 'hackerSetup' | 'smugglerMark'
      | 'pirateRob' | 'pirateDecide' | 'auctionPick' | 'auctionBid'
      | 'impDraw' | 'impRedeem' | 'facelessPick' | 'blufferDeclare'
      | 'blufferChallenge' | 'ceoGive' | 'ceoDecide' | 'agentAsk'
      | 'agentDecide' | 'mynameSet' | 'cleanerDel';
    max?: number;
    chipId?: string;
    defId?: string;
    /** preciseDel: 抽到的 3 张牌；hackerSetup: 自己抽牌堆；detectivePick: 弃牌区 */
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
    /** succubusSteal：本次抢夺金额（3/1）；fryerDel：剩余可删张数 */
    blood?: number;
    /** auctionBid：当前最高价 */
    amount?: number;
    /** auctionPick：可暗置的两张黑市牌 defId */
    options?: string[];
    /** generalChoice/ceoGive/agentAsk：可多次给的累计金额等 */
    given?: number;
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
  /** 无面人：本局角色牌堆（开局洗混，每回合抽2张） */
  charDeck: string[];
  /** 职业赌徒：本回合的夺魁竞猜 */
  gamblerGuess: { by: string; seat: number } | null;
  /** 炸弹客：本回合宣告的数字 X */
  bomberX: number | null;
  /** 瞎掰王：本回合宣告（declared 为宣告牌，challenged=是否有人质疑，challengers=质疑者） */
  bluffer: { seat: string; declared: BCard[]; challenged: boolean; challengers: string[] } | null;
  /** 我的名字？：自定义牌型与名称 */
  mynameCat: number | null;
  mynameText: string | null;
  /** 走私客：本回合标记的黑市栏位 */
  smugglerMark: { slot: number; by: string } | null;
  /** 窥天师：天意（暗置的黑市牌 defId 序列） */
  seerZone: string[];
  /** 特工：本回合的出牌区交换记录（aCards/bCards 为双方交换时的出牌 id） */
  agentSwap: { a: string; b: string; aCards: string[]; bCards: string[] } | null;
  /** 捣蛋鬼：等待触发的抽牌+换牌小回合数 */
  impTurns: number;
  /** 购买阶段前的角色互动队列（海盗/走私客/瞎掰帝/捣蛋鬼赎回） */
  preBuyQueue: { seat: string; kind: 'pirateRob' | 'smugglerMark' | 'auctionStart' | 'impRedeem' }[];
  /** 瞎掰帝：进行中的叫价（by=拍卖师） */
  auction: { defId: string; highest: number; highestBy: string | null; queue: string[]; by: string } | null;
  /** 游戏开始前的角色初始化队列（我的名字？/黑客初始构筑） */
  startupQueue: { seat: string; kind: 'mynameSet' | 'hackerSetup' }[];
  /** 抽牌阶段前的角色互动队列（私家侦探/无面人） */
  preDrawQueue: { seat: string; kind: 'detectivePick' | 'facelessPick' }[];
  /** 换牌阶段结束的角色互动队列（炸弹客/咒术师/将军/赌神/无业游民/霸道总裁） */
  swapEndQueue: { seat: string; kind: 'bomberClaim' | 'curseTake' | 'generalChoice' | 'godPeek' | 'vagrantDraw' | 'ceoGive' }[];
  /** 结算阶段的角色互动队列（魅魔/票贩子/炸鸡店老板） */
  settleQueue: { seat: string; kind: 'succubusSteal' | 'scalperDeal' | 'fryerDel' }[];
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
