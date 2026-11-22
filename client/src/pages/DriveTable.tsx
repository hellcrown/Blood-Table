/**
 * 勿停 · 对局页
 *
 * 布局（页根自建滚动区——body overflow:hidden 下页根不滚就会裁掉内容）：
 * 页头 → 状态条（里程/路牌/房主终止）→ 观战横幅 → 挡风玻璃 canvas（含后视镜与仪表盘，flex 撑满）
 * → 操控区（底部固定：持键 + 点按）→ 终局面板。
 *
 * 渲染：rAF 直写 canvas 读 viewRef（后台页 rAF 暂停无害——状态在服务器，回前台下一帧即刷新）；
 * 里程按速度外推插值（10Hz 视图帧之间平滑滚动）。引擎嗡鸣每帧随速度/尾压更新。
 * 操控：油门/刹车/探头=按住（pointerdown/up + setPointerCapture try/catch），换道/关窗/灯=点按；
 * 页面隐藏（visibilitychange）自动松开全部持键——防后台幽灵车全速狂奔。
 * 音效：prevRef 跳变检测（state 帧全量重发，不能按对象身份判变化）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import { DRIVE_MAX_SPEED, DRIVE_RESULT_TEXT, type DriveIntent, type DriveSide, type DriveView } from '@shared/driveProtocol';
import { net } from '../net/socket';
import { drawDistOf, paintScene } from '../net/driveBoard';
import { playSfx, startEngine, stopEngine, updateEngine } from '../audio/sound';
import { ChatModal } from '../components/ChatModal';
import { RoomHistoryModal } from '../components/RoomHistoryModal';
import { useEscClose } from '../components/useOverlayClose';

type HoldKey = 'gas' | 'brake' | 'spot';

/** rAF 缺失环境（部分 WebView/测试环境）回退 30ms 定时器：渲染循环必须一直活着 */
const scheduleFrame = (cb: () => void): number =>
  typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(cb) : window.setTimeout(cb, 33);
const cancelFrame = (id: number): void => {
  if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(id);
  else window.clearTimeout(id);
};

