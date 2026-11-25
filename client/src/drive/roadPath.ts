/**
 * 勿停 · 道路几何（纯逻辑，无 three/React 依赖，node 可单测）
 *
 * 服务端只下发弯道序列（曲率），道路在三维画面和导航地图里的形状由客户端积分得出。
 * 采样点坐标系：以「车所在里程处的道路切线」为基准——x 向右、y 向前、单位米；
 * theta 为该处切线相对基准的转角（正=右弯），(nx, ny) 为右法线。
 * 3D 场景与地图共用同一份积分，保证「地图上的弯」和「眼前的弯」是同一条路。
 */
import { curvatureAt, type DriveCurve } from '@shared/driveProtocol';

export interface RoadSample {
  /** 绝对里程（米） */
  s: number;
  x: number;
  y: number;
  theta: number;
  nx: number;
  ny: number;
}

export const PATH_STEP_M = 4;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * 由弯道序列积分出道路中心线：里程 s0−back 到 s0+ahead，每 step 米一个采样。
 * 先沿路积分（θ += κ·ds，x += sinθ·ds，y += cosθ·ds），再整体平移旋转，
 * 使 s0 处的中心点落在原点、切线朝向 +y。
 */
export function buildRoadPath(
  curves: readonly DriveCurve[],
  s0: number,
  back: number,
  ahead: number,
  step: number = PATH_STEP_M,
): RoadSample[] {
  const start = s0 - back;
  const count = Math.max(2, Math.ceil((back + ahead) / step));
  const xs = new Float64Array(count + 1);
  const ys = new Float64Array(count + 1);
  const ts = new Float64Array(count + 1);
  let x = 0;
  let y = 0;
  let th = 0;
  for (let i = 0; i <= count; i++) {
    xs[i] = x;
    ys[i] = y;
    ts[i] = th;
    // 中点法取曲率（弯道两端有 20m 渐变，逐段中点采样足够平滑）
    th += curvatureAt(curves, start + (i + 0.5) * step) * step;
    x += Math.sin(th) * step;
    y += Math.cos(th) * step;
  }
  // s0 处的位姿
  const f = back / step;
  const i0 = Math.min(count, Math.floor(f));
  const i1 = Math.min(count, i0 + 1);
  const t = f - i0;
  const px = lerp(xs[i0]!, xs[i1]!, t);
  const py = lerp(ys[i0]!, ys[i1]!, t);
  const pth = lerp(ts[i0]!, ts[i1]!, t);
  const cos = Math.cos(pth);
  const sin = Math.sin(pth);
  const ox = px * cos - py * sin;
  const oy = px * sin + py * cos;
  const out: RoadSample[] = [];
  for (let i = 0; i <= count; i++) {
    const rx = xs[i]!;
    const ry = ys[i]!;
    const theta = ts[i]! - pth;
    out.push({
      s: start + i * step,
      x: rx * cos - ry * sin - ox,
      y: rx * sin + ry * cos - oy,
      theta,
      nx: Math.cos(theta),
      ny: -Math.sin(theta),
    });
  }
  return out;
}

/** 里程 s 处的中心线采样（等距采样 → 按下标线性插值；越界取端点） */
export function sampleAt(path: readonly RoadSample[], s: number): RoadSample {
  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last) return { s, x: 0, y: 0, theta: 0, nx: 1, ny: 0 };
  const step = path.length > 1 ? path[1]!.s - first.s : PATH_STEP_M;
  const f = Math.min(path.length - 1, Math.max(0, (s - first.s) / (step || PATH_STEP_M)));
  const i0 = Math.min(path.length - 1, Math.floor(f));
  const i1 = Math.min(path.length - 1, i0 + 1);
  const t = f - i0;
  const a = path[i0]!;
  const b = path[i1]!;
  return {
    s,
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    theta: lerp(a.theta, b.theta, t),
    nx: lerp(a.nx, b.nx, t),
    ny: lerp(a.ny, b.ny, t),
  };
}

