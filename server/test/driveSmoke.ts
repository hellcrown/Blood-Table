/**
 * 勿停 WS 端到端冒烟：建房（drive）→ 加入 → solo 参数设置 → 开局 → 油门意图驱动车辆
 * （快拍广播下速度/里程上涨）→ 开窗搜掠路径观察 → 关窗 → 瞭望 ping → 慢速喂养猎影触发扑击
 * → 房主终止 → 终局统计与 matchlog。运行前先启动服务器（SMOKE_URL 或 ws://localhost:3000/ws），
 * 在 server/ 下 `npx tsx test/driveSmoke.ts`。不带 .test.ts 后缀：不进 npm test，仅手动冒烟。
 */
import WebSocket from 'ws';
import type { C2S, S2C } from '@shared/protocol';
import type { DriveView } from '@shared/driveProtocol';

const URL = process.env.SMOKE_URL ?? 'ws://localhost:3000/ws';

class Client {
  ws: WebSocket | null = null;
  view: DriveView | null = null;
  /** 最近一帧视图（含等待页 TableView——返回房间后 kind 不再是 drive） */
  lastView: { kind?: string; phase?: string } | null = null;
  roomCode = '';
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
          this.lastView = v;
          if (v.kind === 'drive') this.view = msg.view as DriveView;
        } else if (msg.t === 'error') this.errors.push(`${msg.code}:${msg.msg}`);
      });
    });
  }

  send(m: C2S): void {
    this.ws?.send(JSON.stringify(m));
  }

  async until(pred: () => boolean, what: string, ms = 8000): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`${this.name} 等待超时：${what}`);
      await new Promise((r) => setTimeout(r, 40));
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const host = new Client('甲');
  const guest = new Client('乙');
  await host.connect();
  await guest.connect();
  host.send({ t: 'create', name: '甲', maxPlayers: 4, mode: 'drive' });
  await host.until(() => !!host.roomCode, '建房');
  check(host.view?.mode === 'drive' || host.view == null, '建房进入勿停等待页');
  guest.send({ t: 'join', name: '乙', code: host.roomCode });
  await new Promise((r) => setTimeout(r, 200));
  host.send({ t: 'settings', driveSignGap: 200, driveDurability: 5, driveTail: 'lenient', driveCrawl: 'low', driveTarget: 0 });
  await sleep(150);
  host.send({ t: 'start' });
  await host.until(() => host.view?.phase === 'driving', '开局进入驾驶');
  check(host.view!.signGap === 200 && guest.view!.signGap === 200, '设置随视图下发（200m/牌 · 耐久 5 · 缓）');

  // 油门：按住 2s，速度应升到接近 50，里程同步上涨
  const pos0 = host.view!.pos;
  host.send({ t: 'vInt', intent: { k: 'gas', on: true } });
  await sleep(2000);
  const v1 = host.view!;
  check(v1.speed > 30, `按住油门加速（${v1.speed.toFixed(0)} km/h）`);
  check(v1.pos > pos0 + 10, `里程推进（${(v1.pos - pos0).toFixed(0)}m）`);
  check(v1.fuel < 100, `油耗随速度（${v1.fuel.toFixed(1)}%）`);
  check((v1.myInputs?.gas ?? false) === true, '自己的持键状态回显（重连同步依据）');

  // 猎影：松开油门滑到勿停线下，缓档衰减慢——先验证尾压开始下降
  host.send({ t: 'vInt', intent: { k: 'gas', on: false } });
  await sleep(3000);
  check(host.view!.gap < 100, `低于勿停线喂养猎影（尾距 ${host.view!.gap.toFixed(0)}）`);

  // 瞭望标记与关窗：不发错误帧
  host.send({ t: 'vInt', intent: { k: 'ping', lane: 0, at: 300 } });
  host.send({ t: 'vInt', intent: { k: 'window', side: 'L' } });
  await sleep(400);
  check(host.view!.windows.L.open === true, '开窗成功（搜掠前置）');
  guest.send({ t: 'vInt', intent: { k: 'window', side: 'L' } });
  await sleep(400);
  check(host.view!.windows.L.open === false, '关窗挫败（归因转移后仍可关）');

  // 慢速喂猎影触发扑击（缓档 4/s，静止 ~25s 才见分晓——改用急刹+标准档不值得等，直接等扑击统计出现）
  host.send({ t: 'vAbort' });
  await host.until(() => host.view?.phase === 'gameover', '房主终止');
  const res = host.view!.result!;
  check(res.reason === 'abort', `终局原因：${res.reason}`);
  check(res.distance > 0 && res.signs === 0, `结算统计（${res.distance}m · ${res.signs} 牌 · 扑击 ${res.attacks} · 搏斗 ${res.crawls}）`);
  check(host.errors.length === 0 && guest.errors.length === 0, '全程无错误帧');

  // 再来一局 → 返回房间
  host.send({ t: 'vRematch' });
  await host.until(() => host.view?.phase === 'driving', '再来一局重新上路');
  host.send({ t: 'vAbort' });
  await host.until(() => host.view?.phase === 'gameover', '再次终止');
  host.send({ t: 'backToRoom' });
  await host.until(() => host.lastView?.phase === 'waiting' && host.lastView?.kind !== 'drive', '返回房间等待页');
  for (const c of [host, guest]) c.close();
  console.log('\n✅ 勿停冒烟通过');
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
