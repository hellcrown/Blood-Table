import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { bloodTick, bSwapStop, createBloodGame } from '../src/blood/engine';
import { promptFor } from '../src/blood/view';
import { botAct, createBrain, updateBrains, deriveStrategy, curStrategy, worstDiscardCards, guessOppStrategy, strongestThreat, type BotBrain } from '../src/blood/botAI';
import type { BCard, BPlayer, BloodState } from '../src/blood/types';

const NOW = 1000;

type BCardLike = BCard;

/** 用 bot 决策驱动对局直到目标阶段或终局 */
function driveBots(gs: BloodState, botIds: string[], until: 'gameover' | BloodState['phase'], maxSteps = 200_000): void {
  const brains = new Map<string, BotBrain>(botIds.map((id) => [id, createBrain()]));
  let now = NOW;
  let guard = 0;
  while (gs.phase !== 'gameover' && gs.phase !== until && guard++ < maxSteps) {
    updateBrains(brains, botIds, gs);
    let acted = false;
    for (const id of botIds) {
      const p = gs.players.find((x) => x.id === id);
      if (!p) continue;
      const prompt = promptFor(gs, p);
      if (prompt.k === 'wait') continue;
      try {
        acted = botAct(brains.get(id)!, gs, id, now) || acted;
      } catch {
        /* 异常回退：交给超时托管 */
      }
    }
    now += acted ? 1500 : 61_000;
    bloodTick(gs, now);
  }
  expect(guard).toBeLessThan(maxSteps);
}

function makePlayers(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `玩家${i}`, seat: i }));
}

describe('血色机器人 · 完整对局', () => {
  it('2 人局全 bot（拓展池）打到终局且满足守恒', () => {
    const gs = createBloodGame(2, makePlayers(2), NOW, true);
    driveBots(gs, ['p0', 'p1'], 'gameover');
    expect(gs.phase).toBe('gameover');
    expect(gs.final).not.toBeNull();
    const champ = gs.players.find((p) => p.seat === gs.final!.winnerSeat)!;
    expect(champ.tickets).toBeGreaterThanOrEqual(gs.target);
  }, 60_000);

  it('3 人局全 bot（基础池）打到终局', () => {
    const gs = createBloodGame(3, makePlayers(3), NOW);
    driveBots(gs, ['p0', 'p1', 'p2'], 'gameover');
    expect(gs.phase).toBe('gameover');
    expect(gs.final).not.toBeNull();
  }, 60_000);

  it('出牌决策（含推演）单次 < 250ms', () => {
    const gs = createBloodGame(2, makePlayers(2), NOW, true);
    driveBots(gs, ['p0', 'p1'], 'play');
    const brains = new Map([['p0', createBrain()]]);
    const p0 = gs.players[0];
    if (gs.phase === 'play' && !p0.locked) {
      // 预热 JIT：在状态快照上先跑一次（首次调用的解释器/内联缓存成本不代表稳态）
      const snapshot = JSON.parse(JSON.stringify(gs)) as BloodState;
      botAct(createBrain(), snapshot, 'p0', NOW);
      const t0 = performance.now();
      botAct(brains.get('p0')!, gs, 'p0', NOW);
      const cost = performance.now() - t0;
      expect(cost).toBeLessThan(250); // 推演预算 200ms + 评估开销余量（更长思考时间可接受）
    }
  });
});

