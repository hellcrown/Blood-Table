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
  bAuctionBid,
  bAuctionPick,
  bAgentAsk,
  bAgentDecide,
  bBlufferChallenge,
  bBlufferDeclare,
  bBomberClaim,
  bBuySeer,
  bCeoDecide,
  bCeoDone,
  bCeoGive,
  bCleanerDel,
  bCurseHide,
  bCurseTake,
  bDesignerDiscard,
  bDetectivePick,
  bDogTarget,
  bFacelessConvert,
  bFacelessPick,
  bFryerDel,
  bFryerDraw,
  bGamblerGuess,
  bGeneralChoice,
  bGodPeekChoice,
  bHackerSetup,
  bImpDraw,
  bImpRedeem,
  bMynameSet,
  bPirateDecide,
  bPirateRob,
  bScalperDeal,
  bSmugglerMark,
  bStudentDump,
  bSuccubusSteal,
  bUndertakerSwap,
  bVagrantDraw,
} from '../src/blood/engine';
import { BLOOD_MARKET_BY_ID } from '@shared/bloodCards';
import { charPoolIds } from '@shared/bloodChars';
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
  if (p.charId === 'faceless' && p.tempChar && rng() < 0.05) {
    tryAct(() => bFacelessConvert(gs, p.id, now));
    return;
  }
  switch (gs.phase) {
    case 'pick': {
      if (!p.charId && p.charOptions.length > 0) {
        tryAct(() => bPickChar(gs, p.id, p.charOptions[ri(rng, p.charOptions.length)], now));
      }
      return;
    }
    case 'setup': {
      const pend0 = gs.secretPending;
      if (pend0 && pend0.seat === p.id && pend0.kind === 'mynameSet') {
        tryAct(() => bMynameSet(gs, p.id, ri(rng, 10), `神秘${ri(rng, 90)}`, now));
        return;
      }
      if (pend0 && pend0.seat === p.id && pend0.kind === 'hackerSetup') {
        const drawIds = p.draw.map((c) => c.id);
        const pick8: string[] = [];
        const pool8 = drawIds.slice();
        for (let i = 0; i < 8 && pool8.length > 0; i++) pick8.push(...pool8.splice(ri(rng, pool8.length), 1));
        tryAct(() => bHackerSetup(gs, p.id, pick8, now));
        return;
      }
      if (p.setupRound < 2 && rng() < 0.85) {
        tryAct(() => bSetup(gs, p.id, randomSubset(rng, p.setupHand, 4).map((c) => c.id), now));
      }
      return;
    }
    case 'swap': {
      const pend = gs.secretPending;
      if (pend && pend.seat === p.id) {
        if (pend.kind === 'bomberClaim') tryAct(() => bBomberClaim(gs, p.id, ri(rng, 3), now));
        else if (pend.kind === 'curseTake') {
          tryAct(() => bCurseTake(gs, p.id, randomSubset(rng, p.curseStash, 9).map((c) => c.id), now));
        } else if (pend.kind === 'generalChoice') {
          const m = pick(rng, ['gift', 'extra', 'skip'] as const);
          if (m === 'gift' && others.length > 0) tryAct(() => bGeneralChoice(gs, p.id, 'gift', pick(rng, others)!.seat, now));
          else tryAct(() => bGeneralChoice(gs, p.id, m ?? 'skip', undefined, now));
        } else if (pend.kind === 'godPeek') {
          tryAct(() => bGodPeekChoice(gs, p.id, rng() < 0.5 ? 'extra' : 'blood', now));
        } else if (pend.kind === 'vagrantDraw') {
          const src = others.filter((o) => o.draw.length >= 2);
          const t = pick(rng, src);
          tryAct(() => bVagrantDraw(gs, p.id, t ? t.seat : -1, now));
        } else if (pend.kind === 'ceoGive') {
          if (rng() < 0.5 && p.blood >= 1 && others.length > 0) {
            tryAct(() => bCeoGive(gs, p.id, pick(rng, others)!.seat, 1 + ri(rng, Math.max(1, p.blood)), now));
          } else tryAct(() => bCeoDone(gs, p.id, now));
        } else if (pend.kind === 'ceoDecide') {
          tryAct(() => bCeoDecide(gs, p.id, rng() < 0.6, now));
        } else if (pend.kind === 'impDraw') {
          const src = others.filter((o) => o.draw.length > 0);
          const t = pick(rng, src);
          if (t) tryAct(() => bImpDraw(gs, p.id, t.seat, now));
        }
        return;
      }
      if (p.swapDone) return;
      if (rng() < 0.2 && p.curseStash.length >= 0 && p.hand.some((c) => c.r === 5 && c.s != null) && rng() < 0.3) {
        const five = pick(rng, p.hand.filter((c) => c.r === 5 && c.s != null));
        if (five) tryAct(() => bCurseHide(gs, p.id, five.id, now));
        return;
      }
      if (rng() < 0.15 && p.charId === 'fryer' && p.blood >= 1) {
        tryAct(() => bFryerDraw(gs, p.id, now));
        return;
      }
      const isTarot = p.charId === 'tarot';
      if (rng() < 0.7 && p.hand.length > 0) {
        const ids = randomSubset(rng, p.hand, isTarot ? 2 : 3).map((c) => c.id);
        tryAct(() => bSwap(gs, p.id, ids, isTarot ? ri(rng, 3) : undefined, now));
      } else if (rng() < 0.3 && p.charId === 'undertaker' && p.hand.length > 0 && p.swapLeft > 0) {
        tryAct(() => bUndertakerSwap(gs, p.id, randomSubset(rng, p.hand, 3).map((c) => c.id), now));
      } else {
        tryAct(() => bSwapStop(gs, p.id, now));
      }
      return;
    }
    case 'play': {
      const pendP = gs.secretPending;
      if (pendP && pendP.seat === p.id) {
        if (pendP.kind === 'gamblerGuess') {
          tryAct(() => bGamblerGuess(gs, p.id, pick(rng, gs.players)!.seat, now));
        } else if (pendP.kind === 'studentDump') {
          tryAct(() => bStudentDump(gs, p.id, rng() < 0.6, undefined, now));
        } else if (pendP.kind === 'studentRemove') {
          const c = pick(rng, p.discard);
          tryAct(() => bStudentDump(gs, p.id, rng() < 0.7 && c != null, c?.id, now));
        } else if (pendP.kind === 'designerDiscard') {
          tryAct(() => bDesignerDiscard(gs, p.id, randomSubset(rng, p.play, 2).map((c) => c.id), now));
        } else if (pendP.kind === 'agentAsk') {
          if (rng() < 0.7 && others.length > 0) tryAct(() => bAgentAsk(gs, p.id, pick(rng, others)!.seat, now));
          else tryAct(() => bAgentAsk(gs, p.id, -1, now));
        } else if (pendP.kind === 'agentDecide') {
          tryAct(() => bAgentDecide(gs, p.id, rng() < 0.5, now));
        } else if (pendP.kind === 'blufferDeclare') {
          const declared = p.play.map((c) => ({ id: c.id, r: c.r === 0 ? 5 : c.r, s: c.s ?? ('s' as const) }));
          tryAct(() => bBlufferDeclare(gs, p.id, declared, now));
        } else if (pendP.kind === 'blufferChallenge') {
          tryAct(() => bBlufferChallenge(gs, p.id, rng() < 0.4, now));
        }
        return;
      }
      if (p.locked) return;
      if (p.hand.length < 5) {
        tryAct(() => bPlay(gs, p.id, p.hand.map((c) => c.id), now));
        return;
      }
      const ids = rng() < 0.5 ? bestFive(p) : randomSubset(rng, p.hand, 5).map((c) => c.id);
      tryAct(() => bPlay(gs, p.id, ids, now));
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
      const pendS = gs.secretPending;
      if (pendS && pendS.seat === p.id) {
        if (pendS.kind === 'succubusSteal') {
          if (rng() < 0.5) tryAct(() => bSuccubusSteal(gs, p.id, -1, now));
          else {
            const t = pick(rng, others);
            if (t) tryAct(() => bSuccubusSteal(gs, p.id, t.seat, now));
            else tryAct(() => bSuccubusSteal(gs, p.id, -1, now));
          }
        } else if (pendS.kind === 'scalperDeal') {
          tryAct(() => bScalperDeal(gs, p.id, rng() < 0.6, now));
        } else if (pendS.kind === 'fryerDel') {
          if (rng() < 0.5) {
            const playedIds = gs.result?.rows.find((r) => r.seat === p.seat)?.cards?.map((c) => c.id) ?? [];
            const avail = p.discard.filter((c) => playedIds.includes(c.id));
            const c = pick(rng, avail);
            if (c) tryAct(() => bFryerDel(gs, p.id, [c.id], false, now));
            else tryAct(() => bFryerDel(gs, p.id, [], true, now));
          } else tryAct(() => bFryerDel(gs, p.id, [], true, now));
        }
        return;
      }
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
        } else if (pend.kind === 'pirateRob') {
          if (rng() < 0.7 && others.length > 0) tryAct(() => bPirateRob(gs, p.id, pick(rng, others)!.seat, now));
          else tryAct(() => bPirateRob(gs, p.id, -1, now));
        } else if (pend.kind === 'pirateDecide') {
          tryAct(() => bPirateDecide(gs, p.id, rng() < 0.5, now));
        } else if (pend.kind === 'smugglerMark') {
          const slots2 = gs.market.map((m, i) => ({ m, i })).filter((x) => x.m.def != null).map((x) => x.i);
          if (rng() < 0.7) {
            const s3 = pick(rng, slots2);
            tryAct(() => bSmugglerMark(gs, p.id, s3 != null ? s3 : -1, now));
          } else tryAct(() => bSmugglerMark(gs, p.id, -1, now));
        } else if (pend.kind === 'auctionPick') {
          tryAct(() => bAuctionPick(gs, p.id, rng() < 0.8 ? ri(rng, 2) : -1, now));
        } else if (pend.kind === 'auctionBid') {
          const maxBid = Math.min(p.blood, (pend.amount ?? 0) + 3);
          tryAct(() => bAuctionBid(gs, p.id, rng() < 0.3 ? 0 : ri(rng, maxBid + 1), now));
        } else if (pend.kind === 'impRedeem') {
          tryAct(() => bImpRedeem(gs, p.id, rng() < 0.6, now));
        }
        return;
      }
      // 窥天师：轮到自己时可随机购买天意
      if (gs.turnSeat === p.seat && !p.buyPassed && p.charId === 'seer' && gs.seerZone.length > 0 && rng() < 0.3) {
        tryAct(() => bBuySeer(gs, p.id, ri(rng, gs.seerZone.length), now));
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
      const pendR = gs.secretPending;
      if (pendR && pendR.seat === p.id && pendR.kind === 'dogTarget') {
        if (rng() < 0.7) tryAct(() => bDogTarget(gs, p.id, pick(rng, gs.players)!.seat, now));
        else tryAct(() => bDogTarget(gs, p.id, -1, now));
        return;
      }
      if (p.removeDone) return;
      if (rng() < 0.5 && p.discard.length > 0) {
        tryAct(() => bRemove(gs, p.id, randomSubset(rng, p.discard, 2).map((c) => c.id), now));
      } else {
        tryAct(() => bRemoveDone(gs, p.id, now));
      }
      return;
    }
    case 'reorg': {
      const pendG = gs.secretPending;
      if (pendG && pendG.seat === p.id && pendG.kind === 'cleanerDel') {
        const t = pick(rng, gs.players)!;
        if (rng() < 0.5) {
          tryAct(() => bCleanerDel(gs, p.id, t.seat, '', now));
        } else {
          const c = pick(rng, t.discard);
          tryAct(() => bCleanerDel(gs, p.id, t.seat, c?.id ?? '', now));
        }
        return;
      }
      if (p.reorgDone) return;
      const inspectorPick = p.charId === 'inspector' && p.discard.length > 0 ? pick(rng, p.discard)?.id : undefined;
      tryAct(() => bReorg(gs, p.id, rng() < 0.5 ? 'reshuffle' : 'blood', now, inspectorPick));
      return;
    }
    default:
      return;
  }
}

