import { BLOOD_MARKET_BY_ID } from '@shared/bloodCards';
import type { BloodCardView, BloodMyPrompt, BloodSeatView, BloodView } from '@shared/bloodProtocol';
import type { Room } from '../rooms';
import { evalForPlayer, effChar } from './engine';
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
  // 挂起中的拓展牌交互优先（跨阶段）
  const pend = gs.secretPending;
  if (pend && pend.seat === p.id) {
    switch (pend.kind) {
      case 'poisonTarget':
        return { k: 'poisonTarget' };
      case 'freezeTarget':
        return { k: 'freezeTarget' };
      case 'amnesiaTarget':
        return { k: 'amnesiaTarget' };
      case 'boxRobTarget':
        return { k: 'boxRobTarget' };
      case 'signalTarget':
        return { k: 'signalTarget' };
      case 'demagTarget':
        return { k: 'demagTarget' };
      case 'pinpointClaim':
        return { k: 'pinpointClaim' };
      case 'irisGuess':
        return { k: 'irisGuess' };
      case 'eraserClaim':
        return { k: 'eraserClaim' };
      case 'demagPick': {
        const tp = gs.players.find((x) => x.id === pend.targetSeat);
        return { k: 'demagPick', targetSeat: tp?.seat ?? -1 };
      }
      case 'pinpointVictim':
        return { k: 'pinpointVictim', rank: pend.rank ?? 0 };
      case 'revealDecide':
        return {
          k: 'revealDecide',
          decision: pend.decision ? { t: pend.decision.t, cardId: pend.decision.cardId } : undefined,
        };
      case 'barrierAsk':
        return { k: 'barrierAsk', eff: pend.eff };
      case 'pullChip':
        return { k: 'pullChip' };
      case 'preciseDel':
        return {
          k: 'preciseDel',
          max: 2,
          cards: (pend.cards ?? []).map((c) => ({ id: c.id, r: c.r, s: c.s })),
        };
      case 'sharedInfo':
        return { k: 'secretDelete', max: pend.max ?? 2 };
      case 'sharedInfoOpp':
        return { k: 'secretDelete', max: 1 };
      /* ---- 拓展角色交互 ---- */
      case 'gamblerGuess':
        return { k: 'gamblerGuess' };
      case 'bomberClaim':
        return { k: 'bomberClaim' };
      case 'succubusSteal':
        return { k: 'succubusSteal', blood: pend.blood };
      case 'scalperDeal':
        return { k: 'scalperDeal' };
      case 'studentDump':
        return { k: 'studentDump' };
      case 'studentRemove':
        return { k: 'studentRemove', cost: 2 };
      case 'designerDiscard':
        return { k: 'designerDiscard' };
      case 'dogTarget':
        return { k: 'dogTarget' };
      case 'generalChoice':
        return { k: 'generalChoice' };
      case 'vagrantDraw':
        return { k: 'vagrantDraw' };
      case 'fryerDel':
        return { k: 'fryerDel', max: pend.max ?? 3 };
      case 'curseTake':
        return { k: 'curseTake' };
      case 'godPeek':
        return { k: 'godPeek' };
      case 'detectivePick':
        return { k: 'detectivePick' };
      case 'hackerSetup':
        return { k: 'hackerSetup', cards: p.draw.map((c) => ({ id: c.id, r: c.r, s: c.s })) };
      case 'smugglerMark':
        return { k: 'smugglerMark' };
      case 'pirateRob':
        return { k: 'pirateRob' };
      case 'pirateDecide':
        return { k: 'pirateDecide' };
      case 'auctionPick':
        return { k: 'auctionPick', options: pend.options };
      case 'auctionBid':
        return { k: 'auctionBid', amount: pend.amount ?? 0 };
      case 'impDraw':
        return { k: 'impDraw' };
      case 'impRedeem':
        return { k: 'impRedeem' };
      case 'facelessPick':
        return { k: 'facelessPick', options: pend.options };
      case 'blufferDeclare':
        return { k: 'blufferDeclare' };
      case 'blufferChallenge':
        return { k: 'blufferChallenge' };
      case 'ceoGive':
        return { k: 'ceoGive', given: pend.given };
      case 'ceoDecide':
        return { k: 'ceoDecide', given: pend.given };
      case 'agentAsk':
        return { k: 'agentAsk' };
      case 'agentDecide':
        return { k: 'agentDecide' };
      case 'mynameSet':
        return { k: 'mynameSet' };
      case 'cleanerDel':
        return {
          k: 'cleanerDel',
          zones: gs.players.map((o) => ({
            seat: o.seat,
            cards: o.discard.map((c) => ({ id: c.id, r: c.r, s: c.s })),
          })),
        };
      default:
        break;
    }
  }
  switch (gs.phase) {
    case 'pick':
      return p.charId ? { k: 'wait' } : { k: 'pick' };
    case 'setup':
      return p.setupRound < 2 ? { k: 'setup', max: 4 } : { k: 'wait' };
    case 'draw':
      return { k: 'wait' };
    case 'swap':
      return p.swapDone ? { k: 'wait' } : { k: 'swap' };
    case 'play':
      return p.locked ? { k: 'wait' } : { k: 'play' };
    case 'reveal': {
      if (gs.turnSeat !== p.seat) return { k: 'wait' };
      if (gs.stealPending && gs.stealPending.seat === p.id) return { k: 'steal' };
      if (p.items.some((i) => BLOOD_MARKET_BY_ID.get(i.def)?.effect.k === 'demagNullify')) {
        return { k: 'revealItem' };
      }
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
      // 瞎掰王宣告成立（无人质疑）时，亮牌按宣告的牌展示
      const bluffing = gs.bluffer && gs.bluffer.seat === p.id && !gs.bluffer.challenged;
      sv.played = (bluffing ? gs.bluffer!.declared : p.play).map((c) => cardView(c, p));
      const ev = evalForPlayer(p, gs);
      sv.handName = ev.catName;
      sv.pips = ev.pips;
    }
    // 捣蛋鬼的弃牌区对所有人公开
    if (p.charId === 'imp' && p.id !== me?.id) {
      sv.impDiscard = p.discard.map((c) => cardView(c, p));
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
        return { id: i.id, defId: i.def, name: def?.name ?? '?', text: def?.text ?? '' };
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
          playCards: me.play.map((c) => cardView(c, me)),
          stash: {
            curse: me.curseStash.map((c) => cardView(c, me)),
            undertaker: me.undertakerStash.map((c) => cardView(c, me)),
          },
          seerTop:
            effChar(me) === 'seer' && me.draw.length > 0 ? cardView(me.draw[me.draw.length - 1], me) : null,
          seerZone:
            effChar(me) === 'seer'
              ? gs.seerZone.map((id) => {
                  const def = BLOOD_MARKET_BY_ID.get(id);
                  return {
                    defId: id,
                    name: def?.name ?? '?',
                    cost: Math.max(0, (def?.cost ?? 0) - 2),
                    text: def?.text ?? '',
                  };
                })
              : [],
          peekHands:
            gs.secretPending?.kind === 'godPeek' && gs.secretPending.seat === me.id
              ? gs.players.map((o) => ({ seat: o.seat, cards: o.hand.map((c) => cardView(c, o)) }))
              : [],
          dogUsed: me.dogUsed,
          tempChar: me.tempChar,
          smugglerSlot: gs.smugglerMark ? gs.smugglerMark.slot : -1,
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