describe('血色机器人 · AI 行为', () => {
  /** 建立一局并推进到 swap（强制角色），返回 gs */
  function toSwap(c0: string, c1: string): BloodState {
    const gs = createBloodGame(2, makePlayers(2), NOW);
    gs.players[0].charOptions = [c0, 'dealer'];
    gs.players[1].charOptions = [c1, 'clerk'];
    driveBots(gs, ['p0', 'p1'], 'swap');
    return gs;
  }

  it('换牌：保留成对牌，弃孤立低牌', () => {
    const gs = toSwap('clerk', 'clerk');
    const p0 = gs.players[0];
    // 布置手牌：K 对 + 孤立低牌
    const pool = [...p0.draw, ...p0.hand, ...p0.discard, ...p0.setupHand];
    const used = new Set<string>();
    const pick = (r: number): BCardLike => {
      const found = pool.find((c) => c.r === r && !used.has(c.id));
      if (!found) throw new Error(`no rank ${r}`);
      used.add(found.id);
      return found;
    };
    const hand = [pick(13), pick(13), pick(5), pick(4), pick(3), pick(2)];
    for (const c of hand) if (!used.has(c.id)) used.delete(c.id);
    p0.hand = hand;
    p0.draw = pool.filter((c) => !used.has(c.id));
    p0.discard = [];
    p0.setupHand = [];
    const before = p0.hand.length;
    botAct(createBrain(), gs, 'p0', NOW);
    // 弃掉的牌不含 K 对
    const discarded = hand.filter((h) => p0.discard.some((d) => d.id === h.id));
    expect(discarded.length).toBeGreaterThan(0);
    expect(discarded.every((d) => d.r !== 13)).toBe(true);
    expect(p0.hand.length).toBe(before);
  });

  it('购买：对手接近目标时优先买破坏类', () => {
    const gs = toSwap('clerk', 'clerk');
    driveBots(gs, ['p0', 'p1'], 'buy');
    const p0 = gs.players[0];
    // 强制轮到 p0 购买
    gs.turnSeat = 0;
    p0.buyPassed = false;
    p0.blood = 20;
    p0.tickets = 0;
    gs.players[1].tickets = 16; // 目标 24 - 8：接近目标
    gs.market[0] = { def: 'betDeal', bonus: 0 };
    gs.market[1] = { def: 'violentDel', bonus: 0 };
    botAct(createBrain(), gs, 'p0', NOW);
    expect(gs.secretPending?.kind).toBe('violentTarget'); // 买了暴力删除
  });

  it('删牌：删孤立低牌，保留成对高牌', () => {
    const gs = toSwap('clerk', 'clerk');
    driveBots(gs, ['p0', 'p1'], 'buy');
    // 直接构造删牌阶段
    gs.phase = 'remove';
    for (const p of gs.players) p.removeDone = false;
    const p0 = gs.players[0];
    const brain = createBrain();
    const strat = curStrategy(brain, p0);
    const isFocus = (c: BCard): boolean =>
      (strat.kind === 'rank' && c.r === strat.rank) ||
      (strat.kind === 'flush' && c.s === strat.suit) ||
      (strat.kind === 'straight' && c.r >= strat.lo && c.r < strat.lo + 5);
    // 从牌池自适应取牌：一个非策略目标的成对点数（保留）+ 一个非策略目标的孤立低点数（删除）
    const pool = [...p0.draw, ...p0.hand, ...p0.discard];
    const byRank = new Map<number, BCard[]>();
    for (const c of pool) {
      if (c.r === 0 || isFocus(c)) continue; // 王牌与策略目标牌不参与"待删"候选
      const list = byRank.get(c.r) ?? [];
      list.push(c);
      byRank.set(c.r, list);
    }
    const pairEntry = [...byRank.entries()].filter(([, cs]) => cs.length >= 2).sort((a, b) => b[0] - a[0])[0];
    const junkEntry = [...byRank.entries()].filter(([r]) => pairEntry == null || r !== pairEntry[0]).sort((a, b) => a[0] - b[0])[0];
    expect(pairEntry && junkEntry).toBeTruthy(); // 牌池中必然存在成对与更低的点数
    const kept = pairEntry![1].slice(0, 2);
    const junk = junkEntry![1][0];
    p0.discard = [...kept, junk];
    p0.hand = [];
    p0.draw = pool.filter((c) => c.id !== kept[0].id && c.id !== kept[1].id && c.id !== junk.id);
    p0.blood = 7; // 只够免费额度：恰好删 1 张（最孤立的低牌 junk）
    botAct(brain, gs, 'p0', NOW);
    expect(p0.removed.some((c) => c.id === junk.id)).toBe(true);
    expect(p0.discard.some((c) => c.r === pairEntry![0])).toBe(true);
  });

  it('跨回合记忆：对决亮牌后 Brain 记录对手出牌', () => {
    const gs = toSwap('clerk', 'clerk');
    const brain = createBrain();
    driveBots(gs, ['p0', 'p1'], 'settle');
    updateBrains(new Map([['p0', brain]]), ['p0'], gs);
    const p1 = gs.players[1];
    const seen = brain.seen.get(1);
    expect(seen).toBeTruthy();
    expect(seen!.size).toBeGreaterThan(0);
    void p1;
  });
});

