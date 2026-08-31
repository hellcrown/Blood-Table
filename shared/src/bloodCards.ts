/**
 * 血色牌局 · 黑市牌定义（严格按实物牌面录入，数量以牌面角标为准）
 * 基础黑市牌库共 24 种 57 张；拓展牌库 27 种（黑市/拓展/ 实卡照片录入），房间开启后并入。
 */

export type MarketKind = 'chip' | 'item' | 'secret';

/** 结构化效果（引擎按此执行，text 为牌面原文） */
export type BloodEffect =
  | { k: 'rankMod'; mod: number } // 校准器+/限流阀-：点数永久±N
  | { k: 'suit'; suits: ('s' | 'h' | 'd' | 'c')[] } // 红/黑芯片：花色视为…
  | { k: 'suitWild' } // 变色墨水
  | { k: 'rankWild' } // 数字滑轨
  | { k: 'wild' } // 百变影像
  | { k: 'dupe' } // 双生镜片：此牌视为2张
  | { k: 'imitate' } // 仿制印章：视为出牌区另一张牌（引擎评估特判）
  | { k: 'copyChip' } // 复制芯片：复制一张芯片效果（暂未自动结算）
  | { k: 'magCoil' } // 磁力线圈：重洗牌库时此牌回到抽牌堆顶
  | { k: 'revealGain'; blood: number } // 【对决】获得N血筹
  | { k: 'revealSteal'; blood: number } // 【对决】掠夺一位对手N血筹
  | { k: 'settleWin'; blood: number } // 【结算】若魁首获得N血筹
  | { k: 'settleLose'; blood: number } // 【结算】若败获得N血筹
  | { k: 'settleWinTicket'; tickets: number } // 加密线路：【结算】若魁首获得N车票
  | { k: 'selfDestruct' } // 自毁芯片：【结算】结束删除本回合打出的所有牌
  | { k: 'rollDice' } // 掷一次骰子，获得点数×1血筹
  | { k: 'deleteUpTo'; n: number } // 可删除至多N张牌
  | { k: 'violentDelete'; n: number } // 删除自己或对手抽牌堆顶N张
  | { k: 'topOfMarket' } // 免费获得黑市牌堆顶的1张牌
  | { k: 'refreshMarket' } // 重整黑市并可立即再购买一次
  | { k: 'privilegeBonus'; blood: number } // 若持有特权证获得N血筹
  | { k: 'closingGift'; blood: number } // 闭店礼：获得N血筹并跳过本回合购买阶段
  | { k: 'bloodShare'; blood: number; oppBlood: number } // 血袭分享：自己获得N，其他每位对手获得M
  | { k: 'stealPrivilege' } // 鬼手探囊：获得临时特权证
  | { k: 'poisonMalus'; n: number } // 餐车投毒：一位对手下回合换牌次数-N
  | { k: 'freezeReorg' } // 冻结车厢：一位对手跳过本回合重整
  | { k: 'amnesiaOff' } // 暂时失忆：一位玩家的技能下回合失效
  | { k: 'boxRob' } // 黑厢抢夺：轮流掷骰，点数大者抢至多4血筹
  | { k: 'pinpointBlast' } // 定点爆破：宣点数，对手弃牌堆删一张该点数
  | { k: 'preciseDelDraw' } // 精准删除：抽3删0-2弃其余
  | { k: 'pullChipGain'; blood: number } // 拔除芯片：拔弃牌堆1芯片获得N血筹
  | { k: 'sharedInfoFx' } // 共享信息：自己删≤2，每位对手可删1
  | { k: 'signalJamFx' } // 信号干扰器：换牌阶段令一位玩家随机弃1抽1
  | { k: 'secretNoteFx' } // 皮下密信：换牌阶段花2血筹抽3张
  | { k: 'eraserFx' } // 魔术橡皮：出牌阶段前宣牌型，本回合该牌型视为高牌
  | { k: 'loudspeakerFx' } // 广播喇叭：对决前宣称夺魁
  | { k: 'irisGambleFx' } // 赌徒虹膜：对决前猜牌型
  | { k: 'demagNullify' } // 消磁枪：对决阶段令一位玩家的一张强化芯片失效
  | { k: 'todo' } // 拓展牌占位：暂未自动结算（购买后公示弃置）
  | { k: 'dealerLicense' }; // 【对决】前：本次对决改为先比总点数再比牌型

