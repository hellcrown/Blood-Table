/**
 * 安全加固回归测试：
 * - 客户端可控参数的越权/畸形输入（NaN 注入、暗牌定点操作、数组类型混淆）
 * - 状态机拒绝畸形动作而非静默过回合
 * - 无人跟注局不亮赢家底牌
 */
import { describe, expect, it } from 'vitest';
import type { BCard, BloodState } from '../src/blood/types';
import {
  BloodError,
  bBuy,
  bCleanerDel,
  bCrownBid,
  bDemagPick,
  bDogTarget,
  bInsertSkip,
  bPassBuy,
  bPickChar,
  bPlay,
  bSecretTarget,
  bSetup,
  bShowdownDone,
  bSwap,
  bSwapStop,
  bUseItem,
  createBloodGame as createBloodGameRaw,
} from '../src/blood/engine';
import { applyAction, createGame, startHand } from '../src/game/engine';
import { GameError, type GState } from '../src/game/types';
import { RoomManager } from '../src/rooms';

const NOW = 1000;
const isRank = (r: number) => (c: BCard) => c.r === r;

/** 竞拍在选将后：随机分配局（crownBid 起手）直接按 1 出价进入构筑；选将局由测试显式选将后调 settleCrownBid */
function createBloodGame(...args: Parameters<typeof createBloodGameRaw>): BloodState {
  const gs = createBloodGameRaw(...args);
  if (gs.phase === 'crownBid') for (const p of gs.players) bCrownBid(gs, p.id, 1, NOW);
  return gs;
}

/** 选将完成后按 1 出价结算竞拍（进入初始构筑） */
function settleCrownBid(gs: BloodState): void {
  if (gs.phase !== 'crownBid') throw new Error(`not in crownBid: ${gs.phase}`);
  for (const p of gs.players) bCrownBid(gs, p.id, 1, NOW);
}

function mk2p(): BloodState {
  const gs = createBloodGame(2, [{ id: 'p0', name: '甲', seat: 0 }, { id: 'p1', name: '乙', seat: 1 }], NOW);
  for (const p of gs.players) {
    p.charOptions = ['dealer', 'noble'];
    bPickChar(gs, p.id, 'dealer', NOW);
  }
  settleCrownBid(gs);
  return gs;
}

function setupDone(gs: BloodState): void {
  for (let r = 0; r < 2; r++) {
    for (const p of gs.players) bSetup(gs, p.id, [], NOW);
  }
}

/** 从玩家所有区域收集指定牌并布置为手牌，其余放入抽牌堆 */
function giveHand(gs: BloodState, seat: number, match: ((c: BCard) => boolean)[]): void {
  const p = gs.players.find((x) => x.seat === seat)!;
  const pool = [...p.draw, ...p.hand, ...p.discard, ...p.setupHand];
  const chosen: BCard[] = [];
  const rest: BCard[] = [];
  const used = new Set<string>();
  for (const m of match) {
    const found = pool.find((c) => !used.has(c.id) && m(c));
    if (found) {
      used.add(found.id);
      chosen.push(found);
    }
  }
  for (const c of pool) if (!used.has(c.id)) rest.push(c);
  p.hand = chosen;
  p.draw = rest;
  p.discard = [];
  p.setupHand = [];
}

function confirmSd(gs: BloodState): void {
  for (const p of gs.players) bShowdownDone(gs, p.id, NOW);
}

function expectBloodError(fn: () => void, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BloodError);
    expect((e as BloodError).code).toBe(code);
    return;
  }
  throw new Error(`应当抛出 BloodError(${code})，但没有抛错`);
}

