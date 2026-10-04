/**
 * 断线遮罩（App 的 offline-veil）测试：断开后延迟 1.5s 才出现（防网络抖动闪烁），
 * 被顶号（replaced）永不遮罩——那时玩家需要自行点「重新连接」。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

class FakeWS {
  static instances: FakeWS[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  readyState = 0;
  constructor(_url: string) {
    FakeWS.instances.push(this);
  }
  send(): void {}
  close(): void {}
}

vi.mock('../../src/audio/sound', () => ({ playSfx: vi.fn() }));

describe('App · 断线遮罩（1.5s 延迟）', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, latest: null, build: null }),
      })),
    );
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function freshApp() {
    vi.resetModules();
    const { default: App } = await import('../../src/App');
    return App;
  }

  it('连接中 1.5 秒内不遮罩，超时后出现遮罩', async () => {
    const App = await freshApp();
    render(<App />);
    expect(document.querySelector('.offline-veil')).toBeNull(); // 刚连接：不闪
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(document.querySelector('.offline-veil')).not.toBeNull();
    expect(document.querySelector('.offline-card')!.textContent).toContain('正在连接服务器…');
  });

  it('断开后遮罩延迟出现：800ms 触发重连会使计时器重启，再等满 1.5s 才遮罩', async () => {
    const App = await freshApp();
    render(<App />);
    act(() => {
      FakeWS.instances.at(-1)!.onclose?.({ code: 1006 });
    });
    // 重连退避 800ms 内：遮罩未出现
    act(() => {
      vi.advanceTimersByTime(799);
    });
    expect(document.querySelector('.offline-veil')).toBeNull();
    // 第 800ms 重连尝试：closed → connecting，遮罩计时器随 effect 重启
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.querySelector('.offline-veil')).toBeNull();
    // 重启后再等满 1.5s 仍连不上：遮罩出现
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(document.querySelector('.offline-veil')).not.toBeNull();
    expect(document.querySelector('.offline-card')!.textContent).toContain('正在连接服务器…');
  });

  it('被顶号（4000 → replaced）：永不遮罩', async () => {
    const App = await freshApp();
    render(<App />);
    act(() => {
      FakeWS.instances.at(-1)!.onclose?.({ code: 4000 });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(document.querySelector('.offline-veil')).toBeNull();
  });

  it('重连成功（open）后遮罩消失', async () => {
    const App = await freshApp();
    render(<App />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(document.querySelector('.offline-veil')).not.toBeNull();
    act(() => {
      FakeWS.instances.at(-1)!.onopen?.();
    });
    expect(document.querySelector('.offline-veil')).toBeNull();
  });
});
