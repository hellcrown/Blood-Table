import { describe, expect, it } from 'vitest';
import {
  BloodError,
  bBuy,
  bInsertChip,
  bInsertSkip,
  bPassBuy,
  bPlay,
  bPickChar,
  bRefreshPick,
  bRemove,
  bRemoveDone,
  bReorg,
  bSecretDelete,
  bSetup,
  bShowdownDone,
  bSteal,
  bSwap,
  bSwapStop,
  bUseItem,
  bViolent,
  bestFive,
  bloodTick,
  createBloodGame,
} from '../src/blood/engine';
import { BLOOD_MARKET_BY_ID } from '@shared/bloodCards';
import type { BloodState, BPlayer } from '../src/blood/types';

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

function ri(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

function pick<T>(rng: () => number, arr: T[]): T | null {
  return arr.length === 0 ? null : arr[ri(rng, arr.length)];
}

function tryAct(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (e) {
    if (e instanceof BloodError) return false;
    throw e;
  }
}

function randomSubset<T>(rng: () => number, arr: T[], max: number): T[] {
  const copy = arr.slice();
  const n = Math.min(max + (rng() < 0.5 ? 0 : 1), copy.length, ri(rng, max) + 1);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(...copy.splice(ri(rng, copy.length), 1));
  return out;
}

function randomAction(gs: BloodState, p: BPlayer, rng: () => number, now: number): void {
  const others = gs.players.filter((x) => x.id !== p.id);
  switch (gs.phase) {
    case 'pick': {
      if (!p.charId && p.charOptions.length > 0) {
        tryAct(() => bPickChar(gs, p.id, p.charOptions[ri(rng, p.charOptions.length)], now));
      }
      return;
    }
    case 'setup': {
      if (p.setupRound < 2 && rng() < 0.85) {
        tryAct(() => bSetup(gs, p.id, randomSubset(rng, p.setupHand, 4).map((c) => c.id), now));
      }
      return;
    }
    case 'swap': {
      if (p.swapDone) return;
      if (rng() < 0.7 && p.hand.length > 0) {
        const ids = randomSubset(rng, p.hand, 3).map((c) => c.id);
        tryAct(() => bSwap(gs, p.id, ids, now));
      } else {
        tryAct(() => bSwapStop(gs, p.id, now));
      }
      return;
    }
    case 'play': {
      if (p.locked || p.hand.length < 5) return;
      if (rng() < 0.5) {
        tryAct(() => bPlay(gs, p.id, bestFive(p), now));
      } else {
        tryAct(() => bPlay(gs, p.id, randomSubset(rng, p.hand, 5).map((c) => c.id), now));
      }
      return;
    }
    case 'reveal': {
      if (gs.turnSeat !== p.seat) return;
      if (gs.stealPending && gs.stealPending.seat === p.id) {
        const targets = others.filter((o) => o.blood >= gs.stealPending!.blood);
        const t = pick(rng, targets);
        if (t) tryAct(() => bSteal(gs, p.id, t.seat, now));
        return;
      }
      const usable = p.items.filter((i) => BLOOD_MARKET_BY_ID.get(i.def)?.effect.k === 'dealerLicense');
      if (usable.length > 0 && rng() < 0.5) {
        tryAct(() => bUseItem(gs, p.id, usable[0].id, now));
      } else {
        tryAct(() => bUseItem(gs, p.id, null, now));
      }
      return;
    }
    case 'settle': {
      // 对决展示确认（模拟客户端关闭演示浮层）
      tryAct(() => bShowdownDone(gs, p.id, now));
      return;
    }
    case 'buy': {
      const pend = gs.secretPending;
      if (pend && pend.seat === p.id) {
        if (pend.kind === 'insertChip') {
          const c = pick(rng, p.discard);
          if (c && rng() < 0.8) tryAct(() => bInsertChip(gs, p.id, c.id, now));
          else tryAct(() => bInsertSkip(gs, p.id, now));
        } else if (pend.kind === 'deleteUpTo') {
          tryAct(() => bSecretDelete(gs, p.id, randomSubset(rng, p.discard, pend.max ?? 2).map((c) => c.id), now));
        } else if (pend.kind === 'violentTarget') {
          const targets = [p, ...others].filter((x) => x.draw.length >= 3);
          const t = pick(rng, targets);
          if (t && rng() < 0.8) tryAct(() => bViolent(gs, p.id, t.seat, now));
          else tryAct(() => bViolent(gs, p.id, -1, now));
        } else if (pend.kind === 'refreshPick') {
          const slots = gs.market
            .map((m, i) => ({ m, i }))
            .filter((x) => x.m.def != null)
            .map((x) => x.i);
          tryAct(() => bRefreshPick(gs, p.id, randomSubset(rng, slots, 2), now));
        }
        return;
      }
      if (gs.turnSeat !== p.seat || p.buyPassed) return;
      if (rng() < 0.45) {
        const affordable = gs.market
          .map((m, i) => ({ m, i }))
          .filter((x) => x.m.def != null && BLOOD_MARKET_BY_ID.get(x.m.def!)!.cost <= p.blood);
        const slot = pick(rng, affordable);
        if (slot) {
          const def = BLOOD_MARKET_BY_ID.get(slot.m.def!)!;
          const insertInto = def.kind === 'chip' && p.discard.length > 0 ? pick(rng, p.discard)?.id : undefined;
          tryAct(() => bBuy(gs, p.id, slot.i, insertInto, now));
          return;
        }
      }
      tryAct(() => bPassBuy(gs, p.id, now));
      return;
    }
    case 'remove': {
      if (p.removeDone) return;
      if (rng() < 0.5 && p.discard.length > 0) {
        tryAct(() => bRemove(gs, p.id, randomSubset(rng, p.discard, 2).map((c) => c.id), now));
      } else {
        tryAct(() => bRemoveDone(gs, p.id, now));
      }
      return;
    }
    case 'reorg': {
      if (p.reorgDone) return;
      tryAct(() => bReorg(gs, p.id, rng() < 0.5 ? 'reshuffle' : 'blood', now));
      return;
    }
    default:
      return;
  }
}

function checkInvariants(gs: BloodState): void {
  for (const p of gs.players) {
    const total = p.draw.length + p.hand.length + p.discard.length + p.removed.length + p.play.length + p.setupHand.length;
    expect(total).toBe(54);
    expect(p.blood).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(p.blood)).toBe(true);
    expect(Number.isFinite(p.tickets)).toBe(true);
  }
  const circulatingDefs =
    gs.supply.length +
    gs.market.filter((m) => m.def != null).length +
    gs.recycle.length +
    gs.players.reduce((s, p) => s + p.items.length + p.chips.length, 0) +
    (gs.secretPending?.defId ? 1 : 0);
  if (circulatingDefs !== 57) {
    throw new Error(
      `defs=${circulatingDefs} supply=${gs.supply.length} market=${gs.market.filter((m) => m.def != null).length} recycle=${gs.recycle.length} items=${gs.players.reduce((s, p) => s + p.items.length, 0)} chips=${gs.players.reduce((s, p) => s + p.chips.length, 0)} pending=${gs.secretPending?.defId ?? '-'} phase=${gs.phase} round=${gs.round} LOG=[${gs.log.slice(-14).map((l) => l.text).join(' | ')}]`,
    );
  }
  expect(circulatingDefs).toBe(57);
}

