/**
 * 全面审查（2026-10-03）批次 G 的回归测试：「新版本已发布」提示的判定。
 *
 * 这段逻辑原先只在客户端组件里，而客户端没有测试基建 —— 偏偏它是有状态、有时序、
 * 且**真的出过缺陷**（点过一次「稍后」后永不再提示）的那一块。
 * 现已抽成 shared/src/updateNotice.ts 的纯函数，用服务端既有基建覆盖。
 *
 * 另一处改进的依据：版本口径原本只看更新日志日期，而实测最近 30 个提交里有 21 个根本没动
 * 更新日志 —— 同一天内多次发版（常态）就完全检测不到。改为优先比构建标识（哈希资源文件名），
 * 取不到时才回退日期口径。
 */
import { describe, expect, it } from 'vitest';
import { decideNotice, isStalePage, staleKey, type VersionRef } from '@shared/updateNotice';
import { versionKey } from '@shared/changelog';

/** 造一个版本引用（build 为 null 表示老服务端 / 开发环境） */
const v = (date: string, title: string, build: string | null = null): VersionRef => ({ date, title, build });

describe('批次 G · 旧包判定（构建标识优先，回退日期）', () => {
  it('构建标识不同 → 本页是旧包（同一日内多次发版也认得出）', () => {
    const bundled = v('2026-10-03', '新版本提示', 'index-OLD.js');
    const server = v('2026-10-03', '新版本提示', 'index-NEW.js');
    expect(isStalePage(bundled, server)).toBe(true);
  });

  it('构建标识相同 → 本页就是最新（哪怕服务端日志标题被改过）', () => {
    const bundled = v('2026-10-03', 'A', 'index-SAME.js');
    const server = v('2026-10-03', 'B', 'index-SAME.js');
    expect(isStalePage(bundled, server)).toBe(false);
  });

  it('取不到构建标识 → 回退日期口径：同日不同标题不提示（不误报让所有人白刷一次）', () => {
    const bundled = v('2026-10-01', '互动玩法与稳定性持续打磨', null);
    const server = v('2026-10-01', '同日改了个标题', null);
    expect(isStalePage(bundled, server)).toBe(false);
  });

  it('取不到构建标识、服务器日志日期更晚 → 仍能提示刷新', () => {
    const bundled = v('2026-10-01', '旧条目', null);
    const server = v('2026-10-05', '新条目', null);
    expect(isStalePage(bundled, server)).toBe(true);
  });

  it('单侧有构建标识时不混用口径（避免把"拿不到"当成"不同"）', () => {
    const bundled = v('2026-10-01', '旧条目', 'index-OLD.js');
    const server = v('2026-10-01', '旧条目', null);
    expect(isStalePage(bundled, server)).toBe(false); // 回退日期：同日 → 不提示
  });

  it('拿不到服务端版本 / 本页无日志 → 一律不提示（静默降级）', () => {
    expect(isStalePage(v('2026-10-01', 'x', 'a.js'), null)).toBe(false);
    expect(isStalePage(null, v('2026-10-05', 'y', 'b.js'))).toBe(false);
  });
});

describe('批次 G · 「稍后」必须绑到具体版本（历史缺陷：点过就永不再提示）', () => {
  const bundled = v('2026-10-03', '新版本提示', 'index-PAGE.js');

  it('忽略当前版本后不再提示；但服务器再发新版时必须重新提示', () => {
    const first = v('2026-10-03', '新版本提示', 'index-A.js');
    const second = v('2026-10-04', '下一个版本', 'index-B.js');
    const dismissed = staleKey(first);
    // 同一版本：已忽略 → 不提示（语义："稍后"而非"永不"）
    expect(decideNotice({ bundled, server: first, seenKey: '', dismissedKey: dismissed })).toBe('none');
    // 换了版本：必须重新提示
    expect(decideNotice({ bundled, server: second, seenKey: '', dismissedKey: dismissed })).toBe('banner');
  });

  it('无构建标识时按「日期+标题」作为忽略键，换版本后同样会重新提示', () => {
    const first = v('2026-10-03', 'A', null);
    const second = v('2026-10-04', 'B', null);
    const bundled = v('2026-10-03', 'A', null);
    const dismissed = staleKey(first);
    expect(dismissed).toBe(`v:${versionKey(first)}`);
    expect(decideNotice({ bundled, server: first, seenKey: '', dismissedKey: dismissed })).toBe('none');
    expect(decideNotice({ bundled, server: second, seenKey: '', dismissedKey: dismissed })).toBe('banner');
  });

  it('同日第二条日志（无构建标识）不判旧包：日期口径的已知取舍，不误报让全站白刷', () => {
    const bundled = v('2026-10-03', 'A', null);
    const sameDaySecond = v('2026-10-03', 'B', null);
    expect(decideNotice({ bundled, server: sameDaySecond, seenKey: versionKey(bundled), dismissedKey: '' })).toBe('none');
    // 而一旦服务端能给出构建标识（本次改动后就有），同日发版立刻能被识别
    const withBuild = v('2026-10-03', 'B', 'index-NEW.js');
    expect(decideNotice({ bundled: v('2026-10-03', 'A', 'index-OLD.js'), server: withBuild, seenKey: '', dismissedKey: '' })).toBe(
      'banner',
    );
  });
});

describe('批次 G · 未读内容提示', () => {
  const bundled = v('2026-10-03', '新版本提示', 'index-PAGE.js');

  it('首次到访不算"有新内容"（否则每个新玩家一进门就被说"刚更新"）', () => {
    expect(decideNotice({ bundled, server: null, seenKey: '', dismissedKey: '' })).toBe('none');
  });

  it('已读标识与当前版本不同 → 提示未读；相同 → 不提示', () => {
    const seenOld = versionKey(v('2026-10-01', '上一条', null));
    expect(decideNotice({ bundled, server: null, seenKey: seenOld, dismissedKey: '' })).toBe('notice');
    expect(decideNotice({ bundled, server: null, seenKey: versionKey(bundled), dismissedKey: '' })).toBe('none');
  });

  it('旧包横幅优先于未读提示（先让玩家刷新，再看更新内容）', () => {
    const server = v('2026-10-09', '更新的版本', 'index-OTHER.js');
    expect(decideNotice({ bundled, server, seenKey: '', dismissedKey: '' })).toBe('banner');
  });
});
