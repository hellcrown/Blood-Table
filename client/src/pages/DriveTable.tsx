/**
 * 勿停 · 对局页 v2（真 3D · 仅电脑）
 *
 * 布局按岗位分三种：
 * - 驾驶员：整幅挡风玻璃（3D 驾驶舱），没有地图；喊话大字与标记旗标叠在画面上；
 * - 副驾驶：大地图（左）+ 小窗 3D（右上）+ 导航操作（右下：车窗/大灯/标记/喊话）；
 * - 单人局：整幅挡风玻璃 + 角落小地图 + 底部一条导航操作（一人全占，硬核）。
 * DOM 结构三种布局共用，只靠 CSS 切换——3D 画布始终是同一个元素，切岗位不重建场景。
 *
 * 渲染：rAF 直写（不经 React state）；每帧 DriveFx 做转向预测与插值 → 画地图 → 3D 场景 →
 * 直接改 HUD 元素。rAF 被暂停的环境（部分内置浏览器判页面 hidden）由 250ms 定时器保底。
 *
 * 输入：键盘 + 鼠标。驾驶 W/↑ 油门、S/↓ 刹车、A/← D/→ 转向；导航 A/← 左窗、D/→ 右窗、
 * W/↑ 大灯、S/↓ 标记最近危险（单人局方向键归驾驶，导航动作用 Q/E/F/R）、1-9 喊话、
 * 鼠标点地图放标记；Tab 切岗位。驾驶员点击画面锁定鼠标环顾（停手 1.5 秒自动回正）。
 * 守卫：输入框里、弹层打开时、断线遮罩时不响应；失焦/切后台自动松键。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import {
  DRIVE_CALLS,
  DRIVE_PING_TTL_MS,
  DRIVE_RESULT_TEXT,
  LANE_W_M,
  ROAD_HALF_M,
  type DriveIntent,
  type DriveRole,
  type DriveSide,
  type DriveView,
} from '@shared/driveProtocol';
import { net } from '../net/socket';
import { isKeyboardPC } from '../device';
import { DriveFx } from '../drive/fx';
import { MAP_AHEAD_M, MAP_BACK_M, buildRoadPath, type MapTransform, type RoadSample } from '../drive/roadPath';
import { mapHitTest, paintMap } from '../drive/map';
import { DriveScene3D } from '../drive/scene/DriveScene3D';
import type { Seat } from '../drive/scene/cockpit';
import { playSfx, startEngine, stopEngine, updateEngine } from '../audio/sound';
import { ChatModal } from '../components/ChatModal';
import { RoomHistoryModal } from '../components/RoomHistoryModal';
import { useEscClose } from '../components/useOverlayClose';

type HeldAction = 'gas' | 'brake' | 'steerL' | 'steerR';
type NavAction = 'L' | 'R' | 'lamp' | 'ping';
type Mode = 'driver' | 'navigator' | 'solo';

/** 驾驶键（按住） */
const HELD_KEYS: Record<string, HeldAction> = {
  KeyW: 'gas',
  ArrowUp: 'gas',
  KeyS: 'brake',
  ArrowDown: 'brake',
  KeyA: 'steerL',
  ArrowLeft: 'steerL',
  KeyD: 'steerR',
  ArrowRight: 'steerR',
};
/** 导航键（点按）：方向键在导航位兼作窗/灯/标记，Q/E/F/R 任何时候都可用 */
const NAV_KEYS: Record<string, NavAction> = {
  KeyA: 'L',
  ArrowLeft: 'L',
  KeyQ: 'L',
  KeyD: 'R',
  ArrowRight: 'R',
  KeyE: 'R',
  KeyW: 'lamp',
  ArrowUp: 'lamp',
  KeyF: 'lamp',
  KeyS: 'ping',
  ArrowDown: 'ping',
  KeyR: 'ping',
};
/** 与驾驶键重合的导航键（单人局里它们归驾驶） */
const DRIVE_OVERLAP = new Set(['KeyA', 'ArrowLeft', 'KeyD', 'ArrowRight', 'KeyW', 'ArrowUp', 'KeyS', 'ArrowDown']);
/** 环顾：鼠标灵敏度与幅度上限 */
const LOOK_SENS = 0.0026;
const LOOK_YAW_MAX = 2.7;
const LOOK_PITCH_MAX = 0.9;
const LOOK_RECENTER_MS = 1500;
/** 副驾驶的喊话在驾驶员画面上停留的时长（纯展示：喊话本身在服务端保留更久） */
const CALL_SHOW_MS = 3000;
/** 喊出后这段时间里，对应按钮高亮，表示「已经喊出来了」 */
const CALL_FLASH_MS = 1500;
/** 本机诊断：把最新视图与平滑状态挂到 window.__drvDev（只在 localhost 生效，线上不存在）——
 *  3D 画面没法自动化测试，目检时靠它在页面里写自动驾驶、读实时状态 */
