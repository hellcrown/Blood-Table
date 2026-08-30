/**
 * WS 端到端冒烟测试：
 *  1. 建房（4人上限）→ 3 人加入 → 开局 → 自动随机打完 3 手
 *  2. 断线重连：乙断开后用 token 重连，验证座位/手牌恢复
 *  3. 2 人单挑房：开局打 1 手
 * 运行前先启动服务器（默认 ws://localhost:3000/ws）。
 */
import WebSocket from 'ws';
import type { C2S, PlayerAction, S2C, TableView } from '@shared/protocol';

const URL = process.env.SMOKE_URL ?? 'ws://localhost:3000/ws';

class Bot {
  name: string;
  ws: WebSocket | null = null;
  token = '';
  playerId = '';
  view: TableView | null = null;
  errors: string[] = [];
  active = true;
  private acting = false;
  private waiters: ((v: TableView) => boolean)[] = [];
  private helloWaiter: (() => void) | null = null;

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
      this.view = msg.view as TableView;
      const stillWaiting = this.waiters.filter((w) => !w(msg.view as TableView));
      this.waiters = stillWaiting;
      this.maybeAct();
    } else if (msg.t === 'error') {
      this.errors.push(`${msg.code}: ${msg.msg}`);
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

  waitState(pred: (v: TableView) => boolean, timeoutMs = 45000): Promise<TableView> {
    return new Promise((resolve, reject) => {
      if (this.view && pred(this.view)) {
        resolve(this.view);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`${this.name} 等待状态超时`)), timeoutMs);
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

  mySeat(): number | null {
    return this.view?.players.find((p) => p.id === this.playerId)?.seat ?? null;
  }

  private maybeAct(): void {
    const v = this.view;
    if (!v || !this.active || this.acting) return;
    if (v.toActSeat == null || v.toActSeat !== this.mySeat()) return;
    if (v.phase !== 'preflop' && v.phase !== 'flop' && v.phase !== 'turn' && v.phase !== 'river') return;
    const me = v.players.find((p) => p.id === this.playerId)!;
    const toCall = Math.max(0, v.currentBet - me.bet);
    const maxTo = me.bet + me.chips;
    const minRaiseTo = Math.min(v.minRaiseTo, maxTo);
    const canRaise = maxTo > v.currentBet && minRaiseTo <= maxTo;
    const roll = Math.random();
    let action: PlayerAction;
    if (toCall === 0) action = roll < 0.8 ? { k: 'check' } : canRaise ? { k: 'raise', to: minRaiseTo } : { k: 'check' };
    else if (roll < 0.1) action = { k: 'fold' };
    else if (roll < 0.75) action = { k: 'call' };
    else if (canRaise && roll < 0.92) action = { k: 'raise', to: minRaiseTo };
    else action = { k: 'allin' };
    this.acting = true;
    setTimeout(() => {
      this.acting = false;
      this.send({ t: 'act', action });
    }, 40);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function expect(cond: unknown, label: string): Promise<void> {
  if (!cond) throw new Error(`断言失败: ${label}`);
}

async function main(): Promise<void> {
  console.log('== 1. 4 人上限房：3 人加入并自动打 3 手 ==');
  const a = new Bot('甲');
  await a.connect();
  a.send({ t: 'create', name: '甲', maxPlayers: 4 });
  await a.waitHello();
  await a.waitState((v) => v.code.length === 4);
  const code = a.view!.code;
  console.log(`   房间码: ${code}`);

  const b = new Bot('乙');
  await b.connect();
  b.send({ t: 'join', name: '乙', code });
  await b.waitHello();
  await b.waitState((v) => v.players.length === 2);

  const c = new Bot('丙');
  await c.connect();
  c.send({ t: 'join', name: '丙', code });
  await c.waitHello();
  await c.waitState((v) => v.players.length === 3);
  console.log('   3 人就座 ✓');

  a.send({ t: 'start' });
  await a.waitState((v) => v.phase === 'preflop');
  console.log('   开局 ✓');

  await Promise.all([
    a.waitState((v) => v.handNumber >= 3 && v.phase === 'result', 60000),
    b.waitState((v) => v.handNumber >= 3 && v.phase === 'result', 60000),
    c.waitState((v) => v.handNumber >= 3 && v.phase === 'result', 60000),
  ]);
  console.log('   完成 3 手对局 ✓');

  for (const bot of [a, b, c]) {
    const v = bot.view!;
    const chipsSum = v.players.reduce((s, p) => s + p.chips, 0);
    await expect(chipsSum === 3000, `筹码守恒(${bot.name}): ${chipsSum}`);
    await expect(v.players.every((p) => p.hole === null || p.hole.length === 2), '底牌字段完整');
  }
  console.log('   筹码守恒 3000 ✓');

  console.log('== 2. 断线重连 ==');
  b.ws!.close();
  await sleep(400);
  const b2 = new Bot('乙');
  await b2.connect();
  b2.send({ t: 'rejoin', token: b.token });
  await b2.waitHello();
  const v2 = await b2.waitState((vv) => vv.players.length === 3);
  await expect(b2.playerId === b.playerId, '重连后 playerId 一致');
  await expect(v2.players.some((p) => p.id === b2.playerId), '重连后仍在座位上');
  b2.active = false;
  console.log('   token 重连恢复 ✓');

  console.log('== 3. 2 人单挑房 ==');
  const p = new Bot('单挑甲');
  await p.connect();
  p.send({ t: 'create', name: '单挑甲', maxPlayers: 2 });
  await p.waitHello();
  await p.waitState((v) => v.code.length === 4);
  const code2 = p.view!.code;
  const q = new Bot('单挑乙');
  await q.connect();
  q.send({ t: 'join', name: '单挑乙', code: code2 });
  await q.waitHello();
  p.send({ t: 'start' });
  await p.waitState((v) => v.phase === 'preflop');
  const pView = p.view!;
  const btn = pView.players.find((x) => x.isButton)!;
  const sb = pView.players.find((x) => x.role === 'sb')!;
  await expect(btn.seat === sb.seat, '单挑庄家即小盲');
  await expect(pView.toActSeat === btn.seat, '单挑翻牌前庄家先行动');
  await Promise.all([
    p.waitState((v) => v.handNumber >= 1 && v.phase === 'result', 60000),
    q.waitState((v) => v.handNumber >= 1 && v.phase === 'result', 60000),
  ]);
  console.log('   单挑局完成 ✓');

  const allErrors = [a, b, c, b2, p, q].flatMap((x) => x.errors);
  const benign = allErrors.filter((e) => !e.startsWith('NOT_YOUR_TURN') && !e.startsWith('ROOM_NOT_FOUND'));
  if (benign.length > 0) {
    console.log('⚠ 意外错误:', benign);
    process.exit(1);
  }
  console.log('\n全部冒烟测试通过 ✅');
  for (const bot of [a, b, b2, c, p, q]) bot.ws?.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('冒烟测试失败 ❌:', e);
  process.exit(1);
});
