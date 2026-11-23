/**
 * 勿停 · 车内仪表视角渲染（无 React 依赖，纯逻辑，node 可单测）
 *
 * 伪 3D 直路：单参数透视 yFrac = camD/(camD+dist)——dist=0 落在画布底、∞ 收敛到地平线。
 * 横向同理随 yFrac 收缩，车道中心与世界路肩的横向米数换算成像素。
 * 夜路能见度：车灯开 ~200m、关 ~90m；瞭望探头 +100m。事件精灵按同一透视缩放，
 * 出雾即现（远处先黑，靠近才看清——「不停车就看不见路」的恐怖感来源）。
 * 仪表盘：速度表针、油表、耐久灯、双窗状态、后视镜红点（猎影逼近度，从不渲染实体）。
 *
 * 帧率与手感（本轮优化）：
 * - DriveFx：视图 10Hz、渲染 60Hz 之间的全部平滑——里程外推+一阶跟随（不再回跳）、
 *   换道横向偏移渐移（消失点固定、近端偏移=车真的在横移）、表针惯量、
 *   撞击震屏/红闪、爬窗侧红光、过路牌闪现（都由事件跳变触发、按帧衰减）；
 * - SceneCache：夜空（渐变+星星）与仪表盘底板是每帧不变的静态层，按尺寸缓存离屏画布，
 *   60fps 下省掉每帧的渐变对象创建与大面积填充；
 * - 路边反光柱（左红右白）与高速风线给足速度感；尸群蠕动、搜掠点呼吸、站牌灯闪烁全部走时间参数。
 */

import type { DriveEvent, DriveView } from '@shared/driveProtocol';
import { DRIVE_MAX_SPEED } from '@shared/driveProtocol';

/** 世界尺度（米）：三车道，车道宽 3.5m，路缘到中心 5.25m */
export const ROAD_HALF_M = 5.25;
export const LANE_W_M = 3.5;
/** 透视焦距（米）：越大视野越平 */
export const CAM_D_M = 6;
/** 地平线占画布高度比例（挡风玻璃上沿之下） */
export const HORIZON_FRAC = 0.42;
/** 车灯开/关的能见距离（米）；瞭望探头额外加成 */
export const DRAW_DIST_LAMP_ON = 200;
export const DRAW_DIST_LAMP_OFF = 90;
export const DRAW_DIST_SPOT_BONUS = 100;
/** 换道横向偏移的屏幕衰减系数（1=真实透视，0.6=略收着走不晕） */
const LANE_SHIFT_DAMP = 0.6;
/** 路边反光柱间距（米） */
export const POLE_GAP_M = 30;

/** 车道中心的横向米数（0=左 1=中 2=右） */
export function laneCenterMeters(lane: number): number {
  return (Math.min(2, Math.max(0, lane)) - 1) * LANE_W_M;
}

/** 路肩搜掠点/加油站的横向米数（路缘外 1.4m） */
export function shoulderMeters(side: 'L' | 'R'): number {
  return (side === 'L' ? -1 : 1) * (ROAD_HALF_M + 1.4);
}

/** 透视占比：dist=0 → 1（画布底），dist→∞ → 0（地平线） */
export function persp(dist: number): number {
  return CAM_D_M / (CAM_D_M + Math.max(0, dist));
}

/** 距离 dist 处的屏幕 y（画布 CSS 高 h） */
export function yFor(dist: number, h: number, horizonY: number): number {
  return horizonY + (h - horizonY) * persp(dist);
}

/** 距离 dist 处的像素/米 横向比例 */
export function metersToPx(dist: number, w: number): number {
  return ((w * 0.46) / ROAD_HALF_M) * persp(dist);
}

/** 车道中心在 dist 处的屏幕 x */
export function laneCenterX(lane: number, dist: number, w: number, cx: number): number {
  return cx + laneCenterMeters(lane) * metersToPx(dist, w);
}

/** 速度表针角度：0-120km/h → -120°..+120°（0° 朝上） */
export function needleAngle(speed: number): number {
  return (Math.min(DRIVE_MAX_SPEED, Math.max(0, speed)) / DRIVE_MAX_SPEED) * 240 - 120;
}

/** 当前能见距离（米） */
export function drawDistOf(lamp: boolean, spot: boolean): number {
  return (lamp ? DRAW_DIST_LAMP_ON : DRAW_DIST_LAMP_OFF) + (spot ? DRAW_DIST_SPOT_BONUS : 0);
}

