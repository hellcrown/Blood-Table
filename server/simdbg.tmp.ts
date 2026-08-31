import { describe, it } from 'vitest';
import { randomInt } from 'node:crypto';
import {
  bBuy, bInsertChip, bInsertSkip, bPassBuy, bPlay, bRefreshPick, bRemove, bRemoveDone,
  bReorg, bSecretDelete, bSetup, bShowdownDone, bSteal, bSwap, bSwapStop, bUseItem,
  bViolent, bestFive, bloodTick, createBloodGame, bPickChar,
} from '../src/blood/engine';
import { BLOOD_MARKET_BY_ID } from '@shared/bloodCards';
import type { BloodState, BPlayer } from '../src/blood/types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (rng: () => number, n: number): number => Math.floor(rng() * n);

it('debug seed3', () => {
  const rng = mulberry32(3);
  const gs = createBloodGame(2, [{ id: 'p0', name: '甲', seat: 0 }, { id: 'p1', name: '乙', seat: 1 }], 1000, true, false);
  let now = 1000;
  let guard = 0;
  const act = (fn: () => void): boolean => { try { fn(); return true; } catch { return false; } };
  while (gs.phase !== 'gameover' && guard++ < 200000) {
    for (const p of gs.players as BPlayer[]) {
      switch (gs.phase) {
        case 'pick': if (!p.charId && p.charOptions.length) act(() => bPickChar(gs, p.id, p.charOptions[ri(rng, p.charOptions.length)], now)); break;
        case 'setup': if (p.setupRound < 2) act(() => bSetup(gs, p.id, [], now)); break;
        case 'swap': if (!p.swapDone) act(() => bSwapStop(gs, p.id, now)); break;
        case 'play': if (!p.locked) act(() => bPlay(gs, p.id, bestFive(p), now)); break;
        case 'reveal': {
          if (gs.turnSeat !== p.seat) break;
          if (gs.secretPending?.kind === 'demagTarget') { gs.secretPending = null; continue; }
          if (gs.stealPending && gs.stealPending.seat === p.id) { gs.stealPending = null; break; }
          act(() => bUseItem(gs, p.id, null, now));
          break;
        }
        case 'settle': act(() => bShowdownDone(gs, p.id, now)); break;
        case 'buy': {
          const pend = gs.secretPending;
          if (pend && pend.seat === p.id) { gs.secretPending = null; break; }
          act(() => bPassBuy(gs, p.id, now));
          break;
        }
        case 'remove': act(() => bRemoveDone(gs, p.id, now)); break;
        case 'reorg': act(() => bReorg(gs, p.id, 'blood', now)); break;
      }
    }
    now += 500;
    bloodTick(gs, now);
  }
  throw new Error(`DONE guard=${guard} phase=${gs.phase} round=${gs.round} LOG=[${gs.log.slice(-20).map((l) => l.text).join(' | ')}]`);
});
