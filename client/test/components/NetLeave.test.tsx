/**
 * 退出房间竞态回归（放 components 项目：需要 jsdom 的 localStorage + WebSocket 替身 + 可控计时器）：
 * leaveRoom 后，同一连接上「服务器处理 leave 前已广播、此刻才到达」的 state 帧必须被丢弃——
 * 否则 view 被复原成旧牌桌（玩家表现为「点退出没反应，要退两次，第二次报『尚未加入房间』」），
 * lastRoom 也被重写（大厅重新弹出「回到房间」横幅）。
 * hello（新会话绑定）清除标记，其后的 state 正常套用；重连后的新连接同样正常。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/** 可控的 WebSocket 替身：jsdom 无 WebSocket，且绝不能让它发起真实连接 */
class FakeWS {
  static instances: FakeWS[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  url: string;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  readyState = 1;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {}
  /** 模拟服务器下行帧 */
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const helloFrame = { t: 'hello', token: 'tok-1', playerId: 'p-1' };
const stateFrame = (code: string) => ({ t: 'state', view: { kind: 'classic', code } });

describe('net.leaveRoom · 迟到 state 帧防护', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    localStorage.clear();
    vi.stubGlobal('WebSocket', FakeWS);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  async function freshNet() {
    vi.resetModules();
    const { net } = await import('../../src/net/socket');
    net.start();
    return net;
  }

  it('leaveRoom 后同连接上的迟到 state 不复原 view、不重写 lastRoom；hello（再次入房）后恢复', async () => {
    const net = await freshNet();
    const ws1 = FakeWS.instances.at(-1)!;
    ws1.onopen?.();
    ws1.receive(helloFrame);
    ws1.receive(stateFrame('ABCD'));
    expect(net.view?.code).toBe('ABCD');
    expect(JSON.parse(localStorage.getItem('blood.lastRoom')!).code).toBe('ABCD');

    net.leaveRoom();
    expect(net.view).toBeNull();
    expect(localStorage.getItem('blood.lastRoom')).toBeNull();
    expect(ws1.sent.some((d) => d.includes('"leave"'))).toBe(true);

    // 竞态窗口：服务器处理 leave 前广播的最后一帧此刻才到达
    ws1.receive(stateFrame('ABCD'));
    expect(net.view).toBeNull(); // 回归点：不得弹回旧牌桌
    expect(localStorage.getItem('blood.lastRoom')).toBeNull(); // 也不得重现「回到房间」

    // 同一连接上再次入房：hello 清除标记，state 正常套用
    ws1.receive(helloFrame);
    ws1.receive(stateFrame('EFGH'));
    expect(net.view?.code).toBe('EFGH');
  });

  it('重连后的新连接不受退出标记影响：state 正常套用', async () => {
    const net = await freshNet();
    const ws1 = FakeWS.instances.at(-1)!;
    ws1.onopen?.();
    ws1.receive(helloFrame);
    ws1.receive(stateFrame('ABCD'));
    net.leaveRoom();
    ws1.onclose?.({ code: 4001 }); // 服务器在 removeSession 后关闭连接，客户端自动重连
    vi.advanceTimersByTime(2000);
    const ws2 = FakeWS.instances.at(-1)!;
    expect(ws2).not.toBe(ws1);
    ws2.onopen?.();
    ws2.receive(helloFrame);
    ws2.receive(stateFrame('EFGH'));
    expect(net.view?.code).toBe('EFGH');
  });

  it('leave 后迟到的 event 帧被丢弃；换房后的血色日志强制重置不混排', async () => {
    const net = await freshNet();
    const ws1 = FakeWS.instances.at(-1)!;
    ws1.onopen?.();
    ws1.receive(helloFrame);
    ws1.receive({
      t: 'state',
      view: { kind: 'blood', code: 'AAAA', logFull: true, log: [{ seq: 1, kind: 'sys', text: 'a1' }, { seq: 2, kind: 'sys', text: 'a2' }] },
    });
    expect(net.view?.log).toHaveLength(2);
    net.leaveRoom();
    // 竞态窗口：旧房 A 的日志增量此刻才到达，不得并入本地基线
    ws1.receive({ t: 'event', line: { seq: 3, kind: 'sys', text: 'stale' } });
    // 同一连接上进入新房 B：中途入房时服务端首帧只带尾部（logFull=false），客户端须自行整体重置
    ws1.receive(helloFrame);
    ws1.receive({
      t: 'state',
      view: { kind: 'blood', code: 'BBBB', logFull: false, log: [{ seq: 10, kind: 'sys', text: 'b1' }] },
    });
    expect(net.view?.code).toBe('BBBB');
    expect(net.view?.log).toHaveLength(1); // 回归点：不得混入 A 房的 1/2/3 行
    expect(net.view?.log[0]!.text).toBe('b1');
  });

  it('主动退出引发的 4001 关闭静默重连：状态不跌入 closed；后续真断线照常提示', async () => {
    const net = await freshNet();
    const ws1 = FakeWS.instances.at(-1)!;
    ws1.onopen?.();
    ws1.receive(helloFrame);
    net.leaveRoom();
    ws1.onclose?.({ code: 4001 }); // 服务器处理 leave 后关闭
    expect(net.status).toBe('open'); // 回归点：不得闪现「连接断开，正在重连」
    vi.advanceTimersByTime(2000);
    const ws2 = FakeWS.instances.at(-1)!;
    expect(ws2).not.toBe(ws1);
    ws2.onopen?.();
    expect(net.status).toBe('open');
    // 静默链只覆盖退出这一次：之后真正的断线照常进入 closed（横幅/遮罩正常出现）
    ws2.onclose?.({ code: 1006 });
    expect(net.status).toBe('closed');
  });
});
