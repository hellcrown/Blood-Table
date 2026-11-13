/**
 * 你画我猜 · 对局页
 *
 * 布局（手机竖屏优先，页根自建滚动区——body overflow:hidden 下页根不滚就会裁掉内容）：
 * 页头 → 状态条 → 玩家分数条 → 画布（满宽 4:3）→ 画手工具栏 / 猜词输入框 → 猜词流（新消息在上、内部滚动）。
 * 输入框紧贴画布下方：手机弹出键盘时画布仍留在可视区内。宽屏（≥960px）画布在左、猜词流在右。
 *
 * 画面：权威模型在 net.drawBoard（快照先于视图到达，页面挂载前也不丢）；本页只负责把它画到 canvas。
 * 远端增量只补画尾段，撤销/清空/快照/尺寸变化整幅重绘；直接同步绘制不走 rAF（后台页 rAF 暂停）。
 * 画手：本地立即落笔，操作攒进队列每 100ms 发一批（服务端笔画专用限流，超长笔画自动拆段）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import {
  DRAW_COLORS,
  DRAW_DIFF_LABEL,
  DRAW_DIFF_MULT,
  DRAW_GUESS_MAX,
  DRAW_PICK_SEC,
  drawDrawerShare,
  type DrawView,
} from '@shared/drawProtocol';
import { net } from '../net/socket';
import { OpQueue, backingSize, paintAll, paintStroke, toCanvasPoint } from '../net/drawBoard';
import { ChatModal } from '../components/ChatModal';
import { RoomHistoryModal } from '../components/RoomHistoryModal';
import { useEscClose } from '../components/useOverlayClose';
import { playSfx } from '../audio/sound';

const END_TEXT = { all: '全员猜对', time: '时间到', away: '画手掉线，本回合作废', left: '画手离开，本回合作废', awayGuess: '在线玩家已全部猜对' } as const;
const RESULT_TEXT = { done: '全部回合画完', abort: '房主终止了本局', leave: '人数不足，本局结束', idle: '全员断线，本局结束' } as const;
/** 色板名（无障碍名 + 提示）：下标同 DRAW_COLORS，0 号是橡皮不在色块里出现 */
const COLOR_NAMES = ['橡皮', '墨黑', '红', '橙', '黄', '绿', '蓝', '紫', '棕'];
const PEN_COLORS = [1, 2, 3, 4, 5, 6, 7, 8];
const WIDTH_NAMES = ['细', '中', '粗'];
/** 每个发送节拍最多发几条（离线积压恢复时防一口气打满笔画限流） */
const SENDS_PER_TICK = 3;