/** 道路坐标（里程 + 横向米数）→ 采样坐标系里的点 */
export function placeAt(path: readonly RoadSample[], s: number, lat: number): { x: number; y: number; theta: number } {
  const p = sampleAt(path, s);
  return { x: p.x + p.nx * lat, y: p.y + p.ny * lat, theta: p.theta };
}

/**
 * 采样坐标系里的点 → 道路坐标（里程 + 横向米数，横向正值在道路右侧）。
 * 找中心线上最近的点：导航位在地图上点哪里，就换算成哪里的里程/横向位置。
 */
export function locateOnRoad(path: readonly RoadSample[], x: number, y: number): { at: number; lat: number } | null {
  if (path.length < 2) return null;
  let best = Infinity;
  let at = path[0]!.s;
  let lat = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    const cx = a.x + dx * t;
    const cy = a.y + dy * t;
    const ex = x - cx;
    const ey = y - cy;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) {
      best = d2;
      at = a.s + (b.s - a.s) * t;
      lat = ex * a.nx + ey * a.ny; // 法线是单位向量：点积即带符号横向距离（正=道路右侧）
    }
  }
  return { at, lat };
}

/* ---------------- 导航地图坐标变换 ---------------- */

export interface MapTransform {
  /** 车在地图上的位置（像素） */
  cx: number;
  cy: number;
  /** 像素/米 */
  scale: number;
  /** 车头相对角（rad，正=车头偏右）：地图按它旋转，使车头恒朝上 */
  rel: number;
  /** 车的横向位置（采样坐标里车在 (lateral, 0)） */
  carX: number;
}

/**
 * 采样坐标 → 地图像素。车固定在 (cx, cy) 且车头朝上：
 * 先减去车自身的位置，再把整个场景绕车反向旋转 rel（车头偏右时，前方的路在地图上偏左）。
 */
export function toMap(t: MapTransform, x: number, y: number): { x: number; y: number } {
  const dx = x - t.carX;
  const dy = y;
  const cos = Math.cos(t.rel);
  const sin = Math.sin(t.rel);
  return {
    x: t.cx + (dx * cos - dy * sin) * t.scale,
    y: t.cy - (dx * sin + dy * cos) * t.scale,
  };
}

/** 地图像素 → 采样坐标（toMap 的逆变换） */
export function fromMap(t: MapTransform, px: number, py: number): { x: number; y: number } {
  const rx = (px - t.cx) / t.scale;
  const ry = (t.cy - py) / t.scale;
  const cos = Math.cos(t.rel);
  const sin = Math.sin(t.rel);
  return {
    x: rx * cos + ry * sin + t.carX,
    y: -rx * sin + ry * cos,
  };
}

/** 地图视野：后方 60m ~ 前方 300m */
export const MAP_BACK_M = 60;
export const MAP_AHEAD_M = 300;

/**
 * 计算地图变换：基准比例由前方视野决定；道路在视野内横向伸得太远时自动缩小比例把它装进来
 * （急弯不至于被地图边缘截断），最多缩到基准的一半。
 */
export function mapTransform(
  w: number,
  h: number,
  path: readonly RoadSample[],
  lateral: number,
  rel: number,
  back: number = MAP_BACK_M,
  ahead: number = MAP_AHEAD_M,
): MapTransform {
  const pad = Math.max(8, Math.min(w, h) * 0.04);
  const base = (h - pad * 2) / (ahead + back);
  let maxX = 1;
  let maxY = 1;
  const cos = Math.cos(rel);
  const sin = Math.sin(rel);
  for (const p of path) {
    const dx = p.x - lateral;
    const rx = dx * cos - p.y * sin;
    const ry = dx * sin + p.y * cos;
    if (ry > ahead) continue; // 顶部以外的点不参与横向适配
    if (ry < -back - 20) continue;
    maxX = Math.max(maxX, Math.abs(rx));
    maxY = Math.max(maxY, ry);
  }
  const fitX = (w / 2 - pad) / maxX;
  const fitY = (base * ahead) / maxY;
  const scale = Math.max(base * 0.5, Math.min(base, fitX, fitY));
  return { cx: w / 2, cy: h - pad - back * scale, scale, rel, carX: lateral };
}