function ownerSeatOf(cardId: string, holderSeat: number): number {
  const m = /^c(\d+)-/.exec(cardId);
  return m ? Number(m[1]) : holderSeat;
}

function checkInvariants(gs: BloodState): void {
  // 按所有权守恒：每名玩家名下的 54 张牌（含被他人临时持有的）恒定；
  // 捣蛋鬼没有个人牌堆（其座位名下为 0 张），其余玩家恒 54 张
  const counts = new Map<number, number>();
  for (const p of gs.players) {
    const zones = [p.draw, p.hand, p.discard, p.removed, p.play, p.setupHand, p.curseStash, p.undertakerStash];
    for (const z of zones) {
      for (const c of z) {
        const owner = ownerSeatOf(c.id, p.seat);
        counts.set(owner, (counts.get(owner) ?? 0) + 1);
      }
    }
  }
  for (const p of gs.players) {
    const n = counts.get(p.seat) ?? 0;
    const ctx = `p=${p.name} char=${p.charId} owned=${n} round=${gs.round} phase=${gs.phase} LOG=${gs.log.slice(-8).map((l) => l.text).join(' | ')}`;
    if (p.charId === 'imp') expect(n === 0 || n === 54, ctx).toBe(true);
    else expect(n, ctx).toBe(54);
    expect(p.blood).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(p.blood)).toBe(true);
    expect(Number.isFinite(p.tickets)).toBe(true);
  }
  const circulatingDefs =
    gs.supply.length +
    gs.market.filter((m) => m.def != null).length +
    gs.recycle.length +
    gs.players.reduce((s, p) => s + p.items.length + p.chips.length, 0) +
    (gs.secretPending?.defId ? 1 : 0) +
    (gs.auction ? 1 : 0) +
    gs.seerZone.length;
  if (circulatingDefs !== 57) {
    throw new Error(
      `defs=${circulatingDefs} supply=${gs.supply.length} market=${gs.market.filter((m) => m.def != null).length} recycle=${gs.recycle.length} items=${gs.players.reduce((s, p) => s + p.items.length, 0)} chips=${gs.players.reduce((s, p) => s + p.chips.length, 0)} pending=${gs.secretPending?.defId ?? '-'} auction=${gs.auction?.defId ?? '-'} seerZone=${gs.seerZone.length} phase=${gs.phase} round=${gs.round} LOG=[${gs.log.slice(-14).map((l) => l.text).join(' | ')}]`,
    );
  }
  expect(circulatingDefs).toBe(57);
}

