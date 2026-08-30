import { describe, expect, it } from 'vitest';
import { legalActionsFor } from '../src/game/betting';
import { applyAction, createGame, requestNextHand, startHand } from '../src/game/engine';
import type { GState } from '../src/game/types';

/** 可复现的伪随机数（mulberry32） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playRandomGame(nPlayers: number, seed: number): void {
  const rng = mulberry32(seed);
  const initial = 1000;
  const players = Array.from({ length: nPlayers }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    seat: i,
    chips: initial,
  }));
  const gs: GState = createGame({ sb: 5, bb: 10, startChips: initial }, nPlayers, players);
  let now = 1000;
  const chipsSum = () => gs.players.reduce((s, p) => s + p.chips, 0);
  let guard = 0;
  const GUARD = 500_000;
  // 下注进行中：筹码 + 已投入守恒；结算后奖金已并入筹码，只查筹码总和
  const checkInvariant = () => {
    if (gs.phase === 'result' || gs.phase === 'gameover') {
      expect(chipsSum()).toBe(initial * nPlayers);
    } else {
      expect(chipsSum() + gs.players.reduce((s, p) => s + p.committed, 0)).toBe(initial * nPlayers);
    }
  };

  startHand(gs, now);
  while (gs.phase !== 'gameover') {
    if (guard++ > GUARD) throw new Error('模拟未收敛：疑似死循环');
    checkInvariant();
    if (gs.phase === 'result') {
      expect(gs.result).not.toBeNull();
      // 池总额守恒
      const potSum = gs.result!.pots.reduce((s, x) => s + x.amount, 0);
      const committedSum = gs.players.reduce((s, p) => s + p.committed, 0);
      expect(potSum).toBe(committedSum);
      requestNextHand(gs, now);
      continue;
    }
    const seatNo = gs.toActSeat;
    if (seatNo == null) throw new Error('无人行动但未进入结算');
    const legal = legalActionsFor(gs, seatNo)!;
    const roll = rng();
    if (legal.canCheck && roll < 0.45) {
      applyAction(gs, seatNo, { k: 'check' }, now++);
    } else if (roll < 0.1) {
      applyAction(gs, seatNo, { k: 'fold' }, now++);
    } else if (legal.canCall && roll < 0.62) {
      applyAction(gs, seatNo, { k: 'call' }, now++);
    } else if (legal.canRaise && roll < 0.9) {
      const lo = legal.minRaiseTo;
      const hi = legal.maxRaiseTo;
      const to = lo + Math.floor(rng() * (hi - lo + 1));
      applyAction(gs, seatNo, { k: 'raise', to }, now++);
    } else if (roll < 0.97) {
      applyAction(gs, seatNo, { k: 'allin' }, now++);
    } else if (legal.canCheck) {
      applyAction(gs, seatNo, { k: 'check' }, now++);
    } else {
      applyAction(gs, seatNo, { k: 'call' }, now++);
    }
  }

  expect(gs.final).not.toBeNull();
  expect(gs.final!.ranking[0].chips).toBe(initial * nPlayers);
  expect(gs.players.reduce((s, p) => s + p.chips, 0)).toBe(initial * nPlayers);
}

describe('随机整场模拟', () => {
  it('2 人局 × 30 场', () => {
    for (let seed = 1; seed <= 30; seed++) playRandomGame(2, seed);
  });

  it('3 人局 × 30 场', () => {
    for (let seed = 100; seed < 130; seed++) playRandomGame(3, seed);
  });

  it('4 人局 × 30 场', () => {
    for (let seed = 200; seed < 230; seed++) playRandomGame(4, seed);
  });
});