describe('加固 · 血色引擎', () => {
  it('赌狗掷出 1 点时删 0 张，不再 splice(-0) 删光整副抽牌堆', () => {
    const gs = mk2p();
    setupDone(gs);
    const p0 = gs.players[0];
    const t = gs.players[1];
    expect(t.draw.length).toBeGreaterThanOrEqual(6);
    let sawRollOne = false;
    for (let i = 0; i < 80 && !sawRollOne; i++) {
      const before = t.draw.length;
      const removedBefore = t.removed.length;
      gs.secretPending = { seat: p0.id, kind: 'dogTarget' };
      bDogTarget(gs, p0.id, 1, NOW);
      const text = gs.log[gs.log.length - 1]?.text ?? '';
      const m = /掷出 (\d+) 点：删除其抽牌堆顶 (\d+) 张/.exec(text);
      expect(m).not.toBeNull();
      const roll = Number(m![1]);
      const deleted = Number(m![2]);
      expect(deleted).toBe(Math.min(roll - 1, before));
      expect(t.draw.length).toBe(before - deleted);
      expect(t.removed.length).toBe(removedBefore + deleted);
      if (roll === 1) sawRollOne = true;
    }
    expect(sawRollOne).toBe(true); // 80 次掷骰必出现 1 点（触发过原 bug 的分支）
  });

  it('清洁工：暗置抽牌堆的牌不可凭 id 指定，只可随机删或指定弃牌区明牌', () => {
    const gs = mk2p();
    setupDone(gs);
    const p0 = gs.players[0];
    const t = gs.players[1];
    const hiddenId = t.draw[t.draw.length - 1].id;
    const drawLen = t.draw.length;
    // 枚举牌 id 定点删对手暗牌：必须拒绝且不改变任何状态
    gs.secretPending = { seat: p0.id, kind: 'cleanerDel', oppQueue: [] };
    expectBloodError(() => bCleanerDel(gs, p0.id, 1, hiddenId, NOW), 'BAD_CARD');
    expect(t.draw.length).toBe(drawLen);
    expect(gs.secretPending?.kind).toBe('cleanerDel');
    // 弃牌区明牌可指定删除
    t.discard.push({ id: 'dX', r: 9, s: 'h' });
    bCleanerDel(gs, p0.id, 1, 'dX', NOW);
    expect(t.removed.some((c) => c.id === 'dX')).toBe(true);
    expect(t.discard.some((c) => c.id === 'dX')).toBe(false);
    // 空 cardId：从抽牌堆随机删 1 张
    const removedBefore = t.removed.length;
    gs.secretPending = { seat: p0.id, kind: 'cleanerDel', oppQueue: [] };
    bCleanerDel(gs, p0.id, 1, '', NOW);
    expect(t.removed.length).toBe(removedBefore + 1);
  });

  it('塔罗师：drawCount 为 NaN 时按 0 处理，弃牌上限不再失效', () => {
    const gs = createBloodGame(2, [{ id: 'p0', name: '甲', seat: 0 }, { id: 'p1', name: '乙', seat: 1 }], NOW);
    for (const p of gs.players) {
      p.charOptions = ['tarot', 'dealer'];
      bPickChar(gs, p.id, 'tarot', NOW);
    }
    settleCrownBid(gs);
    setupDone(gs);
    giveHand(gs, 0, [isRank(13), isRank(12), isRank(11), isRank(10), isRank(9), isRank(8)]);
    const p0 = gs.players[0];
    const handLen = p0.hand.length;
    const ids = p0.hand.slice(0, 3).map((c) => c.id);
    // 3 张 > 上限 2（drawCount NaN → 0）：必须拒绝且手牌不变
    expectBloodError(() => bSwap(gs, p0.id, ids, Number.NaN, NOW), 'TOO_MANY');
    expect(p0.hand.length).toBe(handLen);
    // 合法用量照常：弃 2 抽 2
    const leftBefore = p0.swapLeft;
    bSwap(gs, p0.id, ids.slice(0, 2), 2, NOW);
    expect(p0.swapLeft).toBe(leftBefore - 1);
  });

  it('货箱盲掏：免费翻出的芯片不再复用购买的 insertInto（失败也不吞费用）', () => {
    const gs = mk2p();
    setupDone(gs);
    bSwapStop(gs, gs.players[0].id, NOW);
    bSwapStop(gs, gs.players[1].id, NOW);
    bPlay(gs, gs.players[0].id, gs.players[0].hand.slice(0, 5).map((c) => c.id), NOW);
    bPlay(gs, gs.players[1].id, gs.players[1].hand.slice(0, 5).map((c) => c.id), NOW);
    confirmSd(gs);
    expect(gs.phase).toBe('buy');
    const buyer = gs.players.find((p) => gs.turnSeat === p.seat)!;
    buyer.blood += 10;
    gs.supply.push('calib1'); // 牌堆顶：校准器 +1（rankMod 芯片）
    gs.market[0] = { def: 'crateDig', bonus: 0 };
    const k = { id: 'k13', r: 13, s: 's' as const };
    buyer.discard.push(k);
    buyer.chips.push({ id: 'ch-pre', def: 'calib1', on: k.id }); // K 已带芯片：免费芯片插入必失败
    const bloodBefore = buyer.blood;
    // 修复前：免费芯片带着 insertInto 走 insertChip → 抛错，费用已扣、芯片蒸发
    bBuy(gs, buyer.id, 0, k.id, NOW);
    expect(gs.secretPending?.kind).toBe('insertChip');
    expect(buyer.blood).toBe(bloodBefore - 3); // 只扣货箱盲掏的费用
    bInsertSkip(gs, buyer.id, NOW); // 无处可插：跳过，流程继续
    expect(gs.secretPending).toBeNull();
  });

  it('消磁枪：只可指定目标出牌区上的芯片，不可探测暗置弃牌区', () => {
    const gs = mk2p();
    setupDone(gs);
    bSwapStop(gs, gs.players[0].id, NOW);
    bSwapStop(gs, gs.players[1].id, NOW);
    giveHand(gs, 0, [isRank(13), isRank(13), isRank(13), isRank(13), isRank(3), isRank(2)]);
    giveHand(gs, 1, [isRank(7), isRank(9), isRank(4), isRank(6), isRank(5), isRank(11)]);
    const p0 = gs.players[0];
    const p1 = gs.players[1];
    p1.chips.push({ id: 'ch-cal', def: 'calib1', on: p1.hand[0].id });
    // 芯片挂在乙的暗置弃牌区（bPlay 后剩余手牌进弃牌区）
    const hidden = p1.hand[5];
    p1.chips.push({ id: 'ch-hid', def: 'calib1', on: hidden.id });
    p0.items.push({ id: 'it-dm', def: 'demag' });
    bPlay(gs, 'p0', p0.hand.slice(0, 5).map((c) => c.id), NOW);
    bPlay(gs, 'p1', p1.hand.slice(0, 5).map((c) => c.id), NOW);
    expect(gs.phase).toBe('reveal');
    bUseItem(gs, 'p0', 'it-dm', NOW);
    bSecretTarget(gs, 'p0', 1, NOW);
    expect(gs.secretPending?.kind).toBe('demagPick');
    // 暗区芯片：拒绝且决策保留
    expectBloodError(() => bDemagPick(gs, 'p0', hidden.id, 'calib1', NOW), 'BAD_TARGET');
    expect(gs.secretPending?.kind).toBe('demagPick');
    // 出牌区芯片：正常失效
    bDemagPick(gs, 'p0', p1.play[0].id, 'calib1', NOW);
    expect(p1.chips.find((c) => c.id === 'ch-cal')!.off).toBe(true);
  });
});

