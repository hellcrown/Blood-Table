import { BLOOD_MARKET_BY_ID } from './bloodCards';

/** 可排序/求核心牌的最小牌结构（服务端结算牌与客户端视图牌均满足） */
export interface SdSortableCard {
  id: string;
  r: number; // 0 = 王牌
  s: string | null;
  chipIds: string[];
}

/** 计算有效点数（限流阀/校准器修正后，钳制 2-14）与增减角标 */
export function effRankOf(c: { r: number; chipIds: string[] }): { r: number; mod: number | null } {
  let r = c.r;
  let mod: number | null = null;
  for (const id of c.chipIds) {
    const eff = BLOOD_MARKET_BY_ID.get(id)?.effect;
    if (eff && eff.k === 'rankMod') {
      r = Math.min(14, Math.max(2, r + eff.mod));
      mod = (mod ?? 0) + eff.mod;
    }
  }
  return { r, mod };
}

/** 有效点数（0 = 王牌；其余 2-14，含芯片修正） */
function effRank(c: SdSortableCard): number {
  if (c.s == null || c.r === 0) return 0;
  return effRankOf(c).r;
}

/**
 * 按牌型排序（对决展示用）：顺子/同花顺按点数升序；同花/高牌按点数降序；
 * 有对/三条/葫芦/四条及以上的牌型，相同点数组在最左（组越大越靠左、组内点值大的在前），王牌恒在最左。
 */
export function sortHandByType<T extends SdSortableCard>(cards: T[], cat: number): T[] {
  if (cat === 4 || cat === 9) {
    // 顺子 / 同花顺：从左到右低到高
    return [...cards].sort((a, b) => effRank(a) - effRank(b));
  }
  if (cat === 0 || cat === 5) {
    // 高牌 / 同花：大牌在前
    return [...cards].sort((a, b) => effRank(b) - effRank(a));
  }
  // 其余：按点数分组（王牌单独），组按 (数量降序, 点值降序)
  const groups = new Map<number, T[]>();
  for (const c of cards) {
    const r = effRank(c);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  }
  const jokers = groups.get(0) ?? [];
  const order = [...groups.keys()]
    .filter((k) => k !== 0)
    .sort((a, b) => (groups.get(b)!.length - groups.get(a)!.length) || b - a);
  return [...jokers, ...order.flatMap((r) => groups.get(r)!)];
}

/**
 * 牌型核心牌（触发放大 + 光柱特效）：按激发顺序返回。
 * 顺子/同花顺 = 全部；对/三条/葫芦/四条及以上 = 同点数组（组大的先、王牌补足主组）；高牌/同花 = 无。
 */
export function coreOrder<T extends SdSortableCard>(cards: T[], cat: number): T[] {
  if (cat === 0 || cat === 5) return [];
  if (cat === 4 || cat === 9) return [...cards];
  const groups = new Map<number, T[]>();
  for (const c of cards) {
    const r = effRank(c);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  }
  const jokers = groups.get(0) ?? [];
  const rankGroups = [...groups.entries()]
    .filter(([r]) => r !== 0)
    .sort((a, b) => (b[1].length - a[1].length) || b[0] - a[0]);
  const core: T[] = [];
  const [mainRank, mainGroup] = rankGroups[0] ?? [null, []];
  if (mainGroup.length >= 2) {
    core.push(...mainGroup);
    // 王牌可补足主组构成三条及以上（如 对+王 = 三条；葫芦主组 2+王 也成立）
    if (jokers.length > 0 && mainGroup.length + jokers.length >= 3 && cat >= 3) {
      core.push(...jokers);
    }
  }
  for (const [r, g] of rankGroups.slice(1)) {
    if (g.length >= 2) core.push(...g);
  }
  void mainRank;
  return core;
}

/**
 * 对决演示时间轴（毫秒）：客户端动画与服务端确认时限共用同一份常数，
 * 保证"倒计时从演示播完后起算"在两端一致。修改时同步 client/src/styles.css 中
 * 对应的 sd-card / sd-score-block / sd-core-in / sd-light-burst / sd-chip-glow 动画时长。
 */
export const SD_TIMING = {
  firstDelay: 120, // 弹窗挂载 → 开始翻牌
  seatGap: 1100, // 下一名玩家开始翻牌的间隔
  cardGap: 130, // 同一玩家相邻两张牌的翻牌间隔
  flipTail: 520, // 最后一张牌翻转过渡收尾
  scoreLead: 260, // 翻牌完 → 分数条开始浮现（phase 2）
  scoreStagger: 460, // 分数条按座位逐条浮现的间隔
  scoreTail: 900, // 翻牌完 → 判定横幅出现（phase 3，另加分数错峰）
  coreLead: 200, // 关键牌放大起始延迟（CSS）
  coreStagger: 240, // 关键牌逐张激发间隔（CSS）
  lightTail: 750, // 关键牌光柱特效时长（CSS）
  chipTail: 1650, // 芯片粒子/辉光收尾（CSS：0.55s 延迟 + 1.1s 辉光）
  verdictTail: 700, // 判定横幅与奖励角标入场完成（CSS：0.45s 横幅 / 0.2s+0.4s 奖励）
} as const;

/**
 * 对决演示完整播完（关键牌高亮、芯片特效、判定横幅全部到位）所需时间。
 * 客户端据此在演示结束后才开始显示确认倒计时；
 * 服务端据此设定 deadline = 演示时长 + 确认等待上限。
 */
export function showdownReadyMs(rowCount: number, maxCards: number, maxCores: number): number {
  const n = Math.max(1, rowCount);
  const dealTotal = (n - 1) * SD_TIMING.seatGap + Math.max(1, maxCards) * SD_TIMING.cardGap + SD_TIMING.flipTail;
  const phase2 = SD_TIMING.firstDelay + dealTotal + SD_TIMING.scoreLead;
  const phase3 = SD_TIMING.firstDelay + dealTotal + SD_TIMING.scoreTail + (n - 1) * SD_TIMING.scoreStagger;
  const highlightEnd =
    phase2 + SD_TIMING.coreLead + Math.max(0, maxCores - 1) * SD_TIMING.coreStagger + SD_TIMING.lightTail;
  return Math.max(phase2 + SD_TIMING.chipTail, phase3 + SD_TIMING.verdictTail, highlightEnd);
}
