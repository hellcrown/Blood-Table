/**
 * 勿停 · 道路几何单测（node）：弯道积分出中心线、采样坐标系、里程/横向与坐标互转、
 * 导航地图的正反变换与自动缩放。3D 画面与地图共用这一份积分。
 */
import { describe, expect, it } from 'vitest';
import type { DriveCurve } from '@shared/driveProtocol';
import {
  MAP_AHEAD_M,
  MAP_BACK_M,
  buildRoadPath,
  fromMap,
  locateOnRoad,
  mapTransform,
  placeAt,
  sampleAt,
  toMap,
  type RoadSample,
} from '../src/drive/roadPath';

const NEAR = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

describe('中心线积分', () => {
  it('直路：沿 +y 笔直延伸，车在原点、切线朝前、右法线朝 +x', () => {
    const path = buildRoadPath([], 100, 40, 200);
    expect(path.length).toBeGreaterThan(50);
    const car = sampleAt(path, 100);
    expect(NEAR(car.x, 0) && NEAR(car.y, 0) && NEAR(car.theta, 0)).toBe(true);
    expect(NEAR(car.nx, 1) && NEAR(car.ny, 0)).toBe(true);
    const ahead = sampleAt(path, 160);
    expect(NEAR(ahead.x, 0) && NEAR(ahead.y, 60)).toBe(true);
    const behind = sampleAt(path, 70);
    expect(NEAR(behind.y, -30)).toBe(true);
  });

  it('右弯：前方的路偏向 +x 且切线角为正；左弯相反', () => {
    const right: DriveCurve[] = [{ at: 20, len: 200, k: 0.008 }];
    const pr = buildRoadPath(right, 0, 0, 300);
    expect(sampleAt(pr, 250).x).toBeGreaterThan(20);
    expect(sampleAt(pr, 150).theta).toBeGreaterThan(0.3);
    const left: DriveCurve[] = [{ at: 20, len: 200, k: -0.008 }];
    const pl = buildRoadPath(left, 0, 0, 300);
    expect(sampleAt(pl, 250).x).toBeLessThan(-20);
    expect(sampleAt(pl, 250).theta).toBeLessThan(0);
  });

  it('法线是单位向量且垂直于切线', () => {
    const path = buildRoadPath([{ at: 0, len: 400, k: 0.006 }], 0, 0, 300);
    for (const p of path) {
      expect(NEAR(Math.hypot(p.nx, p.ny), 1, 1e-9)).toBe(true);
      // 切线 = (sinθ, cosθ)，右法线 = (cosθ, −sinθ)：点积为 0
      expect(NEAR(Math.sin(p.theta) * p.nx + Math.cos(p.theta) * p.ny, 0, 1e-9)).toBe(true);
    }
  });

  it('车停在弯道中间：车所在处仍是原点、切线朝前，身后的路在后方', () => {
    const path = buildRoadPath([{ at: 0, len: 400, k: 0.01 }], 150, 60, 240);
    const car = sampleAt(path, 150);
    expect(NEAR(car.x, 0, 1e-9) && NEAR(car.y, 0, 1e-9) && NEAR(car.theta, 0, 1e-9)).toBe(true);
    const behind = sampleAt(path, 110);
    const ahead = sampleAt(path, 200);
    expect(behind.y).toBeLessThan(0);
    expect(ahead.y).toBeGreaterThan(0);
    expect(ahead.x).toBeGreaterThan(0); // 右弯：前方偏右
  });

  it('placeAt / sampleAt 越界取端点，不抛错', () => {
    const path = buildRoadPath([], 100, 40, 80);
    expect(sampleAt(path, -999).s).toBe(-999);
    expect(NEAR(sampleAt(path, 9999).y, 80)).toBe(true);
    const p = placeAt([], 50, 3);
    expect(NEAR(p.x, 3) && NEAR(p.y, 0)).toBe(true);
  });
});