/** 事件在世界坐标里的长度（米） */
export function eventLen(ev: DriveEvent): number {
  return ev.kind === 'swarm' ? 40 : ev.kind === 'station' ? 30 : 0;
}

/* ---------------- 帧间平滑与特效（视图 10Hz → 渲染 60Hz 的全部插值） ---------------- */

/** 渲染特效状态（DriveFx 实现此结构，paintScene 只消费它） */
export interface SceneFx {
  /** 平滑后的渲染里程（视图 pos 外推 + 一阶跟随；提供时优先于 input.renderPos） */
  pos: number;
  /** 平滑后的车辆横向偏移（米，路中心为 0；正=车在右侧） */
  laneOffset: number;
  /** 平滑后的表针角度（度） */
  needle: number;
  /** 撞击震屏强度 0-1（按帧衰减） */
  shake: number;
  /** 撞击红闪强度 0-1（按帧衰减） */
  flash: number;
  /** 左/右侧爬窗红光 0-1（由视图窗状态实时驱动） */
  crawlL: number;
  crawlR: number;
  /** 过路牌闪现 0-1 与号码（按帧衰减） */
  signFlash: number;
  signNo: number;
}

const lerp = (cur: number, target: number, t: number): number => cur + (target - cur) * Math.min(1, t);

/** 帧间平滑器：onView 在视图到达时喂基准，frame 在每个渲染帧推进 */
export class DriveFx implements SceneFx {
  laneOffset = 0;
  needle = -120;
  shake = 0;
  flash = 0;
  crawlL = 0;
  crawlR = 0;
  signFlash = 0;
  signNo = 0;
  /** 平滑里程（外推目标的一阶跟随） */
  pos = 0;
  private basePos = 0;
  private baseSpeed = 0;
  private baseAt = 0;
  private lastSigns = -1;
  private lastDur = -1;
  private startedAt = -1;
  private lastFrameAt = 0;

  /** 新视图到达：更新外推基准 + 检测事件跳变（撞击/过路牌）；后台长停帧由 frame 兜底对齐 */
  onView(view: DriveView, now: number): void {
    if (view.startedAt !== this.startedAt) {
      // 新一局：全部直接对齐（里程/车道/表针归位，特效清零）
      this.startedAt = view.startedAt;
      this.pos = view.pos;
      this.laneOffset = laneCenterMeters(view.lane);
      this.needle = needleAngle(view.speed);
      this.shake = 0;
      this.flash = 0;
      this.signFlash = 0;
      this.lastSigns = view.signs;
      this.lastDur = view.durability;
    }
    this.basePos = view.pos;
    this.baseSpeed = view.speed;
    this.baseAt = now;
    // 事件跳变（state 帧全量重发，按数值判变化，不能按对象身份）
    if (view.signs > this.lastSigns) {
      this.signFlash = 1;
      this.signNo = view.signs;
      this.lastSigns = view.signs;
    }
    if (view.durability < this.lastDur) {
      this.shake = 1;
      this.flash = 1;
      this.lastDur = view.durability;
    } else if (view.durability > this.lastDur) {
      this.lastDur = view.durability; // 搜到修补工具：不闪光，只刷新基线
    }
    // 爬窗红光：预警半亮常驻脉动、爬入计时全亮急闪
    const glow = (w: DriveView['windows']['L']): number => (w.climbLeft != null ? 1 : w.warn ? 0.55 : 0);
    this.crawlL = glow(view.windows.L);
    this.crawlR = glow(view.windows.R);
  }

  /** 每个渲染帧推进（dtMs 为距上一帧的毫秒） */
  frame(now: number, dtMs: number, view: DriveView): void {
    const dt = Math.min(0.1, Math.max(0.0005, dtMs / 1000));
    // 后台页 rAF 暂停/网络长时间无帧：直接对齐，不做大步追赶（否则回前台狂飘）
    if (now - this.lastFrameAt > 4000) {
      this.pos = this.basePos + (this.baseSpeed / 3.6) * Math.min(2, (now - this.baseAt) / 1000);
      this.baseAt = now;
      this.laneOffset = laneCenterMeters(view.lane);
    } else {
      const estimate = this.basePos + (this.baseSpeed / 3.6) * Math.max(0, (now - this.baseAt) / 1000);
      this.pos = lerp(this.pos, estimate, dt * 9);
      this.laneOffset = lerp(this.laneOffset, laneCenterMeters(view.lane), dt * 7);
    }
    this.needle = lerp(this.needle, needleAngle(view.speed), dt * 6);
    this.shake = Math.max(0, this.shake - dt * 3.2);
    this.flash = Math.max(0, this.flash - dt * 2.6);
    this.signFlash = Math.max(0, this.signFlash - dt * 1.4);
    this.lastFrameAt = now;
  }
}

