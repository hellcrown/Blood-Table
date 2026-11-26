/**
 * 勿停 WS 端到端冒烟（v2）：建房（drive）→ 加入 → 设置 → 开局（默认岗位：房主驾驶、来宾导航）
 * → 油门/转向 → 导航位开窗/喊话/地图标记 → 切岗位 → 开到第 1 号路牌后找一只夜行者、停在它附近
 * 验证被惊动、再开起来甩脱（尽力而为：60s 内没遇到会明确提示跳过）→ 房主终止 → 再来一局 → 返回房间。
 * 运行前先启动服务器（SMOKE_URL 或 ws://localhost:3000/ws），在 server/ 下 `npx tsx test/driveSmoke.ts`。
 * 不带 .test.ts 后缀：不进 npm test，仅手动冒烟。
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
      await sleep(40);
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
  guest.send({ t: 'join', name: '乙', code: host.roomCode });
  await sleep(200);
  host.send({ t: 'settings', driveSignGap: 200, driveDurability: 5, driveTail: 'lenient', driveCrawl: 'low', driveCurves: 'lenient' });
  await sleep(150);
  host.send({ t: 'start' });
  await host.until(() => host.view?.phase === 'driving', '开局进入驾驶');
  check(guest.view?.myRole === 'navigate' && host.view?.myRole === 'drive', '默认岗位：房主驾驶、来宾导航');

  // 油门
  const pos0 = host.view!.pos;
  host.send({ t: 'vInt', intent: { k: 'gas', on: true } });
  await sleep(2200);
  const v1 = host.view!;
  check(v1.speed > 30, `按住油门加速（${v1.speed.toFixed(0)} km/h）`);
  check(v1.pos > pos0 + 10 && v1.lateral === 0, `直路上笔直前进（${(v1.pos - pos0).toFixed(0)}m，横向 0）`);
  check(v1.steerIn === 0, '转向输入随帧下发');

  // 转向：左打 → 车向左横移；松开 → 车头角回正
  host.send({ t: 'vInt', intent: { k: 'steer', dir: -1 } });
  await sleep(350);
  const v2 = host.view!;
  check(v2.rel < 0 && v2.lateral < -0.2, `左打方向（车头角 ${v2.rel.toFixed(2)}，横向 ${v2.lateral.toFixed(2)}m）`);
  check(v2.steerIn === -1, '转向输入被服务端采纳');
  const relPeak = Math.abs(v2.rel);
  const latAfterSteer = v2.lateral;
  host.send({ t: 'vInt', intent: { k: 'steer', dir: 0 } });
  await sleep(900);
  check(Math.abs(host.view!.rel) < relPeak, '松开方向键车头角回正');
  // 把车开回路面中段：刚才的左打让车一路向左滑，不拉回来的话它会在后面的检查里溜上路肩
  //（路肩减速极强，会让「踩油门要加速」的断言失真）。闭环控制而不是开环定时：
  // 一直往右打到车回到中线右侧、且车头已经摆正为止
  let backOnRoad = false;
  const recoverStart = Date.now();
  while (Date.now() - recoverStart < 8000) {
    const v = host.view!;
    if (v.phase !== 'driving') break;
    const want = v.lateral > 0.6 ? (v.rel > 0 ? -1 : 0) : v.rel < 0.22 ? 1 : 0;
    host.send({ t: 'vInt', intent: { k: 'steer', dir: want } });
    if (v.lateral > 0.6 && Math.abs(v.rel) < 0.12) {
      backOnRoad = true;
      break;
    }
    await sleep(100);
  }
  host.send({ t: 'vInt', intent: { k: 'steer', dir: 0 } });
  check(backOnRoad, `右打方向把车拉回路面中段（横向 ${latAfterSteer.toFixed(1)}m → ${host.view!.lateral.toFixed(1)}m）`);
  check(host.view!.offRoad === false, '车在路面上');
  host.send({ t: 'vInt', intent: { k: 'gas', on: false } });
  await sleep(300);

  // 导航位专属：开窗 / 喊话 / 地图标记
  host.send({ t: 'vInt', intent: { k: 'window', side: 'L' } });
  await sleep(300);
  check(host.view!.windows.L.open === false, '驾驶员开不了窗（岗位权限）');
  guest.send({ t: 'vInt', intent: { k: 'window', side: 'L' } });
  guest.send({ t: 'vInt', intent: { k: 'call', i: 1 } });
  guest.send({ t: 'vInt', intent: { k: 'ping', at: 320, lat: 0 } });
  await host.until(() => !!host.view && host.view.calls.length > 0 && host.view.pings.length > 0, '收到喊话与标记');
  check(host.view!.windows.L.open === true, '副驾驶开窗生效');
  check(host.view!.calls.some((c) => c.i === 1 && c.by === '乙'), '喊话下发给驾驶员（右弯！）');
  check(host.view!.pings.some((p) => p.at === 320 && p.lat === 0), '地图标记下发给驾驶员');
  guest.send({ t: 'vInt', intent: { k: 'window', side: 'L' } });
  await sleep(300);
  check(host.view!.windows.L.open === false, '副驾驶关窗');

  // 切岗位：来宾接管驾驶
  guest.send({ t: 'vInt', intent: { k: 'role', role: 'drive' } });
  await guest.until(() => guest.view?.canDrive === true, '来宾切到驾驶位');
  guest.send({ t: 'vInt', intent: { k: 'gas', on: true } });
  await host.until(() => host.view!.drivers === 2, '两位驾驶员');
  const speedBefore = host.view!.speed;
  // 等服务端把来宾的油门积分进车速（视图 10Hz 一帧）
  await host.until(() => host.view!.speed > speedBefore + 3, '来宾的油门让车加速', 4000);
  check(host.view!.speed > speedBefore, `来宾也能踩油门（${speedBefore.toFixed(0)} → ${host.view!.speed.toFixed(0)} km/h）`);
  guest.send({ t: 'vInt', intent: { k: 'role', role: 'navigate' } });
  await guest.until(() => guest.view?.canNavigate === true, '来宾切回导航位');
  check(guest.view!.myInputs?.gas === false, '切岗位即松手');

  // 简易「自动驾驶司机」（冒烟脚本自己的）：保持车道、避开前方路障/尸群/游荡的夜行者、巡航限速。
  // 只在状态变化时才发意图（意图通道有限速，每拍重发会被丢）
  const sent = { steer: 0 as -1 | 0 | 1, gas: false, brake: false };
  const drive = (steer: -1 | 0 | 1, gas: boolean, brake: boolean): void => {
    if (steer !== sent.steer) {
      host.send({ t: 'vInt', intent: { k: 'steer', dir: steer } });
      sent.steer = steer;
    }
    if (gas !== sent.gas) {
      host.send({ t: 'vInt', intent: { k: 'gas', on: gas } });
      sent.gas = gas;
    }
    if (brake !== sent.brake) {
      host.send({ t: 'vInt', intent: { k: 'brake', on: brake } });
      sent.brake = brake;
    }
  };
  const autopilot = (cruise: number): void => {
    const v = host.view;
    if (!v || v.phase !== 'driving') return;
    const blocked = (lane: number): boolean =>
      v.events.some((ev) => {
        const d = ev.at - v.pos;
        if (d < -2 || d > 90 || (ev.kind !== 'barrier' && ev.kind !== 'swarm')) return false;
        return Math.abs((ev.lat ?? 0) - lane) < (ev.half ?? 1.3) + 1.6;
      }) ||
      v.monsters.some((m) => (m.mode === 'wander' || m.mode === 'return') && m.at - v.pos > -2 && m.at - v.pos < 90 && Math.abs(m.lat - lane) < 2.6);
    let target = 0;
    if (blocked(0)) {
      target = [-3.5, 0, 3.5].filter((l) => !blocked(l)).sort((a, b) => Math.abs(a - v.lateral) - Math.abs(b - v.lateral))[0] ?? 0;
    }
    const u = 2.4 * v.rel + 0.45 * (v.lateral - target);
    drive(u > 0.12 ? -1 : u < -0.12 ? 1 : 0, v.speed < cruise - 4, v.speed > cruise + 8);
  };

  // 遇袭（尽力而为）：开到出现游荡的夜行者 → 停在它跟前 → 被惊动 → 开起来甩脱
  let encountered = false;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && host.view?.phase === 'driving') {
    const v = host.view!;
    // 前方 35~80m 有夜行者：刹停（停稳后它仍在 90m 惊动范围内）。
    // 车速一低于 10km/h 它就从「游荡」切成「被惊动」——所以两种都算
    const prey = v.monsters.find((m) => (m.mode === 'wander' || m.mode === 'hunt') && m.at - v.pos > 35 && m.at - v.pos < 80);
    if (prey) {
      autopilot(0); // 刹停，同时保持车道（别在滑行中溜到路肩上）
      if (v.speed < 8) {
        encountered = true;
        break;
      }
    } else {
      autopilot(70);
    }
    await sleep(100);
  }
  if (!encountered) {
    console.log(`  ⚠ 120s 内没能停在一只夜行者跟前（当前 ${host.view?.phase} · ${host.view?.signs} 号路牌），跳过遇袭检查`);
  } else {
    autopilot(0);
    await host.until(() => host.view!.monsters.some((m) => m.mode === 'hunt' || m.mode === 'latched'), '停车后被惊动', 10_000);
    check(host.view!.monsters.some((m) => m.mode === 'hunt' || m.mode === 'latched'), '车一停稳，附近的夜行者冲了过来');
    await sleep(2500);
    console.log(`  ℹ 两秒半后的状态：${host.view!.monsters.some((m) => m.mode === 'latched') ? '已扒住车门' : '仍在追（距离较远）'}`);
    // 开起来甩脱：带车道保持地加速，直到过了甩脱线（跟着夜行者的速度走，越往后越高）
    const escape = host.view!.escapeSpeed;
    const escStart = Date.now();
    while (host.view!.speed < escape + 3 && host.view?.phase === 'driving' && Date.now() - escStart < 12_000) {
      autopilot(70);
      await sleep(100);
    }
    check(host.view!.phase === 'gameover' || host.view!.speed >= escape, `重新开起来（${host.view!.speed.toFixed(0)} km/h）`);
    check(
      host.view!.monsters.every((m) => m.mode !== 'latched'),
      `车速过 ${escape} km/h 的甩脱线后没有扒着的夜行者`,
    );
    drive(0, false, false);
  }

  if (host.view?.phase === 'driving') {
    host.send({ t: 'vAbort' });
    await host.until(() => host.view?.phase === 'gameover', '房主终止');
    check(host.view!.result?.reason === 'abort', '终局原因：abort');
  } else {
    console.log(`  ℹ 对局已提前结束（${host.view?.result?.reason}），跳过房主终止检查`);
  }
  check(host.errors.length === 0 && guest.errors.length === 0, '全程无错误帧');

  host.send({ t: 'vRematch' });
  await host.until(() => host.view?.phase === 'driving' && host.view.startedAt !== v1.startedAt, '再来一局重新上路');
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
