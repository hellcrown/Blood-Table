/**
 * App 壳层组件测试（jsdom）：横幅与 toast 此前只能构建后人工判断，这里钉住三处回归过的问题：
 * 1. 4000（被顶号）关闭后必须显示「其他窗口接管」而非「正在重连」——该状态永不重连，文案曾误导；
 * 2. toast 定时器互覆：第二条错误不得被第一条的定时器提前清掉；
 * 3. 连接中横幅正常出现。
 * net 是模块级单例且 App 副作用会真的 new WebSocket：每个用例 vi.resetModules 后
 * 用 FakeWebSocket 重新导入，保证状态隔离且不发起真实连接。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

/** 可控的 WebSocket 替身：jsdom 无 WebSocket，且绝不能让它发起真实连接 */
class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  readyState = 0;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(): void {}
  close(): void {}
}

vi.mock('../../src/audio/sound', () => ({ playSfx: vi.fn() }));

describe('App · 连接横幅与错误 toast', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.stubGlobal('WebSocket', FakeWS);
    // 完整 JSON 响应桩：headers.get 必须可用，否则 fetchServerVersion 读 content-type 抛 TypeError
    // 被 catch 吞掉——版本检查会走「异常兜底」分支而非正常 JSON 分支（测的不是想测的路径）
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, latest: null, build: null }),
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** 每用例独立模块图：net 单例、App 副作用全部从零开始 */
  async function freshApp() {
    vi.resetModules();
    const { net } = await import('../../src/net/socket');
    const { default: App } = await import('../../src/App');
    return { net, App };
  }

  it('连接中显示「连接服务器中…」；被顶号（4000）后显示接管提示而非「正在重连」', async () => {
    const { net, App } = await freshApp();
    render(<App />);
    expect(screen.getByText('连接服务器中…')).toBeInTheDocument();
    const ws = FakeWS.instances.at(-1)!;
    act(() => {
      ws.onclose?.({ code: 4000 });
    });
    expect(screen.getByText('本房间已在其他窗口打开，此窗口已退回大厅')).toBeInTheDocument();
    expect(screen.queryByText('连接断开，正在重连…')).not.toBeInTheDocument();
    // 4000 路径不得调度重连（互踢死循环防护）
    expect(FakeWS.instances).toHaveLength(1);
    void net;
  });

  it('普通断线显示「正在重连」并调度重连（与 4000 口径区分）', async () => {
    const { App } = await freshApp();
    render(<App />);
    const ws = FakeWS.instances.at(-1)!;
    act(() => {
      ws.onclose?.({ code: 1006 });
    });
    expect(screen.getByText('连接断开，正在重连…')).toBeInTheDocument();
  });

  it('toast 定时器互覆回归：后到的错误不被前一条的 2.6s 定时器提前清掉', async () => {
    vi.useFakeTimers();
    const { App } = await freshApp();
    render(<App />);
    const ws = FakeWS.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ t: 'error', code: 'A', msg: '第一条错误' }) });
    });
    expect(screen.getByText('第一条错误')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
      ws.onmessage?.({ data: JSON.stringify({ t: 'error', code: 'B', msg: '第二条错误' }) });
    });
    expect(screen.getByText('第二条错误')).toBeInTheDocument();
    // t=+2700ms：旧实现里第一条的 2600ms 定时器此刻已把第二条清掉
    act(() => {
      vi.advanceTimersByTime(1700);
    });
    expect(screen.queryByText('第一条错误')).not.toBeInTheDocument();
    expect(screen.getByText('第二条错误')).toBeInTheDocument();
    // 第二条自己的 2600ms 到期后消失
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('第二条错误')).not.toBeInTheDocument();
  });
});
