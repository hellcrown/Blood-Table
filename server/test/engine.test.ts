import { describe, expect, it } from 'vitest';
import type { Card, Rank, Suit } from '@shared/protocol';
import { computePots, legalActionsFor } from '../src/game/betting';
import { applyAction, autoAction, createGame, startHand } from '../src/game/engine';
import type { GState } from '../src/game/types';

const RANK_MAP: Record<string, Rank> = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
function c(s: string): Card {
  const r = s[0];
  const suit = s[1] as Suit;
  const rank = RANK_MAP[r] ?? (Number(r) as Rank);
  return { r: rank, s: suit };
}

function makeGame(n: number, chips = 1000): GState {
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i, chips }));
  return createGame({ sb: 5, bb: 10, startChips: chips }, n, players);
}

const seat = (gs: GState, i: number) => gs.players.find((p) => p.seat === i)!;
const act = (gs: GState, seatNo: number, action: Parameters<typeof applyAction>[2]) =>
  applyAction(gs, seatNo, action, 1000);

describe('盲注与行动顺序', () => {
  it('2 人单挑：庄家即小盲，翻牌前庄家先行动', () => {
    const gs = makeGame(2);
    startHand(gs, 0);
    expect(gs.sbSeat).toBe(gs.buttonSeat);
    expect(gs.bbSeat).not.toBe(gs.buttonSeat);
    expect(gs.toActSeat).toBe(gs.buttonSeat);
    expect(seat(gs, gs.buttonSeat).bet).toBe(5);
    expect(seat(gs, gs.bbSeat!).bet).toBe(10);
  });

  it('2 人单挑：翻牌后非庄家先行动', () => {
    const gs = makeGame(2);
    startHand(gs, 0);
    const btn = gs.buttonSeat;
    const bb = gs.bbSeat!;
    act(gs, btn, { k: 'call' });
    act(gs, bb, { k: 'check' });
    expect(gs.phase).toBe('flop');
    expect(gs.toActSeat).toBe(bb);
  });

  it('3 人：庄下一位小盲、再下一位大盲、大盲下一位先行动', () => {
    const gs = makeGame(3);
    startHand(gs, 0);
    const btn = gs.buttonSeat;
    const sb = (btn + 1) % 3;
    const bb = (btn + 2) % 3;
    expect(gs.sbSeat).toBe(sb);
    expect(gs.bbSeat).toBe(bb);
    expect(gs.toActSeat).toBe(btn);
    expect(seat(gs, sb).bet).toBe(5);
    expect(seat(gs, bb).bet).toBe(10);
  });

  it('庄位逐手轮转', () => {
    const gs = makeGame(3);
    startHand(gs, 0);
    const b1 = gs.buttonSeat;
    let guard = 0;
    while (gs.phase !== 'result' && guard++ < 50) {
      const s = gs.toActSeat;
      if (s == null) break;
      const legal = legalActionsFor(gs, s)!;
      if (legal.canCheck) act(gs, s, { k: 'check' });
      else act(gs, s, { k: 'fold' });
    }
    expect(gs.phase).toBe('result');
    startHand(gs, 2000);
    expect(gs.buttonSeat).toBe((b1 + 1) % 3);
  });

  it('大盲选择权：全部平跟后大盲仍可行动', () => {
    const gs = makeGame(4);
    startHand(gs, 0);
    const bb = gs.bbSeat!;
    let s = gs.toActSeat!;
    let guard = 0;
    while (s !== bb && guard++ < 10) {
      act(gs, s, { k: 'call' });
      s = gs.toActSeat!;
    }
    expect(s).toBe(bb);
    expect(legalActionsFor(gs, bb)!.canCheck).toBe(true);
    act(gs, bb, { k: 'check' });
    expect(gs.phase).toBe('flop');
  });
});

describe('下注规则', () => {
  it('加注到语义与最小加注限制', () => {
    const gs = makeGame(3);
    startHand(gs, 0);
    const utg = gs.toActSeat!;
    act(gs, utg, { k: 'raise', to: 30 });
    expect(seat(gs, utg).bet).toBe(30);
    expect(gs.currentBet).toBe(30);
    expect(gs.minRaise).toBe(20);
    const next = gs.toActSeat!;
    expect(legalActionsFor(gs, next)!.minRaiseTo).toBe(50);
    expect(() => act(gs, next, { k: 'raise', to: 45 })).toThrow();
    act(gs, next, { k: 'raise', to: 50 });
    expect(gs.currentBet).toBe(50);
  });

  it('短全下不重开行动：已行动者只能跟注或弃牌', () => {
    const gs = makeGame(3, 1000);
    startHand(gs, 0);
    const btn = gs.buttonSeat;
    const sb = gs.sbSeat!;
    const bb = gs.bbSeat!;
    act(gs, btn, { k: 'fold' });
    act(gs, sb, { k: 'call' });
    act(gs, bb, { k: 'check' });
    expect(gs.phase).toBe('flop');
    const first = gs.toActSeat!; // 翻牌圈先行动者
    const secondSeat = first === sb ? bb : sb;
    seat(gs, secondSeat).chips = 250;
    act(gs, first, { k: 'raise', to: 200 });
    expect(gs.minRaise).toBe(200);
    act(gs, secondSeat, { k: 'allin' }); // 全下 250，加注幅度 50 < 200 → 短加注
    expect(gs.currentBet).toBe(250);
    expect(gs.shortAllIn).toBe(true);
    const legalFirst = legalActionsFor(gs, first)!;
    expect(legalFirst.canRaise).toBe(false);
    expect(legalFirst.canCall).toBe(true);
    expect(legalFirst.callAmount).toBe(50);
    act(gs, first, { k: 'call' });
    expect(gs.phase).toBe('turn'); // 双方全下/匹配后发转牌
  });

  it('超时托管：可让牌则让牌，面对下注则弃牌', () => {
    const gs = makeGame(2);
    startHand(gs, 0);
    applyAction(gs, gs.toActSeat!, { k: 'call' }, 0);
    const bb = gs.bbSeat!;
    autoAction(gs, bb, 1000);
    expect(seat(gs, bb).lastAction).toBe('让牌');
    expect(gs.phase).toBe('flop');
    // 转到面对下注的场景：先行动者下注，另一人超时应弃牌
    const bettor = gs.toActSeat!;
    act(gs, bettor, { k: 'raise', to: 40 });
    const other = gs.toActSeat!;
    autoAction(gs, other, 2000);
    expect(seat(gs, other).folded).toBe(true);
    expect(gs.phase).toBe('result');
  });
});

