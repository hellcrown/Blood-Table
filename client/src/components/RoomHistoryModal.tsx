/**
 * 房间对局记录弹窗（各游戏页 page-bar「📜」入口）：
 * 打开时拉一次 roomMatchHistory 快照（条件渲染=每次打开重新拉，天然看到最新终局），
 * 新局在前；心有灵犀条目展开完整轮次对照（复用 .cv-row 相遇之路标记结构，顶部标注左右两侧是谁），
 * 其余模式渲染服务端拼好的名次行。记录随房间存亡——离开房间即不可看（服务端房绑定保证）。
 */
import { useEffect, useState } from 'react';
import type { RoomMatchEntry } from '@shared/protocol';
import { net } from '../net/socket';
import { fmtChatTime } from '../chatTime';
import { useEscClose } from './useOverlayClose';

export function RoomHistoryModal({ onClose }: { onClose: () => void }) {
  useEscClose(onClose);
  const [entries, setEntries] = useState<RoomMatchEntry[] | null>(null);
  const [offline, setOffline] = useState(false);

  // 订阅与请求放在同一个无守卫 effect：严格模式下 effect 双跑时退订后会重新订阅（多发一次请求无害，服务端有限流）
  useEffect(() => {
    const off = net.onRoomMatchLog((list) => {
      setOffline(false);
      setEntries(list);
    });
    if (!net.send({ t: 'roomMatchHistory' })) setOffline(true);
    return off;
  }, []);

  return (
    <div className="overlay codex-overlay" onClick={onClose}>
      <div className="panel codex-panel lb-panel" onClick={(e) => e.stopPropagation()}>
        <div className="codex-head">
          <h3 style={{ margin: 0 }}>📜 对局记录</h3>
          <span className="spacer" />
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="codex-body">
          {offline && entries == null && (
            <div className="hint" style={{ padding: '8px 2px' }}>
              未连接服务器，连接恢复后再打开查看
            </div>
          )}
          {!offline && entries == null && <div className="hint" style={{ padding: '8px 2px' }}>加载中…</div>}
          {entries != null && entries.length === 0 && (
            <div className="hint" style={{ padding: '8px 2px' }}>
              本房间还没有打完的对局——记录只在房间内保留，离开房间后不可再看
            </div>
          )}
          {entries?.map((e, i) => (
            <MatchEntryCard key={`${e.startedAt}-${e.mode}-${i}`} entry={e} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MatchEntryCard({ entry: e }: { entry: RoomMatchEntry }) {
  return (
    <div className="log-entry rh-entry">
      <div className="log-entry-head">
        <b>{e.title}</b>
        <span className="hint">
          {fmtChatTime(e.endedAt)}
          {e.durationMin != null ? ` · ${e.durationMin} 分钟` : ''}
        </span>
      </div>
      {e.converge ? (
        // 心有灵犀：完整轮次对照（与对局页「相遇之路」同款标记结构）；entries 与 ranks 都按 seat 升序
        <div className="rh-cv">
          <div className="hint rh-cv-names">
            {e.ranks[0]?.name ?? '?'}（左） × {e.ranks[1]?.name ?? '?'}（右）
          </div>
          {e.converge.rounds.map((r) => (
            <div key={r.n} className={`cv-row${r.same ? ' cv-same' : ''}`}>
              <span className="cv-n">第{r.n}轮</span>
              <div className="cv-duo">
                <span className="cv-pill">{r.entries[0]?.text}</span>
                <span className="cv-x">{r.same ? '✓' : '×'}</span>
                <span className="cv-pill">{r.entries[1]?.text}</span>
              </div>
            </div>
          ))}
          {e.converge.rounds.length === 0 && (
            <div className="hint">
              一轮都没揭示就结束了（
              {e.converge.result.reason === 'abort'
                ? '房主终止'
                : e.converge.result.reason === 'leave'
                  ? '有人离开'
                  : '全员断线'}
              ）
            </div>
          )}
        </div>
      ) : (
        <div className="rh-ranks">
          {e.ranks.map((r, i) => (
            <div key={r.seat} className={`result-row${e.winnerSeat === r.seat ? ' winner' : ''}`}>
              <span className="r-name">
                {e.ranks.length > 1 ? `${i + 1}. ` : ''}
                {r.name}
              </span>
              <span className="r-hand">{r.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
