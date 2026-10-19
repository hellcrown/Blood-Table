/**
 * 血色猎场 WS 端到端冒烟：建房（tactics）→ 加入 → 开局 → 双方自动打到终局。
 * 策略：能攻击射程内目标就打；否则沿共享 BFS 最短路逼近最近目标（怪或对手）；
 * 无路可走/无处可去就结束回合。运行前先启动服务器（SMOKE_URL 或 ws://localhost:3000/ws）。
 */
import WebSocket from 'ws';
import type { C2S, S2C } from '@shared/protocol';
import type { TacticsView } from '@shared/tacticsProtocol';
import { shortestPath } from '@shared/tacticsGrid';

const URL = process.env.SMOKE_URL ?? 'ws://localhost:3000/ws';
const MAX_TURNS = 400;

class Bot {
  name: string;
  ws: WebSocket | null = null;
  token = '';
  playerId = '';
  view: TacticsView | null = null;
  errors: string[] = [];
  private waiters: ((v: TacticsView) => boolean)[] = [];

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
      this.view = msg.view as TacticsView;
      this.waiters = this.waiters.filter((w) => !w(this.view!));
      this.maybeAct();
    } else if (msg.t === 'error') {
      this.errors.push(`${msg.code}: ${msg.msg}`);
    }
  }

  send(msg: C2S): void {
    this.ws?.send(JSON.stringify(msg));
  }

  waitView(pred: (v: TacticsView) => boolean): Promise<TacticsView> {
    if (this.view && pred(this.view)) return Promise.resolve(this.view);
    return new Promise((resolve) => this.waiters.push((v) => pred(v) && (resolve(v), true)));
  }

  private acting = false;
  private maybeAct(): void {
    const v = this.view;
    if (!v || this.acting || v.phase !== 'playing' || v.currentId !== this.playerId) return;
    const act = tacticsAct(v, this.playerId);
    if (!act) return;
    if (process.env.TAC_DEBUG) {
      const p = v.players.find((x) => x.id === this.playerId);
      console.error(`[dbg] ${this.name} T${v.turnNumber} @( ${p?.r},${p?.c}) ap=${p?.ap} -> ${JSON.stringify(act)}`);
    }
    this.acting = true;
    setTimeout(() => {
      this.acting = false;
      this.send(act);
    }, 30);
  }
}

/** 冒烟 AI：射程内有目标就打（曼哈顿 1）；否则按共享 BFS 最短路逼近最近目标；否则结束回合 */
function tacticsAct(v: TacticsView, me: string): C2S | null {
  const p = v.players.find((x) => x.id === me);
  if (!p || !p.alive) return null;
  const targets: { r: number; c: number }[] = [
    ...v.monsters.map((m) => ({ r: m.r, c: m.c })),
    ...v.players.filter((x) => x.alive && x.id !== me).map((x) => ({ r: x.r, c: x.c })),
  ];
  for (const t of targets) {
    if (Math.abs(p.r - t.r) + Math.abs(p.c - t.c) <= 1) return { t: 'tAttack', r: t.r, c: t.c };
  }
  const blocked = new Set<number>([
    ...v.monsters.map((m) => m.r * v.cols + m.c),
    ...v.players.filter((x) => x.alive && x.id !== me).map((x) => x.r * v.cols + x.c),
  ]);
  let best: { r: number; c: number } | null = null;
  let bestLen = Infinity;
  for (const t of targets) {
    const goal = t.r * v.cols + t.c;
    // 目标格被占（不可停留），寻路时豁免它、走到它前一格——此处必然未相邻（相邻已在上面打了）
    const blocks = new Set(blocked);
    blocks.delete(goal);
    const path = shortestPath(v.rows, v.cols, v.grid, blocks, p.r * v.cols + p.c, goal);
    if (path && path.length > 1 && path.length < bestLen) {
      bestLen = path.length;
      const k = Math.min(path.length - 1, p.ap); // 沿最短路走 min(路径长-1, 剩余AP) 步
      const step = path[k - 1]!;
      best = { r: Math.floor(step / v.cols), c: step % v.cols };
    }
  }
  if (best) return { t: 'tMove', to: best };
  return { t: 'tEndTurn' };
}

async function main(): Promise<void> {
  // 总看门狗：对局卡死（如双方无合法动作的死循环）时转储现场并失败退出
  const watchdog = setTimeout(() => {
    const v = a.view;
    console.error('✗ 冒烟看门狗超时：对局未在时限内结束');
    if (v) {
      console.error(
        `  现场：T${v.turnNumber} current=${v.currentId} phase=${v.phase} ` +
          `players=${JSON.stringify(v.players.map((p) => ({ id: p.id, r: p.r, c: p.c, hp: p.hp, ap: p.ap, alive: p.alive })))} ` +
          `monsters=${v.monsters.length}`,
      );
    }
    process.exit(1);
  }, 45_000);
  watchdog.unref?.();

  const a = new Bot('甲');
  const b = new Bot('乙');
  await a.connect();
  await b.connect();
  a.send({ t: 'create', name: '甲', maxPlayers: 2, mode: 'tactics' });
  await a.waitView((v) => v.kind === 'tactics' || v.phase === 'waiting');
  const code = (a.view as unknown as { code: string }).code;
  b.send({ t: 'join', name: '乙', code });
  await b.waitView((v) => (v as { phase?: string }).phase === 'waiting');
  a.send({ t: 'start' });
  await Promise.all([
    a.waitView((v) => v.kind === 'tactics' && v.phase === 'gameover'),
    b.waitView((v) => v.kind === 'tactics' && v.phase === 'gameover'),
  ]);
  const va = a.view!;
  if (va.ranking.length !== 2 || !va.winnerId) throw new Error(`终局异常：ranking=${JSON.stringify(va.ranking)}`);
  if (va.turnNumber > MAX_TURNS) throw new Error(`对局过长：turnNumber=${va.turnNumber}`);
  for (const bot of [a, b]) {
    if (bot.errors.length > 0) throw new Error(`${bot.name} 收到错误：${bot.errors.join('；')}`);
  }
  console.log(
    `✓ 血色猎场冒烟：${va.rows}×${va.cols} 图 · ${va.turnNumber} 回合 · 冠军 ${va.ranking[0]!.name} · 野怪剩余 ${va.monsters.length}`,
  );
  a.ws?.close();
  b.ws?.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('✗ 血色猎场冒烟失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
