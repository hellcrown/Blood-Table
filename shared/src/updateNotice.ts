/**
 * 「新版本已发布」提示的判定逻辑（纯函数，放 shared 供客户端与测试共用）。
 *
 * 为什么需要它：这段判定原先散在客户端组件里，而客户端没有测试基建 ——
 * 恰恰是"有状态、有时序、最容易出错"的一块（历史缺陷：点过「稍后」之后**再也不提示**）。
 * 抽成纯函数后，服务端的 vitest 就能覆盖它。
 *
 * 两个层次的版本口径：
 * - **构建标识**（哈希资源文件名，如 `index-BxY-_A9X.js`）：页面用 import.meta.url 得到自己的，
 *   服务端 /api/version 下发当前部署的。两者不等 = 页面是旧包。它能识别**同日多次发版**，
 *   而"更新日志日期"不能 —— 实测最近 30 个提交里有 21 个根本没动更新日志。
 * - **更新日志版本标识**（日期 + 标题）：构建标识取不到时（开发环境、老服务端）回退用它，
 *   按日期比较、同日不提示（两个方向都无从判断先后，宁可漏报也不误报）。
 */
import { isStaleBundle, versionKey, type ChangelogRef } from './changelog';

export interface VersionRef extends ChangelogRef {
  /** 构建标识：哈希资源文件名；开发环境 / 老服务端为 null */
  build?: string | null;
}

/** banner = 页面是旧包，提示刷新；notice = 本页最新但有未读更新日志；none = 不提示 */
export type NoticeKind = 'banner' | 'notice' | 'none';

export interface NoticeInput {
  bundled: VersionRef | null;
  server: VersionRef | null;
  /** 玩家已读到的版本标识（'' = 首次到访） */
  seenKey: string;
  /** 本次会话已忽略的"旧包"标识（'' = 未忽略过任何版本） */
  dismissedKey: string;
}

/** 本页是否为旧包（该提示刷新了） */
export function isStalePage(bundled: VersionRef | null, server: VersionRef | null): boolean {
  if (!bundled || !server) return false;
  if (bundled.build && server.build) return bundled.build !== server.build;
  return isStaleBundle(server, bundled);
}

/**
 * 旧包的身份标识：用于记住「稍后」。
 * 必须绑到**具体版本**而不是一个布尔值 —— 否则点过一次「稍后」就再也不提示，
 * 之后无论发多少版都收不到刷新提醒（历史缺陷）。
 */
export function staleKey(server: VersionRef | null): string {
  if (!server) return '';
  return server.build ? `build:${server.build}` : `v:${versionKey(server)}`;
}

export function decideNotice(input: NoticeInput): NoticeKind {
  const { bundled, server, seenKey, dismissedKey } = input;
  if (isStalePage(bundled, server) && staleKey(server) !== dismissedKey) return 'banner';
  // 首次到访（seenKey 为空）不算"有新内容"：那是玩家第一次见到的版本，
  // 由调用方静默记下即可，否则每个新玩家一进门就被告知"刚更新"
  if (seenKey && bundled && versionKey(bundled) !== seenKey) return 'notice';
  return 'none';
}