export interface BloodMarketDef {
  id: string;
  no: string;
  name: string;
  kind: MarketKind;
  cost: number;
  count: number;
  text: string;
  effect: BloodEffect;
  /** 不可插入JOKER中 */
  noJoker?: boolean;
  /** 拓展牌（仅房间开启「拓展黑市」时进入牌库） */
  expansion?: boolean;
}

export const BLOOD_MARKET_DEFS: BloodMarketDef[] = [
  // ── 强化芯片 ──
  { id: 'limiter1', no: 'NO.010', name: '限流阀-1', kind: 'chip', cost: 3, count: 2, text: '此牌点数永久-1，花色不变。', effect: { k: 'rankMod', mod: -1 } },
  { id: 'limiter2', no: 'NO.0??', name: '限流阀-2', kind: 'chip', cost: 3, count: 2, text: '此牌点数永久-2，花色不变。', effect: { k: 'rankMod', mod: -2 } },
  { id: 'limiter3', no: 'NO.0??', name: '限流阀-3', kind: 'chip', cost: 3, count: 1, text: '此牌点数永久-3，花色不变。', effect: { k: 'rankMod', mod: -3 } },
  { id: 'limiter4', no: 'NO.0??', name: '限流阀-4', kind: 'chip', cost: 3, count: 1, text: '此牌点数永久-4，花色不变。', effect: { k: 'rankMod', mod: -4 } },
  { id: 'calib1', no: 'NO.011', name: '校准器+1', kind: 'chip', cost: 4, count: 2, text: '此牌点数永久+1，花色不变。', effect: { k: 'rankMod', mod: 1 } },
  { id: 'calib2', no: 'NO.012', name: '校准器+2', kind: 'chip', cost: 4, count: 2, text: '此牌点数永久+2，花色不变。', effect: { k: 'rankMod', mod: 2 } },
  { id: 'calib3', no: 'NO.013', name: '校准器+3', kind: 'chip', cost: 4, count: 1, text: '此牌点数永久+3，花色不变。', effect: { k: 'rankMod', mod: 3 } },
  { id: 'calib4', no: 'NO.014', name: '校准器+4', kind: 'chip', cost: 4, count: 1, text: '此牌点数永久+4，花色不变。', effect: { k: 'rankMod', mod: 4 } },
  { id: 'redChip', no: 'NO.016', name: '红色芯片', kind: 'chip', cost: 1, count: 2, text: '【对决】此牌的花色视为♦或♥。', effect: { k: 'suit', suits: ['d', 'h'] } },
  { id: 'twinLens', no: 'NO.017', name: '双生镜片', kind: 'chip', cost: 10, count: 2, text: '【对决】将此牌视为2张（不可插入删牌区）。', effect: { k: 'dupe' }, noJoker: true },
  { id: 'blackChip', no: 'NO.018', name: '黑色芯片', kind: 'chip', cost: 1, count: 2, text: '【对决】此牌的花色视为♠或♣。', effect: { k: 'suit', suits: ['s', 'c'] } },
  { id: 'slider', no: 'NO.021', name: '数字滑轨', kind: 'chip', cost: 6, count: 2, text: '【对决】此牌的点数可视为任意点数。', effect: { k: 'rankWild' } },
  { id: 'coatSteal', no: 'NO.022', name: '血幕镀层（夺）', kind: 'chip', cost: 1, count: 2, text: '【对决】选择并掠夺一位对手1血筹（不可插入删牌区）。', effect: { k: 'revealSteal', blood: 1 }, noJoker: true },
  { id: 'coatWin', no: 'NO.023', name: '血幕镀层（胜）', kind: 'chip', cost: 1, count: 2, text: '【结算】若魁首👑，获得4血筹（不可插入删牌区）。', effect: { k: 'settleWin', blood: 4 }, noJoker: true },
  { id: 'coatLose', no: 'NO.024', name: '血幕镀层（败）', kind: 'chip', cost: 1, count: 2, text: '【结算】若败，获得3血筹（不可插入删牌区）。', effect: { k: 'settleLose', blood: 3 }, noJoker: true },
  { id: 'coatOut', no: 'NO.025', name: '血幕镀层（出）', kind: 'chip', cost: 1, count: 2, text: '【对决】获得2血筹（不可插入删牌区）。', effect: { k: 'revealGain', blood: 2 }, noJoker: true },
  { id: 'inkSuit', no: 'NO.028', name: '变色墨水', kind: 'chip', cost: 2, count: 4, text: '【对决】此牌的花色可视为任意花色。', effect: { k: 'suitWild' } },
  { id: 'morph', no: 'NO.020', name: '百变影像', kind: 'chip', cost: 8, count: 2, text: '【对决】此牌可视为任意花色与点数。', effect: { k: 'wild' } },
  // ── 秘密交易 ──
  { id: 'betDeal', no: 'NO.026', name: '对赌协议', kind: 'secret', cost: 3, count: 5, text: '掷一次骰子，获得骰子点数的🩸。', effect: { k: 'rollDice' } },
  { id: 'cheapDel', no: 'NO.027', name: '廉价删除', kind: 'secret', cost: 3, count: 4, text: '可删除至多2张牌。', effect: { k: 'deleteUpTo', n: 2 } },
  { id: 'violentDel', no: 'NO.031', name: '暴力删除', kind: 'secret', cost: 3, count: 4, text: '删除自己或对手抽牌堆顶的3张牌（抽牌堆至少有3张牌）。', effect: { k: 'violentDelete', n: 3 } },
  { id: 'crateDig', no: 'NO.034', name: '货箱盲掏', kind: 'secret', cost: 3, count: 4, text: '免费获得黑市牌堆顶的1张牌。', effect: { k: 'topOfMarket' } },
  { id: 'dividend', no: 'NO.037', name: '特权分红', kind: 'secret', cost: 1, count: 1, text: '若你持有👑，获得3🩸。', effect: { k: 'privilegeBonus', blood: 3 } },
  { id: 'refill', no: 'NO.043', name: '再来一批', kind: 'secret', cost: 1, count: 4, text: '将黑市区中至多2张牌放入黑市牌堆底，然后补齐黑市，并可立即再进行一次购买。', effect: { k: 'refreshMarket' } },
  // ── 备用道具 ──
  { id: 'dealerLic', no: 'NO.03X', name: '荷官证', kind: 'item', cost: 6, count: 1, text: '【对决】前，可令本次【对决】改为比较总点数大小，平局再比牌型大小。', effect: { k: 'dealerLicense' } },
];

