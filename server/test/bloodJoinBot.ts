/**
 * 加入指定房间的自动打牌机器人（血色模式）。
 * 用法：npx tsx test/bloodJoinBot.ts <房间码> <名字>
 */
import WebSocket from 'ws';
import { bestFive } from '../src/blood/engine';
import type { BloodView } from '@shared/bloodProtocol';
import type { C2S, S2C } from '@shared/protocol';

const URL = process.env.SMOKE_URL ?? 'ws://localhost:3000/ws';
const code = process.argv[2] ?? '';
const name = process.argv[3] ?? '机器人';

class Bot {
  ws: WebSocket | null = null;
  token = '';
  playerId = '';
  view: BloodView | null = null;
  private acting = false;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(URL);
      this.ws = ws;
      ws.on('open', () => {
        resolve();
        if (this.token) {
          // 断线重连
          this.send({ t: 'rejoin', token: this.token });
        }
      });
      ws.on('error', reject);
      ws.on('close', () => {
        setTimeout(() => {
          this.connect().catch(() => setTimeout(() => this.connect(), 1500));
        }, 800);
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as S2C;
        if (msg.t === 'hello') {
          this.token = msg.token;
          this.playerId = msg.playerId;
        }
        if (msg.t === 'state' && msg.view.kind === 'blood') {
          this.view = msg.view;
          if (!this.acting) {
            this.acting = true;
            setTimeout(() => {
              this.acting = false;
              try {
                this.act();
              } catch {
                /* 忽略 */
              }
            }, 150);
          }
        }
      });
    });
  }

  send(msg: C2S): void {
    this.ws?.send(JSON.stringify(msg));
  }

  act(): void {
    const v = this.view;
    if (!v || v.prompt.k === 'wait') return;
    const r = Math.random;
    const discardValid = v.me.discard.filter((c) => c.chipIds.length === 0);
    switch (v.prompt.k) {
      case 'pick':
        if (v.me.charOptions.length > 0) this.send({ t: 'bPickChar', charId: v.me.charOptions[0] });
        break;
      case 'setup':
        this.send({ t: 'bSetup', removed: [] });
        break;
      case 'swap':
        if (r() < 0.4 && v.me.hand.length >= 2) {
          this.send({ t: 'bSwap', cardIds: v.me.hand.slice(0, 2).map((c) => c.id) });
        } else this.send({ t: 'bSwapStop' });
        break;
      case 'play':
        this.send({
          t: 'bPlay',
          cardIds: bestFive({ hand: v.me.hand.map((c) => ({ id: c.id, r: c.r, s: c.s })), chips: [] } as never),
        });
        break;
      case 'steal': {
        const t = v.players.find((p) => p.seat !== v.me.seat && p.blood >= 1);
        if (t) this.send({ t: 'bSteal', seat: t.seat });
        break;
      }
      case 'revealItem':
        this.send({ t: 'bUseItem', itemId: null });
        break;
      case 'sdConfirm':
        this.send({ t: 'bShowdownDone' });
        break;
      case 'buy': {
        const affordable = v.market.map((m, i) => ({ m, i })).filter((x) => x.m.defId != null && x.m.cost <= v.me.blood);
        if (r() < 0.4 && affordable.length > 0) {
          const s = affordable[Math.floor(r() * affordable.length)];
          const defKind = s.m.kind;
          const insertInto = defKind === 'chip' && discardValid.length > 0 ? discardValid[0].id : undefined;
          this.send({ t: 'bBuy', slot: s.i, insertInto });
        } else this.send({ t: 'bPassBuy' });
        break;
      }
      case 'insertChip':
        if (discardValid.length > 0) this.send({ t: 'bInsertChip', cardId: discardValid[0].id });
        else this.send({ t: 'bInsertSkip' });
        break;
      case 'secretDelete':
        this.send({ t: 'bSecretDelete', cardIds: v.me.discard.slice(0, 1).map((c) => c.id) });
        break;
      case 'violentTarget': {
        const opp = v.players.find((p) => p.seat !== v.me.seat && p.drawCount >= 3);
        if (opp) this.send({ t: 'bViolent', seat: opp.seat });
        else if (v.me.drawCount >= 3) this.send({ t: 'bViolent', seat: v.me.seat });
        else this.send({ t: 'bViolent', seat: -1 });
        break;
      }
      case 'refreshPick': {
        const slots = v.market.map((m, i) => (m.defId ? i : -1)).filter((i) => i >= 0);
        this.send({ t: 'bRefreshPick', slots: slots.slice(0, 1) });
        break;
      }
      case 'remove':
        this.send({ t: 'bRemoveDone' });
        break;
      case 'reorg':
        this.send({ t: 'bReorg', choice: r() < 0.5 ? 'reshuffle' : 'blood' });
        break;
    }
  }
}

async function main(): Promise<void> {
  const bot = new Bot();
  await bot.connect();
  bot.send({ t: 'join', name, code });
  console.log(`机器人【${name}】已加入房间 ${code}，自动行动中…`);
  setInterval(() => {}, 1 << 30); // 保持进程
}

main().catch((e) => {
  console.error('加入失败:', e);
  process.exit(1);
});
