import { useEffect, useRef, useState } from 'react';
import { net } from '../net/socket';
import { useEscClose } from './useOverlayClose';
import { fmtChatTime } from '../chatTime';
import type { ChatMsg } from '@shared/protocol';

const LOCAL_MAX = 200;

type Scope = 'room' | 'global';

const SCOPE_HINT: Record<Scope, string> = {
  room: '仅本房间成员（含观战者）可见；房间解散后记录清空',
  global: '对所有在线玩家可见；文明发言，对局状态在服务器不受影响',
};

/** 实时消息追加（有界） */
function append(list: ChatMsg[], m: ChatMsg): ChatMsg[] {
  const next = [...list, m];
  return next.length > LOCAL_MAX ? next.slice(next.length - LOCAL_MAX) : next;
}

/**
 * 聊天弹层：房间内对话 + 全服聊天双页签（大厅无房间，仅全服）。
 * - 房间页签：仅同房间成员（含观战者）可见；历史挂在服务端房间对象上（上限 80 条，房间销毁即清空）
 * - 全服页签：消息广播给全服所有在线玩家
 * - 首次激活页签时拉一次历史快照（*chatLog 去重合并），此后实时追加广播（*chatMsg，含本人回显）；
 *   两个页签的后台消息持续累积，切回不丢
 * - 发送冷却 1.2s：两通道服务端均限频 10 秒 5 条（按 IP 独立计数），超频静默丢弃（无回显即未发出），
 *   冷却避免「发了没反应」的困惑
 * - 昵称：房间通道取会话名（入房已清洗查重，登录=账号名金色）；全服通道匿名=大厅昵称
 */
export function ChatModal({ onClose, roomScope = false }: { onClose: () => void; roomScope?: boolean }) {
  const [tab, setTab] = useState<Scope>(roomScope ? 'room' : 'global');
  const [store, setStore] = useState<Record<Scope, ChatMsg[]>>({ room: [], global: [] });
  const [draft, setDraft] = useState('');
  const [cooldown, setCooldown] = useState<Record<Scope, boolean>>({ room: false, global: false });
  const [rateLimited, setRateLimited] = useState<Record<Scope, boolean>>({ room: false, global: false });
  /** 与服务端 10 秒/5 条限频同窗口的本地计数（两通道独立）：提前拦住第 6-9 条，避免静默丢失 */
  const sendTimesRef = useRef<Record<Scope, number[]>>({ room: [], global: [] });
  /** 已拉取过历史快照的页签：切页签只拉一次，防反复请求撞限频 */
  const fetchedRef = useRef<Record<Scope, boolean>>({ room: false, global: false });
  const logRef = useRef<HTMLDivElement | null>(null);
  useEscClose(onClose);

  useEffect(() => {
    const merge = (scope: Scope, list: ChatMsg[]): void => {
      setStore((prev) => {
        // 快照与实时广播存在竞态窗口：按 (ts,name,text) 去重合并而非整体替换，
        // 防止快照生成前已收到的实时消息被抹掉
        const seen = new Set(prev[scope].map((m) => `${m.ts}|${m.name}|${m.text}`));
        const merged = [...prev[scope], ...list.filter((m) => !seen.has(`${m.ts}|${m.name}|${m.text}`))];
        merged.sort((a, b) => a.ts - b.ts);
        return { ...prev, [scope]: merged.slice(-LOCAL_MAX) };
      });
    };
    const offLog = net.onChatLog((list) => merge('global', list));
    const offRoomLog = net.onRoomChatLog((list) => merge('room', list));
    const offMsg = net.onChatMsg((m) => setStore((prev) => ({ ...prev, global: append(prev.global, m) })));
    const offRoomMsg = net.onRoomChatMsg((m) => setStore((prev) => ({ ...prev, room: append(prev.room, m) })));
    return () => {
      offLog();
      offRoomLog();
      offMsg();
      offRoomMsg();
    };
  }, []);

  // 首次激活页签时拉历史快照（挂载即拉当前页签，切页签懒拉一次）
  useEffect(() => {
    if (fetchedRef.current[tab]) return;
    fetchedRef.current[tab] = true;
    net.send(tab === 'global' ? { t: 'chatHistory' } : { t: 'roomChatHistory' });
  }, [tab]);

  const msgs = store[tab];

  // 新消息到达自动滚到底（v1 一律滚底，简单可靠）
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tab, msgs.length]);

  const send = (scope: Scope): void => {
    const text = draft.trim();
    if (!text || cooldown[scope]) return;
    const now = Date.now();
    const times = sendTimesRef.current[scope].filter((t) => now - t < 10_000);
    sendTimesRef.current[scope] = times;
    if (times.length >= 5) {
      // 已达服务端窗口上限：按最早一条过期时间冷却，明示而非静默丢失
      const wait = 10_000 - (now - times[0]!) + 100;
      setCooldown((c) => ({ ...c, [scope]: true }));
      setRateLimited((c) => ({ ...c, [scope]: true }));
      window.setTimeout(() => {
        setCooldown((c) => ({ ...c, [scope]: false }));
        setRateLimited((c) => ({ ...c, [scope]: false }));
      }, wait);
      return;
    }
    times.push(now);
    net.send(scope === 'global' ? { t: 'chat', text } : { t: 'roomChat', text });
    setDraft('');
    setCooldown((c) => ({ ...c, [scope]: true }));
    setRateLimited((c) => ({ ...c, [scope]: false }));
    window.setTimeout(() => setCooldown((c) => ({ ...c, [scope]: false })), 1200);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel chat-panel" onClick={(e) => e.stopPropagation()}>
        {roomScope ? (
          <>
            <h3>💬 聊天</h3>
            <div className="chat-tabs">
              <button className={`chat-tab ${tab === 'room' ? 'active' : ''}`} onClick={() => setTab('room')}>
                🏠 房间
              </button>
              <button className={`chat-tab ${tab === 'global' ? 'active' : ''}`} onClick={() => setTab('global')}>
                🌐 全服
              </button>
            </div>
          </>
        ) : (
          <h3>💬 全服聊天</h3>
        )}
        <p className="hint">{SCOPE_HINT[tab]}</p>
        <div className="chat-log" ref={logRef}>
          {msgs.length === 0 && <p className="hint">还没有消息，说点什么吧</p>}
          {msgs.map((m, i) => (
            <div key={`${m.ts}-${i}`} className="chat-msg">
              <span className="chat-time">{fmtChatTime(m.ts)}</span>
              <b className={m.account ? 'chat-name acct' : 'chat-name'}>{m.name}</b>
              <span className="chat-text">{m.text}</span>
            </div>
          ))}
        </div>
        <div className="chat-input-row">
          <input
            value={draft}
            maxLength={120}
            placeholder={
              rateLimited[tab] ? '发言太频繁，请稍候…' : cooldown[tab] ? '稍等片刻…' : '说点什么（最多 120 字）'
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // 输入法组合中的 Enter 是「确认候选词」，不能当发送
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(tab);
            }}
          />
          <button className="btn small primary" disabled={cooldown[tab] || !draft.trim()} onClick={() => send(tab)}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
