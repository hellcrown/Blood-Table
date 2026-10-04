/**
 * 血战日志的本地合并（纯函数，无浏览器依赖，便于单测）。
 *
 * 为什么单独成文件：这段逻辑原先埋在 `Net` 类的私有方法里，依赖 `this.bloodLog`，
 * 于是"去重/截断/换局重置"这些**最容易出错、且出错后只表现为「日志面板内容不对」**的判定
 * 完全无法被测试覆盖 —— 它没有网络、没有 React，本该是最容易测的一类代码。
 * 抽出来后 socket.ts 只负责"把结果存回 this.bloodLog"。
 */
import type { LogLine } from '@shared/protocol';

/** 本地累积上限（与服务端 gs.log 的上限一致） */
export const BLOOD_LOG_CAP = 2000;

/**
 * 合并日志：按 seq 去重排序后截断到上限。
 *
 * @param buf      本地已累积的日志（不被修改）
 * @param incoming 本次收到的日志（服务端全量或 `event` 增量）
 * @param full     true = 用 incoming **重置**本地累积（首帧 / 重连 / 落后过多）
 *
 * 两条非显然规则：
 * 1. 序号回退（本次最大 seq < 本地最大 seq）说明服务端开了新的一局（logSeq 归零重排），必须重置 ——
 *    否则"按 seq 去重"会把新一局的日志整段当成已见过而吞掉，面板会停在上一局。
 *    取"本次最大 seq"要**扫一遍 incoming**，不能直接读 `incoming[last]`：服务端批量下发时
 *    末尾元素未必是最大者，误判会触发一次假重置，把本地已有的历史整段丢掉（只表现为"日志少了几条"）。
 * 2. 同一 seq 内容由服务端保证一致，故重复到达直接忽略即可，无需比对内容。
 *
 * `buf` 只允许是本函数的返回值（恒为升序），因此它的最大 seq 取末尾元素即可。
 */
export function mergeBloodLog(buf: LogLine[], incoming: LogLine[], full: boolean): LogLine[] {
  let inMax = 0;
  for (const l of incoming) if (l.seq > inMax) inMax = l.seq;
  const bufMax = buf.length > 0 ? buf[buf.length - 1].seq : 0;
  const reset = full || (inMax > 0 && bufMax > 0 && inMax < bufMax);
  const merged = reset ? [] : buf.slice();
  const seen = new Set(merged.map((l) => l.seq));
  for (const line of incoming) {
    if (seen.has(line.seq)) continue;
    seen.add(line.seq);
    merged.push(line);
  }
  merged.sort((a, b) => a.seq - b.seq);
  return merged.length > BLOOD_LOG_CAP ? merged.slice(-BLOOD_LOG_CAP) : merged;
}
