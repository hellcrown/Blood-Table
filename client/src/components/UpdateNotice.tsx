import { useEffect, useState } from 'react';
import {
  bundledVersion,
  fetchServerVersion,
  loadDismissedKey,
  pageIsStale,
  saveDismissedKey,
  serverStaleKey,
  versionLabel,
  type VersionRef,
} from '../net/version';

/**
 * 「新版本已发布」提示（大厅）。
 *
 * 两种情形，优先级不同：
 * 1) 页面是旧包（服务器部署的构建与页面自己的构建标识不同）→ 金色横幅 +「立即刷新」：
 *    不刷新就一直在旧逻辑上玩。
 * 2) 本页已是最新版，但玩家没读过这次的更新日志 → 细提示条 +「查看更新」，点开或点掉即消。
 *
 * 「稍后」的忽略状态绑到**具体版本**（staleKey）并存 sessionStorage：
 * 原先用一个布尔 state，点过一次就再也不提示 —— 之后无论发多少版都收不到刷新提醒。
 */
export function UpdateNotice({
  unseen,
  onOpenChangelog,
  onDismissUnseen,
}: {
  unseen: boolean;
  onOpenChangelog: () => void;
  onDismissUnseen: () => void;
}) {
  const [stale, setStale] = useState<VersionRef | null>(null);
  const [dismissedKey, setDismissedKey] = useState(() => loadDismissedKey());

  useEffect(() => {
    let alive = true;
    const check = async (): Promise<void> => {
      const server = await fetchServerVersion();
      if (!alive) return;
      // 服务器部署的构建与页面自己的不同 → 本页是旧包；取不到构建标识时回退按更新日志日期比
      setStale(server && pageIsStale(server) ? server : null);
    };
    void check();
    const timer = window.setInterval(() => void check(), 5 * 60 * 1000);
    // 回到前台立刻复查：玩家切走时发的版，切回来即可见
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  if (stale && serverStaleKey(stale) !== dismissedKey) {
    return (
      <div className="update-banner">
        <div className="update-banner-text">
          <b>🆕 新版本已发布</b>
          <span className="hint">{versionLabel(stale)}</span>
          <span className="hint">你当前打开的是旧版本，刷新即可用上最新改动（对局状态在服务器，重连后按提示回到大厅）</span>
        </div>
        <div className="update-banner-actions">
          <button className="btn small primary" onClick={() => window.location.reload()}>
            立即刷新
          </button>
          <button
            className="btn small ghost"
            onClick={() => {
              const key = serverStaleKey(stale);
              saveDismissedKey(key);
              setDismissedKey(key);
            }}
          >
            稍后
          </button>
        </div>
      </div>
    );
  }

  if (unseen) {
    return (
      <div className="update-notice">
        <span>🎉 新版本已发布：{versionLabel(bundledVersion())}</span>
        <button className="btn small primary" onClick={onOpenChangelog}>
          查看更新
        </button>
        <button className="btn small ghost" onClick={onDismissUnseen}>
          知道了
        </button>
      </div>
    );
  }

  return null;
}
