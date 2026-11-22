/**
 * 勿停 · 渲染逻辑单测（node 环境）：透视投影、车道横坐标、表针角度、能见距离、
 * 事件长度与浮现透明度、paintScene 全场景冒烟（记录型假 2D 上下文）。
 */
import { describe, expect, it } from 'vitest';
import type { DriveEvent, DriveView } from '@shared/driveProtocol';
import {
  CAM_D_M,
  HORIZON_FRAC,
  drawDistOf,
  eventLen,
  laneCenterMeters,
  laneCenterX,
  metersToPx,
  needleAngle,
  paintScene,
  persp,
  shoulderMeters,
  yFor,
} from '../src/net/driveBoard';

const W = 400;
const H = 600;
const HORIZON = H * HORIZON_FRAC;

function view(overrides?: Partial<DriveView>): DriveView {
  return {
    kind: 'drive',
    mode: 'drive',
    code: 'TEST',
    hostId: 'u1',
    phase: 'driving',
    players: [],
    speed: 60,
    lane: 1,
    fuel: 70,
    durability: 3,
    maxDurability: 3,
    gap: 80,
    pos: 1000,
    signs: 2,
    targetSigns: 0,
    signGap: 400,
    tail: 'normal',
    crawlRate: 'normal',
    windows: {
      L: { open: true, warn: false, climbLeft: null },
      R: { open: false, warn: false, climbLeft: null },
    },
    lamp: true,
    events: [],
    pings: [],
    myInputs: { gas: true, brake: false, spot: false },
    iDowned: false,
    spectator: false,
    serverTime: 0,
    startedAt: 0,
    result: null,
    log: [],
    logSeq: 0,
    ...overrides,
  };
}

describe('透视投影', () => {
  it('persp：dist=0 落底为 1，单调递减趋于地平线', () => {
    expect(persp(0)).toBe(1);
    expect(persp(10)).toBeLessThan(persp(5));
    expect(persp(1_000_000)).toBeLessThan(0.001);
    expect(persp(-3)).toBe(1); // 负距离按 0 处理（车头后方钳制）
  });
  it('yFor：dist=0 落在画布底，∞ 收敛到地平线', () => {
    expect(yFor(0, H, HORIZON)).toBe(H);
    expect(yFor(CAM_D_M * 1000, H, HORIZON)).toBeLessThan(HORIZON + 1); // 6000m 处已贴住地平线
  });
  it('车道中心：0 < 1 < 2，且随距离向中心收拢；路肩在路缘之外', () => {
    const x0 = laneCenterX(0, 5, W, W / 2);
    const x1 = laneCenterX(1, 5, W, W / 2);
    const x2 = laneCenterX(2, 5, W, W / 2);
    expect(x0).toBeLessThan(x1);
    expect(x1).toBeLessThan(x2);
    expect(laneCenterX(1, 5, W, W / 2)).toBe(W / 2); // 中车道即路中心
    expect(Math.abs(laneCenterX(0, 100, W, W / 2) - W / 2)).toBeLessThan(
      Math.abs(laneCenterX(0, 5, W, W / 2) - W / 2),
    ); // 远处收拢
    expect(laneCenterMeters(1)).toBe(0);
    expect(Math.abs(shoulderMeters('R'))).toBeGreaterThan(5.25); // 路缘 5.25m 之外
  });
  it('米转像素随透视收缩', () => {
    expect(metersToPx(0, W)).toBeGreaterThan(metersToPx(100, W));
  });
});

describe('表针与能见度', () => {
  it('表针：0 → -120°，120 → +120°，负速钳制', () => {
    expect(needleAngle(0)).toBe(-120);
    expect(needleAngle(120)).toBe(120);
    expect(needleAngle(-5)).toBe(-120);
    expect(needleAngle(60)).toBe(0);
  });
  it('能见距离：灯开 200/灯灭 90/探头 +100', () => {
    expect(drawDistOf(true, false)).toBe(200);
    expect(drawDistOf(false, false)).toBe(90);
    expect(drawDistOf(false, true)).toBe(190);
    expect(drawDistOf(true, true)).toBe(300);
  });
  it('事件长度：尸群 40m / 加油站 30m / 点事件 0', () => {
    const ev = (kind: DriveEvent['kind']): DriveEvent => ({ at: 0, kind });
    expect(eventLen(ev('swarm'))).toBe(40);
    expect(eventLen(ev('station'))).toBe(30);
    expect(eventLen(ev('barrier'))).toBe(0);
    expect(eventLen(ev('loot'))).toBe(0);
  });
});

describe('paintScene 冒烟（假 2D 上下文）', () => {
  function makeCtx(): { ctx: CanvasRenderingContext2D; calls: string[] } {
    const calls: string[] = [];
    const grad = { addColorStop: () => calls.push('addColorStop') };
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
          if (prop === 'canvas') return { width: 400, height: 600 };
          return (..._a: unknown[]) => calls.push(String(prop));
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  }

  it('全场景不抛错且画了路面/仪表/后视镜；事件与 ping 进了绘制调用', () => {
    const { ctx, calls } = makeCtx();
    const v = view({
      events: [
        { at: 1040, kind: 'barrier', lane: 1 },
        { at: 1150, kind: 'swarm', lane: 0, lane2: 2 },
        { at: 1300, kind: 'loot', side: 'R', content: 'fuel' },
        { at: 1500, kind: 'station', side: 'L' },
      ],
      pings: [{ lane: 1, at: 1040, ts: 0, by: '乙' }],
    });
    expect(() => paintScene(ctx, W, H, { view: v, renderPos: 1000, now: 100, drawDist: 200 })).not.toThrow();
    expect(calls).toContain('fillRect');
    expect(calls).toContain('fillText');
    expect(calls).toContain('arc'); // 尸群/表针/红点
    expect(calls).toContain('moveTo');
  });

  it('灯灭同样不抛错（整体压暗路径）；被拖走/终局视图不抛错', () => {
    const { ctx } = makeCtx();
    expect(() => paintScene(ctx, W, H, { view: view({ lamp: false }), renderPos: 0, now: 0, drawDist: 90 })).not.toThrow();
    expect(() => paintScene(ctx, W, H, { view: view({ phase: 'gameover', result: { reason: 'dead', distance: 100, signs: 1, durationMs: 5000, attacks: 1, crawls: 0, loots: 0 } }), renderPos: 0, now: 0, drawDist: 200 })).not.toThrow();
  });
});
