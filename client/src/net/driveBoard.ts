/**
 * 勿停 · 车内仪表视角渲染（无 React 依赖，纯逻辑，node 可单测）
 *
 * 伪 3D 直路：单参数透视 yFrac = camD/(camD+dist)——dist=0 落在画布底、∞ 收敛到地平线。
 * 横向同理随 yFrac 收缩，车道中心与世界路肩的横向米数换算成像素。
 * 夜路能见度：车灯开 ~200m、关 ~90m；瞭望探头 +100m。事件精灵按同一透视缩放，
 * 出雾即现（远处先黑，靠近才看清——「不停车就看不见路」的恐怖感来源）。
 * 仪表盘：速度表针、油表、耐久灯、双窗状态、后视镜红点（猎影逼近度，从不渲染实体）。
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
  return (w * 0.46) / ROAD_HALF_M * persp(dist);
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

export interface SceneInput {
  view: DriveView;
  /** 渲染里程（视图 pos + 速度外推；由页面按帧更新） */
  renderPos: number;
  /** 当前时刻（ms，窗爬红光闪烁用） */
  now: number;
  /** 能见距离（车灯/探头决定） */
  drawDist: number;
}

/* ---------------- 配色（深夜黑 + 血色红点缀） ---------------- */
const C = {
  skyTop: '#04050a',
  skyLow: '#0a0c14',
  ground: '#0a0b10',
  road: '#16171d',
  roadFar: '#101116',
  edge: '#43464f',
  dash: '#565a66',
  shoulder: '#1b1c22',
  barrier: '#c23b3b',
  barrierStripe: '#e8e4da',
  swarm: '#7e2020',
  lootFuel: '#d9a13c',
  lootRepair: '#58a55c',
  station: '#3d6f8e',
  stationLight: '#e8c26a',
  mirror: '#0a0a0e',
  red: '#e03131',
  dashPanel: '#101014',
  gauge: '#2a2b33',
  needle: '#e8e4da',
  fuel: '#d9a13c',
  fuelLow: '#e03131',
  ok: '#58a55c',
  warn: '#e0a031',
  text: '#9a9da8',
};

/** 事件精灵：远处先没入黑暗，靠近才浮现（雾里出形） */
function eventAlpha(rel: number, drawDist: number): number {
  if (rel < -5 || rel > drawDist) return 0;
  const t = rel / drawDist;
  return Math.min(1, Math.max(0.15, 1.35 - t * 1.35));
}

/** 画一个伪 3D 夜路场景（ctx 已按 DPR 设好 transform；w/h 为 CSS 尺寸） */
export function paintScene(ctx: CanvasRenderingContext2D, w: number, h: number, input: SceneInput): void {
  const { view, renderPos, now, drawDist } = input;
  const cx = w / 2;
  const horizonY = h * HORIZON_FRAC;
  const dashY = h * 0.72; // 仪表盘上沿

  /* 夜空 */
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
  sky.addColorStop(0, C.skyTop);
  sky.addColorStop(1, C.skyLow);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, horizonY);

  /* 地面 */
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, horizonY, w, dashY - horizonY);

  /* 路面梯形（近宽远窄） */
  const pNear = persp(0);
  const pFar = persp(drawDist);
  const roadHalfNear = cx * 0.92;
  const roadHalfFar = roadHalfNear * (pFar / pNear);
  ctx.fillStyle = C.road;
  ctx.beginPath();
  ctx.moveTo(cx - roadHalfNear, dashY);
  ctx.lineTo(cx - roadHalfFar, horizonY);
  ctx.lineTo(cx + roadHalfFar, horizonY);
  ctx.lineTo(cx + roadHalfNear, dashY);
  ctx.closePath();
  ctx.fill();

  /* 路缘实线 */
  ctx.strokeStyle = C.edge;
  ctx.lineWidth = 2;
  for (const side of [-1, 1] as const) {
    ctx.beginPath();
    ctx.moveTo(cx + side * roadHalfNear, dashY);
    ctx.lineTo(cx + side * roadHalfFar, horizonY);
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
      const y0 = yFor(Math.max(0, d0), h, horizonY);
      const y1 = yFor(Math.max(0, d0 + 6), h, horizonY);
      const x0 = cx + m * metersToPx(Math.max(0, d0), w);
      const x1 = cx + m * metersToPx(Math.max(0, d0 + 6), w);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }

  /* 事件精灵 */
  for (const ev of view.events) {
    const len = eventLen(ev);
    const rel = ev.at - renderPos;
    if (rel > drawDist || rel + len < -4) continue;
    const alpha = eventAlpha(rel, drawDist);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    if (ev.kind === 'barrier') {
      drawBarrier(ctx, w, h, horizonY, cx, rel, ev);
    } else if (ev.kind === 'swarm') {
      drawSwarm(ctx, w, h, horizonY, cx, rel);
    } else if (ev.kind === 'loot') {
      drawLoot(ctx, w, h, horizonY, cx, rel, ev);
    } else if (ev.kind === 'station') {
      drawStation(ctx, w, h, horizonY, cx, rel, ev);
    }
    ctx.globalAlpha = 1;
  }

  /* 瞭望标记（队友打的绿色箭头，3 秒内可见） */
  for (const p of view.pings) {
    if (now - p.ts > 3000) continue;
    const rel = p.at - renderPos;
    if (rel < 0 || rel > drawDist) continue;
    const y = yFor(rel, h, horizonY);
    const x = cx + laneCenterMeters(p.lane) * metersToPx(rel, w);
    ctx.fillStyle = '#7ee081';
    const s = Math.max(4, 6 * persp(rel) * (h / 500));
    ctx.beginPath();
    ctx.moveTo(x - s, y - s * 2.2);
    ctx.lineTo(x + s, y - s * 2.2);
    ctx.lineTo(x, y - s * 0.9);
    ctx.closePath();
    ctx.fill();
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

  /* 后视镜：两枚红点即猎影（从不渲染实体——看见了就晚了） */
  drawMirror(ctx, w, h, view, now);

  /* 挡风玻璃暗角 */
  const vig = ctx.createRadialGradient(cx, horizonY + 40, Math.min(w, h) * 0.3, cx, h * 0.45, Math.max(w, h) * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, dashY);

  /* 仪表盘 */
  drawDashboard(ctx, w, h, dashY, view, now);
}

