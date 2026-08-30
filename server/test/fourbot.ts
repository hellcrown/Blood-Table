/**
 * 4 人桌视觉验收辅助：机器人创建 4 人房并占 3 个座位，
 * 等待浏览器玩家加入第 4 座后开局并自动行动。
 */
import WebSocket from 'ws';
import type { C2S, PlayerAction, S2C, TableView } from '@shared/protocol';

const URL = 'ws://localhost:3000/ws';

class Bot {
  name: string;
  ws: WebSocket | null = null;
  token = '';
  playerId = '';
  view: TableView | null = null;
  private acting = false;
  private waiters: ((v: TableView) => boolean)[] = [];

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
    } else if (msg.t === 'state') {
      this.view = msg.view as TableView;
      this.waiters = this.waiters.filter((w) => !w(msg.view as TableView));
      this.maybeAct();
    }
  }

  send(msg: C2S): void {
    this.ws?.send(JSON.stringify(msg));
  }

  waitState(pred: (v: TableView) => boolean, timeoutMs = 30000): Promise<TableView> {
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

  private mySeat(): number | null {
    return this.view?.players.find((p) => p.id === this.playerId)?.seat ?? null;
  }

  private maybeAct(): void {
    const v = this.view;
    if (!v || this.acting) return;
    if (v.toActSeat == null || v.toActSeat !== this.mySeat()) return;
    if (v.phase !== 'preflop' && v.phase !== 'flop' && v.phase !== 'turn' && v.phase !== 'river') return;
    const me = v.players.find((p) => p.id === this.playerId)!;
    const toCall = Math.max(0, v.currentBet - me.bet);
    const maxTo = me.bet + me.chips;
    const minRaiseTo = Math.min(v.minRaiseTo, maxTo);
    const canRaise = maxTo > v.currentBet && minRaiseTo <= maxTo;
    const roll = Math.random();
    let action: PlayerAction;
    if (toCall === 0) action = roll < 0.7 ? { k: 'check' } : canRaise ? { k: 'raise', to: minRaiseTo } : { k: 'check' };
    else if (roll < 0.15) action = { k: 'fold' };
    else if (roll < 0.8) action = { k: 'call' };
    else if (canRaise) action = { k: 'raise', to: minRaiseTo };
    else action = { k: 'call' };
    this.acting = true;
    setTimeout(() => {
      this.acting = false;
      this.send({ t: 'act', action });
    }, 900 + Math.random() * 1200);
  }
}

async function main(): Promise<void> {
  const host = new Bot('机器人甲');
  await host.connect();
  host.send({ t: 'create', name: '机器人甲', maxPlayers: 4 });
  await host.waitState((v) => v.code.length === 4);
  const code = host.view!.code;
  console.log(`ROOM_CODE=${code}`);

  const b = new Bot('机器人乙');
  await b.connect();
  b.send({ t: 'join', name: '机器人乙', code });
  await b.waitState((v) => v.players.length === 2);
  const c = new Bot('机器人丙');
  await c.connect();
  c.send({ t: 'join', name: '机器人丙', code });
  await c.waitState((v) => v.players.length === 3);
  console.log('3 个机器人就座，等待浏览器玩家加入第 4 座…');

  await host.waitState((v) => v.players.length === 4, 180_000);
  host.send({ t: 'start' });
  console.log('已开局，机器人自动行动 3 分钟…');
  await new Promise((r) => setTimeout(r, 180_000));
}

main().catch((e) => {
  console.error('4人桌机器人脚本失败:', e);
  process.exit(1);
});