describe('坐标 ↔ 道路位置', () => {
  const straight = (): RoadSample[] => buildRoadPath([], 100, 60, 300);

  it('直路上的点换算回里程与横向位置（右为正）', () => {
    const path = straight();
    const a = placeAt(path, 220, 3.5);
    const hit = locateOnRoad(path, a.x, a.y)!;
    expect(NEAR(hit.at, 220, 0.01) && NEAR(hit.lat, 3.5, 1e-6)).toBe(true);
    const b = placeAt(path, 60, -1.75);
    const hitB = locateOnRoad(path, b.x, b.y)!;
    expect(NEAR(hitB.at, 60, 0.01) && NEAR(hitB.lat, -1.75, 1e-6)).toBe(true);
    // 点在路外的树林里：横向距离照样算得出
    const far = locateOnRoad(path, 27.3, 0)!; // 车身旁右 27.3m（路外的树林里）
    expect(NEAR(far.lat, 27.3, 1e-6) && NEAR(far.at, 100, 0.01)).toBe(true);
    expect(locateOnRoad([], 0, 0)).toBeNull();
  });

  it('弯道上的点也能换算回正确的里程与横向位置', () => {
    const path = buildRoadPath([{ at: 0, len: 500, k: 0.009 }], 100, 60, 300);
    const p = placeAt(path, 280, -2.5);
    const hit = locateOnRoad(path, p.x, p.y)!;
    expect(Math.abs(hit.at - 280)).toBeLessThan(0.6);
    expect(Math.abs(hit.lat + 2.5)).toBeLessThan(0.05);
  });
});

describe('导航地图坐标变换', () => {
  it('车恒在 (cx, cy)；车头朝前时正前方的路在车上方', () => {
    const path = buildRoadPath([], 100, 60, 300);
    const t = mapTransform(400, 600, path, 0, 0);
    const car = toMap(t, 0, 0);
    expect(NEAR(car.x, t.cx) && NEAR(car.y, t.cy)).toBe(true);
    const ahead = toMap(t, 0, 100);
    expect(NEAR(ahead.x, t.cx, 1e-9)).toBe(true);
    expect(NEAR(ahead.y, t.cy - 100 * t.scale, 1e-9)).toBe(true);
    expect(t.cy).toBeGreaterThan(600 * 0.7); // 车在地图下方（后面只留 60m）
  });

  it('车头偏右时，前方的路在地图上偏左；车偏在右侧车道时，路中心在车的左边', () => {
    const path = buildRoadPath([], 100, 60, 300);
    const t = mapTransform(400, 600, path, 0, 0.4);
    const ahead = toMap(t, 0, 100);
    expect(ahead.x).toBeLessThan(t.cx);
    const t2 = mapTransform(400, 600, path, 3.5, 0);
    const center = toMap(t2, 0, 0);
    expect(center.x).toBeCloseTo(t2.cx - 3.5 * t2.scale, 6);
    const carPoint = toMap(t2, 3.5, 0); // 车自己的位置
    expect(NEAR(carPoint.x, t2.cx) && NEAR(carPoint.y, t2.cy)).toBe(true);
  });

  it('toMap 与 fromMap 互逆（任意车头角、任意横向位置）', () => {
    const path = buildRoadPath([], 100, 60, 300);
    for (const [lat, rel] of [
      [0, 0],
      [2.2, 0.35],
      [-4.1, -0.5],
    ]) {
      const t = mapTransform(640, 720, path, lat, rel);
      for (const [x, y] of [
        [0, 0],
        [12.3, 88.8],
        [-7.7, -33.1],
      ]) {
        const px = toMap(t, x, y);
        const back = fromMap(t, px.x, px.y);
        expect(NEAR(back.x, x, 1e-9) && NEAR(back.y, y, 1e-9)).toBe(true);
      }
    }
  });

  it('自动缩放：急弯伸得太远时缩小比例把它装进地图，最多缩到一半', () => {
    const straight = buildRoadPath([], 100, 60, 300);
    const base = mapTransform(360, 600, straight, 0, 0).scale;
    const sharp = buildRoadPath([{ at: 0, len: 600, k: 0.014 }], 100, 60, 300);
    const t = mapTransform(360, 600, sharp, 0, 0);
    expect(t.scale).toBeLessThan(base);
    expect(t.scale).toBeGreaterThanOrEqual(base * 0.5 - 1e-9);
    // 前方 200m 处的点仍在地图横向范围内
    const q = placeAt(sharp, 300, 0); // 前方 200m 处
    const p = toMap(t, q.x, q.y);
    expect(Math.abs(p.x - t.cx)).toBeLessThanOrEqual(180);
    expect(MAP_AHEAD_M).toBe(300);
    expect(MAP_BACK_M).toBe(60);
  });
});
