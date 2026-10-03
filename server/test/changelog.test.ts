import { describe, expect, it } from 'vitest';
import { CHANGELOG, LATEST, isStaleBundle, versionKey } from '@shared/changelog';

/**
 * 增删更新日志时的不变式。
 *
 * 前四条不是洁癖：`/api/version` 与前端「新版本已发布」提示都建立在
 * 「CHANGELOG[0] 是最新一条」+「日期为零填充 ISO 字符串」两条前提上，
 * 前提被悄悄破坏（例如有人把新条目追加到数组末尾）会静默让提示失效。
 * 最后一条守卫写作口径：更新日志是给玩家看的，开发/运维细节不该出现在里面。
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

  it('版本标识唯一：同一天发多次也能区分', () => {
    const keys = CHANGELOG.map(versionKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.length > 0)).toBe(true);
    expect(versionKey(null)).toBe('');
    expect(versionKey(undefined)).toBe('');
    expect(versionKey({ date: '2026-10-03', title: '标题' })).toBe('2026-10-03|标题');
  });

  it('isStaleBundle：只按日期判新旧，同日改标题不误报', () => {
    const bundled = { date: '2026-10-01', title: '互动玩法与稳定性持续打磨' };
    // 服务器日期更晚 → 本页是旧包，提示刷新
    expect(isStaleBundle({ date: '2026-10-05', title: '下一个版本' }, bundled)).toBe(true);
    // 服务器日期更早（本地开发 / 回滚中）→ 不提示
    expect(isStaleBundle({ date: '2026-09-25', title: '正式域名上线' }, bundled)).toBe(false);
    // 同一版 → 不提示
    expect(isStaleBundle(bundled, bundled)).toBe(false);
    // 关键：同日不同标题 → 不提示。两个方向谁在前无从判断，误报会让所有人白刷一次
    expect(isStaleBundle({ date: '2026-10-01', title: '同日改了个标题' }, bundled)).toBe(false);
    expect(isStaleBundle(bundled, { date: '2026-10-01', title: '同日改了个标题' })).toBe(false);
    // 拿不到服务器版本（离线 / 未升级的老服务端 / 返回的不是 JSON）→ 静默降级
    expect(isStaleBundle(null, bundled)).toBe(false);
    expect(isStaleBundle(undefined, bundled)).toBe(false);
    expect(isStaleBundle({ date: '', title: '' }, bundled)).toBe(false);
    expect(isStaleBundle(bundled, null)).toBe(false);
  });
});

describe('更新日志 · 面向玩家', () => {
  /**
   * 开发者/运维词汇黑名单：命中即说明写了玩家不需要知道的内部细节。
   * 这些内容属于 README 与提交记录，不该出现在玩家看到的日志里。
   */
  const DEV_WORDS: Array<[RegExp, string]> = [
    [/bloodtable/i, '运维命令名'],
    [/\bpm2\b/i, '进程守护工具'],
    [/nginx/i, '反向代理'],
    [/deploy/i, '部署脚本'],
    [/\bgit\b/i, '版本控制'],
    [/\btoken\b/i, '登录凭据'],
    [/仓库/, '代码仓库'],
    [/部署/, '部署'],
    [/运维/, '运维'],
    [/用例/, '测试用例'],
    [/接口|API/, '接口'],
    [/落库|数据库/, '存储'],
    [/管理员/, '管理端功能'],
    [/埋点/, '埋点'],
    [/服务器/, '服务端'],
    [/限流|并发/, '容量参数'],
    [/gzip|SEO|HTML|CSS|WebSocket/i, '技术术语'],
  ];

  it('标题与条目都不含开发/运维细节', () => {
    const offenders: string[] = [];
    for (const e of CHANGELOG) {
      for (const [re, why] of DEV_WORDS) {
        if (re.test(e.title)) offenders.push(`标题「${e.title}」含${why}：${re}`);
        for (const it of e.items) {
          if (re.test(it)) offenders.push(`条目含${why}：${it.slice(0, 40)}…`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('每条都有实质内容：标题非空、至少一条条目、条目不是空串', () => {
    for (const e of CHANGELOG) {
      expect(e.title.trim().length).toBeGreaterThan(0);
      expect(e.items.length).toBeGreaterThan(0);
      for (const it of e.items) expect(it.trim().length).toBeGreaterThan(0);
    }
  });

  it('黑名单确实有牙：历史上写过的开发者措辞都能被拦下', () => {
    // 都是本文档早期真实出现过的措辞（含被删掉的「运维命令入库」条目）。
    // 若哪天有人放宽正则，这些用例先红，守卫不会退化成永远通过的摆设。
    const legacyDevText = [
      '标题：版本提示 · 运维命令入库',
      '运维命令 bloodtable（update/restart/stop/logs/clear）纳入仓库：换机器、重装服务器不再丢命令',
      '更新不再打断对局：部署前自动等待进行中的对局打完（对局内会收到公告），超时才强制',
      '每局终局自动落库统计：管理员可查总局数、平均时长、角色出场与胜率',
      '并发容量提升：连接上限 1200、房间上限 400，静态资源 gzip 加速',
      'SEO 基础：站点标题/描述/分享卡片，搜索引擎收录提交',
      '游戏内反馈直通管理员面板',
      '大厅新增「⚡ 回到房间」：一键重进上次房间（token 失效也能回）',
      '经 nginx 反代，连接更稳定；安全加固轮（限流/断连防御）',
    ];
    for (const t of legacyDevText) {
      expect(
        DEV_WORDS.some(([re]) => re.test(t)),
        `这条开发者措辞没被拦下，请补正则：${t}`,
      ).toBe(true);
    }
  });
});
