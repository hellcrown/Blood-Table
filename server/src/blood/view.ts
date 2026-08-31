import { BLOOD_MARKET_BY_ID } from '@shared/bloodCards';
import type { BloodCardView, BloodMyPrompt, BloodSeatView, BloodView } from '@shared/bloodProtocol';
import type { Room } from '../rooms';
import { evalForPlayer } from './engine';
import type { BCard, BloodState, BPlayer } from './types';

function cardView(c: BCard, p: BPlayer): BloodCardView {
  return {
    id: c.id,
    r: c.r,
    s: c.s,
    chipIds: p.chips.filter((ch) => ch.on === c.id).map((ch) => ch.def),
  };
}

function promptFor(gs: BloodState, p: BPlayer): BloodMyPrompt {
  switch (gs.phase) {
    case 'pick':
      return p.charId ? { k: 'wait' } : { k: 'pick' };
    case 'setup':
      return p.setupRound < 2 ? { k: 'setup', max: 4 } : { k: 'wait' };
    case 'swap':
      return p.swapDone ? { k: 'wait' } : { k: 'swap' };
    case 'play':
      return p.locked ? { k: 'wait' } : { k: 'play' };
    case 'reveal': {
      if (gs.turnSeat !== p.seat) return { k: 'wait' };
      if (gs.stealPending && gs.stealPending.seat === p.id) return { k: 'steal' };
      return { k: 'wait' };
    }
    case 'settle':
      // 对决展示：未确认者需点击确认（关闭演示浮层即发送）
      return p.sdSeen ? { k: 'wait' } : { k: 'sdConfirm' };
    case 'buy': {
      const pend = gs.secretPending;
      if (pend && pend.seat === p.id) {
        if (pend.kind === 'insertChip') return { k: 'insertChip', defId: pend.defId };
        if (pend.kind === 'deleteUpTo') return { k: 'secretDelete', max: pend.max ?? 0 };
        if (pend.kind === 'violentTarget') return { k: 'violentTarget' };
        if (pend.kind === 'refreshPick') return { k: 'refreshPick', max: pend.max ?? 0 };
      }
      if (gs.turnSeat === p.seat && !p.buyPassed) return { k: 'buy' };
      return { k: 'wait' };
    }
    case 'remove':
      return p.removeDone ? { k: 'wait' } : { k: 'remove', cost: 2 };
    case 'reorg':
      return p.reorgDone ? { k: 'wait' } : { k: 'reorg' };
    default:
      return { k: 'wait' };
  }
}

export function buildBloodView(room: Room, gs: BloodState, viewerId: string | null): BloodView {
  const me = gs.players.find((p) => p.id === viewerId) ?? null;
  const revealPublic = gs.phase === 'reveal';

  const players: BloodSeatView[] = gs.players.map((p) => {
    const sv: BloodSeatView = {
      id: p.id,
      name: p.name,
      seat: p.seat,
      blood: p.blood,
      tickets: p.tickets,
      connected: room.sessions.get(p.id)?.connected ?? false,
      privilege: p.privilege,
      charId: p.charId,
      handCount: p.hand.length,
      drawCount: p.draw.length,
      itemCount: p.items.length,
      swapLeft: p.swapLeft,
      swapDone: p.swapDone,
      locked: p.locked,
      buyPassed: p.buyPassed,
      removeDone: p.removeDone,
      reorgDone: p.reorgDone,
      sdSeen: p.sdSeen,
      lastAction: p.lastAction,
    };
    if (revealPublic) {
      sv.played = p.play.map((c) => cardView(c, p));
      const ev = evalForPlayer(p);
      sv.handName = ev.catName;
      sv.pips = ev.pips;
    }
    return sv;
  });

  const market = gs.market.map((slot) => {
    const def = slot.def ? BLOOD_MARKET_BY_ID.get(slot.def) : null;
    return {
      defId: slot.def,
      name: def?.name ?? '（空）',
      kind: def?.kind ?? ('secret' as const),
      cost: def?.cost ?? 0,
      text: def?.text ?? '',
      bonus: slot.bonus,
    };
  });

  const myItems = me
    ? me.items.map((i) => {
        const def = BLOOD_MARKET_BY_ID.get(i.def);
        return { id: i.id, name: def?.name ?? '?', text: def?.text ?? '' };
      })
    : [];

  return {
    kind: 'blood',
    code: room.code,
    phase: gs.phase,
    round: gs.round,
    target: gs.target,
    seatCount: gs.seatCount,
    hostId: room.hostId,
    serverTime: Date.now(),
    players,
    market,
    supplyCount: gs.supply.length,
    recycleCount: gs.recycle.length,
    turnSeat: gs.turnSeat,
    deadline: gs.deadline,
    comparePipsFirst: gs.comparePipsFirst,
    announce: gs.announce
      ? (() => {
          const def = BLOOD_MARKET_BY_ID.get(gs.announce!.defId);
          const buyer = gs.players.find((x) => x.seat === gs.announce!.buyerSeat);
          const eff = def?.effect;
          const extra =
            eff && eff.k === 'revealGain'
              ? `获得 ${eff.blood} 血筹`
              : eff && eff.k === 'revealSteal'
                ? `掠夺一位对手 ${eff.blood} 血筹`
                : undefined;
          return {
            defId: gs.announce!.defId,
            name: def?.name ?? '?',
            kind: def?.kind ?? ('secret' as const),
            text: def?.text ?? '',
            cost: def?.cost ?? 0,
            buyerSeat: gs.announce!.buyerSeat,
            buyerName: buyer?.name ?? '?',
            at: gs.announce!.at,
            extra,
          };
        })()
      : null,
    showdownWait:
      gs.phase === 'settle'
        ? { done: gs.players.filter((p) => p.sdSeen).length, total: gs.players.length }
        : null,
    result: gs.result
      ? {
          rows: gs.result.rows.map((r) => {
            const owner = gs.players.find((x) => x.seat === r.seat);
          return {
            seat: r.seat,
            name: r.name,
            cat: r.cat,
            catName: r.catName,
              pips: r.pips,
              rank: r.rank,
              gainTickets: r.gainTickets,
              gainBlood: r.gainBlood,
              cards:
                r.cards == null
                  ? null
                  : r.cards.map((c) => ({
                      id: c.id,
                      r: c.r,
                      s: c.s,
                      chipIds: (owner?.chips ?? []).filter((ch) => ch.on === c.id).map((ch) => ch.def),
                    })),
            };
          }),
          winnerSeat: gs.result.winnerSeat,
          comparePipsFirst: gs.result.comparePipsFirst,
        }
      : null,
    final: gs.final,
    log: gs.log.slice(-40),
    logSeq: gs.logSeq,
  me: me
    ? {
        seat: me.seat,
        blood: me.blood,
        tickets: me.tickets,
        charOptions: gs.phase === 'pick' && !me.charId ? me.charOptions : [],
        hand: me.hand.map((c) => cardView(c, me)),
          discard: me.discard.map((c) => cardView(c, me)),
          removed: me.removed.map((c) => cardView(c, me)),
          drawCount: me.draw.length,
          setupHand: me.setupHand.map((c) => cardView(c, me)),
          items: myItems,
          swapLeft: me.swapLeft,
        }
      : {
          seat: -1,
          blood: 0,
          tickets: 0,
          charOptions: [],
          hand: [],
          discard: [],
          removed: [],
          drawCount: 0,
          setupHand: [],
          items: [],
          swapLeft: 0,
        },
    prompt: me ? promptFor(gs, me) : { k: 'wait' },
  };
}
