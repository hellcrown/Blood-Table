/**
 * 聊天时间戳的玩家可读格式：
 * 今天 → 「HH:mm」；昨天/前天 → 「昨天 HH:mm」「前天 HH:mm」；
 * 更早 → 「M月D日 HH:mm」（跨年再加年份）。
 * 纯函数（now 可注入）以便单测覆盖日界与跨年；时间部分手写 HH:mm，
 * 不用 toLocaleTimeString——Node 与浏览器的 zh-CN 小时制输出不一致，断言会被环境摆布。
 */
export function fmtChatTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // 按各自「当天零点」的差值算相隔天数：round 抹平日界两侧的毫秒偏差（含夏令时时钟偏移）
  const dayStart = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((dayStart(n) - dayStart(d)) / 86_400_000);
  if (diffDays <= 0) return hhmm; // 今天（含时钟偏差下的未来时间戳）
  if (diffDays === 1) return `昨天 ${hhmm}`;
  if (diffDays === 2) return `前天 ${hhmm}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (d.getFullYear() === n.getFullYear()) return `${md} ${hhmm}`;
  return `${d.getFullYear()}年${md} ${hhmm}`;
}
