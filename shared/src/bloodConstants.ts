/**
 * 血色模式的契约常量：阶段清单与时限。
 *
 * 为什么必须收在一处：这些值原先在服务端类型、视图协议、客户端阶段条、管理端列表里**各抄一份**，
 * 改一端另一端不会报错 —— 例如客户端阶段条漏了 draw/setup 时只是"该阶段一个都不高亮"，
 * 而时限在客户端硬编码 60000 会在服务端调整后静默失配（倒计时条与真实时限对不上）。
 * 放到 shared 后：阶段联合类型与标签表由同一份数据派生，**缺项会被编译期拦下**。
 */
import type { Phase } from './protocol';

/** 血色模式 14 个阶段：顺序即客户端阶段条与引擎推进顺序（gameover 仅作终态，不进阶段条） */
export const BLOOD_PHASES = [
  'pick', // 选将（随机抽 2 张角色牌选 1）
  'crownBid', // 特权证暗标竞拍（每人密封出价 0~3）
  'setup', // 初始构筑（两轮「抽 8 删 ≤4」）
  'draw', // 抽牌
  'swap', // 换牌
  'swapItem', // 换牌结束：逐一询问信号干扰器/皮下密信/魔术橡皮
  'play', // 出牌（暗扣 5 张）
  'revealPre', // 对决前：逐一询问荷官证/广播喇叭/赌徒虹膜
  'reveal', // 对决宣告
  'settle', // 结算展示
  'buy', // 购买
  'remove', // 删牌
  'reorg', // 重整
  'gameover', // 终局
] as const;

export type BloodPhase = (typeof BLOOD_PHASES)[number];

/** 阶段中文名：客户端阶段条与管理端对局列表共用（Record 保证不漏任何一个阶段） */
export const BLOOD_PHASE_LABELS: Record<BloodPhase, string> = {
  pick: '选将',
  crownBid: '竞拍',
  setup: '构筑',
  draw: '抽牌',
  swap: '换牌',
  swapItem: '换牌结束',
  play: '出牌',
  revealPre: '对决前',
  reveal: '对决',
  settle: '结算',
  buy: '购买',
  remove: '删牌',
  reorg: '重整',
  gameover: '已结束',
};

/** 阶段/回合超时（服务端权威；客户端倒计时条按此换算比例，不得各写一个字面量） */
export const BLOOD_TURN_MS = 60_000;
/** 对决展示确认等待上限（演示播完后起算，超时自动确认推进） */
export const BLOOD_SD_WAIT_MS = 30_000;
/** 每轮初始构筑最多删几张 */
export const BLOOD_SETUP_KEEP = 4;

/** 经典德扑：每手行动时限与结算展示时长（服务端权威） */
export const TURN_MS = 60_000;
export const RESULT_MS = 6_000;

/**
 * 经典德扑阶段中文名：客户端牌桌顶栏、操作栏、管理端对局列表共用一份。
 * 键取自 shared/protocol 的 Phase 联合类型，漏一个阶段会被 Record 的完整性检查拦下。
 */
export const CLASSIC_PHASE_LABELS: Record<Phase, string> = {
  waiting: '等待开局…',
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
  result: '结算',
  gameover: '牌局结束',
};