const DEV_HOOK =
  typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? ((window as unknown as { __drvDev?: object }).__drvDev = {})
    : null;

/** rAF 缺失环境回退 33ms 定时器：渲染循环必须一直活着 */
const scheduleFrame = (cb: () => void): number =>
  typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(cb) : window.setTimeout(cb, 33);
const cancelFrame = (id: number): void => {
  if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(id);
  else window.clearTimeout(id);
};

const SIDE_NAME: Record<DriveSide, string> = { L: '左', R: '右' };

export function DriveTable({ view }: { view: DriveView }) {
  const [chatOpen, setChatOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const [locked, setLocked] = useState(false);
  useEscClose(() => setHelpOpen(false), helpOpen);

  const pc = isKeyboardPC();
  const me = view.players.find((p) => p.id === net.playerId);
  const spectating = view.spectator || !me;
  const isHost = view.hostId === net.playerId;
  const driving = view.phase === 'driving';
  const mode: Mode = view.solo ? 'solo' : view.myRole === 'drive' ? 'driver' : 'navigator';

  const viewRef = useRef(view);
  viewRef.current = view;
  const overlayRef = useRef(false);
  overlayRef.current = chatOpen || historyOpen || helpOpen;

  /* ---------------- 帧间平滑（预测/插值/特效） ---------------- */
  const fxRef = useRef<DriveFx | null>(null);
  if (!fxRef.current) fxRef.current = new DriveFx();
  const fx = fxRef.current;
  const resyncAtRef = useRef(0);
  useEffect(() => {
    fx.onView(view, Date.now());
    // 重连/丢帧后持键自愈：本地还按着、服务端却已清零 → 重新上报（服务端清零是掉线兜底，不是否定玩家）
    const mine = view.myInputs;
    if (mine && view.canDrive) {
      const held = driveRef.current;
      const stale: DriveIntent[] = [];
      if (held.gas && !mine.gas) stale.push({ k: 'gas', on: true });
      if (held.brake && !mine.brake) stale.push({ k: 'brake', on: true });
      if (held.steer !== 0 && mine.steer !== held.steer) stale.push({ k: 'steer', dir: held.steer });
      if (stale.length > 0 && Date.now() - resyncAtRef.current > 300) {
        resyncAtRef.current = Date.now();
        for (const it of stale) net.send({ t: 'vInt', intent: it });
      }
    }
    if (!view.canDrive) releaseDriveKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /* ---------------- 意图发送 ---------------- */
  const send = (intent: DriveIntent): void => {
    net.send({ t: 'vInt', intent });
  };
  const setRole = (role: DriveRole): void => {
    const v = viewRef.current;
    if (v.solo || v.spectator || v.phase !== 'driving') return;
    send({ k: 'role', role });
  };
  const toggleWindow = (side: DriveSide): void => {
    if (viewRef.current.canNavigate) send({ k: 'window', side });
  };
  const toggleLamp = (): void => {
    if (viewRef.current.canNavigate) send({ k: 'lamp' });
  };
  const doCall = (i: number): void => {
    if (viewRef.current.canNavigate) send({ k: 'call', i });
  };
  /** 标记前方最近的危险（路障/尸群/游荡的夜行者） */
  const pingNearest = (): void => {
    const v = viewRef.current;
    if (!v.canNavigate) return;
    const ahead = (at: number): number => at - v.pos;
    let best: { at: number; lat: number } | null = null;
    for (const ev of v.events) {
      if (ev.kind !== 'barrier' && ev.kind !== 'swarm') continue;
      const d = ahead(ev.at);
      if (d > -5 && (!best || d < ahead(best.at))) best = { at: ev.at, lat: ev.lat ?? 0 };
    }
    for (const m of v.monsters) {
      if (m.mode === 'latched' || m.mode === 'thrown') continue;
      const d = ahead(m.at);
      if (d > -5 && (!best || d < ahead(best.at))) best = { at: m.at, lat: m.lat };
    }
    if (best) send({ k: 'ping', at: Math.round(best.at), lat: Math.round(best.lat) });
  };

  /* ---------------- 键盘：驾驶键按住、导航键点按 ---------------- */
  const keysRef = useRef(new Set<string>());
  const driveRef = useRef({ gas: false, brake: false, steer: 0 as -1 | 0 | 1 });

  const refreshDriveKeys = (): void => {
    const next = { gas: false, brake: false, steer: 0 as -1 | 0 | 1 };
    for (const code of keysRef.current) {
      const a = HELD_KEYS[code];
      if (a === 'gas') next.gas = true;
      else if (a === 'brake') next.brake = true;
    }
    const l = [...keysRef.current].some((c) => HELD_KEYS[c] === 'steerL');
    const r = [...keysRef.current].some((c) => HELD_KEYS[c] === 'steerR');
    next.steer = ((r ? 1 : 0) - (l ? 1 : 0)) as -1 | 0 | 1; // 同时按左右 = 抵消
    const prev = driveRef.current;
    if (next.gas !== prev.gas) send({ k: 'gas', on: next.gas });
    if (next.brake !== prev.brake) send({ k: 'brake', on: next.brake });
    if (next.steer !== prev.steer) send({ k: 'steer', dir: next.steer });
    driveRef.current = next;
    fx.steerLocal = next.steer;
  };
  const releaseDriveKeys = (): void => {
    if (keysRef.current.size === 0) return;
    keysRef.current.clear();
    refreshDriveKeys();
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const v = viewRef.current;
      if (!v || v.phase !== 'driving' || e.isComposing) return;
      // 焦点在输入框/下拉框里时按键归它（聊天、设置），不当作游戏操作
      const target = e.target;
      if (target instanceof Element && target.closest('input, textarea, select')) return;
      if (overlayRef.current) {
        releaseDriveKeys(); // 弹层打开：把驾驶键全部松开（聊天时不能还踩着油门）
        return;
      }
      const code = e.code;
      if (code === 'Tab') {
        e.preventDefault();
        if (!v.solo && !e.repeat) setRole(v.myRole === 'drive' ? 'navigate' : 'drive');
        return;
      }
      if (/^Digit[1-9]$/.test(code)) {
        if (v.canNavigate && !e.repeat) {
          e.preventDefault();
          doCall(Number(code.slice(5)) - 1);
        }
        return;
      }
      const held = HELD_KEYS[code];
      if (v.canDrive && held) {
        e.preventDefault(); // 方向键/空格不再滚动页面或触发按钮
        if (!e.repeat && !keysRef.current.has(code)) {
          keysRef.current.add(code);
          refreshDriveKeys();
        }
        return;
      }
      const nav = NAV_KEYS[code];
      if (v.canNavigate && nav && !(v.solo && DRIVE_OVERLAP.has(code))) {
        e.preventDefault();
        if (!e.repeat) {
          if (nav === 'L' || nav === 'R') toggleWindow(nav);
          else if (nav === 'lamp') toggleLamp();
          else pingNearest();
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (keysRef.current.delete(e.code)) refreshDriveKeys();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 失焦 / 切后台：松开全部驾驶键（防幽灵车全速狂奔）
  useEffect(() => {
    const onVis = (): void => {
      if (document.hidden) releaseDriveKeys();
    };
    window.addEventListener('blur', releaseDriveKeys);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('blur', releaseDriveKeys);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- 鼠标环顾 ---------------- */
  const lookRef = useRef({ yaw: 0, pitch: 0, movedAt: 0, dragging: false, lx: 0, ly: 0 });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const applyLook = (dx: number, dy: number): void => {
    const lk = lookRef.current;
    lk.yaw = Math.min(LOOK_YAW_MAX, Math.max(-LOOK_YAW_MAX, lk.yaw + dx * LOOK_SENS));
    lk.pitch = Math.min(LOOK_PITCH_MAX, Math.max(-LOOK_PITCH_MAX, lk.pitch - dy * LOOK_SENS));
    lk.movedAt = Date.now();
  };
  useEffect(() => {
    const onLockChange = (): void => {
      const isLocked = document.pointerLockElement === canvasRef.current;
      setLocked(isLocked);
      if (!isLocked) {
        lookRef.current.yaw = 0; // 松开鼠标立即回正
        lookRef.current.pitch = 0;
      }
    };
    const onMouseMove = (e: MouseEvent): void => {
      if (document.pointerLockElement === canvasRef.current) applyLook(e.movementX, e.movementY);
    };
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('mousemove', onMouseMove);
    return () => {
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('mousemove', onMouseMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- 3D 场景与渲染循环 ---------------- */
  const sceneRef = useRef<DriveScene3D | null>(null);
  const mapRef = useRef<HTMLCanvasElement | null>(null);
  const viewWrapRef = useRef<HTMLDivElement | null>(null);
  const mapWrapRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ vw: 0, vh: 0, mw: 0, mh: 0 });
  const mapTRef = useRef<MapTransform | null>(null);
  const mapPathRef = useRef<RoadSample[]>([]);
  const glowLRef = useRef<HTMLDivElement | null>(null);
  const glowRRef = useRef<HTMLDivElement | null>(null);
  const perfRef = useRef<HTMLDivElement | null>(null);
  /** 帧率统计：滚动的一秒内帧数 + 每帧耗时（更新 + 渲染的指数平均） */
  const perfStat = useRef({ frames: 0, since: 0, fps: 0, cost: 0, shownAt: 0 });
  const flashRef = useRef<HTMLDivElement | null>(null);
  const signRef = useRef<HTMLDivElement | null>(null);
  const flagsRef = useRef<HTMLDivElement | null>(null);
  const flagEls = useRef(new Map<number, HTMLDivElement>());

  useLayoutEffect(() => {
    if (!pc) return; // 非电脑端不建场景
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      sceneRef.current = new DriveScene3D(canvas);
    } catch {
      setWebglFailed(true);
      return;
    }
    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, [pc]);

  // 尺寸跟随容器（两个画布各自的 CSS 尺寸 × DPR）
  useLayoutEffect(() => {
    const fit = (): void => {
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const vr = viewWrapRef.current?.getBoundingClientRect();
      const mr = mapWrapRef.current?.getBoundingClientRect();
      const vw = vr && vr.width > 1 ? vr.width : 0;
      const vh = vr && vr.height > 1 ? vr.height : 0;
      const mw = mr && mr.width > 1 ? mr.width : 0;
      const mh = mr && mr.height > 1 ? mr.height : 0;
      sizeRef.current = { vw, vh, mw, mh };
      if (vw > 0 && vh > 0) sceneRef.current?.resize(vw, vh);
      const mc = mapRef.current;
      if (mc && mw > 0 && mh > 0) {
        const bw = Math.round(mw * dpr);
        const bh = Math.round(mh * dpr);
        if (mc.width !== bw || mc.height !== bh) {
          mc.width = bw;
          mc.height = bh;
        }
      }
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    if (viewWrapRef.current) ro?.observe(viewWrapRef.current);
    if (mapWrapRef.current) ro?.observe(mapWrapRef.current);
    window.addEventListener('resize', fit);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [pc]);

  // 渲染循环
  useEffect(() => {
    if (!pc) return;
    let raf = 0;
    let stopped = false;
    let lastFrameAt = 0;
    /** HUD 直写（不经 React）：撞击红闪、过路牌闪现、副驾驶标记的旗标（带距离，出屏时贴边） */
    const updateHud = (v: DriveView, now: number, w: number, h: number, scene: DriveScene3D): void => {
      if (flashRef.current) flashRef.current.style.opacity = String(0.34 * fx.flash);
      // 被扒/被爬的那一侧画面泛红（与窗外那盏红灯同节奏）
      const beat = 0.55 + 0.45 * Math.sin(now / 70);
      const glowL = Math.max(fx.maulL, fx.crawlL) * beat;
      const glowR = Math.max(fx.maulR, fx.crawlR) * beat;
      if (glowLRef.current) glowLRef.current.style.opacity = String(glowL);
      if (glowRRef.current) glowRRef.current.style.opacity = String(glowR);
      if (signRef.current) {
        const a = Math.min(1, fx.signFlash * 1.3);
        signRef.current.style.opacity = String(a);
        if (a > 0) signRef.current.textContent = `路牌 ${fx.signNo}`;
      }
      const box = flagsRef.current;
      if (!box) return;
      const seen = new Set<number>();
      for (const p of v.pings) {
        if (now - p.ts > DRIVE_PING_TTL_MS || p.ts > now) continue;
        seen.add(p.id);
        let el = flagEls.current.get(p.id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'drv-ping';
          el.dataset.ping = String(p.id);
          box.appendChild(el);
          flagEls.current.set(p.id, el);
        }
        const ndc = scene.project(p.at, p.lat, 1.8);
        const dist = Math.max(0, Math.round(p.at - fx.pos));
        const onScreen = ndc.inFront && Math.abs(ndc.x) <= 0.94 && Math.abs(ndc.y) <= 0.9;
        if (onScreen) {
          el.style.left = `${((ndc.x + 1) / 2) * w}px`;
          el.style.top = `${((1 - ndc.y) / 2) * h}px`;
          el.textContent = `🚩 ${dist}m`;
          el.dataset.edge = '0';
        } else {
          // 出屏/在镜头背后：贴到画面边缘，箭头指向它相对车头的方位
          const bearing = p.at < fx.pos ? '后方' : p.lat > fx.lateral ? '右侧' : '左侧';
          el.style.left = `${p.lat > fx.lateral ? w - 12 : 12}px`;
          el.style.top = `${h * 0.42}px`;
          el.textContent = `${p.lat > fx.lateral ? '→' : '←'} 🚩 ${dist}m ${bearing}`;
          el.dataset.edge = '1';
        }
      }
      for (const [id, el] of flagEls.current) {
        if (!seen.has(id)) {
          el.remove();
          flagEls.current.delete(id);
        }
      }
    };
    const renderFrame = (): void => {
      const v = viewRef.current;
      if (!v) return;
      const now = Date.now();
      const dtMs = lastFrameAt === 0 ? 33 : now - lastFrameAt;
      lastFrameAt = now;
      fx.frame(now, dtMs, v);
      if (DEV_HOOK) Object.assign(DEV_HOOK, { view: v, fx });

      // 环顾自动回正：停手 1.5 秒视线缓回正前方（开着车不能一直扭头看侧面）
      const lk = lookRef.current;
      if (now - lk.movedAt > LOOK_RECENTER_MS && (lk.yaw !== 0 || lk.pitch !== 0)) {
        const k = Math.exp(-Math.min(0.1, dtMs / 1000) * 6);
        lk.yaw = Math.abs(lk.yaw * k) < 0.003 ? 0 : lk.yaw * k;
        lk.pitch = Math.abs(lk.pitch * k) < 0.003 ? 0 : lk.pitch * k;
      }

      // 地图（副驾驶大地图 / 单人局角落小地图）
      const { vw, vh, mw, mh } = sizeRef.current;
      const mc = mapRef.current;
      if (mc && mw > 0 && mh > 0) {
        const ctx = mc.getContext('2d');
        if (ctx) {
          const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          const path = buildRoadPath(v.curves, fx.pos, MAP_BACK_M, MAP_AHEAD_M);
          mapPathRef.current = path;
          mapTRef.current = paintMap(ctx, mw, mh, {
            path,
            pos: fx.pos,
            lateral: fx.lateral,
            rel: fx.rel,
            events: v.events,
            monsters: [...fx.monsters.values()],
            nextSignAt: v.nextSignAt,
            signs: v.signs,
            targetSigns: v.targetSigns,
            gap: fx.gap,
            windows: v.windows,
            pings: v.pings,
            now,
            compact: v.solo,
          });
        }
      }

      const scene = sceneRef.current;
      if (scene && vw > 0 && vh > 0) {
        const cost0 = performance.now();
        scene.update(v, fx, mode === 'navigator' ? 'navigator' : 'driver', lk.yaw, lk.pitch, now);
        scene.render();
        const ps = perfStat.current;
        ps.cost += (performance.now() - cost0 - ps.cost) * 0.1;
        ps.frames++;
        if (now - ps.since >= 1000) {
          ps.fps = (ps.frames * 1000) / (now - ps.since);
          ps.frames = 0;
          ps.since = now;
        }
        // 帧率读数半秒刷新一次：首版上线是性能试水，玩家卡不卡能直接读出来反馈
        if (perfRef.current && now - ps.shownAt >= 500 && ps.fps > 0) {
          ps.shownAt = now;
          perfRef.current.textContent = `${Math.round(ps.fps)} 帧/秒 · 每帧 ${ps.cost.toFixed(1)}ms`;
        }
        updateHud(v, now, vw, vh, scene);
      }
      updateEngine(fx.speedSmooth / 120, 1 - fx.gap / 100);
    };
    const loop = (): void => {
      if (stopped) return;
      raf = scheduleFrame(loop);
      renderFrame();
    };
    raf = scheduleFrame(loop);
    // 保底渲染：部分内置浏览器把页面判成 hidden，rAF 永久暂停——250ms 发现「200ms 内没渲染过」就补一帧
    const safety = window.setInterval(() => {
      if (!stopped && Date.now() - lastFrameAt > 200) renderFrame();
    }, 250);
    return () => {
      stopped = true;
      cancelFrame(raf);
      window.clearInterval(safety);
      stopEngine();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pc]);

  // 引擎声：驾驶中开启（终局/观战不开——AudioContext 需手势，按下任意键即视为手势）
  useEffect(() => {
    if (view.phase === 'driving' && !spectating) startEngine();
    else stopEngine();
    return () => stopEngine();
  }, [view.phase, spectating]);

  /* ---------------- 音效（只在跳变时响；state 帧全量重发，不能按对象身份判变化） ---------------- */
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
    mauls: view.mauls,
    startedAt: view.startedAt,
  });
  useEffect(() => {
    const prev = prevRef.current;
    const warn = view.windows.L.warn || view.windows.R.warn;
    if (view.startedAt !== prev.startedAt) {
      prevRef.current = { ...prev, phase: view.phase, signs: view.signs, warn, urgent: urgentCrawl, dur: view.durability, gap: view.gap, mauls: view.mauls, startedAt: view.startedAt };
      return;
    }
    if (view.signs > prev.signs) playSfx('sign');
    if (warn && !prev.warn) playSfx('scratch');
    if (urgentCrawl && !prev.urgent) playSfx('alarm');
    if (view.durability < prev.dur) playSfx('thud');
    if (view.gap < 20 && prev.gap >= 20) playSfx('alarm');
    if (view.mauls > prev.mauls) playSfx('bang');
    if (fx.takeHuntPulse()) playSfx('shriek');
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
      mauls: view.mauls,
      startedAt: view.startedAt,
    };
  }, [view, urgentCrawl, spectating, fx]);

  /* ---------------- 状态文案 ---------------- */
  const winActive = view.windows.L.climbLeft != null || view.windows.R.climbLeft != null;
  const winWarn = !winActive && (view.windows.L.warn || view.windows.R.warn);
  const latestCall = view.calls.length > 0 ? view.calls[view.calls.length - 1] : null;
  const callVisible = !!latestCall && Date.now() - latestCall.ts < CALL_SHOW_MS;
  const canLook = driving && (mode === 'driver' || mode === 'solo');
  // 警报直接按视图数据算：视图每 100ms 到一帧就会重渲染，不依赖渲染循环里的平滑状态
  const hunting = view.monsters.reduce((sum, m) => sum + (m.mode === 'hunt' ? 1 : 0), 0);
  const latched = view.monsters.reduce((sum, m) => sum + (m.mode === 'latched' ? 1 : 0), 0);

  /* ---------------- 事件处理（鼠标） ---------------- */
  const onCanvasClick = (): void => {
    const canvas = canvasRef.current;
    if (!canvas || !canLook || spectating) return;
    try {
      canvas.requestPointerLock?.();
    } catch {
      /* 不支持锁定：仍可用拖动环顾 */
    }
  };
  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (mode !== 'navigator' && !spectating) return;
    lookRef.current.dragging = true;
    lookRef.current.lx = e.clientX;
    lookRef.current.ly = e.clientY;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* 合成指针可能抛错 */
    }
  };
  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const lk = lookRef.current;
    if (!lk.dragging) return;
    applyLook(e.clientX - lk.lx, e.clientY - lk.ly);
    lk.lx = e.clientX;
    lk.ly = e.clientY;
  };
  const onCanvasPointerUp = (): void => {
    lookRef.current.dragging = false;
  };
  const onMapClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!view.canNavigate || !mapTRef.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    const hit = mapHitTest(mapTRef.current, mapPathRef.current, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    if (hit) send({ k: 'ping', at: Math.round(hit.at), lat: Math.round(hit.lat) });
  };

  /* ---------------- 渲染 ---------------- */
  const showMap = mode !== 'driver';
  const crew = view.players;

  if (!pc) {
    return (
      <div className="drv-page">
        <PcGate />
      </div>
    );
  }

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
            {!view.solo && !spectating && (
              <span className="drv-role" title="Tab 切换岗位">
                <button className={`btn tiny ${view.myRole === 'drive' ? 'primary' : 'ghost'}`} disabled={!driving} onClick={() => setRole('drive')}>
                  🚗 驾驶
                </button>
                <button className={`btn tiny ${view.myRole === 'navigate' ? 'primary' : 'ghost'}`} disabled={!driving} onClick={() => setRole('navigate')}>
                  🗺 导航
                </button>
              </span>
            )}
            {isHost && !spectating && (
              <button className="btn tiny ghost" onClick={() => net.send({ t: 'vAbort' })} title="提前结束本局">
                终止本局
              </button>
            )}
          </>
        )}
      </div>

      <div className={`drv-main mode-${mode}`}>
        <section className="drv-map" ref={mapWrapRef} hidden={!showMap}>
          <canvas ref={mapRef} className="drv-map-canvas" aria-label="导航地图" onClick={onMapClick} />
        </section>

        <section className="drv-side">
          <div className="drv-view" ref={viewWrapRef}>
            <canvas
              ref={canvasRef}
              className="drv-3d"
              aria-label="车内视野"
              onClick={onCanvasClick}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
            />
            <div className="drv-hud">
              <div ref={glowLRef} className="drv-sideglow left" data-side="L" />
              <div ref={glowRRef} className="drv-sideglow right" data-side="R" />
              <div ref={flashRef} className="drv-flash" />
              <div ref={signRef} className="drv-sign" />
              <div className="drv-warns">
                {driving && !view.solo && view.drivers === 0 && <div className="drv-warn blink">⚠ 无人驾驶！按 Tab 接管方向盘</div>}
                {driving && latched > 0 && <div className="drv-warn blink">🚨 被扒车 ×{latched}！开起来才能甩掉</div>}
                {driving && latched === 0 && hunting > 0 && <div className="drv-warn amber">⚠ 它们冲过来了 ×{hunting}！</div>}
                {driving && view.iDowned && <div className="drv-warn">🕸 你被拖出了车外 —— 下一个路牌会把你捡回来</div>}
                {driving && !view.iDowned && winWarn && <div className="drv-warn amber">⚠ 有东西在抓{sideOf(view)}车窗 —— 准备关窗！</div>}
                {driving && !view.iDowned && winActive && <div className="drv-warn blink">🚨 它正在爬进{sideOf(view)}车窗 —— 快关窗！</div>}
                {driving && view.offRoad && <div className="drv-warn amber">⚠ 驶出了路面！开回路上</div>}
              </div>
              {callVisible && latestCall && (
                <div className="drv-call" key={latestCall.id}>
                  {DRIVE_CALLS[latestCall.i]}
                  <small>{latestCall.by}</small>
                </div>
              )}
              <div ref={flagsRef} />
              <div ref={perfRef} className="drv-perf" />
              {webglFailed && (
                <div className="drv-gate">
                  <b>无法启动 3D 画面</b>
                  <span>你的浏览器没有开启 WebGL。请换用最新版 Chrome / Edge / Firefox，或在浏览器设置里开启硬件加速后刷新。</span>
                </div>
              )}
            </div>
            {!locked && canLook && !spectating && !webglFailed && <div className="drv-lockhint">点击画面锁定鼠标环顾 · Esc 释放 · 停手自动回正</div>}
            {spectating && <div className="spectate-banner drv-spec">🔭 观战中 —— 拖动画面环顾</div>}
          </div>

          {mode !== 'driver' && (
            <div className="drv-panel">
              <div className="drv-status">
                <span>
                  车速 <b>{Math.round(view.speed)}</b> km/h
                </span>
                <span>
                  油量 <b className={view.fuel < 20 ? 'bad' : ''}>{Math.round(view.fuel)}%</b>
                </span>
                <span>
                  耐久 <b className={view.durability <= 1 ? 'bad' : ''}>{view.durability}</b>/{view.maxDurability}
                </span>
                <span>
                  车道 <b>{laneText(view.lateral)}</b>
                </span>
                {mode === 'solo' && <span className="hint">单人全占：方向键开车 · Q/E 关窗 · F 大灯 · R 标记 · 1-9 喊话 · 点地图放标记</span>}
              </div>
              <div className="drv-btnrow">
                {(['L', 'R'] as DriveSide[]).map((side) => (
                  <button
                    key={side}
                    className={`btn ${view.windows[side].open ? 'primary' : 'ghost'}`}
                    disabled={!view.canNavigate}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggleWindow(side)}
                  >
                    {SIDE_NAME[side]}窗 {view.windows[side].open ? '开着 · 关上' : '关着 · 打开'}
                  </button>
                ))}
                <button className={`btn ${view.lamp ? 'primary' : 'ghost'}`} disabled={!view.canNavigate} onMouseDown={(e) => e.preventDefault()} onClick={toggleLamp}>
                  💡 大灯 {view.lamp ? '开' : '关'}
                </button>
                <button className="btn ghost" disabled={!view.canNavigate} onMouseDown={(e) => e.preventDefault()} onClick={pingNearest}>
                  🚩 标记最近危险
                </button>
              </div>
              {mode === 'navigator' && (
                <div className="drv-calls">
                  {DRIVE_CALLS.map((text, i) => {
                    // 刚喊出的那条高亮一下：按键盘喊话也要看得到「确实喊出去了」
                    const shouted = !!latestCall && latestCall.i === i && latestCall.by === me?.name && Date.now() - latestCall.ts < CALL_FLASH_MS;
                    return (
                    <button key={i} className={`btn ${shouted ? 'primary' : 'ghost'}`} disabled={!view.canNavigate} onMouseDown={(e) => e.preventDefault()} onClick={() => doCall(i)} title={`快捷键 ${i + 1}`}>
                      <kbd>{i + 1}</kbd> {text}
                    </button>
                    );
                  })}
                </div>
              )}
              {mode === 'navigator' && <div className="hint">鼠标点左侧地图任意位置放标记 · 拖动上方画面环顾 · Tab 切到驾驶</div>}
            </div>
          )}
        </section>
      </div>

      <div className="drv-hints">
        {mode === 'driver' && !spectating
          ? 'W/↑ 油门 · S/↓ 刹车 · A/← D/→ 转向 · 鼠标环顾 · Tab 切导航'
          : mode === 'solo'
            ? 'W/↑ 油门 · S/↓ 刹车 · A/← D/→ 转向 · 鼠标环顾 · Q/E 车窗 · F 大灯 · R 标记 · 1-9 喊话'
            : 'A/← 左窗 · D/→ 右窗 · W/↑ 大灯 · S/↓ 标记 · 1-9 喊话 · 点地图放标记 · Tab 切驾驶'}
      </div>

      {view.phase === 'gameover' && (
        <div className="overlay drv-overwrap">
          <div className="panel drv-over" onClick={(e) => e.stopPropagation()}>
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
              {crew.map((p) => (
                <span key={p.id} className={`dr-chip${p.downed ? ' left' : ''}`}>
                  {p.name}
                  {p.id === net.playerId && <em>（你）</em>}
                  <i className="dr-off">{p.left ? '已离开' : p.downed ? '被拖走' : p.role === 'drive' ? '驾驶' : '导航'}</i>
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
        </div>
      )}

      {helpOpen && (
        <div className="overlay" onClick={() => setHelpOpen(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="box-title">勿停 · 玩法速查</div>
            <div className="tac-help-body">
              <p>
                <b>别停</b>：车速低于 30km/h 就在喂养车后的「猎影」，后视镜里的红眼越来越近就是它——追上即撞损车尾。车一<b>停稳</b>
                ，附近的夜行者会被惊动冲过来扒车撕扯，唯一的解法是开起来（到 25km/h 全部甩飞）。加油站必须停车才加得到油，所以每次加油都是一次赌博。
              </p>
              <p>
                <b>真弯道</b>：按住 A/← D/→ 转车头，松手车头慢慢回正；弯道会把车往外甩，越快甩得越狠——不打方向就冲出路面，撞护栏扣耐久。
              </p>
              <p>
                <b>驾驶 / 导航</b>：驾驶员只有挡风玻璃，弯后被树林和黑暗挡住；副驾驶看地图（弯道、路障、夜行者、猎影都在上面），用 1-9 喊话和点地图放标记告诉驾驶员。Tab 切换岗位。
              </p>
              <p>
                <b>窗户</b>：路肩补给要同侧外侧车道 + 该侧窗开着 + 低于 50km/h 驶过才收得到；但窗爬者会爬开着的窗（灯亮来得更勤），抓挠声是唯一预警。
              </p>
              <p>
                <b>路牌</b>：每过一块难度 +1，复活所有被拖走的人；撞路障、碾尸群的噪音会把猎影招过来。
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

/** 哪一侧车窗有动静（提示文案用） */
function sideOf(view: DriveView): string {
  if (view.windows.L.climbLeft != null || view.windows.L.warn) return '左';
  if (view.windows.R.climbLeft != null || view.windows.R.warn) return '右';
  return '';
}

/** 车道名（与仪表盘同一组常量：路面半宽 5.25m、车道宽 3.5m） */
function laneText(lateral: number): string {
  if (Math.abs(lateral) > ROAD_HALF_M) return '路肩！';
  return lateral < -LANE_W_M / 2 ? '左道' : lateral > LANE_W_M / 2 ? '右道' : '中道';
}

/** 仅电脑：触屏设备看到的整屏提示 */
function PcGate() {
  return (
    <div className="drv-page-gate">
      <div className="panel drv-gatepanel">
        <h3>勿停是电脑端玩法</h3>
        <p>这个模式需要键盘开车、鼠标环顾和点地图，手机和平板玩不了。</p>
        <p className="hint">请在带键盘和鼠标的电脑上打开 {location.host} 加入房间。</p>
        <div className="panel-actions">
          <button className="btn" onClick={() => net.send({ t: 'enterSpectate' })}>
            转为观战
          </button>
          <button className="btn primary" onClick={() => net.leaveRoom()}>
            退出房间
          </button>
        </div>
      </div>
    </div>
  );
}
