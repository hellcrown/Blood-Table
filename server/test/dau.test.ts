/**
 * 日活统计回归测试：同日去重、跨天切分、保留天数裁剪、快照落盘与重载。
 * 假时钟固定「今天」避免随真实日期漂移；每例 resetModules 取全新模块实例（dau 是模块级单例状态）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 固定「现在」= 指定日期 12:00（服务器本地时区） */
function setNow(d: Date): void {
  vi.setSystemTime(d);
}
const at = (y: number, m: number, day: number): Date => new Date(y, m - 1, day, 12, 0, 0);

async function fresh() {
  vi.resetModules();
  return await import('../src/dau');
}

describe('dau · 日活统计', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setNow(at(2026, 10, 6));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('同日去重：重复 IP/账号只计一次，连接次数照加；无流量日按日历补零', async () => {
    const dau = await fresh();
    dau.recordConnection('1.1.1.1');
    dau.recordConnection('1.1.1.1');
    dau.recordConnection('2.2.2.2');
    dau.recordAccountVisit('acc-A');
    dau.recordAccountVisit('acc-A');
    const days = dau.dauSummary(7);
    expect(days).toHaveLength(7); // 零日补齐：09-30..10-05 为零行，表格日期不错位；[0] 恒为今天
    expect(days[0]).toEqual({ day: '2026-10-06', uv: 2, accounts: 1, conns: 3 });
    expect(days[6]).toEqual({ day: '2026-09-30', uv: 0, accounts: 0, conns: 0 });
  });

  it('跨天切分：新的一天开启新条目，旧条目不变', async () => {
    const dau = await fresh();
    dau.recordConnection('1.1.1.1');
    dau.recordAccountVisit('acc-A');
    setNow(at(2026, 10, 7));
    dau.recordConnection('3.3.3.3');
    const days = dau.dauSummary(7);
    // 最近 7 天（10-01..10-07），其中 10-06/07 有数据、其余零行；[0] 恒为今天
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ day: '2026-10-07', uv: 1, accounts: 0, conns: 1 });
    expect(days[1]).toEqual({ day: '2026-10-06', uv: 1, accounts: 1, conns: 1 });
    expect(days[6]).toEqual({ day: '2026-10-01', uv: 0, accounts: 0, conns: 0 });
  });

  it('保留天数裁剪：内部最多 180 天；summary 恒为 lastN 个日历日（超出窗口补零）', async () => {
    const dau = await fresh();
    for (let i = 199; i >= 0; i--) {
      setNow(at(2026, 10, 6 - i)); // 从 200 天前正向记到今天（Date 算术自动跨月回退）
      dau.recordConnection(`10.0.0.${i}`);
    }
    expect(dau.dauSummary(30)).toHaveLength(30);
    expect(dau.dauSummary(30)[0]!.day).toBe('2026-10-06');
    // 零日补齐语义：summary(500) 恒为 500 个日历日（超出 180 天保留窗的部分为全零行）
    expect(dau.dauSummary(500)).toHaveLength(500);
  });

  it('快照落盘与重载：模拟重启后数据完整恢复', async () => {
    const file = path.join(os.tmpdir(), `blood-dau-test-${Math.random().toString(36).slice(2)}.json`);
    try {
      const dau1 = await fresh();
      dau1.initDauStore(file);
      dau1.recordConnection('1.1.1.1');
      dau1.recordConnection('1.1.1.1');
      dau1.recordAccountVisit('acc-A');
      dau1.flushDau();
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).days).toEqual([
        { day: '2026-10-06', ips: ['1.1.1.1'], accounts: ['acc-A'], conns: 2 },
      ]);
      // 模拟进程重启：全新模块实例从文件恢复
      const dau2 = await fresh();
      dau2.initDauStore(file);
      const days = dau2.dauSummary(7);
      expect(days).toHaveLength(7);
      expect(days[0]).toEqual({ day: '2026-10-06', uv: 1, accounts: 1, conns: 2 });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('未初始化存储时纯内存可用（测试环境口径）', async () => {
    const dau = await fresh();
    dau.recordConnection('9.9.9.9');
    const days = dau.dauSummary(7);
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ day: '2026-10-06', uv: 1, accounts: 0, conns: 1 });
  });
});
