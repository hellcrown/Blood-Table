/**
 * 勿停 · 导航地图与仪表盘单测（node；记录型假 2D 上下文——jsdom 没有 canvas 实现）
 * 钉住：各种事件/怪物/标记都画得出且不抛错、地图点击换算回道路位置、猎影距离换算、
 * 车道名与表针角度。
 */
import { describe, expect, it } from 'vitest';
import type { DriveEvent, DrivePing } from '@shared/driveProtocol';
import { laneName, needleDeg, paintCluster } from '../src/drive/cluster';
import { mapHitTest, paintMap, shadowDistance, type MapData } from '../src/drive/map';
import type { MonsterTrack } from '../src/drive/fx';
import { buildRoadPath, mapTransform, placeAt, toMap } from '../src/drive/roadPath';
import { recordingCtx } from './driveFixture';

const NOW = 1_700_000_000_000;
const W = 400;
const H = 600;

function monster(id: number, mode: MonsterTrack['mode'], over: Partial<MonsterTrack> = {}): MonsterTrack {
  const at = 1000 + id * 60;
  const lat = (id % 3) - 1;
  return {
    id,
    at,
    lat,
    mode,
    side: mode === 'latched' ? 'R' : null,
    vs: 0,
    vx: 0,
    climbLeft: null,
    targetAt: at,
    targetLat: lat,
    targetAtTime: NOW,
    ...over,
  };
}

function fullData(over: Partial<MapData> = {}): MapData {
  const path = buildRoadPath([], 1000, 60, 300);
  const events: DriveEvent[] = [
    { at: 1120, kind: 'barrier', lat: 0, half: 1.3 },
    { at: 1300, kind: 'barrier', lat: -3.5, half: 3.4 },
    { at: 1180, kind: 'swarm', lat: -1.75, half: 3.6 },
    { at: 1250, kind: 'loot', side: 'L', content: 'fuel' },
    { at: 1260, kind: 'loot', side: 'R', content: 'repair' },
    { at: 1100, kind: 'station', side: 'R' },
  ];
  const monsters = [monster(1, 'wander'), monster(2, 'hunt', { vs: -5, vx: -1 }), monster(3, 'return'), monster(4, 'latched', { climbLeft: 1200 }), monster(5, 'thrown')];
  const pings: DrivePing[] = [{ id: 1, at: 1150, lat: 0, ts: NOW - 1000, by: '队友' }];
  return {
    path,
    pos: 1000,
    lateral: 0,
    rel: 0,
    events,
    monsters,
    nextSignAt: 1200,
    signs: 2,
    targetSigns: 5,
    gap: 30,
    windows: { L: { open: true, warn: true, climbLeft: null }, R: { open: false, warn: false, climbLeft: 1400 } },
    pings,
    now: NOW,
    ...over,
  };
}

