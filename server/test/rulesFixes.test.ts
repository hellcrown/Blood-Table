import { describe, expect, it, vi } from 'vitest';
import { evalBloodHand, applyImitate, type EvalCard } from '@shared/bloodEval';
import type { BloodState, BPlayer } from '../src/blood/types';
import { bloodTick, createBloodGame as createBloodGameRaw, bCrownBid, bPickChar, bPlay, bGamblerGuess, bRevealChipTarget, finalRank, bAgentAsk, bAgentDecide } from '../src/blood/engine';
import { createGame, startHand, applyAction } from '../src/game/engine';
import { RoomManager } from '../src/rooms';
import { BloodError } from '../src/blood/engine';
import { legalActionsFor } from '../src/game/betting';

const NOW = 1000;

/** 选将完成后按 1 出价结算竞拍（进入初始构筑）；竞拍在选将后 */
function settleCrownBid(gs: BloodState): void {
  if (gs.phase !== 'crownBid') throw new Error(`not in crownBid: ${gs.phase}`);
  for (const p of gs.players) bCrownBid(gs, p.id, 1, NOW);
}

function makeGame(charIds: [string, string]): BloodState {
  const gs = createBloodGameRaw(2, [{ id: 'p0', name: '甲', seat: 0 }, { id: 'p1', name: '乙', seat: 1 }], NOW);
  for (const [i, cid] of charIds.entries()) {
    const p = gs.players[i];
    p.charOptions = [cid, 'noble'];
    bPickChar(gs, p.id, cid, NOW);
  }
  settleCrownBid(gs);
  return gs;
}

function dealFive(gs: BloodState, p: BPlayer): string[] {
  p.hand = p.draw.splice(-5);
  return p.hand.map((c) => c.id);
}

describe('深查修复 · 血色引擎', () => {
  it('出牌钩子队列化：竞猜挂起期间设计师出牌，竞猜后钩子仍触发', () => {
    const gs = makeGame(['designer', 'gambler']);
    gs.phase = 'play';
    const p0 = gs.players[0];
    const ids = dealFive(gs, p0);
    gs.secretPending = { seat: 'p1', kind: 'gamblerGuess' }; // 赌徒竞猜挂起中（挂起者是 p1）
    bPlay(gs, 'p0', ids.slice(0, 5), NOW);
    expect(gs.secretPending?.kind).toBe('gamblerGuess'); // 未被覆盖
    expect(gs.playHooks).toContainEqual({ seat: 'p0', kind: 'designerDiscard' });
    bGamblerGuess(gs, 'p1', 0, NOW + 100);
    expect(gs.secretPending?.kind).toBe('designerDiscard'); // 竞猜后钩子出队
  });

  it('消磁枪二级选芯片超时：清理挂起并推进（不泄漏进结算）', () => {
    const gs = makeGame(['dealer', 'dealer']);
    gs.phase = 'reveal';
    gs.turnSeat = 0;
    gs.secretPending = { seat: 'p0', kind: 'demagPick', defId: 'demag', targetSeat: 'p1' };
    gs.deadline = NOW + 60_000;
    bloodTick(gs, NOW + 61_000);
    expect(gs.secretPending).toBeNull();
    expect(gs.phase).not.toBe('reveal'); // 已推进
  });

  it('复制芯片不能复制自己', () => {
    const gs = makeGame(['dealer', 'dealer']);
    gs.phase = 'reveal';
    const p0 = gs.players[0];
    p0.play = [{ id: 'cx', r: 5, s: 's' }];
    p0.chips = [{ id: 'cc1', def: 'copyChip', on: 'cx' }];
    gs.secretPending = { seat: 'p0', kind: 'revealDecide', decision: { t: 'copy', chipId: 'cc1', cardId: 'cx', defId: 'copyChip' } };
    expect(() => bRevealChipTarget(gs, 'p0', 0, 'cx', 'copyChip', NOW)).toThrow(/不能复制自己/);
  });

  it('finalRank 含弹簧临时修正（与大厨数点/定点爆破口径一致）', () => {
    const gs = makeGame(['dealer', 'dealer']);
    const p0 = gs.players[0];
    const card = { id: 'c5', r: 5, s: 's' as const };
    p0.chips = [{ id: 'ch1', def: 'calib1', on: 'c5', springMod: 2 }];
    expect(finalRank(p0, card)).toBe(8); // 5 +1(校准) +2(弹簧)
    p0.chips[0].off = true;
    expect(finalRank(p0, card)).toBe(5); // 失效芯片不计
  });
});

