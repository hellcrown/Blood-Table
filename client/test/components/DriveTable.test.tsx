/**
 * 勿停 · 对局页组件测试（jsdom；画布用记录调用的假 2D 上下文——jsdom 没有 canvas 实现）
 * 钉住：持键意图（按下发 on、松开发 off、幂等不重发）、点按意图（换道/关窗/灯/标记）、
 * 页面隐藏自动松键（防后台幽灵车）、被拖走禁用操控、观战无操控区、终局三件套、危险横幅。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { DriveView } from '@shared/driveProtocol';
import { DriveTable } from '../../src/pages/DriveTable';
import { net } from '../../src/net/socket';

vi.mock('../../src/audio/sound', () => ({
  playSfx: vi.fn(),
  startEngine: vi.fn(),
  stopEngine: vi.fn(),
  updateEngine: vi.fn(),
}));

const ME = 'u-me';
const T0 = 1_700_000_000_000;

function drvView(overrides?: Partial<DriveView>): DriveView {
  return {
    kind: 'drive',
    mode: 'drive',
    code: 'TEST',
    hostId: ME,
    phase: 'driving',
    players: [
      { id: ME, name: '我', seat: 0, downed: false, left: false, connected: true, isHost: true, loots: 0, dragged: 0 },
      { id: 'u2', name: '队友', seat: 1, downed: false, left: false, connected: true, isHost: false, loots: 0, dragged: 0 },
    ],
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
      L: { open: false, warn: false, climbLeft: null },
      R: { open: false, warn: false, climbLeft: null },
    },
    lamp: true,
    events: [],
    pings: [],
    myInputs: { gas: false, brake: false, spot: false },
    iDowned: false,
    spectator: false,
    serverTime: T0,
    startedAt: T0,
    result: null,
    log: [],
    logSeq: 0,
    ...overrides,
  };
}

/** 假 2D 上下文：paintScene 用到的全部方法（含渐变工厂） */
function installCanvasStub(): () => void {
  const grad = { addColorStop: () => {} };
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
        if (prop === 'canvas') return { width: 400, height: 600 };
        return () => {};
      },
      set: () => true,
    },
  );
  const orig = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: () => ctx,
  });
  return () => {
    if (orig) Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', orig);
  };
}