/* ---------------- RoomManager 级：添加/移除/回收 ---------------- */

import { RoomManager } from '../src/rooms';

function stubWs() {
  return { readyState: 0, OPEN: 0, send: () => {}, on: () => {} } as never;
}

describe('血色机器人 · 房间管理', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  interface TestRoom {
    code: string;
    sessions: Map<string, { id: string; bot?: boolean; seat: number; connected: boolean }>;
    hostId: string;
    game: BloodState | null;
    botBrains: Map<string, BotBrain>;
    botNextAct: Map<string, number>;
  }
  type TestMgr = { rooms: Map<string, TestRoom> } & Record<string, (...args: unknown[]) => unknown>;

  function makeRoomWithBot(): { mgr: RoomManager; m: TestMgr; room: TestRoom; host: { id: string; bot?: boolean; seat: number; connected: boolean } } {
    const mgr = new RoomManager();
    const m = mgr as unknown as TestMgr;
    const ws = stubWs();
    (m.handleCreate as (w: unknown, msg: unknown) => void)(ws, { t: 'create', name: '甲', maxPlayers: 4, mode: 'blood' });
    const room = [...m.rooms.values()][0];
    const host = [...room.sessions.values()].find((s) => !s.bot)!;
    return { mgr, m, room, host };
  }

  it('房主可添加/移除机器人，开局包含 bot', () => {
    const { m, room, host } = makeRoomWithBot();
    (m.handleAddBot as (r: unknown, s: unknown) => void)(room, host);
    expect(room.sessions.size).toBe(2);
    expect([...room.sessions.values()].filter((s) => s.bot).length).toBe(1);
    const bot = [...room.sessions.values()].find((s) => s.bot)!;
    (m.handleKickBot as (r: unknown, s: unknown, msg: unknown) => void)(room, host, { t: 'kickBot', seat: bot.seat });
    expect(room.sessions.size).toBe(1);
    (m.handleAddBot as (r: unknown, s: unknown) => void)(room, host);
    (m.handleStart as (r: unknown, s: unknown) => void)(room, host);
    expect(room.game!.players.length).toBe(2);
  });

  it('真人离开后房主不转移给 bot，新真人加入自动接任', () => {
    const { mgr, m, room, host } = makeRoomWithBot();
    (m.handleAddBot as (r: unknown, s: unknown) => void)(room, host);
    (m.handleLeave as (r: unknown, s: unknown) => void)(room, host);
    expect(room.hostId).toBe(''); // 不转移给机器人
    // 新真人加入 → 自动接任房主
    const ws2 = stubWs();
    (m.handleJoin as (w: unknown, msg: unknown) => void)(ws2, { t: 'join', name: '乙', code: room.code });
    expect(room.hostId).not.toBe('');
    expect([...room.sessions.values()].find((s) => s.id === room.hostId)?.bot).toBeFalsy();
    void mgr;
  });

  it('重开局清空机器人跨回合记忆', () => {
    const { m, room, host } = makeRoomWithBot();
    (m.handleAddBot as (r: unknown, s: unknown) => void)(room, host);
    const botId = [...room.sessions.values()].find((s) => s.bot)!.id;
    room.botBrains.get(botId)!.seen.set(0, new Set(['c1-0']));
    room.botBrains.get(botId)!.rankSuit.set('13:s', 3);
    (m.handleStart as (r: unknown, s: unknown) => void)(room, host);
    // 开局时整表清空（bot 记忆只在单局内有效），开局后重新初始化为空脑
    expect(room.botBrains.size).toBe(0);
    expect(m.runBots as unknown).toBeTruthy();
    void m;
    void botId;
  });

  it('真人全部离开后 5 分钟，房间连同 bot 一起回收', () => {
    const { mgr, m, room, host } = makeRoomWithBot();
    (m.handleAddBot as (r: unknown, s: unknown) => void)(room, host);
    expect(room.sessions.size).toBe(2);
    (m.handleLeave as (r: unknown, s: unknown) => void)(room, host);
    // 离开后的第一次 tick 记录空房时间，5 分钟后的 tick 执行删除
    mgr.tickAll();
    vi.setSystemTime(new Date(NOW + 6 * 60_000));
    mgr.tickAll();
    expect(m.rooms.size).toBe(0);
  });
});