function drawBarrier(ctx: CanvasRenderingContext2D, w: number, h: number, horizonY: number, cx: number, rel: number, ev: DriveEvent): void {
  const y = yFor(Math.max(0.5, rel), h, horizonY);
  const mpp = metersToPx(Math.max(0.5, rel), w);
  const lanes = [ev.lane, ev.lane2].filter((l): l is 0 | 1 | 2 => l != null);
  const barH = Math.max(3, 1.1 * (h - horizonY) * persp(Math.max(0.5, rel)) * 0.12);
  for (const lane of lanes) {
    const x = cx + laneCenterMeters(lane) * mpp;
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

function drawSwarm(ctx: CanvasRenderingContext2D, w: number, h: number, horizonY: number, cx: number, rel: number): void {
  // 尸群横穿：两条车道上一簇蠕动暗红点（覆盖区 [rel, rel+40]）
  for (let i = 0; i < 26; i++) {
    const d = Math.max(0.5, rel + ((i * 13.7) % 40));
    const y = yFor(d, h, horizonY);
    const mpp = metersToPx(d, w);
    const jitter = ((i * 7.3) % 10) - 5;
    const laneM = i % 2 === 0 ? -LANE_W_M / 2 + jitter * 0.14 : LANE_W_M / 2 + jitter * 0.14;
    const x = cx + laneM * mpp + Math.sin(i * 3.1) * 3 * mpp * 0.2;
    const r = Math.max(1, 0.5 * mpp);
    ctx.fillStyle = C.swarm;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLoot(ctx: CanvasRenderingContext2D, w: number, h: number, horizonY: number, cx: number, rel: number, ev: DriveEvent): void {
  const d = Math.max(0.5, rel);
  const y = yFor(d, h, horizonY);
  const mpp = metersToPx(d, w);
  const x = cx + shoulderMeters(ev.side ?? 'R') * mpp;
  const size = Math.max(3, 1.1 * mpp);
  ctx.fillStyle = ev.content === 'repair' ? C.lootRepair : C.lootFuel;
  ctx.fillRect(x - size / 2, y - size, size, size);
  // 发光圈（夜里远远就能看到路肩有东西）
  ctx.strokeStyle = ev.content === 'repair' ? C.lootRepair : C.lootFuel;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y - size / 2, size * 1.6, 0, Math.PI * 2);
  ctx.stroke();
}

function drawStation(ctx: CanvasRenderingContext2D, w: number, h: number, horizonY: number, cx: number, rel: number, ev: DriveEvent): void {
  // 加油站棚：路肩上的立柱顶棚 + 亮字灯牌
  const d0 = Math.max(0.5, rel);
  const y0 = yFor(d0, h, horizonY);
  const y1 = yFor(Math.max(0.5, rel + 30), h, horizonY);
  const mpp0 = metersToPx(d0, w);
  const x = cx + shoulderMeters(ev.side ?? 'R') * mpp0;
  const topY = Math.min(y0, y1) - Math.max(6, 2.6 * mpp0);
  ctx.fillStyle = C.station;
  ctx.fillRect(x - 8 * mpp0 * 0.5, topY, 8 * mpp0, Math.max(2, 0.4 * mpp0));
  ctx.fillRect(x - 1.2 * mpp0, topY, Math.max(1, 0.5 * mpp0), y0 - topY);
  ctx.fillStyle = C.stationLight;
  ctx.fillRect(x - 6 * mpp0 * 0.5, topY - Math.max(2, 0.9 * mpp0), 5 * mpp0, Math.max(2, 0.8 * mpp0));
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

/** 仪表盘：速度表针 / 油表 / 耐久灯 / 双窗 / 车灯（全部分栏按仪表区高度取比例，窄矮机型不裁切） */
function drawDashboard(ctx: CanvasRenderingContext2D, w: number, h: number, top: number, view: DriveView, now: number): void {
  ctx.fillStyle = C.dashPanel;
  ctx.fillRect(0, top, w, h - top);
  ctx.strokeStyle = C.gauge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, top);
  ctx.lineTo(w, top);
  ctx.stroke();

  const dh = h - top;
  const at = (frac: number): number => top + dh * frac;

  /* 速度表（左）：弧形刻度 + 表针 + 数字（支点上移，矮仪表区也不裁） */
  const gx = Math.min(w * 0.2, 110);
  const gr = Math.min(dh * 0.26, 34);
  const gy = at(0.4);
  ctx.strokeStyle = C.gauge;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(gx, gy, gr, Math.PI * (1 + 1 / 3), Math.PI * (2 - 1 / 3), false);
  ctx.stroke();
  const ang = (needleAngle(view.speed) * Math.PI) / 180 - Math.PI / 2;
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
