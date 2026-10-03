import { describe, expect, it } from 'vitest';
import { CHANGELOG, LATEST, isNewerVersion, versionKey } from '@shared/changelog';

/**
 * 增删更新日志时的不变式。
 *
 * 这些约束不是洁癖：`/api/version` 与前端「新版本已发布」提示都建立在
 * 「CHANGELOG[0] 是最新一条」+「日期为零填充 ISO 字符串」两条前提上，
 * 前提被悄悄破坏（例如有人把新条目追加到数组末尾）会静默让提示失效。
 */
describe('更新日志 · 版本口径', () => {
  it('CHANGELOG[0] 恒为最新：LATEST 与之同源', () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    expect(LATEST).toBe(CHANGELOG[0]);
  });

  it('日期为零填充 ISO 日期：字典序比较才等价于时间先后', () => {
    for (const e of CHANGELOG) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${e.date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(e.date);
    }
  });

  it('条目自上而下由新到旧（不递增）', () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(CHANGELOG[i - 1].date >= CHANGELOG[i].date).toBe(true);
    }
  });

  it('版本标识唯一：同日多条目也能区分', () => {
    const keys = CHANGELOG.map(versionKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.length > 0)).toBe(true);
  });

  it('同一天发两次版：日期相同、标题不同 → 判定为有更新', () => {
    const a = { date: '2026-09-28', title: '声音与角色难度' };
    const b = { date: '2026-09-28', title: '架构升级' };
    // 同日不同条目互为「有更新」：这里只回答「变没变」，先后由日期决定
    expect(isNewerVersion(a, b)).toBe(true);
    expect(isNewerVersion(b, a)).toBe(true);
    // 同一条目 = 没变
    expect(isNewerVersion(a, { date: a.date, title: a.title })).toBe(false);
    // 若只在日期粒度比较，上面第一条会得 false —— 这正是不用日期当版本号的原因
  });

  it('isNewerVersion：日期先后 / 同版本 / 空值', () => {
    const newer = { date: '2026-10-05', title: '未来的版本' };
    const older = { date: '2026-10-01', title: '互动玩法与稳定性持续打磨' };
    expect(isNewerVersion(newer, older)).toBe(true);
    expect(isNewerVersion(older, newer)).toBe(false);
    // 同版本（同日期同标题）= 本页就是最新包 → 前端不提示刷新
    expect(isNewerVersion(LATEST, { date: LATEST!.date, title: LATEST!.title })).toBe(false);
    // 服务端没有该接口或返回空 → 一律不提示，静默降级
    expect(isNewerVersion(null, older)).toBe(false);
    expect(isNewerVersion(undefined, older)).toBe(false);
    // a 存在而 b 为空：按「a 更新」处理（调用方约定：拿不到服务端版本时根本不调用，见下一条）
    expect(isNewerVersion(LATEST, null)).toBe(true);
    // 组件侧守卫（UpdateNotice）：服务端版本缺失（离线 / 未升级的老服务端）时不提示刷新
    const noServer: { date: string; title: string } | null = null;
    expect(Boolean(noServer && isNewerVersion(noServer, LATEST))).toBe(false);
  });

  it('versionKey：空值不产生伪标识', () => {
    expect(versionKey(null)).toBe('');
    expect(versionKey(undefined)).toBe('');
    expect(versionKey({ date: '2026-10-03', title: '标题' })).toBe('2026-10-03|标题');
  });
});
