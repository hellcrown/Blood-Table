/**
 * 勿停 · 对局页组件测试（jsdom；3D 场景模块用桩替换——它需要真实 WebGL；
 * canvas 2D 用记录型假上下文）
 * 钉住：三种布局（驾驶员/副驾驶/单人全占）、键盘驾驶（成对发送、多键映射、左右抵消）、
 * 失焦/切后台/弹层打开/输入框聚焦时的守卫、Tab 切岗位、岗位权限（非驾驶位发不出驾驶意图）、
 * 导航键（车窗/大灯/标记/喊话）、点地图放标记、拖动环顾、喊话栏、警报、标记旗标、
 * 鼠标锁定、终局面板、重连补发、触屏门槛、WebGL 失败提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DRIVE_CALLS, type DriveView } from '@shared/driveProtocol';
import { DriveTable } from '../../src/pages/DriveTable';
import { net } from '../../src/net/socket';
import { ME, T0, drvView, installCanvasStub, navView } from '../driveFixture';

/** 3D 场景桩：记录 update/render/project/dispose 调用 */
const { SceneStub } = vi.hoisted(() => {
  class SceneStub {
    static instances: SceneStub[] = [];
    static failNext = false;
    updates: { seat: string; yaw: number; pitch: number }[] = [];
    renders = 0;
    disposed = false;
    projectResult = { x: 0.1, y: 0.2, inFront: true };
    constructor(_canvas: unknown) {
      if (SceneStub.failNext) throw new Error('no webgl');
      SceneStub.instances.push(this);
    }
    resize(): void {}
    update(_v: unknown, _fx: unknown, seat: string, yaw: number, pitch: number): void {
      this.updates.push({ seat, yaw, pitch });
    }
    render(): void {
      this.renders++;
    }
    project(): { x: number; y: number; inFront: boolean } {
      return this.projectResult;
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  return { SceneStub };
});
vi.mock('../../src/drive/scene/DriveScene3D', () => ({ DriveScene3D: SceneStub }));
vi.mock('../../src/audio/sound', () => ({ playSfx: vi.fn(), startEngine: vi.fn(), stopEngine: vi.fn(), updateEngine: vi.fn() }));

type Sent = { t: string; intent?: Record<string, unknown> };

const rect = (w: number, h: number): DOMRect => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

/** 让地图容器报 400×600、3D 画面容器报 640×400（jsdom 默认全是 0） */
function installRects(): () => void {
  const orig = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    const cls = String(this.className);
    if (cls.includes('drv-map')) return rect(400, 600);
    if (cls.includes('drv-view')) return rect(640, 400);
    return rect(0, 0);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = orig;
  };
}

const intentsOf = (spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] =>
  spy.mock.calls.map((c) => (c[0] as Sent).intent ?? {});

const key = (code: string, init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(document.body, { code, ...init });
};
const keyUp = (code: string): void => {
  fireEvent.keyUp(document.body, { code });
};

/** 让渲染循环跑过几拍（jsdom 没有 rAF，走 33ms 定时器回退） */
async function tick(ms = 40): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe('DriveTable · 勿停对局页', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let restoreCanvas: () => void = () => {};
  let restoreRects: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    net.playerId = ME;
    net.status = 'open';
    SceneStub.instances = [];
    SceneStub.failNext = false;
    sendSpy = vi.spyOn(net, 'send').mockReturnValue(true) as unknown as ReturnType<typeof vi.spyOn>;
    restoreCanvas = installCanvasStub().restore;
    restoreRects = installRects();
  });
  afterEach(() => {
    restoreCanvas();
    restoreRects();
    net.playerId = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const driveIntents = (): Record<string, unknown>[] => intentsOf(sendSpy).filter((i) => 'k' in i && ['gas', 'brake', 'steer'].includes(String(i.k)));
  const allIntents = (): Record<string, unknown>[] => intentsOf(sendSpy);

  /* ---------------- 驾驶员 ---------------- */

  it('驾驶员布局：整幅 3D 画面、没有地图也没有导航操作区；有环顾提示', () => {
    render(<DriveTable view={drvView()} />);
    expect(document.querySelector('.drv-main')!.className).toContain('mode-driver');
    expect(document.querySelector('canvas.drv-3d')).toBeTruthy();
    expect(document.querySelector('.drv-map')!.hasAttribute('hidden')).toBe(true);
    expect(screen.queryByText(/左窗/)).toBeNull();
    expect(screen.getByText(/点击画面锁定鼠标环顾/)).toBeTruthy();
    expect(SceneStub.instances).toHaveLength(1);
  });

  it('键盘驾驶：按下发 on、松开发 off；同一动作的多个键映射到最后一个松开才发 off；按住不重复发', () => {
    render(<DriveTable view={drvView()} />);
    key('KeyW');
    expect(driveIntents()).toEqual([{ k: 'gas', on: true }]);
    key('KeyW', { repeat: true }); // 系统重复触发：不重发
    key('ArrowUp'); // 另一个油门键：状态没变，不发
    keyUp('KeyW'); // ArrowUp 还按着：仍不松
    expect(driveIntents()).toEqual([{ k: 'gas', on: true }]);
    keyUp('ArrowUp');
    expect(driveIntents()).toEqual([
      { k: 'gas', on: true },
      { k: 'gas', on: false },
    ]);
    // 事件已被处理：方向键的默认行为（滚动页面）被阻止
    const evt = new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true, cancelable: true });
    document.body.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });

  it('键盘转向：右 +1、左 −1、同时按抵消为 0', () => {
    render(<DriveTable view={drvView()} />);
    key('KeyD');
    key('ArrowLeft');
    keyUp('KeyD');
    keyUp('ArrowLeft');
    expect(driveIntents()).toEqual([
      { k: 'steer', dir: 1 },
      { k: 'steer', dir: 0 },
      { k: 'steer', dir: -1 },
      { k: 'steer', dir: 0 },
    ]);
  });

  it('失焦 / 切后台：自动松开全部驾驶键', () => {
    render(<DriveTable view={drvView()} />);
    key('KeyW');
    key('KeyA');
    sendSpy.mockClear();
    fireEvent(window, new Event('blur'));
    expect(driveIntents()).toEqual([{ k: 'gas', on: false }, { k: 'steer', dir: 0 }]);
    key('KeyW');
    sendSpy.mockClear();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(driveIntents()).toEqual([{ k: 'gas', on: false }]);
    hidden.mockRestore();
  });

  it('弹层打开时按键不当作游戏操作，并松开已按下的驾驶键', () => {
    render(<DriveTable view={drvView()} />);
    key('KeyW');
    sendSpy.mockClear();
    fireEvent.click(screen.getByTitle('玩法速查'));
    expect(document.querySelector('.overlay')).toBeTruthy();
    key('KeyD');
    expect(driveIntents()).toEqual([{ k: 'gas', on: false }]); // 松了油门，方向键没被当成转向
    fireEvent.keyDown(window, { key: 'Escape' }); // Esc 关掉弹层
    expect(document.querySelector('.overlay')).toBeNull();
    sendSpy.mockClear();
    key('KeyD');
    expect(driveIntents()).toEqual([{ k: 'steer', dir: 1 }]);
  });

  it('焦点在输入框里时按键不当作游戏操作', () => {
    render(<DriveTable view={drvView()} />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { code: 'KeyW' });
    expect(sendSpy).not.toHaveBeenCalled();
    input.remove();
  });

  it('Tab 切岗位：发 role；单人局不切', () => {
    const { unmount } = render(<DriveTable view={drvView()} />);
    key('Tab');
    expect(allIntents()).toEqual([{ k: 'role', role: 'navigate' }]);
    unmount();
    sendSpy.mockClear();
    render(<DriveTable view={drvView({ solo: true, canNavigate: true })} />);
    key('Tab');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('岗位权限：驾驶员发不出导航意图（车窗/大灯/喊话/标记）', () => {
    render(<DriveTable view={drvView()} />);
    key('KeyQ');
    key('KeyF');
    key('KeyR');
    key('Digit1');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('驾驶员点击画面锁定鼠标环顾', () => {
    const lock = vi.fn();
    const proto = HTMLCanvasElement.prototype as unknown as { requestPointerLock?: () => void };
    proto.requestPointerLock = lock;
    try {
      render(<DriveTable view={drvView()} />);
      fireEvent.click(document.querySelector('canvas.drv-3d')!);
      expect(lock).toHaveBeenCalledTimes(1);
    } finally {
      delete proto.requestPointerLock;
    }
  });

  /* ---------------- 副驾驶 ---------------- */

  it('副驾驶布局：左地图 + 右画面 + 导航操作区（车窗/大灯/标记/9 条喊话）', () => {
    render(<DriveTable view={navView()} />);
    expect(document.querySelector('.drv-main')!.className).toContain('mode-navigator');
    expect(document.querySelector('.drv-map')!.hasAttribute('hidden')).toBe(false);
    expect(screen.getByText('左窗 关着 · 打开')).toBeTruthy();
    expect(screen.getByText('右窗 关着 · 打开')).toBeTruthy();
    expect(screen.getByText('💡 大灯 开')).toBeTruthy();
    expect(screen.getByText('🚩 标记最近危险')).toBeTruthy();
    for (const text of DRIVE_CALLS) expect(screen.getByText(text)).toBeTruthy();
  });

  it('副驾驶键位：A/← 左窗、D/→ 右窗、W/↑ 大灯、S/↓ 标记最近危险、数字键喊话；发不出驾驶意图', () => {
    render(<DriveTable view={navView({ events: [{ at: 1100, kind: 'barrier', lat: 0, half: 1.3 }] })} />);
    key('KeyA');
    key('ArrowRight');
    key('KeyW');
    keyUp('KeyW');
    key('ArrowDown');
    key('Digit2');
    expect(allIntents()).toEqual([
      { k: 'window', side: 'L' },
      { k: 'window', side: 'R' },
      { k: 'lamp' },
      { k: 'ping', at: 1100, lat: 0 },
      { k: 'call', i: 1 },
    ]);
    expect(driveIntents()).toEqual([]);
  });

  it('点地图任意位置放标记：换算成道路坐标发给驾驶员', async () => {
    render(<DriveTable view={navView()} />);
    await tick();
    sendSpy.mockClear();
    const map = document.querySelector('canvas.drv-map-canvas')!;
    // 地图 400×600：车在底部（后方 60m），正前方 100m 的路中间
    const pad = 16;
    const scale = (600 - pad * 2) / 360;
    const y = 600 - pad - 60 * scale - 100 * scale;
    fireEvent.click(map, { clientX: 200, clientY: y });
    const ping = allIntents().find((i) => i.k === 'ping')!;
    expect(Math.abs(Number(ping.at) - 1100)).toBeLessThan(2);
    expect(Math.abs(Number(ping.lat))).toBeLessThan(0.6);
    // 点在右侧车道
    sendSpy.mockClear();
    fireEvent.click(map, { clientX: 200 + 3.5 * scale, clientY: y });
    const ping2 = allIntents().find((i) => i.k === 'ping')!;
    expect(Math.abs(Number(ping2.lat) - 3.5)).toBeLessThan(0.6); // 横向位置取整到米
  });

  it('拖动小窗环顾：场景收到视角偏角，且镜头在副驾驶座', async () => {
    render(<DriveTable view={navView()} />);
    const scene = SceneStub.instances[0]!;
    const canvas = document.querySelector('canvas.drv-3d')!;
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 160, clientY: 70, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    await tick();
    const last = scene.updates.at(-1)!;
    expect(last.seat).toBe('navigator');
    expect(last.yaw).toBeGreaterThan(0); // 鼠标右移 → 向右看
    expect(last.pitch).toBeGreaterThan(0); // 鼠标上移 → 向上看
    expect(scene.renders).toBeGreaterThan(0);
  });

  it('停手 1.5 秒后视线自动回正', async () => {
    render(<DriveTable view={navView()} />);
    const scene = SceneStub.instances[0]!;
    const canvas = document.querySelector('canvas.drv-3d')!;
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    await tick(3000);
    const last = scene.updates.at(-1)!;
    expect(Math.abs(last.yaw)).toBeLessThan(0.01);
  });

  /* ---------------- 单人全占 ---------------- */

  it('单人局：整幅画面 + 角落小地图 + 导航操作；方向键归驾驶，车窗/大灯用 Q/E/F', () => {
    render(<DriveTable view={drvView({ solo: true, canNavigate: true })} />);
    expect(document.querySelector('.drv-main')!.className).toContain('mode-solo');
    expect(document.querySelector('.drv-map')!.hasAttribute('hidden')).toBe(false);
    key('KeyA'); // 转向，不是开窗
    key('KeyQ'); // 左窗
    key('KeyF'); // 大灯
    key('Digit1'); // 喊话
    expect(allIntents()).toEqual([
      { k: 'steer', dir: -1 },
      { k: 'window', side: 'L' },
      { k: 'lamp' },
      { k: 'call', i: 0 },
    ]);
  });

  /* ---------------- HUD ---------------- */

  it('喊话栏：副驾驶的喊话带喊话人大字显示', () => {
    render(<DriveTable view={drvView({ calls: [{ id: 1, by: '队友', i: 1, ts: T0 }] })} />);
    expect(screen.getByText(DRIVE_CALLS[1])).toBeTruthy();
    expect(screen.getByText('队友')).toBeTruthy();
  });

  it('警报：无人驾驶 / 被合围 / 被扒车 / 被拖走 / 爬窗 / 驶出路面', () => {
    const { unmount } = render(<DriveTable view={drvView({ drivers: 0 })} />);
    expect(screen.getByText(/无人驾驶/)).toBeTruthy();
    unmount();
    const { unmount: u2 } = render(
      <DriveTable
        view={drvView({
          monsters: [{ id: 1, at: 1040, lat: 0, mode: 'hunt', side: null, vs: -5, vx: 0, climbLeft: null }],
        })}
      />,
    );
    expect(screen.getByText(/它们冲过来了 ×1/)).toBeTruthy();
    u2();
    const { unmount: u3 } = render(
      <DriveTable
        view={drvView({
          monsters: [{ id: 2, at: 1000, lat: 2.3, mode: 'latched', side: 'R', vs: 0, vx: 0, climbLeft: null }],
        })}
      />,
    );
    expect(screen.getByText(/被扒车 ×1！开到 32km\/h 才能甩掉/)).toBeTruthy(); // 甩脱线跟着夜行者的速度走，直接告诉玩家
    u3();
    const { unmount: u4 } = render(<DriveTable view={drvView({ iDowned: true, canDrive: false })} />);
    expect(screen.getByText(/你被拖出了车外/)).toBeTruthy();
    key('KeyW'); // 被拖走的人不能操作
    expect(sendSpy).not.toHaveBeenCalled();
    u4();
    const { unmount: u5 } = render(
      <DriveTable view={drvView({ windows: { L: { open: true, warn: false, climbLeft: 2400 }, R: { open: false, warn: false, climbLeft: null } } })} />,
    );
    expect(screen.getByText(/正在爬进左车窗/)).toBeTruthy();
    u5();
    render(<DriveTable view={drvView({ offRoad: true })} />);
    expect(screen.getByText(/驶出了路面/)).toBeTruthy();
  });

  it('被扒的一侧画面泛红：左侧被扒 → 左侧红光亮、右侧不亮', async () => {
    render(
      <DriveTable view={drvView({ speed: 0, monsters: [{ id: 9, at: 1000, lat: -2.3, mode: 'latched', side: 'L', vs: 0, vx: 0, climbLeft: null }] })} />,
    );
    await tick();
    const left = document.querySelector('.drv-sideglow.left') as HTMLElement;
    const right = document.querySelector('.drv-sideglow.right') as HTMLElement;
    expect(Number(left.style.opacity)).toBeGreaterThanOrEqual(0.09); // 随节拍闪烁，最低 0.1
    expect(Number(right.style.opacity)).toBe(0);
  });

  it('标记旗标：副驾驶放的标记在驾驶员画面上带距离显示', async () => {
    render(<DriveTable view={drvView({ speed: 0, pings: [{ id: 3, at: 1150, lat: 0, ts: T0, by: '队友' }] })} />);
    await tick();
    const flag = document.querySelector('.drv-ping')!;
    expect(flag.textContent).toBe('🚩 150m');
    expect(flag.getAttribute('data-edge')).toBe('0');
  });

  it('标记在镜头背后/出屏时贴边带箭头', async () => {
    SceneStub.failNext = false;
    render(<DriveTable view={drvView({ pings: [{ id: 4, at: 900, lat: -6, ts: T0, by: '队友' }] })} />);
    const scene = SceneStub.instances[0]!;
    scene.projectResult = { x: 3, y: 0, inFront: false };
    await tick();
    const flag = document.querySelector('.drv-ping')!;
    expect(flag.getAttribute('data-edge')).toBe('1');
    expect(flag.textContent).toContain('🚩');
    expect(flag.textContent).toContain('后方'); // 在车后：箭头指向左边（它在路的左侧），文字说明在后方
  });

  it('终局：显示结果统计；房主可再来一局；返回房间', () => {
    render(
      <DriveTable
        view={drvView({
          phase: 'gameover',
          result: { reason: 'dead', distance: 1234, signs: 3, durationMs: 90_000, attacks: 2, crawls: 1, loots: 4 },
        })}
      />,
    );
    expect(screen.getByText('车毁人亡')).toBeTruthy();
    expect(screen.getByText(/1234m/)).toBeTruthy();
    fireEvent.click(screen.getByText('再来一局'));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'vRematch' });
    fireEvent.click(screen.getByText('返回房间'));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'backToRoom' });
  });

  it('重连自愈：本地仍按住油门而服务端已清零 → 新视图到达时自动补发；服务端已确认则不重发', () => {
    const { rerender } = render(<DriveTable view={drvView()} />);
    key('KeyW');
    sendSpy.mockClear();
    rerender(<DriveTable view={drvView({ myInputs: { gas: false, brake: false, steer: 0 } })} />);
    expect(allIntents()).toEqual([{ k: 'gas', on: true }]);
    sendSpy.mockClear();
    rerender(<DriveTable view={drvView({ myInputs: { gas: true, brake: false, steer: 0 } })} />);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('卸载时释放 3D 场景', () => {
    const { unmount } = render(<DriveTable view={drvView()} />);
    unmount();
    expect(SceneStub.instances[0]!.disposed).toBe(true);
  });

  /* ---------------- 仅电脑 ---------------- */

  it('触屏设备：整屏提示、不建 3D 场景；可退出房间', () => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
    try {
      render(<DriveTable view={drvView()} />);
      expect(screen.getByText('勿停是电脑端玩法')).toBeTruthy();
      expect(document.querySelector('canvas.drv-3d')).toBeNull();
      expect(SceneStub.instances).toHaveLength(0);
      fireEvent.click(screen.getByText('退出房间'));
      expect(sendSpy).toHaveBeenCalledWith({ t: 'leave' });
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });

  it('WebGL 不可用：画面区给出明确提示', () => {
    SceneStub.failNext = true;
    render(<DriveTable view={drvView()} />);
    expect(screen.getByText('无法启动 3D 画面')).toBeTruthy();
    expect(screen.queryByText(/点击画面锁定鼠标环顾/)).toBeNull();
  });

  it('观战者：没有操作区与岗位切换，有观战横幅', () => {
    render(<DriveTable view={drvView({ spectator: true, canDrive: false, canNavigate: false, myInputs: null })} />);
    expect(screen.getByText(/观战中/)).toBeTruthy();
    expect(screen.queryByText('🚗 驾驶')).toBeNull();
    key('KeyW');
    key('Digit1');
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('勿停 · 等待房与大厅门槛', () => {
  it('isKeyboardPC：主指针精确=电脑；探测不可用按电脑处理', async () => {
    const { isKeyboardPC } = await import('../../src/device');
    expect(isKeyboardPC()).toBe(true); // jsdom 没有 matchMedia
    window.matchMedia = ((q: string) => ({ matches: q === '(pointer: fine)', media: q })) as unknown as typeof window.matchMedia;
    try {
      expect(isKeyboardPC()).toBe(true);
      window.matchMedia = (() => ({ matches: false, media: '' })) as unknown as typeof window.matchMedia;
      expect(isKeyboardPC()).toBe(false);
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });
});