describe('血色机器人 · 长线构筑策略', () => {
  /** 构造一局并返回 p0（活牌由调用方自行装填） */
  function freshP0(): { gs: BloodState; p: BPlayer; brain: BotBrain } {
    const gs = createBloodGame(2, makePlayers(2), NOW);
    const p = gs.players[0];
    return { gs, p, brain: createBrain() };
  }

  const card = (r: number, s: BCard['s']): BCard => ({ id: `t${r}${s ?? 'j'}${Math.random().toString(36).slice(2, 6)}`, r, s });

  it('满配牌库：默认选中主点数多条策略（高点数优先）', () => {
    const { p } = freshP0();
    const alive: BCard[] = [];
    for (const s of ['s', 'h', 'd', 'c'] as const) for (let r = 2; r <= 14; r++) alive.push(card(r, s));
    alive.push(card(0, null), card(0, null));
    p.draw = alive;
    const ranked = deriveStrategy(p);
    expect(ranked[0].kind).toBe('rank');
    expect(ranked[0].kind === 'rank' && ranked[0].rank).toBe(14); // 四条 A 分数最高
  });

  it('构筑删光了方片：策略自动转向，不再选方片同花', () => {
    const { p } = freshP0();
    const alive: BCard[] = [];
    for (let r = 2; r <= 14; r++) alive.push(card(r, 's')); // 黑桃 13 张
    for (let r = 2; r <= 12; r++) alive.push(card(r, 'c')); // 梅花 11 张
    for (let r = 2; r <= 11; r++) alive.push(card(r, 'h')); // 红心 10 张
    alive.push(card(9, 'd'), card(5, 'd')); // 方片仅剩 2 张（构筑时被删光）
    alive.push(card(9, 'h'), card(9, 's'), card(9, 'c')); // 三张 9
    p.draw = alive;
    const ranked = deriveStrategy(p);
    expect(ranked.some((s) => s.kind === 'flush' && s.suit === 'd')).toBe(false);
    expect(ranked[0].kind).toBe('rank'); // 转向三张 9 的葫芦/四条路线
    expect(ranked[0].kind === 'rank' && ranked[0].rank).toBe(9);
  });

  it('策略滞后切换：原策略仍接近最优时保持，明显更差才换', () => {
    const { p, brain } = freshP0();
    const alive: BCard[] = [];
    for (let r = 2; r <= 14; r++) alive.push(card(r, 's'));
    alive.push(card(9, 'h'), card(9, 'd'), card(9, 'c'), card(9, 's'));
    p.draw = alive;
    brain.strategy = { kind: 'rank', rank: 9, score: 7.24 };
    // 三张 9 被对手删掉两张：rank 9 大幅掉分 → 切换到别的策略
    p.draw = p.draw.filter((c) => !(c.r === 9)).concat(card(9, 'h'));
    const next = curStrategy(brain, p);
    expect(next.kind === 'rank' && next.rank === 9).toBe(false);
    expect(brain.strategy).toBe(next);
  });

  it('删牌决策：永不删除策略目标牌', () => {
    const { p } = freshP0();
    p.discard = [card(8, 'h'), card(3, 'd'), card(4, 'c'), card(0, null)];
    const del = worstDiscardCards(p, 2, { kind: 'rank', rank: 8, score: 7 });
    expect(del).not.toContain(p.discard[0].id); // 8 不删
    expect(del).not.toContain(p.discard[3].id); // JOKER 不删
    expect(del).toContain(p.discard[1].id); // 删孤立低牌
  });

  it('构筑阶段按策略删牌：保留同花主体，删无关杂牌', () => {
    const { gs, p, brain } = freshP0();
    gs.phase = 'setup';
    p.setupRound = 0;
    p.setupHand = [
      card(5, 'd'), card(9, 'd'), card(12, 'd'), card(13, 'd'), card(14, 'd'), // 五张方片主体
      card(3, 's'), card(7, 'h'), card(10, 'c'), card(2, 's'),
    ];
    botAct(brain, gs, p.id, NOW);
    // bSetup：保留的进弃牌区，删除的进删牌区（随后发新一轮构筑牌）
    expect(p.discard.filter((c) => c.s === 'd').length).toBe(5);
    expect(p.removed.length).toBe(4);
    expect(p.removed.every((c) => c.s !== 'd')).toBe(true);
  });

  it('购买接入策略：点数芯片插向可转化成目标点数的牌', () => {
    const { gs, p, brain } = freshP0();
    gs.phase = 'buy';
    gs.turnSeat = p.seat;
    p.buyPassed = false;
    p.blood = 20;
    p.privilege = false; // 排除特权分红抢购与随机特权影响
    p.setupHand = []; // 排除随机构筑牌对策略推导的干扰
    p.discard = [card(8, 'h'), card(5, 'c')];
    p.draw = [card(9, 's'), card(9, 'h'), card(9, 'd')];
    p.hand = [];
    brain.strategy = { kind: 'rank', rank: 9, score: 7 };
    gs.market[0] = { def: 'calib1', bonus: 0 }; // 校准器+1：8 → 9
    gs.market[1] = { def: 'refill', bonus: 0 };
    gs.market[2] = { def: 'dividend', bonus: 0 }; // 无特权 → 低分，避免干扰
    gs.market[3] = { def: 'closingS', bonus: 0 };
    gs.market[4] = { def: 'dividend', bonus: 0 };
    botAct(brain, gs, p.id, NOW);
    const chip = p.chips.find((ch) => ch.def === 'calib1');
    expect(chip).toBeTruthy();
    expect(p.discard.find((c) => c.id === chip!.on)?.r).toBe(8); // 插在 8 上凑成第 4 张 9
  });
});

