/**
 * 勿停 · 客户端测试夹具（不是测试文件：视图工厂 / 记录型假 2D 上下文）
 * jsdom 没有 canvas 实现，也没有 WebGL——纯绘制函数喂一个记录调用的假上下文即可验证「画了、没抛错」。
 */
import type { DriveView } from '@shared/driveProtocol';

export const ME = 'u-me';
export const T0 = 1_700_000_000_000;

const closedWindow = { open: false, warn: false, climbLeft: null } as const;

/** 驾驶员视角的默认视图（两人局：我驾驶、队友导航） */
export function drvView(overrides?: Partial<DriveView>): DriveView {
  return {
    kind: 'drive',
    mode: 'drive',
    code: 'TEST',
    hostId: ME,
    phase: 'driving',
    players: [
      { id: ME, name: '我', seat: 0, downed: false, left: false, connected: true, isHost: true, loots: 0, dragged: 0, role: 'drive' },
      { id: 'u2', name: '队友', seat: 1, downed: false, left: false, connected: true, isHost: false, loots: 0, dragged: 0, role: 'navigate' },
    ],
    speed: 60,
    lateral: 0,
    rel: 0,
    fuel: 70,
    durability: 3,
    maxDurability: 3,
    gap: 80,
    pos: 1000,
    signs: 2,
    targetSigns: 0,
    signGap: 400,
    nextSignAt: 1200,
    tail: 'normal',
    crawlRate: 'normal',
    windows: { L: { ...closedWindow }, R: { ...closedWindow } },
    lamp: true,
    offRoad: false,
    events: [],
    monsters: [],
    curves: [],
    pings: [],
    calls: [],
    steerIn: 0,
    myInputs: { gas: false, brake: false, steer: 0 },
    myRole: 'drive',
    canDrive: true,
    canNavigate: false,
    solo: false,
    drivers: 1,
    escapeSpeed: 32,
    iDowned: false,
    spectator: false,
    mauls: 0,
    attacks: 0,
    serverTime: T0,
    startedAt: T0,
    result: null,
    log: [],
    logSeq: 0,
    ...overrides,
  };
}

/** 副驾驶视角（我导航、队友驾驶） */
export function navView(overrides?: Partial<DriveView>): DriveView {
  const base = drvView();
  return drvView({
    ...overrides,
    players: [
      { ...base.players[0]!, role: 'navigate' },
      { ...base.players[1]!, role: 'drive' },
    ],
    myRole: 'navigate',
    canDrive: false,
    canNavigate: true,
  });
}

/** 记录型假 2D 上下文：任何方法调用都记进 calls；属性可随意赋值；渐变工厂返回带 addColorStop 的对象 */
export function recordingCtx(calls: string[]): CanvasRenderingContext2D {
  const grad = { addColorStop: () => calls.push('addColorStop') };
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          void args;
        };
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

/** 让页面上所有 canvas 的 getContext 都返回记录型假上下文 */
export function installCanvasStub(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const ctx = recordingCtx(calls);
  const orig = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: () => ctx,
  });
  return {
    calls,
    restore: () => {
      if (orig) Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', orig);
    },
  };
}
