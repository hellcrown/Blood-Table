/**
 * WebSocket 心跳：周期 ping，未在下一轮前回 pong 的连接视为死连接 terminate。
 *
 * **pong 复位是本机制的核心，缺它比没有心跳更糟**：浏览器对 ping 的 pong 是协议层自动应答，
 * 服务端必须挂 'pong' 监听把 isAlive 置回 true——此前 index.ts 只在心跳里置 false 且无人复位，
 * 导致每条连接 30-60 秒必被 terminate 一轮（客户端静默重连顶替，全站长期处于周期性
 * 「断线→重连」循环，观战宽限/退出竞态等一切时序问题都被它放大），fresh-eyes 复审才暴露。
 * 抽成独立模块：用假时钟测试「有 pong 长期存活 / 无 pong 两轮清除」，防再次静默退化。
 */
export interface HeartSocket {
  isAlive?: boolean;
  ping(): void;
  terminate(): void;
  on(ev: string, cb: (...args: unknown[]) => void): unknown;
}

/** 连接建立时调用：初始存活 + pong 应答复位 isAlive */
export function attachHeartbeat(ws: HeartSocket): void {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
}

/** 启动周期心跳，返回定时器（unref，不阻止进程退出） */
export function startHeartbeat(clients: () => Iterable<HeartSocket>, intervalMs = 30_000): NodeJS.Timeout {
  return setInterval(() => {
    for (const ws of clients()) {
      const alive = ws.isAlive !== false;
      if (!alive) {
        ws.terminate(); // 上一轮 ping 未等到 pong：TCP 已死或对端僵死
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, intervalMs).unref();
}