describe('血色机器人 · 对手策略猜测', () => {

  /** 座位 deck 中 (点数,花色) 对应的牌 id（与 seatDeck 发牌顺序一致） */
  function seenId(seat: number, r: number, s: 's' | 'h' | 'd' | 'c'): string {
    const suits = ['s', 'h', 'd', 'c'];
    let n = 0;
    for (const ss of suits) {
      for (let rr = 2; rr <= 14; rr++) {
        if (ss === s && rr === r) return `c${seat}-${n}`;
        n++;
      }
    }
    throw new Error('unreachable');
  }

  it('亮牌直方图：反复亮红心 → 猜同花红心，带座位号', () => {
    const gs = createBloodGame(2, makePlayers(2), NOW);
    const brain = createBrain();
    brain.seen.set(1, new Set([seenId(1, 3, 'h'), seenId(1, 7, 'h'), seenId(1, 12, 'h')]));
    const g = guessOppStrategy(brain, gs.players[1]);
    expect(g).not.toBeNull();
    expect(g!.strat.kind).toBe('flush');
    expect(g!.strat.kind === 'flush' && g!.strat.suit).toBe('h');
    expect(g!.seat).toBe(1);
    const threat = strongestThreat(brain, gs, gs.players[0]);
    expect(threat?.seat).toBe(1);
  });

  it('购买宣告佐证：花色芯片购买提高同花猜测置信度', () => {
    const gs = createBloodGame(2, makePlayers(2), NOW);
    const brain = createBrain();
    brain.seen.set(1, new Set([seenId(1, 3, 'h'), seenId(1, 7, 'h'), seenId(1, 12, 'h')]));
    const baseConf = guessOppStrategy(brain, gs.players[1])!.conf;
    brain.oppBuys.set(1, ['redChip', 'inkSuit', 'betDeal']);
    const boosted = guessOppStrategy(brain, gs.players[1])!;
    expect(boosted.conf).toBeGreaterThan(baseConf);
    expect(boosted.conf).toBeGreaterThanOrEqual(0.9);
  });

  it('信号不足：亮牌太少且无购买记录 → 不猜测', () => {
    const gs = createBloodGame(2, makePlayers(2), NOW);
    const brain = createBrain();
    brain.seen.set(1, new Set([seenId(1, 3, 'h'), seenId(1, 7, 'h')])); // 同花仅 2 张、无对子
    expect(guessOppStrategy(brain, gs.players[1])).toBeNull();
    expect(strongestThreat(brain, gs, gs.players[0])).toBeNull();
  });

  it('updateBrains 采集对手公开购买宣告，且不重复计数', () => {
    const gs = createBloodGame(2, makePlayers(2), NOW);
    gs.announce = { defId: 'redChip', buyerSeat: 1, at: 12345 };
    const brains = new Map([['p0', createBrain()]]);
    updateBrains(brains, ['p0'], gs);
    updateBrains(brains, ['p0'], gs); // 同一条宣告不重复计
    expect(brains.get('p0')!.oppBuys.get(1)).toEqual(['redChip']);
    gs.announce = { defId: 'inkSuit', buyerSeat: 1, at: 19999 };
    updateBrains(brains, ['p0'], gs);
    expect(brains.get('p0')!.oppBuys.get(1)).toEqual(['redChip', 'inkSuit']);
  });

  it('赌徒虹膜：按推断牌型竞猜最危险对手', () => {
    const gs = createBloodGame(2, makePlayers(2), NOW);
    const p0 = gs.players[0];
    gs.secretPending = { seat: p0.id, kind: 'irisGuess' };
    const brain = createBrain();
    brain.seen.set(1, new Set([seenId(1, 8, 's'), seenId(1, 8, 'h'), seenId(1, 8, 'd')])); // 反复亮 8 → 猜多条
    botAct(brain, gs, 'p0', NOW);
    expect(gs.irisGuess?.seat).toBe(1);
    expect(gs.irisGuess?.cat).toBe(7); // 成型度高 → 押四条
  });

  it('赌徒虹膜：无猜测时回退盲猜牌型 2', () => {
    const gs = createBloodGame(2, makePlayers(2), NOW);
    const p0 = gs.players[0];
    gs.secretPending = { seat: p0.id, kind: 'irisGuess' };
    botAct(createBrain(), gs, 'p0', NOW);
    expect(gs.irisGuess?.cat).toBe(2);
  });

  it('魔术橡皮：宣告最危险对手的推断牌型', () => {
    const gs = createBloodGame(2, makePlayers(2), NOW);
    const p0 = gs.players[0];
    gs.secretPending = { seat: p0.id, kind: 'eraserClaim' };
    const brain = createBrain();
    brain.seen.set(1, new Set([seenId(1, 5, 'd'), seenId(1, 5, 's'), seenId(1, 5, 'c')])); // 对手凑 5
    botAct(brain, gs, 'p0', NOW);
    expect(gs.eraserType).toBe(7); // 宣告四条，压其成型牌型
  });
});