describe('深查修复 · 评估器', () => {
  const wild = (id: string): EvalCard => ({ id, ranks: Array.from({ length: 13 }, (_, i) => i + 2), suits: ['s', 'h', 'd', 'c'], count: 1 });
  const fixed = (id: string, r: number, s: 's' | 'h' | 'd' | 'c'): EvalCard => ({ id, ranks: [r], suits: [s], count: 1 });

  it('全灵活手牌贪心回退取高解释（5 张全 wild → 5×A♠ 同花五条，pips 70）', () => {
    const r = evalBloodHand([wild('a'), wild('b'), wild('c'), wild('d'), wild('e')]);
    expect(r.cat).toBe(11); // 同花五条
    expect(r.pips).toBe(70); // 5×14
  });

  it('仿制印章仅排除自身宿主：对方印章宿主基础面是合法目标', () => {
    const cards: EvalCard[] = [fixed('a', 7, 's'), fixed('b', 9, 'h')];
    const raws = [
      { r: 7, s: 's' as const },
      { r: 9, s: 'h' as const },
    ];
    const out = applyImitate(cards, raws, [true, true]);
    // a 可仿 b 的 9♥，b 可仿 a 的 7♠（各自池排除自己）
    expect(out[0].ranks).toContain(9);
    expect(out[0].ranks).not.toContain(7);
    expect(out[1].ranks).toContain(7);
    expect(out[1].ranks).not.toContain(9);
  });
});

