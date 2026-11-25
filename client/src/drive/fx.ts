/**
 * 勿停 · 帧间平滑与特效状态（纯逻辑，无 three/React 依赖，node 可单测）
 *
 * 视图 10Hz、渲染 60Hz，中间的全部插值都在这里：
 * - 转向预测：本地按键一到就按与服务端同源的方程（stepSteering）积分；另维护一个「幽灵」——
 *   把服务端最后一帧状态按**服务端已知的输入**继续积分得到的基线，本地预测每帧向它靠拢。
 *   我的按键在服务端确认之前由预测领先（打方向不糊不延迟），确认之后两者完全一致、稳态误差为零；
 *   服务端报来真实修正时车平滑贴过去而不是瞬移，也不会被拉向已经过期的上一帧值。
 * - 里程按速度外推；表针/方向盘/尾距平滑；
 * - 怪物位置插值：按服务端给的速度外推 + 向「目标继续外推」的位置校正；
 * - 特效：撞击震屏红闪、过路牌闪现、爬窗红光、路肩颠簸、被扒车时的持续震动，全部按帧衰减。
 */
import { curvatureAt, stepSteering, type DriveView, type DriveSide, type DriveViewMonster } from '@shared/driveProtocol';

/** 怪物在客户端的跟踪状态（位置为插值后的当前值） */
export interface MonsterTrack {
  id: number;
  at: number;
  lat: number;
  vs: number;
  vx: number;
  mode: DriveViewMonster['mode'];
  side: DriveSide | null;
  climbLeft: number | null;
  /** 服务端最近一次下发的位置及其到达时刻（校正目标） */
  targetAt: number;
  targetLat: number;
  targetAtTime: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** 预测向幽灵靠拢的速率（/s） */
const RECONCILE_RATE = 6;
/** 里程靠拢的速率（/s） */
const POS_RATE = 9;

export class DriveFx {
  /** 平滑后的渲染里程 / 横向位置 / 车头相对角 */
  pos = 0;
  lateral = 0;
  rel = 0;
  /** 里程外推用的车速（服务端原值）与表针用的平滑车速（km/h） */
  speed = 0;
  speedSmooth = 0;
  /** 方向盘偏转 −1..1（平滑） */
  wheel = 0;
  /** 平滑后的猎影尾距 0-100 */
  gap = 100;
  /** 撞击震屏强度 0-1 */
  shake = 0;
  /** 撞击红闪强度 0-1 */
  flash = 0;
  /** 过路牌闪现 0-1 与号码 */
  signFlash = 0;
  signNo = 0;
  /** 左/右侧爬窗红光 0-1（按调度来的窗爬者） */
  crawlL = 0;
  crawlR = 0;
  /** 左/右侧是否有夜行者扒着（0 或 1）——与爬窗红光一起决定那一侧的红色警示 */
  maulL = 0;
  maulR = 0;
  /** 被惊动 / 扒着车的夜行者数量 */
  hunting = 0;
  latched = 0;
  /** 本地按下的转向（−1/0/1，预测用；由页面按键直接写入） */
  steerLocal: -1 | 0 | 1 = 0;
  readonly monsters = new Map<number, MonsterTrack>();

  private hitShake = 0;
  /** 预测体（本地按键立刻生效） */
  private predLat = 0;
  private predRel = 0;
  private predPos = 0;
  /** 服务端幽灵（只按服务端已知输入外推的基线） */
  private ghostLat = 0;
  private ghostRel = 0;
  private ghostPos = 0;
  /** 服务端最近一帧 */
  private basePos = 0;
  private baseSpeed = 0;
  private baseLat = 0;
  private baseRel = 0;
  private baseGap = 100;
  private serverSteer: -1 | 0 | 1 = 0;
  private serverMySteer: -1 | 0 | 1 = 0;
  private lastSigns = -1;
  private lastDur = -1;
  private lastHunting = 0;
  private startedAt = -1;
  private lastFrameAt = 0;

