import { describe, expect, it } from 'vitest';
import {
  bundledVersion,
  loadDismissedKey,
  loadSeenKey,
  pageIsStale,
  POLL_MS,
  serverStaleKey,
  versionLabel,
} from '../src/net/version';

/**
 * 客户端版本提示的「薄壳」部分：判定逻辑在 @shared/updateNotice 里已有完整覆盖，
 * 这里只钉住两件在真实浏览器里出过问题的事：
 * 1. 存储不可用（隐私模式 / 禁用 storage）时必须静默降级，不能抛异常把整个页面带崩；
 * 2. 文案与旧包判定在"拿不到服务端版本"时的兜底表现为「不提示」。
 * 本文件在 node 环境下运行（没有 window），恰好就是存储不可用的最严格场景。
 */
describe('客户端 · 版本提示薄壳', () => {
  it('存储不可用时读取一律返回空串而不抛异常', () => {
    // 环境守卫：本文件的前提是 node（无 window）。若未来配置漂移把本文件划进 jsdom
    // （存储可用），测试照样会绿但测的不再是「存储不可用」——这里让它当场红而不是静默失效
    expect(typeof window).toBe('undefined');
    expect(loadSeenKey()).toBe('');
    expect(loadDismissedKey()).toBe('');
  });

  it('开发态（非哈希产物）推断不出构建标识，回退到日期口径', () => {
    const v = bundledVersion();
    if (v) expect(v.build).toBeNull();
  });

  it('拿不到服务端版本时不判定为旧包', () => {
    expect(pageIsStale(null)).toBe(false);
    expect(serverStaleKey(null)).toBe('');
  });

  it('文案：有标题用 `日期 · 标题`，无标题只显示日期，无版本返回空串', () => {
    expect(versionLabel({ date: '2026-10-03', title: '新版本提示', build: null })).toBe('2026-10-03 · 新版本提示');
    expect(versionLabel({ date: '2026-10-03', title: '', build: null })).toBe('2026-10-03');
    expect(versionLabel(null)).toBe('');
  });

  it('轮询间隔是 5 分钟（发版不频繁，且这是一个极小的 GET）', () => {
    expect(POLL_MS).toBe(5 * 60 * 1000);
  });
});
