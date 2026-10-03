/**
 * 血色模式端到端冒烟：2 个机器人从初始构筑打到车票达标获胜。
 * 运行前先启动服务器（ws://localhost:3000/ws）。
 */
import WebSocket from 'ws';
import { bestFive } from '../src/blood/engine';
import { BLOOD_MARKET_BY_ID } from '@shared/bloodCards';
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
      // 连接被服务端关闭（限速断开 / 房间解散 / 服务端重启）：不记录的话只会看到"等待超时"
      ws.on('close', (code: number, reason: Buffer) => {
        this.errors.push(`连接关闭 code=${code} reason=${reason.toString() || '-'}`);
        console.error(`  ⚠️ [${this.name}] 连接关闭 code=${code} reason=${reason.toString() || '-'}`);
      });
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
      // 实时打印被拒绝的动作：否则只有超时那一刻才知道"有事发生过"
      console.error(`  ⚠️ [${this.name}] 服务端拒绝：${em.code} ${em.msg}`);
      // 退避 600ms：原为 150ms，一旦某个动作被持续拒绝就会变成 ~6.6 条/秒的消息洪泛，
      // 触发服务端的每连接限速（超速丢弃、持续洪泛则断开）→ 连接被掐、视图定格在最后一次 state，
      // 表现为"等待超时"而看不出真正原因。
      setTimeout(() => this.maybeAct(), 600);
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
      const timer = setTimeout(() => {
        // 超时消息带上最后看到的阶段与提示：否则只能看到一个"等待超时"，无从判断卡在哪
        const v = this.view;
        reject(
          new Error(
            `${this.name} 等待超时（最后状态：phase=${v?.phase ?? '?'} prompt=${v?.prompt?.k ?? '?'} ` +
              `票=${v?.players.map((p) => p.tickets).join('/') ?? '?'}）`,
          ),
        );
      }, timeoutMs);
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
    // 250ms（≈4 条/秒）而非 60ms（≈10-16 条/秒）：服务端每连接限速是 TokenBucket(6, 30)，
    // 超速丢弃、持续洪泛直接 close(4009,"flood")。机器人抢在限速之上行动会被服务端断开，
    // 视图定格在最后一次 state —— 表现为"等待超时"，且每次卡在不同阶段（真正原因被掩盖）。
    // 真人远慢于此，故这里放慢恰恰更接近真实客户端行为。
    setTimeout(() => {
      this.acting = false;
      try {
        this.actOnce();
      } catch (e) {
        // 未处理的提示/非法动作：立刻以清晰信息退出，而不是让整场卡到超时
        console.error('❌ 机器人动作失败:', (e as Error).message);
        process.exit(1);
      }
    }, 250);
  }

  private handIds(): string[] {
    return this.view!.me.hand.map((c) => c.id);
  }

  private discardIds(): string[] {
    return this.view!.me.discard.map((c) => c.id);
  }

  /**
   * 与服务端 isChipInsertable 同口径挑芯片宿主：只按"这张牌还没芯片"会挑到非法目标
   * （点数芯片把牌改出 2-14 范围、禁插王的芯片等），服务端会以 BAD_INSERT 拒绝。
   * 购买（指定 insertInto）与 insertChip 决策两处共用。
   */
  private insertableFor(defId: string | null | undefined): { id: string }[] {
    const def = BLOOD_MARKET_BY_ID.get(defId ?? '');
    const eff = def?.effect;
    return (this.view?.me.discard ?? []).filter((c) => {
      if (c.chipIds.length > 0) return false;
      if (def?.noJoker && c.s == null) return false;
      if (eff?.k === 'rankMod') {
        if (c.s == null) return false; // 点数芯片不得插入王
        const rank = c.r + eff.mod;
        if (rank < 2 || rank > 14) return false;
      }
      return true;
    });
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
        // 初始构筑每轮最多删 4 张（BLOOD_SETUP_KEEP）：按 30% 概率从 8 张里抽会偶尔超上限，
        // 被服务端以 TOO_MANY 拒绝（二项分布下约 6% 概率），故显式截断
        const removed = this.view!.me.setupHand
          .filter(() => r() < 0.3)
          .slice(0, 4)
          .map((c) => c.id);
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
        // 对决阶段的宣告窗口：**只有消磁枪**能被 bUseItem 接受（其余道具在 bUseItem 里会
        // BAD_TIMING）。原脚本直接拿 items[0] 发，买到荷官证时会被拒到 60 秒超时。
        const demag = v.me.items.find((i) => i.defId === 'demag');
        if (demag && r() < 0.5) this.sendAct({ t: 'bUseItem', itemId: demag.id });
        else this.sendAct({ t: 'bUseItem', itemId: null });
        return;
      }
      case 'itemAsk': {
        // 阶段边界（换牌结束 / 对决前）的道具询问：应答是 bItemAsk{use}，
        // **不是** bUseItem（后者只在对决阶段有效，会抛 BAD_PHASE）
        this.sendAct({ t: 'bItemAsk', use: r() < 0.5 });
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
            const validTargets = this.insertableFor(slot.m.defId);
            const insertInto = defKind === 'chip' && validTargets.length > 0 ? validTargets[0].id : undefined;
            this.sendAct({ t: 'bBuy', slot: slot.i, insertInto });
            return;
          }
        }
        this.sendAct({ t: 'bPassBuy' });
        return;
      }
      case 'insertChip': {
        const valid = this.insertableFor(v.prompt.defId);
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
      case 'crownBid': {
        // 特权证暗标竞拍（选将之后、构筑之前）：以前漏了这个分支，default 静默什么都不做，
        // 于是每局开局都干等 60 秒超时托管 —— 整场跑不完 180 秒的等待上限。
        this.sendAct({ t: 'bCrownBid', bid: 1 });
        return;
      }
      case 'reorg': {
        this.sendAct({ t: 'bReorg', choice: r() < 0.5 ? 'reshuffle' : 'blood' });
        return;
      }
      case 'wait':
        // 轮不到我 / 无需动作：actOnce 是延迟 60ms 后执行的，期间局势可能已变（对方先动了），
        // 因此这里必须容忍 wait，否则会把正常的"等别人"误判成未处理提示。
        return;
      default:
        // 不再静默 return：未处理的提示会让这一局卡到超时才失败，且看不出原因。
        // 直接抛错把提示类型与当前阶段暴露出来（引擎新增交互时这里会立刻红）。
        throw new Error(`未处理的提示类型：${v.prompt.k}（阶段 ${v.phase}）—— 请补上对应动作`);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 便于失败时统一打印各机器人收到的服务端反馈 */
const BOTS: BloodBot[] = [];

async function main(): Promise<void> {
  console.log('== 血色模式 2 人局端到端 ==');
  const a = new BloodBot('血甲');
  BOTS.push(a);
  await a.connect();
  a.send({ t: 'create', name: '血甲', maxPlayers: 2, mode: 'blood' });
  await a.waitHello();
  await sleep(400);
  const code = a.code;
  console.log(`房间 ${code}`);

  const b = new BloodBot('血乙');
  BOTS.push(b);
  await b.connect();
  b.send({ t: 'join', name: '血乙', code });
  await b.waitHello();
  await sleep(500);

  a.send({ t: 'start' });
  console.log('开局，等待整场结束（2 人局目标 24 车票）…');
  // 进度输出：整场耗时由**设计上的对决演示节奏**主导（每回合数秒），通常需要几分钟；
  // 不打印的话看起来像卡死了。每 15 秒报一次当前阶段与票数。
  const progress = setInterval(() => {
    const v = a.view;
    if (!v) return;
    const seats = v.players.map((p) => `${p.name}:${p.tickets}票`).join(' / ');
    console.log(`  … phase=${v.phase} 回合=${v.round} ${seats}`);
  }, 15_000);
  // 预算 600 秒：原为 180 秒，实测只能打到 18/24 票就被判超时
  //（不是卡住 —— 对决演示等节奏延迟是设计使然）
  await Promise.all([
    a.waitState((v) => v.phase === 'gameover' && !!v.final, 600_000),
    b.waitState((v) => v.phase === 'gameover' && !!v.final, 600_000),
  ]).finally(() => clearInterval(progress));

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
  // 把两个机器人收集到的服务端拒绝/连接关闭一并打出来：
  // 「等待超时」本身几乎总是**症状**（动作被拒 → 重试 → 被限速断开 / 状态机卡住），
  // 真正的线索在这些记录里。
  for (const bot of BOTS) {
    if (bot.errors.length === 0) continue;
    console.error(`  ⚠️ [${bot.name}] 期间收到的服务端反馈（最近 10 条）：`);
    for (const line of bot.errors.slice(-10)) console.error(`     ${line}`);
  }
  process.exit(1);
});