  /** 新视图到达：更新基准 + 检测事件跳变（state 帧全量重发，按数值判变化，不能按对象身份） */
  onView(view: DriveView, now: number): void {
    if (view.startedAt !== this.startedAt) {
      // 新一局：全部直接对齐，特效清零
      this.startedAt = view.startedAt;
      this.pos = view.pos;
      this.predLat = this.ghostLat = view.lateral;
      this.predRel = this.ghostRel = view.rel;
      this.predPos = this.ghostPos = view.pos;
      this.lateral = view.lateral;
      this.rel = view.rel;
      this.speed = view.speed;
      this.speedSmooth = view.speed;
      this.gap = view.gap;
      this.wheel = 0;
      this.hitShake = 0;
      this.shake = 0;
      this.flash = 0;
      this.signFlash = 0;
      this.monsters.clear();
      this.lastSigns = view.signs;
      this.lastDur = view.durability;
      this.lastHunting = 0;
    }
    this.basePos = view.pos;
    this.baseSpeed = view.speed;
    this.baseLat = view.lateral;
    this.baseRel = view.rel;
    this.baseGap = view.gap;
    // 幽灵重新对齐服务端：视图里带的转向输入是服务端已经确认的
    this.ghostLat = view.lateral;
    this.ghostRel = view.rel;
    this.ghostPos = view.pos;
    this.serverSteer = view.steerIn;
    this.serverMySteer = view.myInputs?.steer ?? 0;

    if (view.signs > this.lastSigns) {
      this.signFlash = 1;
      this.signNo = view.signs;
      this.lastSigns = view.signs;
    }
    if (view.durability < this.lastDur) {
      this.hitShake = 1;
      this.flash = 1;
    }
    this.lastDur = view.durability; // 搜到修补工具：只刷新基线，不闪光
    this.lastHunting = this.hunting;

    const glow = (w: DriveView['windows']['L']): number => (w.climbLeft != null ? 1 : w.warn ? 0.55 : 0);
    this.crawlL = glow(view.windows.L);
    this.crawlR = glow(view.windows.R);

    // 怪物跟踪：新出现的直接落位，已在跟踪的更新目标（位置由 frame 插值过去）
    const seen = new Set<number>();
    let hunting = 0;
    let latched = 0;
    for (const m of view.monsters) {
      seen.add(m.id);
      if (m.mode === 'hunt') hunting++;
      if (m.mode === 'latched') latched++;
      const t = this.monsters.get(m.id);
      if (t) {
        t.mode = m.mode;
        t.side = m.side;
        t.climbLeft = m.climbLeft;
        t.vs = m.vs;
        t.vx = m.vx;
        t.targetAt = m.at;
        t.targetLat = m.lat;
        t.targetAtTime = now;
      } else {
        this.monsters.set(m.id, {
          id: m.id,
          at: m.at,
          lat: m.lat,
          vs: m.vs,
          vx: m.vx,
          mode: m.mode,
          side: m.side,
          climbLeft: m.climbLeft,
          targetAt: m.at,
          targetLat: m.lat,
          targetAtTime: now,
        });
      }
    }
    for (const id of [...this.monsters.keys()]) if (!seen.has(id)) this.monsters.delete(id);
    this.hunting = hunting;
    this.latched = latched;
    this.maulL = view.monsters.some((m) => m.mode === 'latched' && m.side === 'L') ? 1 : 0;
    this.maulR = view.monsters.some((m) => m.mode === 'latched' && m.side === 'R') ? 1 : 0;
  }

  /** 被惊动的夜行者数量是否刚刚增加（页面据此放尖啸音；看过即清） */
  takeHuntPulse(): boolean {
    if (this.hunting > this.lastHunting) {
      this.lastHunting = this.hunting;
      return true;
    }
    this.lastHunting = this.hunting;
    return false;
  }

