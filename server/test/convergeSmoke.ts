/**
 * 心有灵犀 WS 端到端冒烟：建房（converge）→ 加入 → 开局 → 第 1 轮不匹配 → 第 2 轮相遇（全角/半角）
 * → 再来一局 → 观战进入。运行前先启动服务器（SMOKE_URL 或 ws://localhost:3000/ws）。
 * 不带 .test.ts 后缀：不进 npm test，仅手动冒烟（与 bloodSmoke/tacticsSmoke 同口径）。
 */
import WebSocket from 'ws';
import type { C2S, S2C } from '@shared/protocol';
import type { ConvergeView } from '@shared/convergeProtocol';

const URL = process.env.SMOKE_URL ?? 'ws://localhost:3000/ws';

class Bot {
  name: string;
  ws: WebSocket | null = null;
  token = '';
  playerId = '';
  view: ConvergeView | null = null;
  errors: string[] = [];
  private waiters: ((v: ConvergeView) => boolean)[] = [];

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
      this.view = msg.view as ConvergeView;
      this.waiters = this.waiters.filter((w) => !w(this.view!));
    } else if (msg.t === 'error') {
      this.errors.push(`${msg.code}: ${msg.msg}`);
    }
  }

  send(msg: C2S): void {
    this.ws?.send(JSON.stringify(msg));
  }

  waitView(pred: (v: ConvergeView) => boolean, what: string): Promise<ConvergeView> {
    if (this.view && pred(this.view)) return Promise.resolve(this.view);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} 等待 ${what} 超时`)), 8000);
      this.waiters.push((v) => {
        if (!pred(v)) return false;
        clearTimeout(timer);
        resolve(v);
        return true;
      });
    });
  }
}

function assert(cond: unknown, what: string): void {
  if (!cond) throw new Error(`断言失败: ${what}`);
  console.log(`  ✓ ${what}`);
}

async function main(): Promise<void> {
  const a = new Bot('甲');
  const b = new Bot('乙');
  const s = new Bot('观战');
  await a.connect();
  await b.connect();
  await s.connect();

  // 建房（converge，人数故意传 4 验证服务端钳 2）→ 加入 → 开局
  a.send({ t: 'create', name: '甲', maxPlayers: 4, mode: 'converge' });
  await a.waitView((v) => (v as { phase?: string }).phase === 'waiting', '等待页');
  const code = (a.view as unknown as { code: string }).code;
  assert(code.length === 4, `建房拿到房间码 ${code}`);
  b.send({ t: 'join', name: '乙', code });
  await b.waitView((v) => (v as { phase?: string }).phase === 'waiting', '乙进入等待页');
  a.send({ t: 'start' });
  await a.waitView((v) => v.kind === 'converge' && v.phase === 'playing', '甲进入对局');
  await b.waitView((v) => v.kind === 'converge' && v.phase === 'playing', '乙进入对局');
  assert(a.view?.players.length === 2, '双人成局');

  // 第 1 轮：不匹配（甲中途覆写一次验证可修改）
  a.send({ t: 'cSubmit', text: '午睡' });
  await a.waitView((v) => v.myText === '午睡', '甲提交');
  a.send({ t: 'cSubmit', text: '大餐' });
  await a.waitView((v) => v.myText === '大餐', '甲覆写');
  b.send({ t: 'cSubmit', text: '肥牛卷' });
  await a.waitView((v) => v.rounds.length === 1 && v.round === 2, '第 1 轮揭示并进入第 2 轮');
  assert(a.view?.rounds[0]?.same === false, '第 1 轮判不同');
  assert((a.view?.rounds[0]?.entries[0]?.text ?? '') === '大餐', '历史保留覆写后的原文');

  // 第 2 轮：全角 vs 半角相遇
  a.send({ t: 'cSubmit', text: '６' });
  b.send({ t: 'cSubmit', text: '6' });
  await a.waitView((v) => v.phase === 'gameover', '甲看到终局');
  await b.waitView((v) => v.phase === 'gameover', '乙看到终局');
  assert(a.view?.result?.matched === true && a.view.result.rounds === 2, '第 2 轮相遇，用时 2 轮');
  assert(a.view?.result?.word === '６', '相遇词保留原文（全角）');
  assert((b.view?.myText ?? 'x') === (b.view?.myText ?? 'y') && b.view?.players.every((p) => !('text' in p)), '视图玩家条目不带文本字段（隐私）');

  // 观战进入（对局已结束 → 观战者回等待页口径；先验证中途观战：再来一局后进入）
  a.send({ t: 'cRematch' });
  await a.waitView((v) => v.phase === 'playing' && v.round === 1, '甲再来一局');
  s.send({ t: 'spectate', name: '围观', code });
  await s.waitView((v) => v.kind === 'converge' && v.spectator === true, '观战者收到对局视图');
  a.send({ t: 'cSubmit', text: '雪' });
  await s.waitView((v) => v.players.every((p) => p.id !== s.playerId), '观战视图不含自己座位');
  b.send({ t: 'cSubmit', text: '雪' });
  await s.waitView((v) => v.kind !== 'converge', '观战者终局自动回等待页');
  assert(a.view?.result?.matched === true, '第 2 局 1 轮相遇');

  // 离场终局
  a.send({ t: 'cRematch' });
  await a.waitView((v) => v.phase === 'playing', '第 3 局开始');
  b.send({ t: 'leave' });
  await a.waitView((v) => v.phase === 'gameover' && v.result?.reason === 'leave', '对方离场即未相遇终局');

  console.log('\n心有灵犀 WS 冒烟全部通过 ✅');
  a.ws?.close();
  b.ws?.close();
  s.ws?.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('冒烟失败:', e);
  process.exit(1);
});