/**
 * 拓展黑市牌（房间开启「拓展黑市」时才进入牌库）。
 * 编号/名称/价格/数量/文本均按 实卡照片（黑市/拓展/*.jpg）录入。
 * 自动结算：仿制印章/加密线路/磁力线圈/自毁芯片/闭店礼·小中大/鬼手探囊/血袭分享；
 * 其余为强交互效果（指定目标/宣告/谈判），暂未自动结算（k:'todo'）——
 * 秘密交易类购买后公示弃置，备用道具类保留在道具区，芯片类正常插入但不改变评估。
 */
export const BLOOD_MARKET_EXPANSION_DEFS: BloodMarketDef[] = [
  // ── 强化芯片 ──
  { id: 'stamp', no: 'NO.014', name: '仿制印章', kind: 'chip', cost: 6, count: 2, text: '【对决】可视为自己出牌区的另一张牌（无视其强化芯片，不可视为JOKER）。', effect: { k: 'imitate' }, noJoker: true, expansion: true },
  { id: 'encrypt', no: 'NO.015', name: '加密线路', kind: 'chip', cost: 5, count: 2, text: '【结算】若👑，获得2🎫（不可插入JOKER中）。', effect: { k: 'settleWinTicket', tickets: 2 }, noJoker: true, expansion: true },
  { id: 'magCoil', no: 'NO.016', name: '磁力线圈', kind: 'chip', cost: 6, count: 2, text: '重洗牌库前，可将在弃牌区的此牌挑出，并在重洗牌库后放在抽牌堆顶。', effect: { k: 'magCoil' }, expansion: true },
  { id: 'copyChip', no: 'NO.019', name: '复制芯片', kind: 'chip', cost: 4, count: 2, text: '【对决】可复制任意一位玩家的强化芯片效果（双生镜片除外）。不可插入JOKER中。', effect: { k: 'todo' }, noJoker: true, expansion: true },
  { id: 'shield', no: 'NO.023', name: '屏蔽器', kind: 'chip', cost: 4, count: 2, text: '【对决】可令一位玩家的1张强化芯片失效（不可插入JOKER中）。', effect: { k: 'todo' }, noJoker: true, expansion: true },
  { id: 'selfDestruct', no: 'NO.025', name: '自毁芯片', kind: 'chip', cost: 2, count: 2, text: '【结算】结束时，删除本回合打出的所有牌（包括此牌）。', effect: { k: 'selfDestruct' }, expansion: true },
  { id: 'spring', no: 'NO.031', name: '弹簧夹层', kind: 'chip', cost: 4, count: 2, text: '【对决】可花费X🩸，令此牌的点数临时增加/减少X点。', effect: { k: 'todo' }, noJoker: true, expansion: true },
  // ── 秘密交易 ──
  { id: 'sharedInfo', no: 'NO.026', name: '共享信息', kind: 'secret', cost: 2, count: 2, text: '可删除至多2张牌，每位对手可删除1张牌。', effect: { k: 'sharedInfoFx' }, expansion: true },
  { id: 'closingS', no: 'NO.028', name: '闭店礼·小', kind: 'secret', cost: 3, count: 1, text: '获得4🩸，跳过本回合的【购买】。', effect: { k: 'closingGift', blood: 4 }, expansion: true },
  { id: 'closingM', no: 'NO.029', name: '闭店礼·中', kind: 'secret', cost: 5, count: 1, text: '获得7🩸，跳过本回合的【购买】。', effect: { k: 'closingGift', blood: 7 }, expansion: true },
  { id: 'closingL', no: 'NO.030', name: '闭店礼·大', kind: 'secret', cost: 8, count: 1, text: '获得11🩸，跳过本回合的【购买】。', effect: { k: 'closingGift', blood: 11 }, expansion: true },
  { id: 'pinpoint', no: 'NO.033', name: '定点爆破', kind: 'secret', cost: 3, count: 2, text: '选择一位对手并宣称一个点数，该对手必须从弃牌堆中删除一张该点数的牌。', effect: { k: 'pinpointBlast' }, expansion: true },
  { id: 'boxRob', no: 'NO.035', name: '黑厢抢夺', kind: 'secret', cost: 2, count: 2, text: '选择一位对手轮流掷骰，若你的点数比对手大，则抢夺其至多4🩸。否则无事发生。', effect: { k: 'boxRob' }, expansion: true },
  { id: 'freezeCar', no: 'NO.036', name: '冻结车厢', kind: 'secret', cost: 2, count: 2, text: '令一位对手跳过本回合的【重整】。', effect: { k: 'freezeReorg' }, expansion: true },
  { id: 'preciseDel', no: 'NO.037', name: '精准删除', kind: 'secret', cost: 2, count: 2, text: '抽3张牌，删除其中0-2张，弃置剩余的牌（抽牌堆至少有3张牌）。', effect: { k: 'preciseDelDraw' }, expansion: true },
  { id: 'ghostHand', no: 'NO.039', name: '鬼手探囊', kind: 'secret', cost: 2, count: 2, text: '获得👑。', effect: { k: 'stealPrivilege' }, expansion: true },
  { id: 'poison', no: 'NO.040', name: '餐车投毒', kind: 'secret', cost: 3, count: 2, text: '令一位对手下回合【换牌】可换牌次数-2。', effect: { k: 'poisonMalus', n: 2 }, expansion: true },
  { id: 'bloodShare', no: 'NO.041', name: '血袭分享', kind: 'secret', cost: 3, count: 2, text: '获得5🩸，其他每位对手获得1🩸。', effect: { k: 'bloodShare', blood: 5, oppBlood: 1 }, expansion: true },
  { id: 'pullChip', no: 'NO.042', name: '拔除芯片', kind: 'secret', cost: 1, count: 2, text: '拔除自己弃牌堆中的1张强化芯片，获得4🩸。', effect: { k: 'pullChipGain', blood: 4 }, expansion: true },
  { id: 'amnesia', no: 'NO.044', name: '暂时失忆', kind: 'secret', cost: 2, count: 2, text: '令一位玩家的技能在下回合失效。', effect: { k: 'amnesiaOff' }, expansion: true },
  // ── 备用道具 ──
  { id: 'signalJam', no: 'NO.045', name: '信号干扰器', kind: 'item', cost: 3, count: 4, text: '【换牌】结束时，可令一位玩家随机弃1张牌，并抽1张牌。', effect: { k: 'signalJamFx' }, expansion: true },
  { id: 'loudspeaker', no: 'NO.046', name: '广播喇叭', kind: 'item', cost: 3, count: 2, text: '【对决】前，可宣称自己将👑。【结算】若成功👑，则获得玩家人数×3🩸，否则跳过本回合的【购买】【删牌】【重整】。', effect: { k: 'loudspeakerFx' }, expansion: true },
  { id: 'irisGamble', no: 'NO.047', name: '赌徒虹膜', kind: 'item', cost: 3, count: 2, text: '【对决】前，猜测一位玩家的牌型。【结算】若猜测正确，获得3🩸，该玩家本回合获得的🎫-4（最低为0）。', effect: { k: 'irisGambleFx' }, expansion: true },
  { id: 'secretNote', no: 'NO.048', name: '皮下密信', kind: 'item', cost: 2, count: 2, text: '【换牌】结束时，可花费2🩸，抽3张牌。', effect: { k: 'secretNoteFx' }, expansion: true },
  { id: 'barrier', no: 'NO.049', name: '防护屏障', kind: 'item', cost: 3, count: 4, text: '取消玩家即将单独对你使用的[秘密交易]或[备用道具]效果（不可对[防护屏障]使用）。', effect: { k: 'todo' }, expansion: true },
  { id: 'eraser', no: 'NO.050', name: '魔术橡皮', kind: 'item', cost: 3, count: 2, text: '【出牌】前，宣称一种牌型，本回合【对决】此牌型视为「高牌」。', effect: { k: 'eraserFx' }, expansion: true },
  { id: 'demag', no: 'NO.051', name: '消磁枪', kind: 'item', cost: 4, count: 2, text: '【对决】令一位玩家的1张强化芯片失效。', effect: { k: 'demagNullify' }, expansion: true },
];

/** 全量牌表（含拓展）：视图/购买解析用 */
export const BLOOD_MARKET_BY_ID = new Map(
  [...BLOOD_MARKET_DEFS, ...BLOOD_MARKET_EXPANSION_DEFS].map((d) => [d.id, d]),
);

/** 生成洗混的黑市牌库（按 count 展开；includeExpansion 时并入拓展牌） */
export function buildBloodMarketDeck(randomInt: (n: number) => number, includeExpansion = false): string[] {
  const defs = includeExpansion ? [...BLOOD_MARKET_DEFS, ...BLOOD_MARKET_EXPANSION_DEFS] : BLOOD_MARKET_DEFS;
  const deck: string[] = [];
  for (const def of defs) {
    for (let i = 0; i < def.count; i++) deck.push(def.id);
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
