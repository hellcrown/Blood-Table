/**
 * 心有灵犀 · 对局页
 * 双人填词趋同：每轮各写一个文本，双方都提交才揭示比对（判同口径在 @shared/convergeProtocol
 * 与服务端同源）。历史按轮对照展示（左 seat0 × 右 seat1，参考双列版式），相遇轮金框高亮；
 * 输入在对方提交前可反复修改（本地草稿，round 变更时以服务端 myText 重置——
 * 故意不盯 myText 本身：提交后继续打字的草稿不能被服务端回显清掉）。
 * 布局：页面本体不滚（body overflow:hidden 全局裁剪），相遇之路是内部滚动区——
 * 输入框恒在屏内，历史撑不下时自己出滚动条，且新一轮揭示/终局时自动滚到最新一行。
 */
import { useEffect, useRef, useState } from 'react';
import type { ConvergeView } from '@shared/convergeProtocol';
import { CONVERGE_TEXT_MAX } from '@shared/convergeProtocol';
import { net } from '../net/socket';
import { ChatModal } from '../components/ChatModal';
import { RoomHistoryModal } from '../components/RoomHistoryModal';
import { useEscClose } from '../components/useOverlayClose';
import { playSfx } from '../audio/sound';

/** 心有灵犀 · 对局页 */
export function ConvergeTable({ view }: { view: ConvergeView }) {
  const [chatOpen, setChatOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useEscClose(() => setHelpOpen(false), helpOpen);

  const me = view.players.find((p) => p.id === net.playerId);
  const spectating = !me;
  const isHost = view.hostId === net.playerId;
  const other = view.players.find((p) => p.id !== net.playerId);

  // 本地草稿：只在轮次推进 / 新一局 / 终局时重置（用服务端 myText 回填断线重连场景）
  const [draft, setDraft] = useState('');
  useEffect(() => {
    setDraft(view.myText ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.round, view.phase, view.startedAt]);

  // 相遇音效：只在「未相遇 → 相遇」的跳变时播一次（state 帧是全量重发，不能按对象身份判变化）
  const matched = view.result?.matched === true;
  useEffect(() => {
    if (matched) playSfx('win');
  }, [matched]);

  // 相遇之路滚动区：轮数推进/终局时自动滚到最新一轮（写太久时新词沉在最底下，必须自己送上门；
  // state 帧全量重发，按 length+phase 作依赖，不做对象身份比较）。
  // 后台态（切走 App 等对方）不产生动画帧，平滑滚动会卡住不动：隐藏时直接跳到底，回来即见最新一轮
  const historyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = historyRef.current;
    if (!el || view.rounds.length === 0) return;
    el.scrollTo?.({ top: el.scrollHeight, behavior: document.hidden ? 'auto' : 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.rounds.length, view.phase]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text || view.phase !== 'playing' || spectating) return;
    net.send({ t: 'cSubmit', text });
  };

  const mineSeat = me?.seat;

  return (
    <div className="converge-page">
      <header className="page-bar">
        <span className="brand">心有灵犀</span>
        <span className="room-code">
          房间码 <b>{view.code}</b>
        </span>
        <span className="spacer" />
        <button className="btn tiny ghost" onClick={() => setHelpOpen(true)} title="玩法速查">
          ❔
        </button>
        <button className="btn tiny ghost" onClick={() => setHistoryOpen(true)} title="对局记录：本房间打完的每一局">
          📜
        </button>
        <button className="btn tiny ghost" onClick={() => setChatOpen(true)} title="聊天：房间成员 / 全服在线玩家">
          💬
        </button>
        <button className="btn small ghost" onClick={() => net.leaveRoom()}>
          退出房间
        </button>
      </header>

      <div className="phase-bar">
        <span>
          {view.phase === 'gameover'
            ? '本局已结束'
            : spectating
              ? `第 ${view.round} 轮 · 观战中`
              : `第 ${view.round} 轮 · 不限时不催促`}
        </span>
        {view.rounds.length > 0 && <span>已揭示 {view.rounds.length} 轮</span>}
      </div>

      {spectating && <div className="spectate-banner">🔭 观战中 —— 下一局开始时自动加入对局</div>}

      {view.phase === 'gameover' && view.result && (
        <div className="panel cv-over">
          <h3>{view.result.matched ? '🧠 你们的脑回路相遇了' : '本局结束 · 未相遇'}</h3>
          {view.result.matched ? (
            <p className="cv-over-line">
              用了 <b>{view.result.rounds}</b> 轮，我们都想到了「<b>{view.result.word}</b>」
            </p>
          ) : (
            <p className="cv-over-line">
              {view.result.reason === 'leave'
                ? '对方中途离开'
                : view.result.reason === 'abort'
                  ? '房主终止了本局'
                  : '全员断线超时'}
              ——共揭示了 {view.result.rounds} 轮
            </p>
          )}
          <div className="panel-actions">
            {isHost && !spectating && (
              <button className="btn primary" onClick={() => net.send({ t: 'cRematch' })}>
                再来一局
              </button>
            )}
            {!isHost && !spectating && <span className="hint">等待房主开始下一局…</span>}
            <button className="btn" onClick={() => net.send({ t: 'backToRoom' })}>
              返回房间
            </button>
          </div>
        </div>
      )}

      {view.phase === 'playing' && (
        <>
          <div className="panel">
            <div className="box-title">本轮 · 第 {view.round} 轮</div>
            {view.players.map((p) => (
              <div key={p.id} className="result-row">
                <span className="r-name">
                  {p.name}
                  {p.id === net.playerId && <em>（你）</em>}
                </span>
                <span className="r-hand">{p.submitted ? '✅ 已写好' : '✍️ 还在想…'}</span>
              </div>
            ))}
            {!spectating && (
              <>
                <div className="act-row cv-input-row">
                  <input
                    className="cv-input"
                    value={draft}
                    maxLength={CONVERGE_TEXT_MAX}
                    placeholder={`第 ${view.round} 轮：写一个词或一句话`}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submit();
                    }}
                  />
                  <button className="btn primary" disabled={!draft.trim()} onClick={submit}>
                    {me?.submitted ? '修改答案' : '提交'}
                  </button>
                </div>
                <span className="hint cv-hint">
                  {me?.submitted
                    ? other?.submitted
                      ? '两边都写好了，正在揭晓…'
                      : `已提交（想改就改，提交后仍可修改）· 等待 ${other?.name ?? '对方'}…`
                    : other?.submitted
                      ? `${other.name} 已经写好了——别只顾着对齐TA，想你们共同的下一步`
                      : '两边都提交后同时揭示；对方写完前随时可修改'}
                </span>
              </>
            )}
          </div>

          {isHost && !spectating && (
            <div className="act-row" style={{ marginTop: 8 }}>
              <button className="btn tiny ghost" onClick={() => net.send({ t: 'cAbort' })} title="结束本局（记未相遇）">
                终止本局
              </button>
            </div>
          )}
        </>
      )}

      <div className="panel cv-history" ref={historyRef}>
        <div className="box-title">相遇之路{view.rounds.length > 0 ? ` · ${view.rounds.length} 轮` : ''}</div>
        {view.rounds.map((r) => (
          <div key={r.n} className={`cv-row${r.same ? ' cv-same' : ''}`}>
            <span className="cv-n">第{r.n}轮</span>
            <div className="cv-duo">
              <span className="cv-pill">
                {r.entries[0]?.text}
                {r.entries[0]?.seat === mineSeat && <i>·你</i>}
              </span>
              <span className="cv-x">{r.same ? '✓' : '×'}</span>
              <span className="cv-pill">
                {r.entries[1]?.text}
                {r.entries[1]?.seat === mineSeat && <i>·你</i>}
              </span>
            </div>
          </div>
        ))}
        {view.rounds.length === 0 && (
          <div className="hint cv-empty">还没有揭示任何一轮：不商量，各写第一个想到的答案吧</div>
        )}
      </div>

      {helpOpen && (
        <div className="overlay" onClick={() => setHelpOpen(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="box-title">心有灵犀 · 玩法速查</div>
            <div className="tac-help-body">
              <p>
                <b>玩法</b>：两人不交流，每轮各写一个词或一句话；两边都提交后同时亮牌，想到同一个答案即「相遇」，
                用时轮数就是你们的默契值
              </p>
              <p>
                <b>判同</b>：全角半角（「６」＝「6」）、大小写、空格差异都不影响；中文按原文比对
              </p>
              <p>
                <b>可反悔</b>：对方写完之前，自己的答案随时可改（手滑不亏轮数）；两边都提交才揭示
              </p>
              <p>
                <b>节奏</b>：不限时；历史里每一轮双方的答案都留着，越到后面越接近彼此的思路
              </p>
              <p>
                <b>结束</b>：相遇即胜；有人中途离开、房主终止或全员掉线则记「未相遇」，房主可再来一局
              </p>
            </div>
            <div className="panel-actions">
              <button className="btn primary" onClick={() => setHelpOpen(false)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
      {chatOpen && <ChatModal onClose={() => setChatOpen(false)} roomScope />}
      {historyOpen && <RoomHistoryModal onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}