export function DriveTable({ view }: { view: DriveView }) {
  const [chatOpen, setChatOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useEscClose(() => setHelpOpen(false), helpOpen);

  const me = view.players.find((p) => p.id === net.playerId);
  const spectating = view.spectator || !me;
  const isHost = view.hostId === net.playerId;
  const canDrive = !!me && !view.iDowned && !spectating && view.phase === 'driving';

  const viewRef = useRef(view);
  viewRef.current = view;

  /* ---------------- 里程外推（视图 10Hz，rAF 60Hz：按当前速度推算渲染里程） ---------------- */
  const deadRef = useRef({ pos: view.pos, t: 0, speed: view.speed });
  useEffect(() => {
    deadRef.current = { pos: view.pos, t: Date.now(), speed: view.speed };
  }, [view]);

  /* ---------------- 画布 ---------------- */
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const fit = (): void => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const bw = Math.max(1, Math.round(r.width * dpr));
      const bh = Math.max(1, Math.round(r.height * dpr));
      sizeRef.current = { w: r.width, h: r.height, dpr };
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(wrap);
    window.addEventListener('resize', fit);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);

  // 渲染循环：rAF 直写（不经过 React state；仪表/路面/引擎声全在这帧内更新）
  useEffect(() => {
    let raf = 0;
    let stopped = false;
    const loop = (): void => {
      if (stopped) return;
      raf = scheduleFrame(loop);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const { w, h, dpr } = sizeRef.current;
      if (w === 0 || h === 0) return;
      const v = viewRef.current;
      const now = Date.now();
      const elapsed = Math.max(0, now - deadRef.current.t) / 1000;
      const renderPos = deadRef.current.pos + (deadRef.current.speed / 3.6) * Math.min(elapsed, 1.2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintScene(ctx, w, h, {
        view: v,
        renderPos,
        now,
        drawDist: drawDistOf(v.lamp, v.myInputs?.spot === true),
      });
      updateEngine(v.speed / DRIVE_MAX_SPEED, 1 - v.gap / 100);
    };
    raf = scheduleFrame(loop);
    return () => {
      stopped = true;
      cancelFrame(raf);
      stopEngine();
    };
  }, []);

  // 引擎声：驾驶中开启（gameover/观战不开——AudioContext 需手势，按下任意操控键即视为手势）
  useEffect(() => {
    if (view.phase === 'driving' && !spectating) startEngine();
    else stopEngine();
    return () => stopEngine();
  }, [view.phase, spectating]);

  /* ---------------- 操控：持键与点按 ---------------- */
  const holdsRef = useRef<Record<HoldKey, boolean>>({ gas: false, brake: false, spot: false });
  const [holds, setHolds] = useState<Record<HoldKey, boolean>>({ gas: false, brake: false, spot: false });

  const sendHold = (k: HoldKey, on: boolean): void => {
    if (holdsRef.current[k] === on) return;
    holdsRef.current[k] = on;
    setHolds((h) => ({ ...h, [k]: on }));
    net.send({ t: 'vInt', intent: { k, on } });
  };

  const releaseAll = (): void => {
    for (const k of ['gas', 'brake', 'spot'] as HoldKey[]) sendHold(k, false);
  };

  // 页面隐藏自动松键：后台标签页按着油门会变成幽灵车全速狂奔
  useEffect(() => {
    const onVis = (): void => {
      if (document.hidden) releaseAll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // 失去驾驶权（被拖走/终局/观战）时清 UI 态并松键
  useEffect(() => {
    if (!canDrive) releaseAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDrive]);

  const holdBtn = (k: HoldKey, label: string, cls: string): React.ReactNode => (
    <button
      className={`btn drv-btn ${cls} ${holds[k] ? 'primary' : 'ghost'}`}
      disabled={!canDrive}
      onPointerDown={(e) => {
        if (!canDrive) return;
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture?.(e.pointerId);
        } catch {
          /* 合成指针可能抛错：不捕获也能用 */
        }
        sendHold(k, true);
      }}
      onPointerUp={() => sendHold(k, false)}
      onPointerCancel={() => sendHold(k, false)}
      onLostPointerCapture={() => sendHold(k, false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );

  const sendIntent = (intent: DriveIntent): void => {
    if (!canDrive) return;
    net.send({ t: 'vInt', intent });
  };

  /* ---------------- 音效（跳变检测） ---------------- */
  const urgentCrawl =
    (view.windows.L.climbLeft != null && view.windows.L.climbLeft < 1000) ||
    (view.windows.R.climbLeft != null && view.windows.R.climbLeft < 1000);
  const prevRef = useRef({
    phase: view.phase,
    signs: view.signs,
    warn: false,
    urgent: false,
    dur: view.durability,
    gap: view.gap,
    startedAt: view.startedAt,
  });
  useEffect(() => {
    const prev = prevRef.current;
    const warn = view.windows.L.warn || view.windows.R.warn;
    if (view.signs > prev.signs) playSfx('sign');
    if (warn && !prev.warn) playSfx('scratch');
    if (urgentCrawl && !prev.urgent) playSfx('alarm');
    if (view.durability < prev.dur) playSfx('thud');
    if (view.gap < 20 && prev.gap >= 20) playSfx('alarm');
    if (view.phase === 'gameover' && prev.phase !== 'gameover' && !spectating) {
      playSfx(view.result?.reason === 'won' ? 'win' : 'lose');
    }
    prevRef.current = {
      phase: view.phase,
      signs: view.signs,
      warn,
      urgent: urgentCrawl,
      dur: view.durability,
      gap: view.gap,
      startedAt: view.startedAt,
    };
  }, [view, urgentCrawl, spectating]);

  /* ---------------- 瞭望标记：一键标记前方最近的危险 ---------------- */
  const pingTarget = view.events.find(
    (e) => e.at > view.pos && (e.kind === 'barrier' || e.kind === 'swarm'),
  );

  /* ---------------- 状态文案 ---------------- */
  const winActive = view.windows.L.climbLeft != null || view.windows.R.climbLeft != null;
  const winWarn = !winActive && (view.windows.L.warn || view.windows.R.warn);

  return (
    <div className="drv-page">
      <header className="page-bar">
        <span className="brand">勿停</span>
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

      <div className="phase-bar drv-phase">
        {view.phase === 'gameover' ? (
          <span>本局结束</span>
        ) : (
          <>
            <span>
              第 <b>{view.signs}</b>
              {view.targetSigns > 0 ? ` / ${view.targetSigns}` : ''} 号路牌
            </span>
            <span>
              里程 <b>{Math.floor(view.pos)}</b>m
            </span>
            <span className={view.gap < 25 ? 'drv-urgent' : ''}>尾距 {Math.round(view.gap)}%</span>
            {isHost && !spectating && (
              <button className="btn tiny ghost" onClick={() => net.send({ t: 'vAbort' })} title="提前结束本局">
                终止本局
              </button>
            )}
          </>
        )}
      </div>

      {spectating && <div className="spectate-banner">🔭 观战中 —— 下一局开始时自动加入对局</div>}
      {!spectating && view.iDowned && view.phase === 'driving' && (
        <div className="spectate-banner drv-downed">🕸 你被拖出了车外 —— 下一个路牌会把你捡回来</div>
      )}
      {!spectating && !view.iDowned && winWarn && <div className="spectate-banner drv-warn">⚠ 有东西在抓车窗 —— 准备关窗！</div>}
      {!spectating && !view.iDowned && winActive && (
        <div className="spectate-banner drv-danger">🚨 它正在爬进车窗 —— 快关窗！</div>
      )}

      <div className="drv-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} className="drv-canvas" aria-label="车内视野" />

        {view.phase === 'gameover' && (
          <div className="drv-over">
            <h3>{view.result ? DRIVE_RESULT_TEXT[view.result.reason] : '本局结束'}</h3>
            {view.result && (
              <div className="drv-stats">
                <span>
                  里程 <b>{view.result.distance}m</b>
                </span>
                <span>
                  路牌 <b>{view.result.signs}</b>
                </span>
                <span>
                  时长 <b>{Math.round(view.result.durationMs / 1000)}s</b>
                </span>
                <span>
                  扑击 <b>{view.result.attacks}</b>
                </span>
                <span>
                  搏斗 <b>{view.result.crawls}</b>
                </span>
                <span>
                  搜掠 <b>{view.result.loots}</b>
                </span>
              </div>
            )}
            <div className="drv-crew">
              {view.players.map((p) => (
                <span key={p.id} className={`dr-chip${p.downed ? ' left' : ''}`}>
                  {p.name}
                  {p.id === net.playerId && <em>（你）</em>}
                  <i className="dr-off">{p.left ? '已离开' : p.downed ? '被拖走' : '在车上'}</i>
                </span>
              ))}
            </div>
            <div className="panel-actions">
              {isHost && !spectating && (
                <button className="btn primary" onClick={() => net.send({ t: 'vRematch' })}>
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

      {!spectating && view.phase !== 'gameover' && (
        <div className="drv-controls">
          <div className="drv-row">
            {holdBtn('gas', '⛽ 油门', 'drv-wide')}
            {holdBtn('brake', '🛑 刹车', 'drv-wide')}
            <button className="btn drv-btn ghost" disabled={!canDrive} onClick={() => sendIntent({ k: 'lane', dir: -1 })}>
              ◀ 道
            </button>
            <button className="btn drv-btn ghost" disabled={!canDrive} onClick={() => sendIntent({ k: 'lane', dir: 1 })}>
              道 ▶
            </button>
          </div>
          <div className="drv-row">
            {(['L', 'R'] as DriveSide[]).map((side) => {
              const open = view.windows[side].open;
              return (
                <button
                  key={side}
                  className={`btn drv-btn ${open ? 'primary' : 'ghost'}`}
                  disabled={!canDrive}
                  onClick={() => sendIntent({ k: 'window', side })}
                >
                  {side === 'L' ? '左' : '右'}窗 {open ? '关' : '开'}
                </button>
              );
            })}
            {holdBtn('spot', '👁 探头', '')}
            <button
              className="btn drv-btn ghost"
              disabled={!canDrive || !pingTarget}
              onClick={() => pingTarget && sendIntent({ k: 'ping', lane: pingTarget.lane ?? 0, at: pingTarget.at })}
              title={pingTarget ? `标记前方 ${Math.round(pingTarget.at - view.pos)}m 的${pingTarget.kind === 'swarm' ? '尸群' : '路障'}` : '前方暂无危险'}
            >
              🚩 标记
            </button>
            <button
              className={`btn drv-btn ${view.lamp ? 'primary' : 'ghost'}`}
              disabled={!canDrive}
              onClick={() => sendIntent({ k: 'lamp' })}
              title="灯亮看得远但吸引爬窗；灯灭省心但看不清路"
            >
              {view.lamp ? '💡 灯开' : '💡 灯灭'}
            </button>
          </div>
        </div>
      )}

      {helpOpen && (
        <div className="overlay" onClick={() => setHelpOpen(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="box-title">勿停 · 玩法速查</div>
            <div className="tac-help-body">
              <p>
                <b>别停</b>：车速低于 30km/h 就在喂养车后的「猎影」，后视镜里的红点就是它——追上即撞损车尾。油量跑空只能滑行等死，加油站必须停稳才加得到油。
              </p>
              <p>
                <b>窗户</b>：路肩的补给要对应侧窗开着、且低于 50km/h 驶过才收得到；但开着窗，窗爬者会来（灯亮时来得更勤）。抓挠声是唯一预警——爬入计时 3 秒，关上窗就没事，关不上开窗的人被拖走，下个路牌复活。
              </p>
              <p>
                <b>分工</b>：1 人全占（硬核）；2 人以上分摊油门/刹车/换道、探头瞭望（看得更远）、关窗与标记。任何人都能接管任何操作。
              </p>
              <p>
                <b>路牌</b>：每过一块难度 +1，复活所有被拖走的人；撞路障/碾尸群不但伤车，噪音还会把猎影招过来。
              </p>
            </div>
            <div className="panel-actions">
              <button className="btn" onClick={() => setHelpOpen(false)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {chatOpen && <ChatModal roomScope onClose={() => setChatOpen(false)} />}
      {historyOpen && <RoomHistoryModal onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}
