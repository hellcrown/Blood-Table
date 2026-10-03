/**
 * 版本提示：以「更新日志最新条目」作为唯一版本口径。
 *
 * - 服务端 GET /api/version 回报「服务器上跑的是哪一条日志」；与页面自己打包进去的条目比对，
 *   即可发现「页面还是旧包」（浏览器缓存住的老 JS）——这正是发版后老页面需要刷新的信号。
 * - 与 localStorage 里玩家已读过的条目标识比对，可发现「有新内容未读」（大厅角标与提示条）。
 *
 * 只用日期不够：09-28 当天发过三条，日期相同会被误判成「没变化」，故标识带上标题。
 */
import { LATEST, isNewerVersion, versionKey, type ChangelogRef } from '@shared/changelog';

export type VersionRef = ChangelogRef;

/** 记录玩家已读到的版本标识 */
const SEEN_KEY = 'bloodtable.changelogSeen';
/** 轮询间隔：发版不会太频繁，5 分钟足够，且这是一个极小的 GET */
const POLL_MS = 5 * 60 * 1000;

/** 页面（打包产物）内的最新版本 */
export function bundledVersion(): VersionRef | null {
  return LATEST ? { date: LATEST.date, title: LATEST.title } : null;
}

export function bundledKey(): string {
  return versionKey(LATEST);
}

/** 玩家已读版本标识（隐私模式下 localStorage 可能不可用，一律容错） */
export function loadSeenKey(): string {
  try {
    return window.localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 标记「已读到当前版本」（打开更新日志或点掉提示条时调用） */
export function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, bundledKey());
  } catch {
    /* 存储不可用：本次会话内不再提示由组件状态负责 */
  }
}

/**
 * 是否有未读的新内容。
 * 首次访问（无记录）返回 false：新玩家不该被告知「新版本已发布」——那是他第一次见到的版本；
 * 随后由 initSeenIfFirstVisit() 悄悄记下，之后的发版才会提示。
 */
export function hasUnseen(): boolean {
  if (!LATEST) return false;
  const seen = loadSeenKey();
  if (!seen) return false;
  return versionKey(LATEST) !== seen;
}

/** 首次访问时静默记录当前版本，避免把「第一次来」当成「刚更新」 */
export function initSeenIfFirstVisit(): void {
  if (!loadSeenKey()) markSeen();
}

/** 取服务器当前版本；失败（离线 / 老服务端无此接口）返回 null，调用方静默降级 */
export async function fetchServerVersion(): Promise<VersionRef | null> {
  try {
    const r = await fetch('/api/version', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!r.ok) return null;
    // 必须是 JSON：未升级的老服务端会把未知路径交给 SPA 回退，返回 200 + index.html，
    // 此时宁可当作「拿不到版本」（不提示）也不要让 HTML 进 JSON.parse 抛异常
    if (!(r.headers.get('content-type') ?? '').includes('application/json')) return null;
    const j = (await r.json()) as { ok?: boolean; latest?: { date?: unknown; title?: unknown } | null };
    const date = typeof j?.latest?.date === 'string' ? j.latest.date : '';
    const title = typeof j?.latest?.title === 'string' ? j.latest.title : '';
    if (!j?.ok || !date) return null;
    return { date, title };
  } catch {
    return null;
  }
}

/** 版本展示文案：`2026-10-03 · 版本提示 · 运维命令入库` */
export function versionLabel(v: VersionRef | null): string {
  if (!v) return '';
  return v.title ? `${v.date} · ${v.title}` : v.date;
}

export { isNewerVersion };