describe('导航地图', () => {
  it('画得出全部种类的图标且不抛错（副驾驶大地图 / 单人局小地图）', () => {
    const calls: string[] = [];
    const ctx = recordingCtx(calls);
    const t = paintMap(ctx, W, H, fullData());
    expect(t.scale).toBeGreaterThan(0.5);
    expect(t.cx).toBe(W / 2);
    for (const op of ['fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'arc', 'fillText', 'setLineDash']) {
      expect(calls).toContain(op);
    }
    const compactCalls: string[] = [];
    expect(() => paintMap(recordingCtx(compactCalls), 230, 290, fullData({ compact: true }))).not.toThrow();
  });

  it('空数据（刚开局什么都没有）也不抛错', () => {
    expect(() => paintMap(recordingCtx([]), W, H, fullData({ events: [], monsters: [], pings: [] }))).not.toThrow();
    expect(() => paintMap(recordingCtx([]), W, H, fullData({ path: [] }))).not.toThrow();
  });

  it('猎影距离：尾距 100 → 130m，归零 → 10m', () => {
    expect(shadowDistance(100)).toBe(130);
    expect(shadowDistance(0)).toBe(10);
    expect(shadowDistance(50)).toBe(70);
    expect(shadowDistance(999)).toBe(130);
  });
});

describe('地图点击 → 道路位置', () => {
  const path = buildRoadPath([], 1000, 60, 300);
  const t = mapTransform(W, H, path, 0, 0);

  it('点在正前方 100m 的路中间：得到对应里程与横向 0', () => {
    const q = placeAt(path, 1100, 0);
    const p = toMap(t, q.x, q.y);
    const hit = mapHitTest(t, path, p.x, p.y, W, H)!;
    expect(Math.abs(hit.at - 1100)).toBeLessThan(0.5);
    expect(Math.abs(hit.lat)).toBeLessThan(0.05);
  });

  it('点在右车道：横向位置为正；点在左边路肩：为负', () => {
    const right = placeAt(path, 1150, 3.5);
    const pr = toMap(t, right.x, right.y);
    expect(mapHitTest(t, path, pr.x, pr.y, W, H)!.lat).toBeCloseTo(3.5, 5);
    const left = placeAt(path, 1080, -6.65);
    const pl = toMap(t, left.x, left.y);
    expect(mapHitTest(t, path, pl.x, pl.y, W, H)!.lat).toBeCloseTo(-6.65, 5);
  });

  it('点在地图边缘：里程钳在可视范围内，横向钳在 ±30m；点在画布外返回 null', () => {
    const far = mapHitTest(t, path, W - 1, 10, W, H)!;
    expect(far.at).toBeLessThanOrEqual(1300 - 2 + 1e-9);
    expect(far.at).toBeGreaterThanOrEqual(940 + 2 - 1e-9);
    expect(Math.abs(far.lat)).toBeLessThanOrEqual(30);
    expect(mapHitTest(t, path, -1, 10, W, H)).toBeNull();
    expect(mapHitTest(t, path, 10, H + 1, W, H)).toBeNull();
    expect(mapHitTest(t, [], 10, 10, W, H)).toBeNull();
  });
});

describe('仪表盘', () => {
  it('车道名按车道中心判定，不在路面上为 null', () => {
    expect(laneName(0)).toBe('M');
    expect(laneName(-3.5)).toBe('L');
    expect(laneName(3.5)).toBe('R');
    expect(laneName(-1.7)).toBe('M');
    expect(laneName(5.3)).toBeNull();
  });

  it('表针：0 → −120°，60 → 0°，120 → +120°，越界钳制', () => {
    expect(needleDeg(0)).toBe(-120);
    expect(needleDeg(60)).toBe(0);
    expect(needleDeg(120)).toBe(120);
    expect(needleDeg(-5)).toBe(-120);
    expect(needleDeg(999)).toBe(120);
  });

  it('画得出且不抛错（含各种告警状态）', () => {
    const calls: string[] = [];
    const ctx = recordingCtx(calls);
    const win = (open: boolean, warn: boolean, climbLeft: number | null) => ({ open, warn, climbLeft });
    expect(() =>
      paintCluster(ctx, 512, 224, {
        speed: 72,
        fuel: 15,
        durability: 1,
        maxDurability: 5,
        lamp: false,
        windows: { L: win(false, true, null), R: win(true, false, 900) },
        offRoad: true,
        lateral: 6.2,
        drivers: 0,
        hunting: 2,
        latched: 1,
        gap: 12,
        noDriver: true,
        now: NOW,
      }),
    ).not.toThrow();
    for (const op of ['fillRect', 'arc', 'moveTo', 'lineTo', 'stroke', 'fill', 'fillText', 'quadraticCurveTo']) expect(calls).toContain(op);
    expect(() =>
      paintCluster(recordingCtx([]), 512, 224, {
        speed: 0,
        fuel: 100,
        durability: 3,
        maxDurability: 3,
        lamp: true,
        windows: { L: win(false, false, null), R: win(false, false, null) },
        offRoad: false,
        lateral: 0,
        drivers: 1,
        hunting: 0,
        latched: 0,
        gap: 100,
        noDriver: false,
        now: NOW + 250,
      }),
    ).not.toThrow();
  });
});