describe('血色机器人 · 换牌节奏', () => {
  /** 建立一局并推进到 swap（强制角色） */
  function toSwapC(c0: string, c1: string): BloodState {
    const gs = createBloodGame(2, makePlayers(2), NOW);
    gs.players[0].charOptions = [c0, 'dealer'];
    gs.players[1].charOptions = [c1, 'clerk'];
    driveBots(gs, ['p0', 'p1'], 'swap');
    return gs;
  }

  /** 从牌池贪心构造一手"高牌散牌"（点数互异、无五连、同花色≤3） */
  function pickHighCardHand(pool: BCard[]): BCard[] {
    for (let attempt = 0; attempt < 80; attempt++) {
      const hand: BCard[] = [];
      const ranks = new Set<number>();
      const suits = new Map<string, number>();
      const order = pool.slice().sort(() => Math.random() - 0.5);
      for (const c of order) {
        if (c.r === 0 || ranks.has(c.r)) continue;
        if ((suits.get(c.s!) ?? 0) >= 3) continue;
        hand.push(c);
        ranks.add(c.r);
        suits.set(c.s!, (suits.get(c.s!) ?? 0) + 1);
        if (hand.length === 6) break;
      }
      const rs = [...ranks].sort((a, b) => a - b);
      let run = 1;
      let ok = hand.length === 6;
      for (let i = 1; i < rs.length && ok; i++) {
        run = rs[i] === rs[i - 1] + 1 ? run + 1 : 1;
        if (run >= 5) ok = false;
      }
      if (ok) return hand;
    }
    throw new Error('无法构造高牌散牌手牌');
  }

  it('换牌：成手（三条）立即停牌，未用次数兑换血筹', () => {
    const gs = toSwapC('clerk', 'clerk');
    const p0 = gs.players[0];
    const pool = [...p0.draw, ...p0.hand, ...p0.discard];
    const threes = pool.filter((c) => c.r === 9).slice(0, 3);
    expect(threes.length).toBe(3);
    const filler = pool.filter((c) => c.r !== 9 && !threes.includes(c)).slice(0, 3);
    p0.hand = [...threes, ...filler];
    p0.draw = pool.filter((c) => !p0.hand.includes(c));
    p0.discard = [];
    const swapLeft = p0.swapLeft;
    const bloodBefore = p0.blood;
    botAct(createBrain(), gs, p0.id, NOW);
    expect(p0.swapDone).toBe(true); // 成手停牌，不再浪费次数
    expect(p0.swapLeft).toBe(swapLeft);
    // 对手也停 → 换牌阶段收尾，未用次数 1:1 兑换血筹
    bSwapStop(gs, gs.players[1].id, NOW);
    expect(p0.blood).toBe(bloodBefore + swapLeft);
  });

  it('换牌：弱牌（高牌）弃满上限重铸手牌', () => {
    const gs = toSwapC('clerk', 'clerk');
    const p0 = gs.players[0];
    const pool = [...p0.draw, ...p0.hand, ...p0.discard];
    const hand = pickHighCardHand(pool);
    p0.hand = hand;
    p0.draw = pool.filter((c) => !hand.includes(c));
    p0.discard = [];
    const swapLeft = p0.swapLeft;
    botAct(createBrain(), gs, p0.id, NOW);
    expect(p0.swapDone).toBe(false); // 弱牌继续换
    expect(p0.discard.length).toBe(3); // 一次弃满 3 张
    expect(p0.hand.length).toBe(6); // 抽至上限
    expect(p0.swapLeft).toBe(swapLeft - 1);
  });
});
