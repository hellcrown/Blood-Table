/**
 * 勿停 · 导航地图（副驾驶专属；canvas 2D，纯绘制，node 可单测）
 *
 * 车头朝上的俯视图：后方 60m ~ 前方 300m。地图按车头相对角旋转，车固定在底部中央恒朝上——
 * 车头偏右时前方的路在地图上偏左，车道线斜着穿过车位，偏离车道一眼可见。
 * 画：路肩 / 三车道 / 边线 / 路障 / 尸群带 / 搜掠点 / 加油站 / 下一块路牌 /
 *     夜行者（游荡·被惊动·回位·扒车·被甩飞各一种画法）/ 猎影（车后红色光团）/ 窗爬者 / 队友标记 / 本车。
 * 信息不对称即玩法：这张图只有副驾驶（和单人局）看得到。
 */
import {
  DRIVE_CLIMB_MS,
  DRIVE_LATCH_CLIMB_MS,
  DRIVE_PING_TTL_MS,
  DRIVE_STATION_LEN,
  DRIVE_SWARM_LEN,
  LANE_W_M,
  ROAD_HALF_M,
  type DriveEvent,
  type DrivePing,
  type DriveSide,
  type DriveView,
} from '@shared/driveProtocol';
import {
  MAP_AHEAD_M,
  MAP_BACK_M,
  fromMap,
  locateOnRoad,
  mapTransform,
  placeAt,
  toMap,
  type MapTransform,
  type RoadSample,
} from './roadPath';
import type { MonsterTrack } from './fx';

export interface MapData {
  path: RoadSample[];
  pos: number;
  lateral: number;
  rel: number;
  events: DriveEvent[];
  monsters: MonsterTrack[];
  nextSignAt: number;
  signs: number;
  targetSigns: number;
  gap: number;
  windows: DriveView['windows'];
  pings: DrivePing[];
  now: number;
  /** 单人局的角落小地图：省略文字与刻度，并且看得更近（路才画得够宽） */
  compact?: boolean;
}

/** 单人局角落小地图的视野：后方 35m ~ 前方 170m */
const COMPACT_BACK_M = 35;
const COMPACT_AHEAD_M = 170;

/** 标记在到期前这段时间里逐渐变淡 */
const PING_FADE_MS = 2000;

const C = {
  bg: '#08090d',
  road: '#262a33',
  shoulder: '#15171e',
  edge: '#7a7f8d',
  lane: '#454a57',
  barrier: '#e8e4da',
  barrierAlt: '#c23b3b',
  swarm: 'rgba(126, 32, 32, 0.8)',
  fuel: '#d9a13c',
  repair: '#58a55c',
  station: '#3d6f8e',
  stationText: '#dceaf5',
  sign: '#2f6b45',
  signGoal: '#b8902e',
  monster: '#e03131',
  return: '#e0a031',
  shadow: '#ff1f1f',
  ping: '#7ee081',
  car: '#f2f4ff',
  text: '#9a9da8',
};

/** 猎影在车后的距离（米）：尾距 100 → 130m，归零 → 10m */
export function shadowDistance(gap: number): number {
  return 10 + Math.min(100, Math.max(0, gap)) * 1.2;
}

/** 在地图上描一条沿道路、横向偏移 lat 的线（可限定里程范围） */
function roadLine(
  ctx: CanvasRenderingContext2D,
  t: MapTransform,
  path: readonly RoadSample[],
  lat: number,
  sFrom: number,
  sTo: number,
): void {
  ctx.beginPath();
  let started = false;
  for (const p of path) {
    if (p.s < sFrom || p.s > sTo) continue;
    const q = toMap(t, p.x + p.nx * lat, p.y + p.ny * lat);
    if (!started) {
      ctx.moveTo(q.x, q.y);
      started = true;
    } else ctx.lineTo(q.x, q.y);
  }
}

