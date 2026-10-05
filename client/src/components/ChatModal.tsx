import { useEffect, useRef, useState } from 'react';
import { net } from '../net/socket';
import { useEscClose } from './useOverlayClose';
import type { ChatMsg } from '@shared/protocol';

const LOCAL_MAX = 200;

/**
 * 全服聊天弹层：任何页面都可打开发言，消息广播给全服所有在线玩家。
 * - 打开时拉一次历史快照（chatLog 替换），此后实时追加广播（chatMsg，含本人回显）
 * - 发送冷却 1.2s：服务端限频 10 秒 5 条，超频静默丢弃（无回显即未发出），冷却避免「发了没反应」的困惑
 * - 昵称：登录=账号名（金色），匿名=大厅昵称（服务端清洗 + 注册名保护）
 */
export function ChatModal({ onClose }: { onClose: () => void }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [cooldown, setCooldown] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  useEscClose(onClose);

  useEffect(() => {
    net.send({ t: 'chatHistory' });
    const offLog = net.onChatLog((list) => setMsgs(list.slice(-LOCAL_MAX)));
    const offMsg = net.onChatMsg((m) =>
      setMsgs((prev) => {
        const next = [...prev, m];
        return next.length > LOCAL_MAX ? next.slice(next.length - LOCAL_MAX) : next;
      }),
    );
    return () => {
      offLog();
      offMsg();
    };
  }, []);

  // 新消息到达自动滚到底（仅当用户未向上翻阅时？v1 一律滚底，简单可靠）
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const send = (): void => {
    const text = draft.trim();
    if (!text || cooldown) return;
    net.send({ t: 'chat', text });
    setDraft('');
    setCooldown(true);
    window.setTimeout(() => setCooldown(false), 1200);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel chat-panel" onClick={(e) => e.stopPropagation()}>
        <h3>💬 全服聊天</h3>
        <p className="hint">对所有在线玩家可见；文明发言，对局状态在服务器不受影响</p>
        <div className="chat-log" ref={logRef}>
          {msgs.length === 0 && <p className="hint">还没有消息，说点什么吧</p>}
          {msgs.map((m, i) => (
            <div key={`${m.ts}-${i}`} className="chat-msg">
              <span className="chat-time">
                {new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <b className={m.account ? 'chat-name acct' : 'chat-name'}>{m.name}</b>
              <span className="chat-text">{m.text}</span>
            </div>
          ))}
        </div>
        <div className="chat-input-row">
          <input
            value={draft}
            maxLength={120}
            placeholder={cooldown ? '稍等片刻…' : '说点什么（最多 120 字）'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
            }}
          />
          <button className="btn small primary" disabled={cooldown || !draft.trim()} onClick={send}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