function mkClassic(n: number, chips = 1000): GState {
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i, chips }));
  return createGame({ sb: 5, bb: 10, startChips: chips }, n, players);
}

describe('加固 · 经典引擎', () => {
  it('畸形 action（null / 未知 k / 空对象）显式拒绝，不再静默过回合', () => {
    const gs = mkClassic(2);
    startHand(gs, NOW);
    const seatNo = gs.toActSeat!;
    const reject = (action: unknown): void => {
      try {
        applyAction(gs, seatNo, action as never, NOW);
      } catch (e) {
        expect(e).toBeInstanceOf(GameError);
        expect((e as GameError).code).toBe('BAD_ACTION');
        return;
      }
      throw new Error('畸形 action 应当被拒绝');
    };
    reject(null);
    reject(undefined);
    reject({});
    reject({ k: 'ghost' });
    reject(42);
    // 状态未被推动
    expect(gs.toActSeat).toBe(seatNo);
    expect(gs.phase).toBe('preflop');
    // 合法动作不受影响
    applyAction(gs, seatNo, { k: 'call' }, NOW);
  });

  it('其余全弃牌：赢家收池但不亮底牌；全下摊牌照常亮牌', () => {
    const gs = mkClassic(3);
    startHand(gs, NOW);
    let guard = 0;
    while (gs.phase !== 'result' && guard++ < 6) {
      const s = gs.toActSeat;
      if (s == null) break;
      applyAction(gs, s, { k: 'fold' }, NOW);
    }
    expect(gs.phase).toBe('result');
    expect(gs.showdown).toBe(false);
    const winner = gs.result!.rows.find((r) => !r.foldedOut)!;
    expect(winner.hole).toBeNull();

    // 摊牌局：两家全下打完公共牌，底牌公开
    const gs2 = mkClassic(2, 500);
    startHand(gs2, NOW);
    const btn = gs2.buttonSeat;
    const bb = gs2.bbSeat!;
    applyAction(gs2, btn, { k: 'raise', to: 500 }, NOW);
    applyAction(gs2, bb, { k: 'allin' }, NOW);
    expect(gs2.phase).toBe('result');
    expect(gs2.showdown).toBe(true);
    for (const r of gs2.result!.rows) {
      if (!r.foldedOut) expect(r.hole).not.toBeNull();
    }
  });

  it('房间设置：数值注入 NaN/非数字被钳制回退，不再污染筹码与座位上限', () => {
    const mgr = new RoomManager();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const room: any = {
      code: 'T1',
      hostId: 'h',
      ownerIp: '',
      maxPlayers: 4,
      mode: 'classic',
      settings: { sb: 5, bb: 10, startChips: 1000 },
      charExpansion: false,
      expansion: false,
      targetTickets: 0,
      sessions: new Map(),
      game: null,
      pendingRemove: new Set(),
      emptySince: 0,
      botBrains: new Map(),
      botNextAct: new Map(),
      matchLogged: false,
      gameStartedAt: null,
    };
    const host: any = { id: 'h', token: 't', name: '房主', seat: 0, connected: true, ws: null, lastEventSeq: 0 };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const set = (msg: Record<string, unknown>): void => (mgr as any).handleSettings(room, host, msg);
    set({ t: 'settings', sb: 'abc' });
    expect(room.settings.sb).toBe(5);
    set({ t: 'settings', bb: Number.NaN });
    expect(room.settings.bb).toBe(10);
    set({ t: 'settings', startChips: '1e999' });
    expect(room.settings.startChips).toBe(1000);
    set({ t: 'settings', maxPlayers: 'x' });
    expect(room.maxPlayers).toBe(4);
    // 合法设置照常生效
    set({ t: 'settings', sb: 20, bb: 40, startChips: 500, maxPlayers: 3 });
    expect(room.settings).toEqual({ sb: 20, bb: 40, startChips: 500 });
    expect(room.maxPlayers).toBe(3);
  });
});
