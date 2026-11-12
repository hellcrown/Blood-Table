/**
 * 你画我猜 WS 端到端冒烟：建房（draw）→ 加入 → 开局 → 画手选词 → 画手发笔画（猜词者收增量）
 * → 猜错（公开）→ 猜中（只广播猜对了）→ 揭晓 → 观战者进场拿整幅快照 → 房主终止 → 终局排名。
 * 运行前先启动服务器（SMOKE_URL 或 ws://localhost:3000/ws），在 server/ 下 `npx tsx test/drawSmoke.ts`。
 * 不带 .test.ts 后缀：不进 npm test，仅手动冒烟（与 bloodSmoke/convergeSmoke 同口径）。
 */
import WebSocket from 'ws';
import type { C2S, S2C } from '@shared/protocol';
import type { DrawView } from '@shared/drawProtocol';

const URL = process.env.SMOKE_URL ?? 'ws://localhost:3000/ws';

class Client {
  ws: WebSocket | null = null;
  view: DrawView | null = null;
  roomCode = '';
  ops = 0;
  snaps: { rev: number; strokes: number }[] = [];
  errors: string[] = [];

  constructor(readonly name: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(URL);
      this.ws = ws;
      ws.on('open', () => resolve());
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as S2C;
        if (msg.t === 'state') {
          const v = msg.view as { kind?: string; code?: string };
          if (v.code) this.roomCode = v.code;
          if (v.kind === 'draw') this.view = msg.view as DrawView;
        } else if (msg.t === 'dOps') this.ops += 1;
        else if (msg.t === 'dSnap') this.snaps.push({ rev: msg.rev, strokes: msg.strokes.length });
        else if (msg.t === 'error') this.errors.push(`${msg.code}:${msg.msg}`);
      });
    });
  }

  send(m: C2S): void {
    this.ws?.send(JSON.stringify(m));
  }

  async until(pred: () => boolean, what: string, ms = 5000): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`${this.name} 等待超时：${what}`);
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  close(): void {
    this.ws?.close();
  }
}

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✅ ${msg}`);
}

async function main(): Promise<void> {
  const host = new Client('甲');
  const guest = new Client('乙');
  await host.connect();
  await guest.connect();
  host.send({ t: 'create', name: '甲', maxPlayers: 4, mode: 'draw' });
  await host.until(() => !!host.roomCode, '建房');
  guest.send({ t: 'join', name: '乙', code: host.roomCode });
  await new Promise((r) => setTimeout(r, 200));
  host.send({ t: 'start' });
  await host.until(() => host.view?.phase === 'choosing', '开局进入选词');
  check(host.view?.choices?.length === 3 && guest.view?.choices == null, '候选只给画手');

  host.send({ t: 'dPick', index: 0 });
  await guest.until(() => guest.view?.phase === 'drawing', '进入作画');
  const word = host.view!.word!;
  check(guest.view!.word == null && /^＿+$/.test(guest.view!.hint ?? ''), `猜词者只见掩码（${guest.view!.hint}）`);

  const before = guest.ops;
  host.send({ t: 'dStroke', ops: [{ k: 'b', id: 0, c: 1, w: 1, p: [100, 100, 200, 200] }] });
  host.send({ t: 'dStroke', ops: [{ k: 'a', id: 0, p: [300, 250] }] });
  await guest.until(() => guest.ops >= before + 2, '收到两批增量笔画');
  check(host.ops === 0, '画手不回显自己的笔画');

  guest.send({ t: 'dGuess', text: '肯定不是这个' });
  await host.until(() => !!host.view?.feed.some((f) => f.text === '肯定不是这个'), '猜错公开');
  guest.send({ t: 'dGuess', text: word });
  await host.until(() => host.view?.phase === 'reveal', '唯一猜词者猜中 → 揭晓');
  check(!host.view!.feed.some((f) => f.kind !== 'sys' && f.text === word), '猜中不广播原文');
  check((guest.view?.players.find((p) => p.name === '乙')?.score ?? 0) > 0, '猜中者得分');

  const spec = new Client('丙');
  await spec.connect();
  spec.send({ t: 'spectate', name: '丙', code: host.roomCode });
  await spec.until(() => spec.snaps.length > 0, '观战进场拿整幅快照');
  check(spec.snaps.at(-1)!.strokes === 1, '快照含画手的那一笔');

  host.send({ t: 'dAbort' });
  await host.until(() => host.view?.phase === 'gameover', '房主终止');
  check(host.view!.ranking[0]?.name === '乙', `终局排名：${host.view!.ranking.map((r) => `${r.name}${r.score}`).join(' / ')}`);
  check(host.errors.length === 0 && guest.errors.length === 0, '全程无错误帧');
  for (const c of [host, guest, spec]) c.close();
  console.log('\n✅ 你画我猜冒烟通过');
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
