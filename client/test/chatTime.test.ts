/**
 * fmtChatTime 回归测试：今天/昨天/前天/当年更早/跨年的显示口径，以及日界两侧的边界。
 * 全部用本地时间构造（now 注入），不依赖运行环境的时区。
 */
import { describe, expect, it } from 'vitest';
import { fmtChatTime } from '../src/chatTime';

/** 本地时间构造 helper：new Date(2026, 9, 6, 10, 30) = 2026-10-06 10:30 */
const at = (y: number, m: number, d: number, hh: number, mm: number, s = 0, ms = 0): number =>
  new Date(y, m - 1, d, hh, mm, s, ms).getTime();

// 固定「现在」= 2026-10-06 10:30，避免用例随真实日期漂移
const NOW = at(2026, 10, 6, 10, 30);

describe('fmtChatTime · 相对日期口径', () => {
  it('今天：只显示 HH:mm（补零）', () => {
    expect(fmtChatTime(at(2026, 10, 6, 9, 15), NOW)).toBe('09:15');
    expect(fmtChatTime(at(2026, 10, 6, 0, 5), NOW)).toBe('00:05');
    expect(fmtChatTime(at(2026, 10, 6, 10, 30), NOW)).toBe('10:30');
  });

  it('昨天 / 前天：相对标注 + 时间', () => {
    expect(fmtChatTime(at(2026, 10, 5, 23, 59), NOW)).toBe('昨天 23:59');
    expect(fmtChatTime(at(2026, 10, 5, 0, 0), NOW)).toBe('昨天 00:00');
    expect(fmtChatTime(at(2026, 10, 4, 8, 5), NOW)).toBe('前天 08:05');
  });

  it('当年更早：M月D日 HH:mm；跨年：带年份', () => {
    expect(fmtChatTime(at(2026, 10, 1, 14, 30), NOW)).toBe('10月1日 14:30');
    expect(fmtChatTime(at(2026, 1, 1, 0, 1), NOW)).toBe('1月1日 00:01');
    expect(fmtChatTime(at(2025, 12, 31, 22, 10), NOW)).toBe('2025年12月31日 22:10');
  });

  it('日界边界：昨天最后一毫秒与今天零点只差一天；未来时间戳按今天处理', () => {
    expect(fmtChatTime(at(2026, 10, 5, 23, 59, 59, 999), NOW)).toBe('昨天 23:59');
    expect(fmtChatTime(at(2026, 10, 6, 0, 0, 0, 0), NOW)).toBe('00:00');
    // 对方设备时钟偏快：时间戳在「现在」之后，不得显示成负数天数相关的怪文案
    expect(fmtChatTime(NOW + 3_600_000, NOW)).toBe('11:30');
  });

  it('整点差恰好一天即「昨天」，不因毫秒取整漂移到「前天」', () => {
    const now = at(2026, 3, 10, 12, 0);
    expect(fmtChatTime(at(2026, 3, 9, 12, 0), now)).toBe('昨天 12:00');
    expect(fmtChatTime(at(2026, 3, 8, 12, 0), now)).toBe('前天 12:00');
    expect(fmtChatTime(at(2026, 3, 7, 12, 0), now)).toBe('3月7日 12:00');
  });
});