function stateSig(gs: BloodState): string {
  return [
    gs.phase, gs.round, gs.turnSeat, gs.impTurns, gs.swapEndQueue.length,
    gs.secretPending ? gs.secretPending.kind + '@' + gs.secretPending.seat : '-',
    gs.players.map((p) => `${p.swapDone ? 1 : 0}${p.swapLeft}${p.locked ? 1 : 0}${p.removeDone ? 1 : 0}${p.reorgDone ? 1 : 0}`).join(','),
  ].join('|');
}

function simGame(seed: number, charExpansion = false, seatCount = 2): void {
  const sigCounts = new Map<string, number>();
  const rng = mulberry32(seed);
  const players = Array.from({ length: seatCount }, (_, i) => ({ id: `p${i}`, name: `玩家${i}`, seat: i }));
  const gs = createBloodGame(seatCount, players, 1000, charExpansion);
  let now = 1000;
  let guard = 0;
  while (gs.phase !== 'gameover') {
    if (guard > 190_000 && guard % 2000 === 0) {
      console.log(`SLOW seed=${seed} g=${guard} phase=${gs.phase} turn=${gs.turnSeat} impT=${gs.impTurns} q=${gs.swapEndQueue.length} pend=${JSON.stringify(gs.secretPending)} swapDone=${gs.players.map((x)=>x.swapDone?1:0).join("")} LOG=[${gs.log.slice(-10).map((l) => l.text).join(' | ')}]`);
    }
    const sig = stateSig(gs);
    sigCounts.set(sig, (sigCounts.get(sig) ?? 0) + 1);
    if ((sigCounts.get(sig) ?? 0) === 3000) {
      throw new Error(
        `seed ${seed} 疑似死循环 sig=${sig} LOG=[${gs.log.slice(-45).map((l) => l.text).join(' | ')}] STATE=${gs.players
          .map((p) => `${p.name}(${p.charId}) sd=${p.swapDone} left=${p.swapLeft} hand=${p.hand.length} draw=${p.draw.length} disc=${p.discard.length}`)
          .join(' | ')}`,
      );
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

describe('血色模式 · 随机整场模拟（拓展角色池）', () => {
  it('2人局拓展池 种子 1-10', () => {
    for (let seed = 1; seed <= 10; seed++) simGame(seed, true, 2);
  });
  it('4人局拓展池 种子 1-5', () => {
    for (let seed = 1; seed <= 5; seed++) simGame(seed, true, 4);
  });
  it('3人局基础池 种子 1-10', () => {
    for (let seed = 1; seed <= 10; seed++) simGame(seed, false, 3);
  });
  it('3人局拓展池 种子 1-5', () => {
    for (let seed = 1; seed <= 5; seed++) simGame(seed, true, 3);
  });
});
