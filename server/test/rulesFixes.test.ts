import { describe, expect, it } from 'vitest';
import { evalBloodHand, applyImitate, type EvalCard } from '@shared/bloodEval';
import type { BloodState, BPlayer } from '../src/blood/types';
import { bloodTick, createBloodGame, bPickChar, bPlay, bGamblerGuess, bRevealChipTarget, finalRank } from '../src/blood/engine';

const NOW = 1000;

function makeGame(charIds: [string, string]): BloodState {
  const gs = createBloodGame(2, [{ id: 'p0', name: '甲', seat: 0 }, { id: 'p1', name: '乙', seat: 1 }], NOW);
  for (const [i, cid] of charIds.entries()) {
    const p = gs.players[i];
    p.charOptions = [cid, 'noble'];
    bPickChar(gs, p.id, cid, NOW);
  }
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