export function DrawTable({ view }: { view: DrawView }) {
  const [chatOpen, setChatOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useEscClose(() => setHelpOpen(false), helpOpen);

  const me = view.players.find((p) => p.id === net.playerId);
  const spectating = view.spectator || !me;
  const isHost = view.hostId === net.playerId;
  const isDrawer = !!me && me.id === view.drawerId;
  const drawer = view.players.find((p) => p.id === view.drawerId);
  const canDraw = isDrawer && view.phase === 'drawing';

  /* ---------------- 倒计时（服务端时钟校准，偏移只在新视图到达时更新） ---------------- */
  const offsetRef = useRef(0);
  useEffect(() => {
    offsetRef.current = view.serverTime - Date.now();
  }, [view]);
  const [, setTick] = useState(0);
  const ticking = view.phase !== 'gameover';
  useEffect(() => {
    if (!ticking) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(t);
  }, [ticking]);
  const remainSec =
    view.deadline != null ? Math.max(0, Math.ceil((view.deadline - (Date.now() + offsetRef.current)) / 1000)) : null;

  /* ---------------- 画布 ---------------- */
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  /** 每笔已画到第几个点（增量补画用；整幅重绘时重建） */
  const paintedRef = useRef(new Map<number, number>());
  const turnIdRef = useRef(view.turnId);
  turnIdRef.current = view.turnId;

  const ctxOf = (): CanvasRenderingContext2D | null => canvasRef.current?.getContext('2d') ?? null;

  /** 当前回合的画面（画面模型若还停在别的回合——快照未到——就先显示白纸） */
  const visibleStrokes = () => (net.drawBoard.turn === turnIdRef.current ? net.drawBoard.strokes : []);

  const repaint = useCallback(() => {
    paintedRef.current.clear();
    const ctx = ctxOf();
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    const strokes = visibleStrokes();
    paintAll(ctx, strokes, w, h, dpr);
    for (const s of strokes) paintedRef.current.set(s.id, s.p.length / 2);
  }, []);

  /** 只补画还没画过的尾段（从末尾往前找到第一笔「已画完」的为止，再按先后顺序补，叠放次序不乱） */
  const paintNew = useCallback(() => {
    const ctx = ctxOf();
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    const strokes = visibleStrokes();
    let i = strokes.length - 1;
    while (i >= 0 && (paintedRef.current.get(strokes[i]!.id) ?? 0) < strokes[i]!.p.length / 2) i--;
    if (i === strokes.length - 1) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let j = i + 1; j < strokes.length; j++) {
      const s = strokes[j]!;
      paintStroke(ctx, s, paintedRef.current.get(s.id) ?? 0, w, h);
      paintedRef.current.set(s.id, s.p.length / 2);
    }
  }, []);

  // 尺寸：画布 backing store 跟随 CSS 尺寸与 DPR（改 width 会清空画布，随后整幅重绘）
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const fit = (): void => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const [bw, bh] = backingSize(r.width, r.height, dpr);
      sizeRef.current = { w: r.width, h: r.height, dpr };
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      repaint();
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(wrap);
    window.addEventListener('resize', fit);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [repaint]);

  // 远端画面变化：快照/撤销/清空整幅重绘，其余只补尾段
  useEffect(
    () =>
      net.onDraw((e) => {
        if (e.kind === 'snap' || e.ops.some((op) => op.k === 'u' || op.k === 'x')) repaint();
        else paintNew();
      }),
    [repaint, paintNew],
  );

  // 换回合/新一局：画面模型以服务端快照为准，这里整幅重绘一次（快照未到则先白纸）
  useEffect(() => {
    repaint();
  }, [view.turnId, view.startedAt, repaint]);

  /* ---------------- 画手：落笔与发送 ---------------- */
  const [color, setColor] = useState(1);
  const [width, setWidth] = useState(1);
  const [eraser, setEraser] = useState(false);
  const queueRef = useRef(new OpQueue());
  const drawingRef = useRef(false);

  const flush = useCallback(() => {
    const q = queueRef.current;
    if (q.size === 0) return;
    if (net.status !== 'open') {
      // 断线期间的笔画作废：重连后服务端快照为准（继续积压只会在重连时撞 id）
      while (q.size > 0) q.take();
      return;
    }
    for (let i = 0; i < SENDS_PER_TICK && q.size > 0; i++) {
      const ops = q.take();
      if (ops.length === 0) break;
      net.send({ t: 'dStroke', ops });
    }
  }, []);

  useEffect(() => {
    if (!canDraw) {
      drawingRef.current = false;
      return;
    }
    const t = window.setInterval(flush, 100);
    return () => {
      window.clearInterval(t);
      flush();
    };
  }, [canDraw, flush]);

  const pointOf = (canvas: HTMLCanvasElement, clientX: number, clientY: number): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return toCanvasPoint(clientX - r.left, clientY - r.top, r.width, r.height);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!canDraw || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // 指针已失效/非活动（部分浏览器对笔或合成事件会抛）：不捕获也照样能画，绝不能让它中断落笔
    }
    const [x, y] = pointOf(e.currentTarget, e.clientX, e.clientY);
    const op = net.drawBoard.begin(eraser ? 0 : color, width, x, y);
    if (!op) return;
    drawingRef.current = true;
    queueRef.current.push(op);
    paintNew();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current || !canDraw) return;
    const native = e.nativeEvent;
    // 合并事件：快速划动时浏览器把多个采样点合成一次 move，取全量采样画出来更顺滑
    const coalesced = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    const samples = coalesced.length > 0 ? coalesced : [native];
    let any = false;
    for (const ev of samples) {
      const [x, y] = pointOf(e.currentTarget, ev.clientX, ev.clientY);
      const op = net.drawBoard.extend(x, y);
      if (op) {
        queueRef.current.push(op);
        any = true;
      }
    }
    if (any) paintNew();
  };

  const onPointerUp = (): void => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    net.drawBoard.end();
    flush();
  };

  const runEdit = (op: ReturnType<typeof net.drawBoard.undo>): void => {
    if (!op) return;
    queueRef.current.push(op);
    flush();
    repaint();
  };

  /* ---------------- 猜词 ---------------- */
  const [guess, setGuess] = useState('');
  const drawerSilent = isDrawer && (view.phase === 'choosing' || view.phase === 'drawing');
  const inputDisabled = spectating || drawerSilent || view.phase === 'gameover';
  const sendGuess = (): void => {
    const text = guess.trim();
    if (!text || inputDisabled) return;
    if (net.send({ t: 'dGuess', text })) setGuess('');
  };
  const placeholder = drawerSilent
    ? '你是画手，专心画吧'
    : view.phase === 'drawing'
      ? view.iSolved
        ? '你已猜对：这里的话只有画手和猜对的人看得到'
        : '输入你的猜测，回车发送'
      : '聊两句…';

  /* ---------------- 音效（只在跳变时响；state 帧是全量重发，不能按对象身份判变化） ---------------- */
  const solvedCount = view.players.filter((p) => p.solved).length;
  const prevRef = useRef({ phase: view.phase, turnId: view.turnId, iSolved: view.iSolved, solvedCount, warned: false });
  useEffect(() => {
    const prev = prevRef.current;
    if (view.iSolved && !prev.iSolved) playSfx('ticket');
    else if (view.turnId === prev.turnId && solvedCount > prev.solvedCount) playSfx('tap');
    if (view.turnId !== prev.turnId && isDrawer && view.phase === 'choosing') playSfx('deal');
    if (view.phase === 'reveal' && prev.phase !== 'reveal') playSfx('reveal');
    if (view.phase === 'gameover' && prev.phase !== 'gameover' && me) {
      const mine = view.ranking.find((r) => r.seat === me.seat);
      playSfx(mine?.rank === 1 ? 'win' : 'lose');
    }
    prevRef.current = {
      phase: view.phase,
      turnId: view.turnId,
      iSolved: view.iSolved,
      solvedCount,
      warned: view.turnId === prev.turnId ? prev.warned : false,
    };
  }, [view, solvedCount, isDrawer, me]);
  useEffect(() => {
    if (view.phase === 'drawing' && remainSec != null && remainSec > 0 && remainSec <= 10 && !prevRef.current.warned) {
      prevRef.current.warned = true;
      playSfx('lock');
    }
  });

  /* ---------------- 状态文案 ---------------- */
  const word = view.word;
  const diff = view.difficulty;
  let wordLine: React.ReactNode = null;
  if (view.phase === 'choosing') {
    wordLine = isDrawer ? `选一个词开始画（${DRAW_PICK_SEC} 秒内不选则随机）` : `${drawer?.name ?? '画手'} 正在选词…`;
  } else if (view.phase === 'drawing') {
    if (isDrawer && word && diff) {
      wordLine = (
        <>
          你要画：<b className="dr-answer">{word}</b>（{DRAW_DIFF_LABEL[diff]} ×{DRAW_DIFF_MULT[diff]}）
        </>
      );
    } else if (word) {
      wordLine = (
        <>
          答案：<b className="dr-answer">{word}</b> ✓
        </>
      );
    } else {
      wordLine = (
        <>
          <b className="dr-hint">{view.hint}</b>
          <span className="hint">
            {' '}
            {view.wordLen} 字{view.category ? ` · ${view.category}` : ''}
            {diff ? ` · ${DRAW_DIFF_LABEL[diff]}` : ''}
          </span>
        </>
      );
    }
  } else if (view.phase === 'reveal' && word) {
    wordLine = (
      <>
        答案：<b className="dr-answer">{word}</b>
      </>
    );
  }

  return (
    <div className="draw-page">
      <header className="page-bar">
        <span className="brand">你画我猜</span>
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

      <div className="phase-bar dr-phase">
        {view.phase === 'gameover' ? (
          <span>本局结束</span>
        ) : (
          <>
            <span>
              第 {view.turnNo}/{view.totalTurns} 回合
            </span>
            <span>画手 {drawer?.name ?? '—'}</span>
            {remainSec != null && (
              <span className={`dr-timer${view.phase === 'drawing' && remainSec <= 10 ? ' urgent' : ''}`}>⏱ {remainSec}s</span>
            )}
            {isHost && !spectating && (
              <button className="btn tiny ghost" onClick={() => net.send({ t: 'dAbort' })} title="提前结束本局（按当前得分排名）">
                终止本局
              </button>
            )}
          </>
        )}
      </div>

      {spectating && <div className="spectate-banner">🔭 观战中 —— 下一局开始时自动加入对局</div>}

      <div className="dr-players">
        {view.players.map((p) => (
          <span
            key={p.id}
            className={`dr-chip${p.id === view.drawerId && view.phase !== 'gameover' ? ' drawer' : ''}${p.solved ? ' solved' : ''}${p.left ? ' left' : ''}`}
          >
            {p.id === view.drawerId && view.phase !== 'gameover' ? '🖌 ' : p.solved ? '✓ ' : ''}
            {p.name}
            {p.id === net.playerId && <em>（你）</em>}
            <b className="dr-score">{p.score}</b>
            {!p.connected && !p.left && <i className="dr-off">离线</i>}
            {p.left && <i className="dr-off">已离开</i>}
          </span>
        ))}
      </div>

      <div className="dr-main">
        <div className="dr-board-col">
          {wordLine && <div className="dr-word">{wordLine}</div>}
          <div className="dr-canvas-wrap" ref={wrapRef}>
            <canvas
              ref={canvasRef}
              className={`dr-canvas${canDraw ? ' can-draw' : ''}`}
              aria-label="画布"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onLostPointerCapture={onPointerUp}
            />
            {view.phase === 'choosing' && isDrawer && view.choices && (
              <div className="dr-overlay">
                <div className="dr-overlay-title">选一个词来画</div>
                <div className="dr-pick-row">
                  {view.choices.map((c, i) => (
                    <button key={c.word} className="btn dr-pick" onClick={() => net.send({ t: 'dPick', index: i })}>
                      <b>{c.word}</b>
                      <small>
                        {DRAW_DIFF_LABEL[c.d]} ×{DRAW_DIFF_MULT[c.d]} · {c.cat}
                      </small>
                    </button>
                  ))}
                </div>
                <div className="hint">难词猜对得分翻倍，但也更难画——每有一人猜对你得 {drawDrawerShare(1)}~{drawDrawerShare(3)} 分</div>
              </div>
            )}
            {view.phase === 'choosing' && !isDrawer && (
              <div className="dr-overlay">
                <div className="dr-overlay-title">{drawer?.name ?? '画手'} 正在选词…</div>
              </div>
            )}
            {view.phase === 'reveal' && (
              <div className="dr-reveal">
                <div>
                  答案是「<b className="dr-answer">{word ?? '—'}</b>」
                  {view.endReason && <span className="hint">（{END_TEXT[view.endReason]}）</span>}
                </div>
                <div className="dr-gains">
                  {view.players
                    .filter((p) => p.gained > 0)
                    .map((p) => (
                      <span key={p.id}>
                        {p.name} +{p.gained}
                      </span>
                    ))}
                  {view.players.every((p) => p.gained === 0) && <span className="hint">本回合没有人得分</span>}
                </div>
              </div>
            )}
          </div>

          {canDraw && (
            <div className="dr-tools">
              <span className="dr-mode">
                <button className={`btn tiny ${eraser ? 'ghost' : 'primary'}`} onClick={() => setEraser(false)}>
                  ✏️ 画笔
                </button>
                <button className={`btn tiny ${eraser ? 'primary' : 'ghost'}`} onClick={() => setEraser(true)}>
                  🧽 橡皮
                </button>
              </span>
              <span className="dr-colors">
                {PEN_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`dr-swatch${!eraser && color === c ? ' on' : ''}`}
                    style={{ background: DRAW_COLORS[c] }}
                    aria-label={COLOR_NAMES[c]}
                    title={COLOR_NAMES[c]}
                    onClick={() => {
                      setColor(c);
                      setEraser(false);
                    }}
                  />
                ))}
              </span>
              <span className="dr-widths">
                {WIDTH_NAMES.map((name, w) => (
                  <button
                    key={name}
                    className={`dr-width${width === w ? ' on' : ''}`}
                    aria-label={`${name}笔`}
                    title={`${name}笔`}
                    onClick={() => setWidth(w)}
                  >
                    <span style={{ width: 4 + w * 6, height: 4 + w * 6 }} />
                  </button>
                ))}
              </span>
              <button className="btn tiny ghost" onClick={() => runEdit(net.drawBoard.undo())}>
                ↶ 撤销
              </button>
              <button className="btn tiny ghost" onClick={() => runEdit(net.drawBoard.clear())}>
                🗑 清空
              </button>
            </div>
          )}

          {view.phase === 'gameover' && (
            <div className="dr-over">
              <h3>{view.result ? RESULT_TEXT[view.result.reason] : '本局结束'}</h3>
              {view.ranking.map((r) => (
                <div key={r.seat} className={`result-row${r.rank === 1 && !r.left ? ' winner' : ''}`}>
                  <span className="r-name">
                    {r.rank === 1 && !r.left ? '👑 ' : `${r.rank}. `}
                    {r.name}
                    {r.left && <em>（中途离开）</em>}
                  </span>
                  <span className="r-hand">{r.score} 分</span>
                </div>
              ))}
              <div className="panel-actions">
                {isHost && !spectating && (
                  <button className="btn primary" onClick={() => net.send({ t: 'dRematch' })}>
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
        </div>

        <div className="dr-side">
          {!spectating && view.phase !== 'gameover' && (
            <div className="act-row dr-input-row">
              <input
                className="dr-input"
                value={guess}
                maxLength={DRAW_GUESS_MAX}
                placeholder={placeholder}
                disabled={inputDisabled}
                onChange={(e) => setGuess(e.target.value)}
                onKeyDown={(e) => {
                  // 输入法组合中的回车是「确认候选词」，不是发送
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) sendGuess();
                }}
              />
              <button className="btn primary" disabled={inputDisabled || !guess.trim()} onClick={sendGuess}>
                发送
              </button>
            </div>
          )}
          <div className="dr-feed">
            {[...view.feed].reverse().map((f) => (
              <div key={f.id} className={`dr-feed-item dr-${f.kind}`}>
                {f.kind === 'sys' ? (
                  f.text
                ) : (
                  <>
                    <b>{f.name}</b>
                    {f.kind === 'solved' ? ' ' : '：'}
                    {f.text}
                  </>
                )}
              </div>
            ))}
            {view.feed.length === 0 && <div className="hint">还没有人说话</div>}
          </div>
        </div>
      </div>

      {helpOpen && (
        <div className="overlay" onClick={() => setHelpOpen(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="box-title">你画我猜 · 玩法速查</div>
            <div className="tac-help-body">
              <p>
                <b>轮流作画</b>：按座位轮流当画手，每人画 {view.cycles} 次；画手从简单/中等/困难三个词里挑一个（{DRAW_PICK_SEC}{' '}
                秒不选则随机），其他人在下方猜
              </p>
              <p>
                <b>计分</b>：猜对得 (40 + 60×剩余时间比例)×倍率，越快越多；每有一人猜对，画手得 25×倍率。倍率：简单 ×1、中等
                ×1.5、困难 ×2；全员猜对提前结束本回合
              </p>
              <p>
                <b>猜词</b>：全角半角、大小写、空格和标点都不影响；常见别称也算对（「猫咪」算「猫」）。差一个字或包含答案会提示「很接近了」，只有你自己看得到
              </p>
              <p>
                <b>提示</b>：一开始就公布字数和类别；剩一半时间时，三字及以上的词会揭开一个字
              </p>
              <p>
                <b>防剧透</b>：猜对后你说的话只有画手和猜对的人看得到；画手作画时不能发言，房间聊天里出现答案会被打码
              </p>
              <p>
                <b>结束</b>：全部回合画完按总分排名；画手掉线 10 秒本回合作废；房主可随时终止本局
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