/* ---------------- 静态层缓存（夜空 / 仪表盘底板，按尺寸重建） ---------------- */

export interface SceneCache {
  w: number;
  h: number;
  dpr: number;
  /** 夜空+星星+地面（与能见距离/车灯无关，可整层复用） */
  sky: HTMLCanvasElement | null;
  /** 仪表盘底板（面板底色/上边框/表盘弧线） */
  dash: HTMLCanvasElement | null;
}

export function createSceneCache(): SceneCache {
  return { w: 0, h: 0, dpr: 1, sky: null, dash: null };
}

function ensureCache(cache: SceneCache, w: number, h: number, dpr: number, horizonY: number): void {
  if (cache.w === w && cache.h === h && cache.dpr === dpr && cache.sky && cache.dash) return;
  cache.w = w;
  cache.h = h;
  cache.dpr = dpr;
  const mk = (): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    return c;
  };
  // 夜空：渐变 + 固定星点（确定性伪随机，不闪烁）
  const sky = mk();
  const sctx = sky.getContext('2d');
  if (sctx) {
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = sctx.createLinearGradient(0, 0, 0, horizonY);
    g.addColorStop(0, '#04050a');
    g.addColorStop(1, '#0a0c14');
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, w, horizonY);
    sctx.fillStyle = '#c9d2e8';
    for (let i = 0; i < 46; i++) {
      const sx = ((i * 173 + 41) % 997) / 997 * w;
      const sy = ((i * 89 + 17) % 523) / 523 * horizonY * 0.72;
      const r = 0.5 + ((i * 31) % 10) / 10 * 0.7;
      sctx.globalAlpha = 0.18 + ((i * 13) % 10) / 10 * 0.3;
      sctx.fillRect(sx, sy, r, r);
    }
    sctx.globalAlpha = 1;
    sctx.fillStyle = '#0a0b10';
    sctx.fillRect(0, horizonY, w, h - horizonY);
  }
  cache.sky = sky;
  // 仪表盘底板
  const dash = mk();
  const dctx = dash.getContext('2d');
  if (dctx) {
    const top = h * 0.72;
    const dh = h - top;
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dctx.fillStyle = '#101014';
    dctx.fillRect(0, top, w, dh);
    dctx.strokeStyle = '#2a2b33';
    dctx.lineWidth = 1;
    dctx.beginPath();
    dctx.moveTo(0, top);
    dctx.lineTo(w, top);
    dctx.stroke();
    // 表盘弧线（静态部分）
    const gx = Math.min(w * 0.2, 110);
    const gr = Math.min(dh * 0.26, 34);
    const gy = top + dh * 0.4;
    dctx.lineWidth = 2;
    dctx.beginPath();
    dctx.arc(gx, gy, gr, Math.PI * (1 + 1 / 3), Math.PI * (2 - 1 / 3), false);
    dctx.stroke();
  }
  cache.dash = dash;
}

/* ---------------- 配色（深夜黑 + 血色红点缀） ---------------- */
const C = {
  ground: '#0a0b10',
  road: '#16171d',
  edge: '#43464f',
  dash: '#565a66',
  barrier: '#c23b3b',
  barrierStripe: '#e8e4da',
  swarm: '#7e2020',
  lootFuel: '#d9a13c',
  lootRepair: '#58a55c',
  station: '#3d6f8e',
  stationLight: '#e8c26a',
  mirror: '#0a0a0e',
  red: '#e03131',
  gauge: '#2a2b33',
  needle: '#e8e4da',
  fuel: '#d9a13c',
  fuelLow: '#e03131',
  ok: '#58a55c',
  warn: '#e0a031',
  text: '#9a9da8',
  poleRed: '#c23b3b',
  poleWhite: '#c9ccd6',
};

/** 事件精灵：远处先没入黑暗，靠近才浮现（雾里出形） */
function eventAlpha(rel: number, drawDist: number): number {
  if (rel < -5 || rel > drawDist) return 0;
  const t = rel / drawDist;
  return Math.min(1, Math.max(0.15, 1.35 - t * 1.35));
}