describe('深查修复 · 视图层', () => {
  it('revealDecide 的 prompt 必须下发 chipId（弹簧夹层人机依赖，漏发则永远「决策目标不匹配」）', async () => {
    const { buildBloodView } = await import('../src/blood/view');
    const gs = makeGame(['dealer', 'dealer']);
    gs.phase = 'reveal';
    gs.turnSeat = 0;
    const p0 = gs.players[0];
    p0.play = [{ id: 'cx', r: 5, s: 's' }];
    p0.chips = [{ id: 'ch1', def: 'spring', on: 'cx' }];
    gs.secretPending = {
      seat: 'p0',
      kind: 'revealDecide',
      decision: { t: 'spring', chipId: 'ch1', cardId: 'cx', defId: 'spring' },
    };
    const room = {
      code: 'TEST',
      hostId: '',
      ownerIp: '',
      maxPlayers: 2,
      mode: 'blood' as const,
      settings: { sb: 5, bb: 10, startChips: 1000 },
      charExpansion: false,
      expansion: false,
      targetTickets: 0,
      sessions: new Map(),
      game: gs,
      pendingRemove: new Set(),
      emptySince: 0,
      botBrains: new Map(),
      botNextAct: new Map(),
      matchLogged: false,
      gameStartedAt: null,
    };
    const view = buildBloodView(room as never, gs, 'p0');
    expect(view.prompt.k).toBe('revealDecide');
    expect(view.prompt.chipId).toBe('ch1');
    expect(view.prompt.decision?.chipId).toBe('ch1');
  });

  it('视图过滤失效芯片：cardView 不下发 off 芯片（目标列表不再有死按钮）', async () => {
    const { buildBloodView } = await import('../src/blood/view');
    const gs = makeGame(['dealer', 'dealer']);
    gs.phase = 'reveal';
    const p1 = gs.players[1];
    p1.play = [{ id: 'cx', r: 9, s: 'h' }];
    p1.chips = [
      { id: 'chA', def: 'calib1', on: 'cx' },
      { id: 'chB', def: 'calib2', on: 'cx', off: true },
    ];
    const room = {
      code: 'TEST',
      hostId: '',
      ownerIp: '',
      maxPlayers: 2,
      mode: 'blood' as const,
      settings: { sb: 5, bb: 10, startChips: 1000 },
      charExpansion: false,
      expansion: false,
      targetTickets: 0,
      sessions: new Map(),
      game: gs,
      pendingRemove: new Set(),
      emptySince: 0,
      botBrains: new Map(),
      botNextAct: new Map(),
      matchLogged: false,
      gameStartedAt: null,
    };
    const view = buildBloodView(room as never, gs, 'p0');
    const played = view.players.find((p) => p.seat === 1)?.played ?? [];
    expect(played[0]?.chipIds).toEqual(['calib1']); // off 的 calib2 不下发
  });
});
describe('第四轮回修', () => {
  it('德州 allin 在 shortAllIn 限制下为普通跟注（不得超额全栈推入）', () => {
    const players = [
      { id: 'a', name: '甲', seat: 0, chips: 1000 },
      { id: 'b', name: '乙', seat: 1, chips: 1000 },
      { id: 'c', name: '丙', seat: 2, chips: 1000 },
    ];
    const gs = createGame({ sb: 5, bb: 10, startChips: 1000 }, 3, players);
    startHand(gs, NOW);
    while (gs.toActSeat != null && gs.phase === 'preflop') {
      const legal = legalActionsFor(gs, gs.toActSeat)!;
      applyAction(gs, gs.toActSeat, legal.canCheck ? { k: 'check' } : { k: 'call' }, NOW + 100);
    }
    expect(gs.phase).toBe('flop');
    const first = gs.toActSeat!;
    applyAction(gs, first, { k: 'raise', to: 200 }, NOW + 200);
    const second = gs.toActSeat!;
    applyAction(gs, second, { k: 'fold' }, NOW + 250); // 第三人弃牌出局
    const last = gs.toActSeat!;
    gs.players.find((p) => p.seat === last)!.chips = 250;
    applyAction(gs, last, { k: 'allin' }, NOW + 300); // 250 > 200，短全下
    expect(gs.currentBet).toBe(250);
    expect(gs.shortAllIn).toBe(true);
    // 回到加注者：已行动且被 shortAllIn 限制，allin 应为普通跟注 50（不得把 800 全栈推入）
    expect(gs.toActSeat).toBe(first);
    applyAction(gs, first, { k: 'allin' }, NOW + 400);
    const firstP = gs.players.find((p) => p.seat === first)!;
    // 语义断言：只跟 50，未全下（全栈推入的旧行为会 allIn=true 且 chips=0）；
    // call 后立即 run-out 摊牌，筹码为结算后值（可能赢池），不断言具体数额
    expect(firstP.allIn).toBe(false);
    expect(firstP.committed).toBe(260); // 确定性总投入：盲注 10 + 加注 200 + 跟注 50（未全栈推入 1000）
  });

  it('特工交换：芯片随宿主牌转移属主（此前集合写反恒为空集）', () => {
    const gs = makeGame(['agent', 'dealer']);
    gs.phase = 'play';
    const [a, b] = gs.players;
    a.hand = a.draw.splice(-1);
    b.hand = b.draw.splice(-1);
    const aCard = a.hand[0];
    const bCard = b.hand[0];
    a.chips = [{ id: 'chA', def: 'calib1', on: aCard.id }];
    b.chips = [{ id: 'chB', def: 'calib2', on: bCard.id }];
    gs.playHooks = [];
    bPlay(gs, a.id, [aCard.id], NOW);
    bPlay(gs, b.id, [bCard.id], NOW);
    expect(gs.secretPending?.kind).toBe('agentAsk');
    bAgentAsk(gs, a.id, 1, NOW + 100);
    expect(gs.secretPending?.kind).toBe('agentDecide');
    bAgentDecide(gs, b.id, true, NOW + 200);
    // 2 人局内 reveal→结算同步走完：agentSwap 已归还清空，芯片应各回原主（集合写反时这里会交叉错主）
    expect(gs.agentSwap).toBeNull();
    expect(a.chips.map((c) => c.id)).toEqual(['chA']);
    expect(b.chips.map((c) => c.id)).toEqual(['chB']);
  });
});

