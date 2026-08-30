/**
 * 血色模式端到端冒烟：2 个机器人从初始构筑打到车票达标获胜。
 * 运行前先启动服务器（ws://localhost:3000/ws）。
 */
import WebSocket from 'ws';
import { bestFive } from '../src/blood/engine';
import type { BloodView } from '@shared/bloodProtocol';
import type { C2S, S2C } from '@shared/protocol';

const URL = process.env.SMOKE_URL ?? 'ws://localhost:3000/ws';

class BloodBot {
  name: string;
  ws: WebSocket | null = null;
  token = '';
  playerId = '';
  view: BloodView | null = null;
  code = '';
  errors: string[] = [];
  private acting = false;
  private waiters: ((v: BloodView) => boolean)[] = [];
  private helloWaiter: (() => void) | null = null;
  private rng = Math.random;

  constructor(name: string) {
    this.name = name;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(URL);
      this.ws = ws;
      ws.on('open', () => resolve());
      ws.on('error', reject);
      ws.on('message', (raw) => this.onMessage(String(raw)));
    });
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as S2C;
    if (msg.t === 'hello') {
      this.token = msg.token;
      this.playerId = msg.playerId;
      this.helloWaiter?.();
      this.helloWaiter = null;
    } else if (msg.t === 'state') {
      if (msg.view.kind !== 'blood') {
        this.code = (msg.view as { code: string }).code;
        return;
      }
      const bv = msg.view;
      this.view = bv;
      this.waiters = this.waiters.filter((w) => !w(bv));
      this.maybeAct();
    } else if (msg.t === 'error') {
      const em = msg as { code: string; msg: string };
      this.errors.push(em.code + ': ' + em.msg);
      setTimeout(() => this.maybeAct(), 150);
    }
  }

  send(msg: C2S): void {
    this.ws?.send(JSON.stringify(msg));
  }

  waitHello(): Promise<void> {
    return new Promise((resolve) => {
      if (this.token) resolve();
      else this.helloWaiter = resolve;
    });
  }

  waitState(pred: (v: BloodView) => boolean, timeoutMs = 90_000): Promise<BloodView> {
    return new Promise((resolve, reject) => {
      if (this.view && pred(this.view)) return resolve(this.view);
      const timer = setTimeout(() => reject(new Error(`${this.name} 等待超时`)), timeoutMs);
      this.waiters.push((v) => {
        if (pred(v)) {
          clearTimeout(timer);
          resolve(v);
          return true;
        }
        return false;
      });
    });
  }

  private sendAct(msg: C2S): void {
    this.send(msg);
  }

  private maybeAct(): void {
    const v = this.view;
    if (!v || this.acting) return;
    const prompt = v.prompt.k;
    if (prompt === 'wait') return;
    this.acting = true;
    setTimeout(() => {
      this.acting = false;
      this.actOnce();
    }, 60);
  }

  private handIds(): string[] {
    return this.view!.me.hand.map((c) => c.id);
  }

  private discardIds(): string[] {
    return this.view!.me.discard.map((c) => c.id);
  }

  private actOnce(): void {
    const v = this.view!;
    const r = this.rng;
    switch (v.prompt.k) {
      case 'pick': {
        if (v.me.charOptions.length > 0) this.sendAct({ t: 'bPickChar', charId: v.me.charOptions[0] });
        return;
      }
      case 'setup': {
        const removed = this.view!.me.setupHand.filter(() => r() < 0.3).map((c) => c.id);
        this.sendAct({ t: 'bSetup', removed });
        return;
      }
      case 'swap': {
        if (r() < 0.5 && v.me.hand.length >= 2) {
          const ids = this.handIds().sort(() => r() - 0.5).slice(0, 1 + Math.floor(r() * 3));
          this.sendAct({ t: 'bSwap', cardIds: ids });
        } else {
          this.sendAct({ t: 'bSwapStop' });
        }
        return;
      }
      case 'play': {
        // 用引擎评估器选最优 5 张（模拟真实客户端行为）
        const pseudo = {
          id: v.me.seat,
          name: this.name,
          seat: v.me.seat,
          blood: v.me.blood,
          tickets: v.me.tickets,
          draw: v.me.hand.map((c, i) => ({ id: c.id, r: c.r, s: c.s })),
          hand: v.me.hand.map((c) => ({ id: c.id, r: c.r, s: c.s })),
          discard: [],
          removed: [],
          play: [],
          chips: [],
          items: [],
          privilege: false,
          swapLeft: 0,
          swapDone: true,
          locked: false,
          buyPassed: false,
          removeDone: false,
          reorgDone: false,
          setupRound: 2,
          setupHand: [],
          lastAction: null,
          connected: true,
        } as never;
        const ids = bestFive(pseudo as never);
        this.sendAct({ t: 'bPlay', cardIds: ids });
        return;
      }
      case 'steal': {
        const targets = v.players.filter((p) => p.seat !== v.me.seat && p.blood >= 1);
        if (targets.length > 0) this.sendAct({ t: 'bSteal', seat: targets[0].seat });
        return;
      }
      case 'revealItem': {
        // 50% 使用荷官证
        const usable = v.me.items[0];
        if (usable && r() < 0.5) this.sendAct({ t: 'bUseItem', itemId: usable.id });
        else this.sendAct({ t: 'bUseItem', itemId: null });
        return;
      }
      case 'sdConfirm': {
        // 看完对决演示：确认后全员统一进入购买
        this.sendAct({ t: 'bShowdownDone' });
        return;
      }
      case 'buy': {
        if (r() < 0.45) {
          const affordable = v.market
            .map((m, i) => ({ m, i }))
            .filter((x) => x.m.defId != null && x.m.cost <= v.me.blood);
          if (affordable.length > 0) {
            const slot = affordable[Math.floor(r() * affordable.length)];
            const defKind = slot.m.kind;
            const validTargets = (this.view?.me.discard ?? []).filter((c) => c.chipIds.length === 0);
            const insertInto = defKind === 'chip' && validTargets.length > 0 ? validTargets[0].id : undefined;
            this.sendAct({ t: 'bBuy', slot: slot.i, insertInto });
            return;
          }
        }
        this.sendAct({ t: 'bPassBuy' });
        return;
      }
      case 'insertChip': {
        const valid = (this.view?.me.discard ?? []).filter((c) => c.chipIds.length === 0);
        if (valid.length > 0 && r() < 0.8) this.sendAct({ t: 'bInsertChip', cardId: valid[0].id });
        else this.sendAct({ t: 'bInsertSkip' });
        return;
      }
      case 'secretDelete': {
        const ids = this.discardIds().slice(0, Math.floor(r() * ((v.prompt.max ?? 2) + 1)));
        this.sendAct({ t: 'bSecretDelete', cardIds: ids });
        return;
      }
      case 'violentTarget': {
        const selfOk = v.me.drawCount >= 3;
        const oppOk = (v.players.find((p) => p.seat !== v.me.seat)?.drawCount ?? 0) >= 3;
        if (oppOk && r() < 0.5 && v.players.some((p) => p.seat !== v.me.seat)) {
          this.sendAct({ t: 'bViolent', seat: v.players.find((p) => p.seat !== v.me.seat)!.seat });
        } else if (selfOk) {
          this.sendAct({ t: 'bViolent', seat: v.me.seat });
        } else {
          this.sendAct({ t: 'bViolent', seat: -1 });
        }
        return;
      }
      case 'refreshPick': {
        const slots = v.market.map((m, i) => (m.defId ? i : -1)).filter((i) => i >= 0);
        this.sendAct({ t: 'bRefreshPick', slots: slots.slice(0, Math.floor(r() * 3)) });
        return;
      }
      case 'remove': {
        if (r() < 0.5 && this.discardIds().length > 0) {
          this.sendAct({ t: 'bRemove', cardIds: this.discardIds().slice(0, 1) });
        } else {
          this.sendAct({ t: 'bRemoveDone' });
        }
        return;
      }
      case 'reorg': {
        this.sendAct({ t: 'bReorg', choice: r() < 0.5 ? 'reshuffle' : 'blood' });
        return;
      }
      default:
        return;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('== 血色模式 2 人局端到端 ==');
  const a = new BloodBot('血甲');
  await a.connect();
  a.send({ t: 'create', name: '血甲', maxPlayers: 2, mode: 'blood' });
  await a.waitHello();
  await sleep(400);
  const code = a.code;
  console.log(`房间 ${code}`);

  const b = new BloodBot('血乙');
  await b.connect();
  b.send({ t: 'join', name: '血乙', code });
  await b.waitHello();
  await sleep(500);

  a.send({ t: 'start' });
  console.log('开局，等待整场结束（车票 24 达标）…');
  await Promise.all([
    a.waitState((v) => v.phase === 'gameover' && !!v.final, 180_000),
    b.waitState((v) => v.phase === 'gameover' && !!v.final, 180_000),
  ]);

  const finalA = a.view!.final!;
  const champ = a.view!.players.find((p) => p.seat === finalA.winnerSeat)!;
  console.log(`🏆 ${champ.name} 获胜：${champ.tickets} 车票 / ${champ.blood} 血筹`);
  if (champ.tickets < 24) throw new Error(`冠军车票 ${champ.tickets} < 24`);
  console.log('血色模式端到端通过 ✅');
  await sleep(200);
  process.exit(0);
}

main().catch((e) => {
  console.error('血色冒烟失败 ❌:', e);
  process.exit(1);
});