function eventAnchor(t: MapTransform, path: readonly RoadSample[], at: number, lat: number): { x: number; y: number; angle: number } {
  const a = pt(t, path, at - 1, lat);
  const b = pt(t, path, at + 1, lat);
  const c = pt(t, path, at, lat);
  return { x: c.x, y: c.y, angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

/** 道路坐标（里程 + 横向）→ 地图像素 */
function pt(t: MapTransform, path: readonly RoadSample[], at: number, lat: number): { x: number; y: number } {
  const p = placeAt(path, at, lat);
  return toMap(t, p.x, p.y);
}

/** 画一张导航地图；返回本次使用的坐标变换（点击放标记时反算用） */
export function paintMap(ctx: CanvasRenderingContext2D, w: number, h: number, d: MapData): MapTransform {
  const compact = !!d.compact;
  const back = compact ? COMPACT_BACK_M : MAP_BACK_M;
  const ahead = compact ? COMPACT_AHEAD_M : MAP_AHEAD_M;
  const t = mapTransform(w, h, d.path, d.lateral, d.rel, back, ahead);
  const pad = Math.max(8, Math.min(w, h) * 0.04);
  const s0 = d.path.length > 0 ? d.path[0]!.s : d.pos - 60;
  const s1 = d.path.length > 0 ? d.path[d.path.length - 1]!.s : d.pos + 300;
  const sc = t.scale;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad * 0.5, pad * 0.5, w - pad, h - pad);
  ctx.clip();

  /* 道路 */
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.strokeStyle = C.shoulder;
  ctx.lineWidth = (ROAD_HALF_M + 1.6) * 2 * sc;
  roadLine(ctx, t, d.path, 0, s0, s1);
  ctx.stroke();
  ctx.strokeStyle = C.road;
  ctx.lineWidth = ROAD_HALF_M * 2 * sc;
  roadLine(ctx, t, d.path, 0, s0, s1);
  ctx.stroke();
  ctx.strokeStyle = C.lane;
  ctx.lineWidth = Math.max(1, 0.14 * sc);
  ctx.setLineDash([5, 7]);
  for (const lat of [-LANE_W_M / 2, LANE_W_M / 2]) {
    roadLine(ctx, t, d.path, lat, s0, s1);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = C.edge;
  ctx.lineWidth = Math.max(1, 0.16 * sc);
  for (const lat of [-ROAD_HALF_M, ROAD_HALF_M]) {
    roadLine(ctx, t, d.path, lat, s0, s1);
    ctx.stroke();
  }

  /* 里程刻度（每 50m 一条短线 + 数字） */
  if (!compact) {
    ctx.fillStyle = C.text;
    ctx.strokeStyle = C.text;
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let s = Math.ceil(d.pos / 50) * 50; s <= d.pos + ahead; s += 50) {
      if (s <= d.pos) continue;
      const a = pt(t, d.path, s, -ROAD_HALF_M - 2);
      const b = pt(t, d.path, s, -ROAD_HALF_M - 4.5);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.fillText(`${s}`, b.x + 3, b.y); // 标绝对里程，与驾驶员仪表的里程数对得上
    }
  }

  /* 路面事件 */
  for (const ev of d.events) {
    if (ev.kind === 'barrier') {
      const half = ev.half ?? 1.3;
      const a = eventAnchor(t, d.path, ev.at, ev.lat ?? 0);
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(a.angle);
      const len = half * 2 * sc;
      const wid = Math.max(compact ? 5 : 7, 1.3 * sc);
      ctx.fillStyle = C.barrier;
      ctx.fillRect(-len / 2, -wid / 2, len, wid);
      ctx.fillStyle = C.barrierAlt;
      const blocks = Math.max(2, Math.round(len / Math.max(6, 0.9 * sc)));
      for (let i = 0; i < blocks; i += 2) ctx.fillRect(-len / 2 + (i * len) / blocks, -wid / 2, len / blocks, wid);
      ctx.restore();
    } else if (ev.kind === 'swarm') {
      ctx.strokeStyle = C.swarm;
      ctx.lineWidth = (ev.half ?? 3.6) * 2 * sc;
      ctx.lineCap = 'round';
      // 尸群带沿路横跨一段：首尾两点连线即可（40m 内弯道极缓）
      const a = pt(t, d.path, ev.at, ev.lat ?? 0);
      const b = pt(t, d.path, ev.at + DRIVE_SWARM_LEN, ev.lat ?? 0);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.lineCap = 'butt';
    } else if (ev.kind === 'loot') {
      const lat = (ev.side === 'L' ? -1 : 1) * (ROAD_HALF_M + 1.4);
      const a = eventAnchor(t, d.path, ev.at, lat);
      const col = ev.content === 'repair' ? C.repair : C.fuel;
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(a.angle);
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 8;
      const r = compact ? 5 : 8;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r, 0);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
      if (!compact) {
        ctx.fillStyle = col;
        ctx.font = '10px system-ui';
        ctx.textAlign = 'center';
        ctx.font = '700 11px system-ui';
        ctx.fillText(ev.content === 'repair' ? '修补' : '油', a.x, a.y + 19);
      }
    } else if (ev.kind === 'station') {
      const side = ev.side === 'L' ? -1 : 1;
      const lat = side * (ROAD_HALF_M + 5.2);
      const a = eventAnchor(t, d.path, ev.at + DRIVE_STATION_LEN / 2, lat);
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(a.angle);
      ctx.fillStyle = C.station;
      ctx.fillRect((-DRIVE_STATION_LEN * sc) / 2, -4.5 * sc, DRIVE_STATION_LEN * sc, 9 * sc);
      ctx.fillStyle = C.stationText;
      ctx.font = `700 ${Math.max(11, Math.min(17, 3.2 * sc))}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(compact ? '油' : '加油站', 0, 0);
      ctx.restore();
    }
  }

  /* 下一块路牌 */
  if (d.nextSignAt <= s1) {
    const a = eventAnchor(t, d.path, d.nextSignAt, ROAD_HALF_M + 3.2);
    const goal = d.targetSigns > 0 && d.signs + 1 >= d.targetSigns;
    ctx.fillStyle = goal ? C.signGoal : C.sign;
    ctx.fillRect(a.x - (compact ? 9 : 15), a.y - (compact ? 7 : 11), compact ? 18 : 30, compact ? 14 : 22);
    ctx.fillStyle = '#f2f4ff';
    ctx.font = `700 ${compact ? 9 : 14}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(goal ? '终点' : `${d.signs + 1}`, a.x, a.y + 0.5);
  }

  /* 队友标记（8 秒内可见，随时间淡出） */
  for (const p of d.pings) {
    const age = d.now - p.ts;
    if (age > DRIVE_PING_TTL_MS) continue;
    const a = pt(t, d.path, p.at, p.lat);
    const fadeFrom = DRIVE_PING_TTL_MS - PING_FADE_MS;
    const alpha = age > fadeFrom ? 1 - (age - fadeFrom) / PING_FADE_MS : 1;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = C.ping;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = C.ping;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
    ctx.fill();
    if (!compact) {
      ctx.font = '700 11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(p.by, a.x, a.y - 13);
    }
    ctx.globalAlpha = 1;
  }

  /* 猎影：车后红色光团，越近越大越亮 */
  const behind = shadowDistance(d.gap);
  const sp = placeAt(d.path, Math.max(s0 + 2, d.pos - behind), 0);
  const sq = toMap(t, sp.x, sp.y);
  const closeness = 1 - Math.min(100, Math.max(0, d.gap)) / 100;
  const sr = (compact ? 10 : 14) + closeness * 18;
  const grad = ctx.createRadialGradient(sq.x, sq.y, 1, sq.x, sq.y, sr);
  grad.addColorStop(0, `rgba(255, 40, 40, ${0.85 + 0.15 * Math.sin(d.now / 160)})`);
  grad.addColorStop(0.5, `rgba(200, 20, 20, ${0.4 + closeness * 0.3})`);
  grad.addColorStop(1, 'rgba(200, 20, 20, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(sq.x, sq.y, sr, 0, Math.PI * 2);
  ctx.fill();
  if (!compact) {
    ctx.fillStyle = closeness > 0.6 ? '#ff5a5a' : C.text;
    ctx.font = '700 12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(behind > 58 ? `猎影 · 后方 ${Math.round(behind)}m` : '猎影', sq.x, Math.min(h - pad - 6, sq.y + sr + 13));
  }

  /* 夜行者 */
  for (const m of d.monsters) {
    if (m.at < s0 - 10 || m.at > s1 + 10) continue;
    if (m.mode === 'latched') {
      // 扒在车侧：按所在侧画在车位旁边
      const q = toMap(t, d.lateral + (m.side === 'R' ? 2.3 : -2.3), 0);
      ctx.strokeStyle = C.monster;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(q.x, q.y, compact ? 10 : 13, 0, Math.PI * 2);
      ctx.stroke();
      if (m.climbLeft != null) {
        // 正在爬窗：进度弧
        ctx.strokeStyle = '#ffb0b0';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(q.x, q.y, (compact ? 10 : 13) + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - m.climbLeft / DRIVE_LATCH_CLIMB_MS));
        ctx.stroke();
      }
      ctx.fillStyle = C.monster;
      ctx.font = `700 ${compact ? 13 : 16}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', q.x, q.y + 0.5);
      ctx.textBaseline = 'alphabetic';
      continue;
    }
    const q = pt(t, d.path, m.at, m.lat);
    if (m.mode === 'hunt') {
      const pulse = (compact ? 9 : 12) + 5 * (0.5 + 0.5 * Math.sin(d.now / 110));
      ctx.strokeStyle = 'rgba(224, 49, 49, 0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(q.x, q.y, pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ff3b3b';
      ctx.beginPath();
      ctx.arc(q.x, q.y, compact ? 5.5 : 7.5, 0, Math.PI * 2);
      ctx.fill();
      // 运动方向短线
      const h2 = pt(t, d.path, m.at + m.vs * 3, m.lat + m.vx * 3);
      const dl = Math.hypot(h2.x - q.x, h2.y - q.y);
      if (dl > 0.5) {
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(q.x + ((h2.x - q.x) / dl) * 14, q.y + ((h2.y - q.y) / dl) * 14);
        ctx.stroke();
      }
    } else if (m.mode === 'return') {
      ctx.strokeStyle = C.return;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(q.x, q.y, compact ? 4.5 : 6, 0, Math.PI * 2);
      ctx.stroke();
    } else if (m.mode === 'thrown') {
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = C.text;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = C.monster;
      ctx.beginPath();
      ctx.arc(q.x, q.y, compact ? 4.5 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#08090d';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /* 窗爬者：车侧红弧 + 爬入进度 */
  for (const side of ['L', 'R'] as DriveSide[]) {
    const win = d.windows[side];
    if (!win.warn && win.climbLeft == null) continue;
    const dir = side === 'L' ? -1 : 1;
    ctx.strokeStyle = win.climbLeft != null ? '#ff3b3b' : C.return;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(t.cx, t.cy, 19, dir < 0 ? Math.PI * 0.75 : -Math.PI * 0.25, dir < 0 ? Math.PI * 1.25 : Math.PI * 0.25);
    ctx.stroke();
    if (win.climbLeft != null) {
      ctx.strokeStyle = '#ffd0d0';
      ctx.beginPath();
      ctx.arc(t.cx, t.cy, 23, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - win.climbLeft / DRIVE_CLIMB_MS));
      ctx.stroke();
    }
  }

  /* 本车（恒朝上） */
  ctx.fillStyle = C.car;
  ctx.strokeStyle = '#08090d';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(t.cx, t.cy - 12);
  ctx.lineTo(t.cx - 8, t.cy + 10);
  ctx.lineTo(t.cx, t.cy + 5);
  ctx.lineTo(t.cx + 8, t.cy + 10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.restore();

  /* 标题与比例 */
  if (!compact) {
    ctx.fillStyle = C.text;
    ctx.font = '12px system-ui';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`导航地图 · 前方 ${ahead}m · 1px ≈ ${(1 / sc).toFixed(2)}m`, pad, pad + 8);
  }
  return t;
}

/**
 * 地图点击 → 道路坐标（里程 + 横向米数）。点在可视区域外返回 null。
 * 横向钳在 ±30m（点在路外的树林里也当作「路边那个位置」）。
 */
export function mapHitTest(t: MapTransform, path: readonly RoadSample[], px: number, py: number, w: number, h: number): { at: number; lat: number } | null {
  if (px < 0 || py < 0 || px > w || py > h) return null;
  const p = fromMap(t, px, py);
  const hit = locateOnRoad(path, p.x, p.y);
  if (!hit) return null;
  const first = path[0]!.s;
  const last = path[path.length - 1]!.s;
  return { at: Math.min(last - 2, Math.max(first + 2, hit.at)), lat: Math.min(30, Math.max(-30, hit.lat)) };
}