function simGame(seed: number): void {
  const rng = mulberry32(seed);
  const gs = createBloodGame(2, [{ id: 'p0', name: '甲', seat: 0 }, { id: 'p1', name: '乙', seat: 1 }], 1000);
  let now = 1000;
  let guard = 0;
  while (gs.phase !== 'gameover') {
    if (guard > 190_000 && guard % 2000 === 0) {
      console.log(`SLOW seed=${seed} g=${guard} phase=${gs.phase} turn=${gs.turnSeat} steal=${JSON.stringify(gs.stealPending)} pend=${JSON.stringify(gs.secretPending)} LOG=[${gs.log.slice(-10).map((l) => l.text).join(' | ')}]`);
    }
    if (guard++ > 200_000) throw new Error(`seed ${seed} 模拟未收敛（phase=${gs.phase}, round=${gs.round}）`);
    checkInvariants(gs);
    for (const p of gs.players) randomAction(gs, p, rng, now);
    now += 500;
    bloodTick(gs, now);
  }
  checkInvariants(gs);
  expect(gs.final).not.toBeNull();
  const champ = gs.players.find((p) => p.seat === gs.final!.winnerSeat)!;
  expect(champ.tickets).toBeGreaterThanOrEqual(gs.target);
  expect(gs.players.reduce((s, p) => s + p.tickets, 0)).toBeGreaterThanOrEqual(gs.target);
}

describe('血色模式 · 随机整场模拟（2人局）', () => {
  it('种子 1-20：全部打完并满足守恒', () => {
    for (let seed = 1; seed <= 20; seed++) simGame(seed);
  });
});