  /** 每个渲染帧推进（dtMs 为距上一帧的毫秒） */
  frame(now: number, dtMs: number, view: DriveView): void {
    const dt = Math.min(0.1, Math.max(0.0005, dtMs / 1000));
    const stalled = now - this.lastFrameAt > 4000;
    this.lastFrameAt = now;
    // 预测用的转向：我的本地按键 + 其他驾驶员的服务端输入（把我自己那份换成实时的）
    const steerPred = clamp(this.steerLocal + this.serverSteer - this.serverMySteer, -1, 1) as -1 | 0 | 1;
    if (stalled) {
      // 后台页 rAF 暂停/长时间没有帧：直接对齐，不做大步追赶（否则回前台狂飘）
      this.pos = this.predPos = this.ghostPos = this.basePos;
      this.predLat = this.ghostLat = this.baseLat;
      this.predRel = this.ghostRel = this.baseRel;
      this.lateral = this.baseLat;
      this.rel = this.baseRel;
    } else {
      const run = this.baseSpeed / 3.6;
      // 幽灵：服务端最后一帧状态 + 服务端已知的输入，继续往下积分
      this.ghostPos += run * dt;
      const ghost = { lateral: this.ghostLat, rel: this.ghostRel, speed: this.baseSpeed };
      stepSteering(ghost, this.serverSteer, curvatureAt(view.curves, this.ghostPos), dt);
      this.ghostLat = ghost.lateral;
      this.ghostRel = ghost.rel;
      // 预测：同方程，但用含本地按键的输入
      this.predPos += run * dt;
      const body = { lateral: this.predLat, rel: this.predRel, speed: this.baseSpeed };
      stepSteering(body, steerPred, curvatureAt(view.curves, this.predPos), dt);
      this.predLat = body.lateral;
      this.predRel = body.rel;
      // 向幽灵靠拢：消掉累计误差；按键尚未被服务端确认的那点领先量只会被轻微削减
      const k = Math.min(1, dt * RECONCILE_RATE);
      this.predLat += (this.ghostLat - this.predLat) * k;
      this.predRel += (this.ghostRel - this.predRel) * k;
      this.predPos += (this.ghostPos - this.predPos) * Math.min(1, dt * POS_RATE);
      this.lateral = this.predLat;
      this.rel = this.predRel;
      this.pos = this.predPos;
      this.wheel += (steerPred - this.wheel) * Math.min(1, dt * 10);
      this.speedSmooth += (this.baseSpeed - this.speedSmooth) * Math.min(1, dt * 8);
      this.gap += (this.baseGap - this.gap) * Math.min(1, dt * 6);
    }
    this.speed = this.baseSpeed;

    // 特效衰减
    this.hitShake = Math.max(0, this.hitShake - dt * 3.2);
    this.flash = Math.max(0, this.flash - dt * 2.6);
    this.signFlash = Math.max(0, this.signFlash - dt * 1.4);
    // 持续震动：路肩颠簸（随车速）、被扒车（更猛）
    const rumble = view.offRoad ? Math.min(0.35, 0.08 + (this.speedSmooth / 120) * 0.4) : 0;
    const mauled = this.latched > 0 ? 0.28 : 0;
    this.shake = Math.max(this.hitShake, rumble, mauled);

    // 怪物插值：按速度外推 + 向「服务端目标继续外推」的位置校正
    for (const m of this.monsters.values()) {
      m.at += m.vs * dt;
      m.lat += m.vx * dt;
      if (m.mode === 'thrown') {
        m.vs = Math.max(0, m.vs - 14 * dt); // 与服务端同一套减速近似
        m.vx *= Math.exp(-3 * dt);
      }
      const since = Math.min(1.5, Math.max(0, (now - m.targetAtTime) / 1000));
      const c = Math.min(1, dt * 10);
      m.at += (m.targetAt + m.vs * since - m.at) * c;
      m.lat += (m.targetLat + m.vx * since - m.lat) * c;
    }
  }
}