describe('边池与结算', () => {
  it('三人不同投入：主池+边池切分', () => {
    const gs = makeGame(3, 1000);
    for (const p of gs.players) {
      p.inHand = true;
      p.chips = 0;
      p.committed = 0;
    }
    seat(gs, 0).committed = 100;
    seat(gs, 1).committed = 200;
    seat(gs, 2).committed = 200;
    expect(computePots(gs)).toEqual([
      { amount: 300, seats: [0, 1, 2] },
      { amount: 200, seats: [1, 2] },
    ]);
  });

  it('弃牌者的投入进入池但无权赢池', () => {
    const gs = makeGame(3, 1000);
    for (const p of gs.players) {
      p.inHand = true;
      p.chips = 0;
      p.committed = 0;
    }
    seat(gs, 0).committed = 80;
    seat(gs, 0).folded = true;
    seat(gs, 1).committed = 150;
    seat(gs, 2).committed = 150;
    // 两层边池的可用赢家相同，合并为一个池展示
    expect(computePots(gs)).toEqual([{ amount: 380, seats: [1, 2] }]);
  });

  it('固定牌面的全下摊牌：主池 300 归 AA、边池 200 归 KK', () => {
    const gs = makeGame(3, 1000);
    seat(gs, 0).chips = 100; // A：短码
    seat(gs, 1).chips = 200; // B：中码
    seat(gs, 2).chips = 200; // C：与 B 相同，跟注即全下
    startHand(gs, 0);
    // 行动顺序取决于庄位，按筹码角色驱动：
    // ≤100 码 → 全下（触发前注入固定牌堆）；其余在未到 200 时加注到 200，否则跟注。
    let guard = 0;
    while (gs.toActSeat != null && guard++ < 10) {
      const s = gs.toActSeat;
      const p = seat(gs, s);
      const stack = p.chips + p.bet;
      if (stack <= 100) {
        seat(gs, 0).hole = [c('As'), c('Ad')];
        seat(gs, 1).hole = [c('Ks'), c('Kd')];
        seat(gs, 2).hole = [c('Qs'), c('Qd')];
        // pop() 从数组尾部取牌 → 依次发出 2c 7h 9d（翻牌）、3s（转牌）、Jc（河牌）
        gs.deck = [c('4h'), c('8d'), c('Jc'), c('3s'), c('9d'), c('7h'), c('2c')];
        act(gs, s, { k: 'allin' });
      } else if (gs.currentBet < 200) {
        act(gs, s, { k: 'raise', to: 200 });
      } else {
        act(gs, s, { k: 'call' });
      }
    }
    expect(gs.phase).toBe('result');
    const fmt = (x: Card) => `${({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' } as Record<number, string>)[x.r] ?? x.r}${x.s}`;
    expect(gs.community.map(fmt)).toEqual(['2c', '7h', '9d', '3s', 'Jc']);
    const rows = gs.result!.rows;
    const rowOf = (s: number) => rows.find((r) => r.seat === s)!;
    const a = gs.players.find((p) => p.committed === 100)!; // A：全下 100
    const b = gs.players.find((p) => p.committed === 200 && p.seat === 1)!; // B：KK
    const cP = gs.players.find((p) => p.committed === 200 && p.seat === 2)!; // C：QQ
    expect(a.won).toBe(300);
    expect(b.won).toBe(200);
    expect(cP.won).toBe(0);
    expect(a.handName).toBe('一对');
    expect(rowOf(a.seat).net).toBe(200);
    expect(gs.players.reduce((s, p) => s + p.chips, 0)).toBe(500);
  });

  it('结算后筹码守恒', () => {
    const gs = makeGame(2, 500);
    startHand(gs, 0);
    let guard = 0;
    while (gs.phase !== 'result' && guard++ < 100) {
      const s = gs.toActSeat;
      if (s == null) break;
      const legal = legalActionsFor(gs, s)!;
      if (legal.canCheck) act(gs, s, { k: 'check' });
      else act(gs, s, { k: 'fold' });
    }
    expect(gs.players.reduce((s, p) => s + p.chips, 0)).toBe(1000);
  });
});
