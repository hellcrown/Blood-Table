/**
 * 版本提示（客户端薄壳）：把「谁是旧包 / 有没有未读」的判定交给 shared 的纯函数，
 * 这里只负责取数（构建标识、fetch）与存储（localStorage）。
 *
 * 判定规则与理由见 @shared/updateNotice 的注释；本文件不再包含业务判断。
 */
import { LATEST, versionKey } from '@shared/changelog';
import { decideNotice, isStalePage, staleKey, type NoticeKind, type VersionRef } from '@shared/updateNotice';

export type { NoticeKind, VersionRef };

/** 记录玩家已读到的版本标识 */
const SEEN_KEY = 'bloodtable.changelogSeen';
/** 本次会话已忽略的"旧包"标识（sessionStorage：关掉标签页即失效，符合"稍后再说"的语义） */
const DISMISS_KEY = 'bloodtable.updateDismissed';
/** 轮询间隔：发版不会太频繁，5 分钟足够，且这是一个极小的 GET */
const POLL_MS = 5 * 60 * 1000;

/**
 * 本页的构建标识 = 自己这个哈希资源文件名（`index-XXXX.js`）。
 * 开发环境是 `/src/...` 这类路径，不匹配正则 → 返回 null → 判定自动回退到日期口径。
 */
export function bundledBuild(): string | null {
  try {
    const file = new URL(import.meta.url).pathname.split('/').pop() ?? '';
    return /^index-[A-Za-z0-9_-]+\.js$/.test(file) ? file : null;
  } catch {
    return null;
  }
}

/** 页面（打包产物）内的最新版本 */
export function bundledVersion(): VersionRef | null {
  if (!LATEST) return null;
  return { date: LATEST.date, title: LATEST.title, build: bundledBuild() };
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

/** 是否有未读的新内容（首次到访返回 false，理由见 shared/updateNotice） */
export function hasUnseen(): boolean {
  return decideNotice({
    bundled: bundledVersion(),
    server: null,
    seenKey: loadSeenKey(),
    dismissedKey: '',
  }) === 'notice';
}

/** 首次访问时静默记录当前版本，避免把「第一次来」当成「刚更新」 */
export function initSeenIfFirstVisit(): void {
  if (!loadSeenKey()) markSeen();
}

/** 本次会话已忽略的旧包标识 */
export function loadDismissedKey(): string {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveDismissedKey(key: string): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, key);
  } catch {
    /* 忽略 */
  }
}

/** 取服务器当前版本；失败（离线 / 老服务端无此接口）返回 null，调用方静默降级 */
export async function fetchServerVersion(): Promise<VersionRef | null> {
  try {
    const r = await fetch('/api/version', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!r.ok) return null;
    // 必须是 JSON：未升级的老服务端会把未知路径交给 SPA 回退，返回 200 + index.html，
    // 此时宁可当作「拿不到版本」（不提示）也不要让 HTML 进 JSON.parse 抛异常
    if (!(r.headers.get('content-type') ?? '').includes('application/json')) return null;
    const j = (await r.json()) as {
      ok?: boolean;
      latest?: { date?: unknown; title?: unknown } | null;
      build?: unknown;
    };
    const date = typeof j?.latest?.date === 'string' ? j.latest.date : '';
    const title = typeof j?.latest?.title === 'string' ? j.latest.title : '';
    if (!j?.ok || !date) return null;
    return { date, title, build: typeof j.build === 'string' ? j.build : null };
  } catch {
    return null;
  }
}

/** 版本展示文案：`2026-10-03 · 新版本提示` */
export function versionLabel(v: VersionRef | null): string {
  if (!v) return '';
  return v.title ? `${v.date} · ${v.title}` : v.date;
}

/** 本页是否为旧包 */
export function pageIsStale(server: VersionRef | null): boolean {
  return isStalePage(bundledVersion(), server);
}

/** 服务器版本的旧包标识（用于记住「稍后」） */
export function serverStaleKey(server: VersionRef | null): string {
  return staleKey(server);
}

export { decideNotice, POLL_MS };
