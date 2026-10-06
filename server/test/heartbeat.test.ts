/**
 * WebSocket 心跳回归测试（假时钟）：**pong 必须复位 isAlive**。
 * 此前服务端只在心跳里置 false 且无人监听 pong 复位——每条连接 30-60 秒被 terminate 一轮，
 * 客户端静默重连顶替，全站长期处于周期性断线重连循环。本测试钉死「有 pong 长期存活」。
 */
import { describe, expect, it, vi } from 'vitest';
import { attachHeartbeat, startHeartbeat, type HeartSocket } from '../src/net/heartbeat';

class FakeSock implements HeartSocket {
  isAlive?: boolean;
  terminated = false;
  pinged = 0;
  private pongHandler: (() => void) | null = null;
  ping(): void {
    this.pinged++;
  }
  terminate(): void {
    this.terminated = true;
  }
  on(ev: string, cb: (...args: unknown[]) => void): void {
    if (ev === 'pong') this.pongHandler = cb;
  }
  /** 模拟浏览器对 ping 的协议层自动应答 */
  receivePong(): void {
    this.pongHandler?.();
  }
}

describe('heartbeat · pong 复位', () => {
  it('有 pong 应答的连接长期存活；无应答的死连接两轮后被 terminate', () => {
    vi.useFakeTimers();
    try {
      const live = new FakeSock();
      const dead = new FakeSock(); // 模拟 TCP 已死/对端僵死：ping 永远等不到 pong
      attachHeartbeat(live);
      expect(live.isAlive).toBe(true);
      const timer = startHeartbeat(() => [live, dead]);

      // 第一轮：全部标记「待确认」并 ping，尚不误杀
      vi.advanceTimersByTime(30_000);
      expect(live.terminated).toBe(false);
      expect(dead.terminated).toBe(false);
      expect(live.pinged).toBe(1);
      live.receivePong(); // live 的 pong 到达；dead 的永远不到

      // 第二轮：dead 被 terminate，live 存活
      vi.advanceTimersByTime(30_000);
      expect(live.terminated).toBe(false);
      expect(dead.terminated).toBe(true);
      live.receivePong(); // 第二轮 ping 的 pong 到达

      // 长期运行：每轮 pong 复位，永不误杀（回归点：曾因无 pong 复位全站周期性断线）
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(30_000);
        live.receivePong();
      }
      expect(live.terminated).toBe(false);
      expect(live.pinged).toBe(12);

      // 未挂 attachHeartbeat 的连接（isAlive undefined）第一轮视为存活，与旧口径一致
      const fresh = new FakeSock();
      const t2 = startHeartbeat(() => [fresh]);
      vi.advanceTimersByTime(30_000);
      expect(fresh.terminated).toBe(false);
      expect(fresh.pinged).toBe(1);

      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });
});
