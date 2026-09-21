import { useState } from 'react';

/** 玩家反馈弹窗：匿名提交问题（可选附联系方式）；对局内会自动附带房间码与昵称 */
export function FeedbackModal({
  onClose,
  roomCode,
  playerName,
}: {
  onClose: () => void;
  roomCode?: string;
  playerName?: string;
}) {
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const submit = (): void => {
    if (busy) return;
    if (!text.trim()) {
      setStatus({ ok: false, msg: '请填写问题描述' });
      return;
    }
    setBusy(true);
    fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        contact: contact || undefined,
        room: roomCode || undefined,
        name: playerName || undefined,
      }),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => null)) as { ok?: boolean; msg?: string } | null;
        if (r.ok && data?.ok) {
          setStatus({ ok: true, msg: data.msg ?? '反馈已提交，感谢你的帮助！' });
          setText('');
          setContact('');
        } else {
          setStatus({ ok: false, msg: data?.msg ?? '提交失败，请稍后再试' });
        }
      })
      .catch(() => setStatus({ ok: false, msg: '网络异常，请稍后再试' }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel feedback-modal" onClick={(e) => e.stopPropagation()}>
        <h3>📨 反馈游戏问题</h3>
        <div className="hint feedback-meta">
          {roomCode ? `房间 ${roomCode} · ` : ''}
          {playerName ? `玩家 ${playerName} · ` : ''}
          反馈匿名提交，仅开发者可见
        </div>
        {status?.ok ? (
          <>
            <div className="feedback-done">✅ {status.msg}</div>
            <div className="panel-actions" style={{ marginTop: 10 }}>
              <button className="btn" onClick={onClose}>
                关闭
              </button>
            </div>
          </>
        ) : (
          <>
            <textarea
              className="feedback-text"
              maxLength={500}
              rows={5}
              placeholder="描述你遇到的问题、bug 或建议（必填，最多 500 字）…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <input
              className="feedback-contact"
              maxLength={50}
              placeholder="联系方式（选填，如 QQ / 微信，方便回访）"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
            />
            {status && !status.ok && <p className="admin-error">{status.msg}</p>}
            <div className="panel-actions" style={{ marginTop: 10 }}>
              <button className="btn primary" disabled={busy || !text.trim()} onClick={submit}>
                {busy ? '提交中…' : '提交反馈'}
              </button>
              <button className="btn" onClick={onClose}>
                取消
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
