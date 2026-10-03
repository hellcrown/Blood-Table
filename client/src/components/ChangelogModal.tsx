import { CHANGELOG } from '@shared/changelog';

/** 更新日志弹窗（大厅「📜 更新日志」入口）：展示版本演进，让玩家感知游戏在持续生长 */
export function ChangelogModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay codex-overlay" onClick={onClose}>
      <div className="panel codex-panel lb-panel" onClick={(e) => e.stopPropagation()}>
        <div className="codex-head">
          <h3 style={{ margin: 0 }}>📜 更新日志</h3>
          <span className="spacer" />
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="codex-body">
          {CHANGELOG.map((e) => (
            <div key={`${e.date}|${e.title}`} className="log-entry">
              <div className="log-entry-head">
                <b>{e.title}</b>
                <span className="hint">{e.date}</span>
              </div>
              <ul>
                {e.items.map((it, i) => (
                  <li key={i}>{it}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