describe('第五轮 · 对抗性协议', () => {
  it('对局进行中入座的会话发 b* 动作 → 干净的 NO_PLAYER（非 INTERNAL TypeError）', () => {
    const mgr = new RoomManager();
    const m = mgr as unknown as Record<string, (...a: unknown[]) => unknown>;
    const rooms = (m as unknown as { rooms: Map<string, { code: string; sessions: Map<string, { id: string }>; game: unknown }> }).rooms;
    const stub = (ip: string, sent: unknown[] = []) =>
      ({ readyState: 0, OPEN: 0, send: (d: string) => sent.push(JSON.parse(d)), on: () => {}, close: () => {}, ip }) as never;

    const sent1: unknown[] = [];
    m.handleCreate(stub('7.7.7.1', sent1), { t: 'create', name: '甲', maxPlayers: 3, mode: 'blood' });
    const room = [...rooms.values()][0];
    const hostSession = [...room.sessions.values()][0];
    const sent2: unknown[] = [];
    m.handleJoin(stub('7.7.7.2', sent2), { t: 'join', code: room.code, name: '乙' });
    m.handleStart(room, hostSession);
    expect(room.game).not.toBeNull();

    // 对局开始后第三人才入座：session 存在但不在于 bs.players
    const sent3: unknown[] = [];
    m.handleJoin(stub('7.7.7.3', sent3), { t: 'join', code: room.code, name: '丙' });
    const session3 = [...room.sessions.values()].at(-1)!;

    expect(() =>
      (m as unknown as { handleBlood: (r: unknown, s: unknown, msg: unknown) => void }).handleBlood(room, session3, {
        t: 'bSwap',
        cardIds: [],
      }),
    ).toThrowError(BloodError);
  });
});

describe('部署排水', () => {
  it('countActiveGames：等待房不计/对局房计；setDraining 公告对每个对局只发一次', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const mgr = new RoomManager();
    const m = mgr as unknown as Record<string, (...a: unknown[]) => unknown>;
    const rooms = (m as unknown as { rooms: Map<string, any> }).rooms;
    const stub = (ip: string) => ({ readyState: 0, OPEN: 0, send: () => {}, on: () => {}, close: () => {}, ip }) as never;

    m.handleCreate(stub('8.8.8.1'), { t: 'create', name: '甲', maxPlayers: 3, mode: 'blood' });
    const room = [...rooms.values()][0];
    const hostSession = [...room.sessions.values()][0];
    m.handleJoin(stub('8.8.8.2'), { t: 'join', code: room.code, name: '乙' });
    // 未开局：games = 0
    expect(mgr.countActiveGames()).toBe(0);
    mgr.setDraining(true); // 等待房不发公告
    expect(room.game).toBeNull();

    m.handleStart(room, hostSession);
    expect(mgr.countActiveGames()).toBe(1);
    // 排水中开局：立即收到一条公告
    const notices = () => room.game!.log.filter((l: { text: string }) => l.text.includes('服务器即将更新')).length;
    expect(notices()).toBe(1);

    // 重复置位/重复 tick 不再追加公告
    mgr.setDraining(true);
    mgr.setDraining(true);
    expect(notices()).toBe(1);

    mgr.setDraining(false); // 关闭清空已公告集合：再次开启会重新公告（新排水轮）
    mgr.setDraining(true);
    expect(notices()).toBe(2);
    mgr.setDraining(false);
    vi.useRealTimers();
  });
});