export interface SceneInput {
  view: DriveView;
  /** 渲染里程（平滑后的跟随值；由 DriveFx 推进） */
  renderPos: number;
  /** 当前时刻（ms，闪烁/蠕动/呼吸动画用） */
  now: number;
  /** 能见距离（车灯/探头决定） */
  drawDist: number;
  /** 帧间平滑与特效（缺省=全默认：现有测试与降级路径） */
  fx?: SceneFx;
}

/** 画一个伪 3D 夜路场景（ctx 已按 DPR 设好 transform；w/h 为 CSS 尺寸） */
export function paintScene(ctx: CanvasRenderingContext2D, w: number, h: number, input: SceneInput, cache?: SceneCache): void {
  const { view, now, drawDist } = input;
  const fx = input.fx;
  const renderPos = fx ? fx.pos : input.renderPos;
  const cx = w / 2;
  const horizonY = h * HORIZON_FRAC;
  const dashY = h * 0.72; // 仪表盘上沿

  // 静态层（提供 cache 且尺寸匹配时整层复用）
  if (cache) ensureCache(cache, w, h, cache.dpr || 1, horizonY);
  const putStatic = (layer: HTMLCanvasElement | null): void => {
    if (layer) ctx.drawImage(layer, 0, 0, w, h);
  };

  // 撞击震屏：只摇场景，仪表盘稳住（驾驶位视角：路在晃、仪表贴在车上）
  const shakeDx = fx ? Math.sin(now / 17) * 7 * fx.shake : 0;
  const shakeDy = fx ? Math.cos(now / 29) * 5 * fx.shake : 0;

  // 换道横向偏移：消失点固定、近端随车横移（车道线与世界精灵同步偏）
  const laneOff = fx ? fx.laneOffset : 0;
  const xOf = (dist: number, lateralM: number): number =>
    cx + lateralM * metersToPx(dist, w) - laneOff * metersToPx(dist, w) * LANE_SHIFT_DAMP;

  ctx.save();
  ctx.translate(shakeDx, shakeDy);

  /* 夜空 + 地面（静态层；缓存不可用时直接画） */
  if (cache?.sky) {
    putStatic(cache.sky);
  } else {
    const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
    sky.addColorStop(0, '#04050a');
    sky.addColorStop(1, '#0a0c14');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizonY);
    ctx.fillStyle = C.ground;
    ctx.fillRect(0, horizonY, w, dashY - horizonY);
  }

  /* 路面梯形（近宽远窄） */
  const pFar = persp(drawDist);
  const roadHalfNear = cx * 0.92;
  const roadHalfFar = roadHalfNear * (pFar / persp(0));
  const xNear = xOf(0, 0);
  const xFar = xOf(drawDist, 0);
  ctx.fillStyle = C.road;
  ctx.beginPath();
  ctx.moveTo(xNear - roadHalfNear, dashY);
  ctx.lineTo(xFar - roadHalfFar, horizonY);
  ctx.lineTo(xFar + roadHalfFar, horizonY);
  ctx.lineTo(xNear + roadHalfNear, dashY);
  ctx.closePath();
  ctx.fill();

  /* 车灯锥形光束（灯开时才有；两束从引擎盖前缘汇聚向远处） */
  if (view.lamp) {
    const beam = ctx.createLinearGradient(0, dashY, 0, horizonY);
    beam.addColorStop(0, 'rgba(232,214,160,0.10)');
    beam.addColorStop(1, 'rgba(232,214,160,0)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(xNear - roadHalfNear * 0.9, dashY);
    ctx.lineTo(xFar - roadHalfFar * 0.4, horizonY + (dashY - horizonY) * 0.06);
    ctx.lineTo(xFar + roadHalfFar * 0.4, horizonY + (dashY - horizonY) * 0.06);
    ctx.lineTo(xNear + roadHalfNear * 0.9, dashY);
    ctx.closePath();
    ctx.fill();
  }

  /* 路缘实线 */
  ctx.strokeStyle = C.edge;
  ctx.lineWidth = 2;
  for (const side of [-1, 1] as const) {
    ctx.beginPath();
    ctx.moveTo(xOf(0, side * ROAD_HALF_M), dashY);
    ctx.lineTo(xOf(drawDist, side * ROAD_HALF_M), horizonY);
    ctx.stroke();
  }

  /* 车道虚线（按世界里程滚动；虚段 6m 实段 10m） */
  ctx.strokeStyle = C.dash;
  ctx.lineWidth = 2;
  const period = 16;
  const startK = Math.floor(renderPos / period);
  for (let k = startK; k < startK + Math.ceil(drawDist / period) + 1; k++) {
    const d0 = k * period - renderPos;
    if (d0 + 6 < 0 || d0 > drawDist) continue;
    for (const m of [-ROAD_HALF_M / 3 - LANE_W_M / 6, 0, ROAD_HALF_M / 3 + LANE_W_M / 6]) {
      const dA = Math.max(0, d0);
      const dB = Math.max(0, d0 + 6);
      ctx.beginPath();
      ctx.moveTo(xOf(dA, m), yFor(dA, h, horizonY));
      ctx.lineTo(xOf(dB, m), yFor(dB, h, horizonY));
      ctx.stroke();
    }
  }

  /* 路边反光柱（左红右白，30m 一根——速度感的主要来源之一） */
  const poleH = (d: number): number => Math.max(2, (h - horizonY) * persp(d) * 0.12);
  const poleK0 = Math.floor(renderPos / POLE_GAP_M);
  for (let k = poleK0; k < poleK0 + Math.ceil(drawDist / POLE_GAP_M) + 1; k++) {
    const d = k * POLE_GAP_M - renderPos;
    if (d < 0 || d > drawDist) continue;
    const a = eventAlpha(d, drawDist);
    if (a <= 0) continue;
    const y = yFor(d, h, horizonY);
    const ph = poleH(d);
    ctx.globalAlpha = a;
    for (const side of [-1, 1] as const) {
      const x = xOf(d, side * (ROAD_HALF_M + 1.2));
      ctx.strokeStyle = '#3a3d46';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - ph);
      ctx.stroke();
      ctx.fillStyle = side < 0 ? C.poleRed : C.poleWhite;
      ctx.fillRect(x - ph * 0.22, y - ph, ph * 0.44, ph * 0.3);
    }
    ctx.globalAlpha = 1;
  }

  /* 事件精灵 */
  for (const ev of view.events) {
    const len = eventLen(ev);
    const rel = ev.at - renderPos;
    if (rel > drawDist || rel + len < -4) continue;
    const alpha = eventAlpha(rel, drawDist);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    if (ev.kind === 'barrier') drawBarrier(ctx, w, h, horizonY, xOf, rel, ev);
    else if (ev.kind === 'swarm') drawSwarm(ctx, w, h, horizonY, xOf, rel, now);
    else if (ev.kind === 'loot') drawLoot(ctx, w, h, horizonY, xOf, rel, ev, now);
    else if (ev.kind === 'station') drawStation(ctx, w, h, horizonY, xOf, rel, ev, now);
    ctx.globalAlpha = 1;
  }

  /* 瞭望标记（队友打的绿色箭头，3 秒内可见） */
  for (const p of view.pings) {
    if (now - p.ts > 3000) continue;
    const rel = p.at - renderPos;
    if (rel < 0 || rel > drawDist) continue;
    const y = yFor(rel, h, horizonY);
    const x = xOf(rel, laneCenterMeters(p.lane));
    ctx.fillStyle = '#7ee081';
    const s = Math.max(4, 6 * persp(rel) * (h / 500));
    ctx.beginPath();
    ctx.moveTo(x - s, y - s * 2.2);
    ctx.lineTo(x + s, y - s * 2.2);
    ctx.lineTo(x, y - s * 0.9);
    ctx.closePath();
    ctx.fill();
  }

  /* 高速风线（>70km/h 逐渐出现，贴屏幕两侧的短划线） */
  const spd = view.speed;
  if (spd > 70) {
    const strength = Math.min(1, (spd - 70) / 50);
    ctx.strokeStyle = 'rgba(154,157,168,1)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 8; i++) {
      const phase = (i * 137 + now * (0.5 + spd / 60)) % 1000;
      const y = horizonY + ((phase % 700) / 700) * (dashY - horizonY);
      const x = i % 2 === 0 ? w * (0.03 + (i % 4) * 0.035) : w * (0.97 - ((i + 1) % 4) * 0.035);
      const len = 14 + (i % 3) * 10;
      ctx.globalAlpha = 0.05 + strength * 0.1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* 远处黑暗渐隐（雾里出形） */
  const fog = ctx.createLinearGradient(0, horizonY, 0, horizonY + (dashY - horizonY) * 0.55);
  fog.addColorStop(0, 'rgba(4,5,10,0.96)');
  fog.addColorStop(1, 'rgba(4,5,10,0)');
  ctx.fillStyle = fog;
  ctx.fillRect(0, horizonY, w, (dashY - horizonY) * 0.55);

  /* 车灯熄灭：整体再压暗一层（只留仪表和红点） */
  if (!view.lamp) {
    ctx.fillStyle = 'rgba(2,3,6,0.45)';
    ctx.fillRect(0, 0, w, dashY);
  }

  /* 爬窗侧红光（预警半亮 / 爬入急闪，只罩对应侧） */
  const glowAt = (side: -1 | 1, intensity: number): void => {
    if (intensity <= 0) return;
    const a = intensity * (0.5 + 0.5 * Math.sin(now / 110));
    const g = ctx.createLinearGradient(side < 0 ? 0 : w, 0, side < 0 ? w * 0.2 : w * 0.8, 0);
    g.addColorStop(0, `rgba(224,49,49,${(0.5 * a).toFixed(3)})`);
    g.addColorStop(1, 'rgba(224,49,49,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizonY * 0.5, w, dashY - horizonY * 0.5);
  };
  glowAt(-1, fx?.crawlL ?? 0);
  glowAt(1, fx?.crawlR ?? 0);

  /* 撞击红闪 */
  if (fx && fx.flash > 0) {
    ctx.fillStyle = `rgba(224,49,49,${(0.32 * fx.flash).toFixed(3)})`;
    ctx.fillRect(0, 0, w, dashY);
  }

  /* 过路牌闪现（里程碑正反馈） */
  if (fx && fx.signFlash > 0) {
    const a = Math.min(1, fx.signFlash * 1.3);
    ctx.globalAlpha = a;
    ctx.fillStyle = '#e8e4da';
    ctx.font = `700 ${Math.max(20, w / 14)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(`路牌 ${fx.signNo}`, cx, horizonY + (dashY - horizonY) * 0.3);
    ctx.font = `${Math.max(11, w / 30)}px system-ui`;
    ctx.fillStyle = C.text;
    ctx.fillText(`${Math.floor(view.pos)}m`, cx, horizonY + (dashY - horizonY) * 0.3 + Math.max(20, w / 18));
    ctx.globalAlpha = 1;
  }

  /* 后视镜：两枚红点即猎影（从不渲染实体——看见了就晚了） */
  drawMirror(ctx, w, h, view, now);

  /* 挡风玻璃暗角 */
  const vig = ctx.createRadialGradient(cx, horizonY + 40, Math.min(w, h) * 0.3, cx, h * 0.45, Math.max(w, h) * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, dashY);

  ctx.restore(); // 震屏只作用于场景

  /* 仪表盘（静态底板缓存 + 动态指针） */
  if (cache?.dash) {
    putStatic(cache.dash);
    drawDashboard(ctx, w, h, dashY, view, now, true, fx?.needle);
  } else {
    drawDashboard(ctx, w, h, dashY, view, now, false, fx?.needle);
  }
}

type XOf = (dist: number, lateralM: number) => number;

function drawBarrier(ctx: CanvasRenderingContext2D, w: number, h: number, horizonY: number, xOf: XOf, rel: number, ev: DriveEvent): void {
  const d = Math.max(0.5, rel);
  const y = yFor(d, h, horizonY);
  const mpp = metersToPx(d, w);
  const lanes = [ev.lane, ev.lane2].filter((l): l is 0 | 1 | 2 => l != null);
  const barH = Math.max(3, 1.1 * (h - horizonY) * persp(d) * 0.12);
  for (const lane of lanes) {
    const x = xOf(d, laneCenterMeters(lane));
    const halfW = LANE_W_M * 0.42 * mpp;
    ctx.fillStyle = C.barrierStripe;
    ctx.fillRect(x - halfW, y - barH, halfW * 2, barH);
    ctx.fillStyle = C.barrier;
    const stripes = 4;
    for (let i = 0; i < stripes; i++) {
      ctx.fillRect(x - halfW + (i * halfW * 2) / stripes, y - barH, (halfW * 2) / stripes / 2, barH);
    }
  }
}

function drawSwarm(ctx: CanvasRenderingContext2D, w: number, h: number, horizonY: number, xOf: XOf, rel: number, now: number): void {
  // 尸群横穿：两条车道上一簇蠕动暗红点（覆盖区 [rel, rel+40]；位置随时间蠕动）
  for (let i = 0; i < 26; i++) {
    const d = Math.max(0.5, rel + ((i * 13.7) % 40));
    const y = yFor(d, h, horizonY);
    const mpp = metersToPx(d, w);
    const jitter = ((i * 7.3) % 10) - 5;
    const laneM = i % 2 === 0 ? -LANE_W_M / 2 + jitter * 0.14 : LANE_W_M / 2 + jitter * 0.14;
    const wob = Math.sin(now / 90 + i * 1.7) * mpp * 0.35;
    const x = xOf(d, laneM) + wob;
    const r = Math.max(1, 0.5 * mpp);
    ctx.fillStyle = C.swarm;
    ctx.beginPath();
    ctx.arc(x, y + Math.cos(now / 70 + i) * mpp * 0.12, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLoot(ctx: CanvasRenderingContext2D, w: number, h: number, horizonY: number, xOf: XOf, rel: number, ev: DriveEvent, now: number): void {
  const d = Math.max(0.5, rel);
  const y = yFor(d, h, horizonY);
  const mpp = metersToPx(d, w);
  const x = xOf(d, shoulderMeters(ev.side ?? 'R'));
  const size = Math.max(3, 1.1 * mpp);
  const bob = Math.sin(now / 300) * size * 0.18;
  ctx.fillStyle = ev.content === 'repair' ? C.lootRepair : C.lootFuel;
  ctx.fillRect(x - size / 2, y - size + bob, size, size);
  // 呼吸发光圈（夜里远远就能看到路肩有东西）
  ctx.strokeStyle = ev.content === 'repair' ? C.lootRepair : C.lootFuel;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 260);
  ctx.beginPath();
  ctx.arc(x, y - size / 2 + bob, size * 1.6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawStation(ctx: CanvasRenderingContext2D, w: number, h: number, horizonY: number, xOf: XOf, rel: number, ev: DriveEvent, now: number): void {
  // 加油站棚：路肩上的立柱顶棚 + 亮字灯牌（灯轻微闪烁）
  const d0 = Math.max(0.5, rel);
  const y0 = yFor(d0, h, horizonY);
  const y1 = yFor(Math.max(0.5, rel + 30), h, horizonY);
  const mpp0 = metersToPx(d0, w);
  const x = xOf(d0, shoulderMeters(ev.side ?? 'R'));
  const topY = Math.min(y0, y1) - Math.max(6, 2.6 * mpp0);
  ctx.fillStyle = C.station;
  ctx.fillRect(x - 8 * mpp0 * 0.5, topY, 8 * mpp0, Math.max(2, 0.4 * mpp0));
  ctx.fillRect(x - 1.2 * mpp0, topY, Math.max(1, 0.5 * mpp0), y0 - topY);
  const flicker = 0.85 + 0.15 * Math.sin(now / 130 + rel);
  ctx.globalAlpha = flicker;
  ctx.fillStyle = C.stationLight;
  ctx.fillRect(x - 6 * mpp0 * 0.5, topY - Math.max(2, 0.9 * mpp0), 5 * mpp0, Math.max(2, 0.8 * mpp0));
  ctx.globalAlpha = 1;
}

/** 后视镜：两枚红点 = 猎影逼近度（大小/亮度∝距离，闪动） */
function drawMirror(ctx: CanvasRenderingContext2D, w: number, h: number, view: DriveView, now: number): void {
  const mw = Math.min(150, w * 0.3);
  const mh = mw * 0.34;
  const mx = w / 2 - mw / 2;
  const my = 6;
  ctx.fillStyle = C.mirror;
  ctx.fillRect(mx, my, mw, mh);
  ctx.strokeStyle = C.gauge;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(mx, my, mw, mh);
  const closeness = 1 - Math.min(1, Math.max(0, view.gap / 100));
  if (closeness > 0.05) {
    const flash = 0.55 + 0.45 * Math.sin(now / (300 - closeness * 160));
    const r = 1.5 + closeness * 5;
    ctx.globalAlpha = Math.min(1, 0.25 + closeness * 0.9) * flash;
    ctx.fillStyle = C.red;
    for (const dx of [mw * 0.42, mw * 0.58]) {
      ctx.beginPath();
      ctx.arc(mx + dx, my + mh / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/** 仪表盘：速度表针 / 油表 / 耐久灯 / 双窗 / 车灯（静态底板可由缓存层提供；表针可吃平滑值） */
function drawDashboard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  top: number,
  view: DriveView,
  now: number,
  baseDrawn: boolean,
  needleOverride?: number,
): void {
  if (!baseDrawn) {
    ctx.fillStyle = '#101014';
    ctx.fillRect(0, top, w, h - top);
    ctx.strokeStyle = C.gauge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(w, top);
    ctx.stroke();
  }

  const dh = h - top;
  const at = (frac: number): number => top + dh * frac;

  /* 速度表（左）：表针 + 数字（弧线在底板层） */
  const gx = Math.min(w * 0.2, 110);
  const gr = Math.min(dh * 0.26, 34);
  const gy = at(0.4);
  const ang = ((needleOverride ?? needleAngle(view.speed)) * Math.PI) / 180 - Math.PI / 2;
  ctx.strokeStyle = C.needle;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(gx, gy);
  ctx.lineTo(gx + Math.cos(ang) * gr * 0.92, gy + Math.sin(ang) * gr * 0.92);
  ctx.stroke();
  ctx.fillStyle = C.text;
  ctx.font = `${Math.max(10, dh * 0.2)}px system-ui`;
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.round(view.speed)}`, gx, Math.min(h - 3, gy + gr + dh * 0.18));
  if (dh > 88) {
    ctx.font = `${Math.max(8, dh * 0.09)}px system-ui`;
    ctx.fillText('km/h', gx, Math.min(h - 2, gy + gr + dh * 0.32));
  }

  /* 中央：里程 / 路牌 / 尾距 */
  ctx.fillStyle = C.text;
  ctx.font = `${Math.max(11, dh * 0.16)}px system-ui`;
  ctx.fillText(`${view.signs}${view.targetSigns > 0 ? ` / ${view.targetSigns}` : ''} 号路牌 · ${Math.floor(view.pos)}m`, w / 2, at(0.38));
  const gapPct = Math.round(view.gap);
  ctx.fillStyle = gapPct < 25 ? C.red : C.text;
  ctx.fillText(`后视距离 ${gapPct}%`, w / 2, at(0.68));

  /* 右列：油表 / 耐久灯 / 双窗 / 车灯（纵向按比例铺开） */
  const fx = w - Math.min(w * 0.24, 130);
  const fw = Math.min(w * 0.2, 104);
  ctx.fillStyle = C.gauge;
  ctx.fillRect(fx, at(0.14), fw, Math.max(6, dh * 0.09));
  const fuelW = fw * Math.min(1, Math.max(0, view.fuel / 100));
  ctx.fillStyle = view.fuel < 20 ? C.fuelLow : C.fuel;
  ctx.fillRect(fx, at(0.14), fuelW, Math.max(6, dh * 0.09));
  ctx.fillStyle = C.text;
  ctx.font = `${Math.max(8, dh * 0.11)}px system-ui`;
  ctx.textAlign = 'right';
  ctx.fillText(`油量 ${Math.round(view.fuel)}%`, fx + fw, at(0.32));

  const iw = Math.max(6, dh * 0.1);
  const iy = at(0.42);
  for (let i = 0; i < view.maxDurability; i++) {
    ctx.fillStyle = i < view.durability ? C.ok : '#3a2020';
    ctx.fillRect(fx + i * (iw + 3), iy, iw, iw * 0.6);
  }
  const wy = at(0.6);
  for (const side of ['L', 'R'] as const) {
    const win = view.windows[side];
    let col = '#2a2b33';
    if (win.climbLeft != null) col = now % 300 < 150 ? C.red : '#5a1d1d';
    else if (win.warn) col = C.warn;
    else if (win.open) col = '#4a4e5a';
    ctx.fillStyle = col;
    ctx.fillRect(side === 'L' ? fx : fx + iw + 6, wy, iw, iw * 0.75);
  }
  const ly = at(0.82);
  ctx.fillStyle = view.lamp ? C.stationLight : '#3a3b42';
  ctx.beginPath();
  ctx.arc(fx + 6, ly, Math.max(3, iw * 0.34), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.text;
  ctx.font = `${Math.max(8, dh * 0.1)}px system-ui`;
  ctx.textAlign = 'left';
  ctx.fillText(view.lamp ? '大灯' : '大灯(灭)', fx + iw + 4, ly + iw * 0.3);
}