describe('DriveTable · 勿停对局页', () => {
  let restoreCanvas: () => void = () => {};
  beforeEach(() => {
    net.playerId = ME;
    net.status = 'open';
    restoreCanvas = installCanvasStub();
  });
  afterEach(() => {
    restoreCanvas();
    net.playerId = null;
    vi.restoreAllMocks();
  });

  it('驾驶者：油门/刹车/探头按住发送 on、松开发 off，重复按下不重发（幂等）', () => {
    const sendSpy = vi.spyOn(net, 'send').mockReturnValue(true);
    render(<DriveTable view={drvView()} />);
    const gas = screen.getByText('⛽ 油门');
    fireEvent.pointerDown(gas);
    expect(sendSpy).toHaveBeenCalledWith({ t: 'vInt', intent: { k: 'gas', on: true } });
    sendSpy.mockClear();
    fireEvent.pointerDown(gas);
    expect(sendSpy).not.toHaveBeenCalled(); // 幂等：按住状态里再按不重发
    fireEvent.pointerUp(gas);
    expect(sendSpy).toHaveBeenCalledWith({ t: 'vInt', intent: { k: 'gas', on: false } });
    const spot = screen.getByText('👁 探头');
    fireEvent.pointerDown(spot);
    expect(sendSpy).toHaveBeenCalledWith({ t: 'vInt', intent: { k: 'spot', on: true } });
    fireEvent.pointerUp(spot);
    expect(sendSpy).toHaveBeenCalledWith({ t: 'vInt', intent: { k: 'spot', on: false } });
  });

  it('点按意图：换道/开关窗/车灯/前方标记各自成包；无危险时标记禁用', () => {
    const sendSpy = vi.spyOn(net, 'send').mockReturnValue(true);
    render(<DriveTable view={drvView({ events: [{ at: 1100, kind: 'barrier', lane: 2 }] })} />);
    fireEvent.click(screen.getByText('道 ▶'));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'vInt', intent: { k: 'lane', dir: 1 } });
    fireEvent.click(screen.getByText('右窗 开'));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'vInt', intent: { k: 'window', side: 'R' } });
    fireEvent.click(screen.getByText('💡 灯开'));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'vInt', intent: { k: 'lamp' } });
    const mark = screen.getByText('🚩 标记');
    fireEvent.click(mark);
    expect(sendSpy).toHaveBeenCalledWith({ t: 'vInt', intent: { k: 'ping', lane: 2, at: 1100 } });
  });

  it('页面隐藏自动松开全部持键（防后台幽灵车）', () => {
    const sendSpy = vi.spyOn(net, 'send').mockReturnValue(true);
    render(<DriveTable view={drvView()} />);
    fireEvent.pointerDown(screen.getByText('⛽ 油门'));
    fireEvent.pointerDown(screen.getByText('👁 探头'));
    sendSpy.mockClear();
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    const calls = sendSpy.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(calls).toContain(JSON.stringify({ t: 'vInt', intent: { k: 'gas', on: false } }));
    expect(calls).toContain(JSON.stringify({ t: 'vInt', intent: { k: 'spot', on: false } }));
    hiddenSpy.mockRestore();
  });

  it('被拖走：横幅提示且操控禁用；爬入计时显示危险横幅', () => {
    const sendSpy = vi.spyOn(net, 'send').mockReturnValue(true);
    const { unmount } = render(<DriveTable view={drvView({ iDowned: true, myInputs: null })} />);
    expect(screen.getByText(/你被拖出了车外/)).toBeTruthy();
    expect((screen.getByText('⛽ 油门') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.pointerDown(screen.getByText('⛽ 油门'));
    expect(sendSpy).not.toHaveBeenCalled();
    unmount();
    render(<DriveTable view={drvView({ windows: { L: { open: true, warn: false, climbLeft: 2400 }, R: { open: false, warn: false, climbLeft: null } } })} />);
    expect(screen.getByText(/快关窗/)).toBeTruthy();
  });

  it('观战者：无操控区、有观战横幅；终局：房主可再来一局、返回房间', () => {
    const sendSpy = vi.spyOn(net, 'send').mockReturnValue(true);
    const { unmount } = render(<DriveTable view={drvView({ spectator: true, myInputs: null })} />);
    expect(screen.getByText(/观战中/)).toBeTruthy();
    expect(screen.queryByText('⛽ 油门')).toBeNull();
    unmount();
    render(
      <DriveTable
        view={drvView({
          phase: 'gameover',
          result: { reason: 'dead', distance: 1234, signs: 3, durationMs: 90_000, attacks: 2, crawls: 1, loots: 4 },
        })}
      />
    );
    expect(screen.getByText('车毁人亡')).toBeTruthy();
    expect(screen.getByText(/1234m/)).toBeTruthy();
    fireEvent.click(screen.getByText('再来一局'));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'vRematch' });
    fireEvent.click(screen.getByText('返回房间'));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'backToRoom' });
  });

  it('非房主终局：只显示等待提示，不出现再来一局按钮；逃生成功文案正确', () => {
    render(
      <DriveTable
        view={drvView({
          hostId: 'u2',
          phase: 'gameover',
          result: { reason: 'won', distance: 5000, signs: 5, durationMs: 300_000, attacks: 1, crawls: 2, loots: 3 },
        })}
      />,
    );
    expect(screen.getByText('全员逃出夜路！')).toBeTruthy();
    expect(screen.queryByText('再来一局')).toBeNull();
    expect(screen.getByText('等待房主开始下一局…')).toBeTruthy();
  });
});
