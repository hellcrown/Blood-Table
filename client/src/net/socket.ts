import type { C2S, LogLine, S2C } from '@shared/protocol';
import type { BloodView } from '@shared/bloodProtocol';
import { mergeBloodLog as mergeLogs } from './bloodLog';

export type ConnStatus = 'connecting' | 'open' | 'closed' | 'replaced';
export type AnyView = import('@shared/protocol').TableView | BloodView;

type ViewListener = (v: AnyView | null) => void;
type ErrorListener = (code: string, msg: string) => void;
type StatusListener = (s: ConnStatus) => void;
export interface FxEvent {
  kind: 'flower' | 'egg';
  from: number;
  to: number;
}
type FxListener = (fx: FxEvent) => void;

export interface AccountInfo {
  id: string;
  name: string;
}
type AccountListener = (a: AccountInfo | null) => void;

const TOKEN_KEY = 'blood.token';
const NAME_KEY = 'blood.name';
const LAST_ROOM_KEY = 'blood.lastRoom';
const AUTH_KEY = 'blood.auth';
// token 存 sessionStorage：每个标签页独立会话，同浏览器多开互不干扰；刷新仍可恢复
// lastRoom 存 localStorage：跨标签页/会话保留「最近房间码」，供大厅「回到房间」横幅使用
// auth 存 localStorage：账号登录令牌（30 天有效），跨标签页/设备共享登录态

export interface LastRoomRef {
  code: string;
  ts: number;
}

/** 读取最近房间引用（无/损坏时返回 null） */
export function loadLastRoom(): LastRoomRef | null {
  try {
    const raw = localStorage.getItem(LAST_ROOM_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as LastRoomRef;
    if (v && typeof v.code === 'string' && /^[A-Z0-9]{4}$/.test(v.code)) return v;
  } catch {
    /* 忽略损坏数据 */
  }
  return null;
}

function saveLastRoom(code: string): void {
  try {
    localStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ code, ts: Date.now() }));
  } catch {
    /* 隐私模式等场景下写入失败可忽略 */
  }
}

function clearLastRoom(): void {
  try {
    localStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * WebSocket 单例：自动重连、token 恢复、视图分发。
 * 服务器下发的 view 已按玩家个性化（只含自己的底牌）。
 */
class Net {
  private ws: WebSocket | null = null;
  private viewListeners = new Set<ViewListener>();
  private errorListeners = new Set<ErrorListener>();
  private statusListeners = new Set<StatusListener>();
  private fxListeners = new Set<FxListener>();
  private accountListeners = new Set<AccountListener>();
  private reconnectTimer: number | null = null;
  private reconnectDelay = 800;
  private started = false;
  /** 已写入 lastRoom 的房间码（避免每条 state 消息重复写 localStorage） */
  private notedCode: string | null = null;
  /**
   * 本地累积的血战日志（按 seq 有序、去重、有上限）。
   * 服务端只在首帧/落后过多时下发全量，其余帧仅带尾部 + `event` 增量 ——
   * 这里合并成一个完整且有界的数组再交给视图消费者，组件因此无需感知协议细节。
   */
  private bloodLog: LogLine[] = [];

  view: AnyView | null = null;
  token: string | null = Net.loadSessionToken();
  playerId: string | null = null;
  status: ConnStatus = 'connecting';
  /** 账号登录令牌（localStorage 持久；null = 匿名游玩） */
  authToken: string | null = Net.loadAuthToken();
  /** 服务端确认的登录身份（hello 下发；null = 匿名或令牌失效） */
  account: AccountInfo | null = null;

  private static loadAuthToken(): string | null {
    try {
      return localStorage.getItem(AUTH_KEY);
    } catch {
      return null; // 隐私模式/禁存储
    }
  }

  private static loadSessionToken(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null; // 隐私模式/禁存储：与 loadAuthToken 同口径，模块求值期不得抛错（否则整页白屏）
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect(): void {
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // 握手看门狗：TCP 已建立但 WS upgrade 挂死时 onclose 永不触发，连接会永久卡在 CONNECTING
    // （online/visibilitychange 的强制重连也因 ws!=null 被跳过）。10s 未 open 主动关闭走既有重连路径。
    const watchdog = window.setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {
          /* 忽略 */
        }
      }
    }, 10_000);
    ws.onopen = () => {
      window.clearTimeout(watchdog);
      this.reconnectDelay = 800;
      this.setStatus('open');
      if (this.token) this.send({ t: 'rejoin', token: this.token });
    };
    ws.onmessage = (ev) => {
      let msg: S2C;
      try {
        msg = JSON.parse(String(ev.data)) as S2C;
      } catch {
        return;
      }
      if (msg.t === 'hello') {
        this.token = msg.token;
        this.playerId = msg.playerId;
        try {
          sessionStorage.setItem(TOKEN_KEY, msg.token);
        } catch {
          /* 隐私模式：token 仅内存持有，刷新需重新加入 */
        }
        // 服务端确认（或刷新）登录身份：令牌失效/匿名时为 undefined → 清空本地展示
        const account = msg.account ?? null;
        if (account?.id !== this.account?.id || account?.name !== this.account?.name) {
          this.account = account;
          this.accountListeners.forEach((l) => l(account));
        }
      } else if (msg.t === 'state') {
        const code = typeof msg.view?.code === 'string' ? msg.view.code : null;
        // code 变化或 lastRoom 被他处清空/覆盖（多标签页共享）时重写，自愈
        if (code && (code !== this.notedCode || loadLastRoom()?.code !== code)) {
          this.notedCode = code;
          saveLastRoom(code);
        }
        const v = msg.view as AnyView;
        if (v.kind === 'blood') {
          // 服务端常规帧只带日志尾部（全量帧标记 logFull），与本地累积合并后再交给消费者
          v.log = this.mergeBloodLog(v.log ?? [], v.logFull !== false);
        }
        this.view = v;
        this.viewListeners.forEach((l) => l(v));
      } else if (msg.t === 'event') {
        // 血战日志增量：服务端把每帧新增的行单独下发（随后必有一条 state），
        // 先并入本地累积，这样滑出尾部窗口的旧行也不会丢
        this.mergeBloodLog([msg.line], false);
      } else if (msg.t === 'fx') {
        this.fxListeners.forEach((l) => l(msg));
      } else if (msg.t === 'error') {
        if (msg.code === 'TOKEN_INVALID' || msg.code === 'ROOM_CLOSED' || msg.code === 'KICKED') {
          // 会话/房间失效或被请离：回到大厅（必须清视图，否则卡死在旧牌桌）
          this.clearToken();
          this.notedCode = null; // 同步重置：否则重进同房间时首条 state 不写 lastRoom，横幅失效
          this.setView(null);
          if (msg.code !== 'TOKEN_INVALID') clearLastRoom(); // 房间已解散/被请离：清除「回到房间」；仅 token 失效时保留（房间可能还在，可重新加入）
          // 三类都要给出可见提示：此前只有被请离有 —— 于是服务器发版重启后（rejoin 找不到内存里的会话
          // → TOKEN_INVALID）全场玩家静默被丢回大厅，完全看不出发生了什么
          const fallback =
            msg.code === 'KICKED'
              ? '你已被房主请出房间'
              : msg.code === 'ROOM_CLOSED'
                ? '房间已解散，你已回到大厅'
                : '会话已失效（服务器可能刚更新过），请重新建房或加入';
          this.errorListeners.forEach((l) => l(msg.code, msg.msg || fallback));
          return;
        }
        this.errorListeners.forEach((l) => l(msg.code, msg.msg));
      }
    };
    ws.onclose = (ev) => {
      window.clearTimeout(watchdog);
      if (this.ws === ws) this.ws = null;
      // 被更新的连接顶掉（同 token 双标签页互踢）：清凭据回大厅，停止重连避免互踢死循环。
      // 单独状态而非 closed：App 层对 closed 一律显示「正在重连」，但 4000 永不重连，文案必须区分
      if (ev.code === 4000) {
        this.setStatus('replaced');
        this.clearToken();
        this.notedCode = null;
        clearLastRoom(); // 「回到房间」横幅会引导以全新会话再加入，与「此窗口已退回大厅」语义矛盾
        this.setView(null);
        return;
      }
      this.setStatus('closed');
      this.scheduleReconnect();
    };
  }

  private wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return;
    // 抖动 1.4-1.8：服务器重启后众多掉线客户端不会在同一瞬间挤上来（防惊群）
    const jitter = 1.4 + Math.random() * 0.4;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(Math.round(this.reconnectDelay * jitter), 5000);
      this.connect();
    }, this.reconnectDelay);
  }

  /** 网络恢复/回到前台：若当前断线则清掉退避等待立即重连 */
  forceReconnectIfClosed(): void {
    if (this.ws || this.reconnectTimer == null) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDelay = 800;
    this.connect();
  }

  /**
   * 发送一条消息。返回是否真的发出去了 —— 此前未连接时静默丢弃（界面照常可点、
   * 本地选牌已被清空、音效照响，玩家以为操作生效，实际服务端在等它，60 秒后按超时托管处理）。
   * 现在丢弃时给一条可见提示。
   */
  send(msg: C2S): boolean {
    // 入房类消息自动携带账号令牌：登录玩家在房内以账号身份记账（战绩/天梯积分）
    if (
      this.authToken &&
      !('auth' in msg) &&
      (msg.t === 'create' || msg.t === 'join' || msg.t === 'spectate' || msg.t === 'rejoin')
    ) {
      (msg as { auth?: string }).auth = this.authToken;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    this.errorListeners.forEach((l) => l('OFFLINE', '连接已断开，这次操作没有发出去（正在重连…）'));
    return false;
  }

  /** 被顶号 / 会话失效后手动重连：凭据已清空，等价于开一个全新匿名会话 */
  reconnectFresh(): void {
    if (this.ws) return; // 已经连着就别重复建
    this.started = false;
    this.start();
  }

  /* ---------------- 账号登录态 ---------------- */

  saveAuthToken(token: string): void {
    this.authToken = token;
    try {
      localStorage.setItem(AUTH_KEY, token);
    } catch {
      /* 隐私模式：仅内存持有 */
    }
  }

  clearAuthToken(): void {
    this.authToken = null;
    this.setAccount(null);
    try {
      localStorage.removeItem(AUTH_KEY);
    } catch {
      /* 忽略 */
    }
  }

  /** 其他标签页登录/登出后同步内存令牌（storage 事件不会在改动方自身触发） */
  syncAuthTokenFromStorage(): void {
    this.authToken = Net.loadAuthToken();
    if (!this.authToken) this.setAccount(null); // 被他页登出：清掉本页登录态展示
  }

  setAccount(a: AccountInfo | null): void {
    if (a?.id === this.account?.id && a?.name === this.account?.name) return;
    this.account = a;
    this.accountListeners.forEach((l) => l(a));
  }

  onAccount(l: AccountListener): () => void {
    this.accountListeners.add(l);
    return () => this.accountListeners.delete(l);
  }

  leaveRoom(): void {
    this.send({ t: 'leave' });
    this.clearToken();
    this.notedCode = null; // 同步重置：否则重进同房间时首条 state 不写 lastRoom，横幅失效
    clearLastRoom();
    this.setView(null);
  }

  /** 大厅「回到房间」横幅手动关闭 */
  forgetLastRoom(): void {
    this.notedCode = null;
    clearLastRoom();
  }

  private clearToken(): void {
    this.token = null;
    this.playerId = null;
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* 隐私模式/禁存储 */
    }
  }

  private setView(v: AnyView | null): void {
    this.view = v;
    this.viewListeners.forEach((l) => l(v));
  }

  saveName(name: string): void {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* 隐私模式/禁存储：昵称不持久化，不影响对局 */
    }
  }

  loadName(): string {
    try {
      // 与服务端 cleanName 同口径：滤控制/零宽字符并限长——历史版本或手工改写的脏值不得直达输入框与服务器
      return (
        localStorage
          .getItem(NAME_KEY)
          ?.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
          .trim()
          .slice(0, 12) ?? ''
      );
    } catch {
      return ''; // 隐私模式/禁存储
    }
  }

  onView(l: ViewListener): () => void {
    this.viewListeners.add(l);
    return () => this.viewListeners.delete(l);
  }

  /**
   * 合并日志：判定规则（去重/排序/上限/换局重置）在 `./bloodLog` 的纯函数里，这里只负责存回。
   * 抽成纯函数的理由见该文件注释：这段逻辑出错只表现为「日志面板内容不对」，必须能被单测覆盖。
   */
  private mergeBloodLog(incoming: LogLine[], full: boolean): LogLine[] {
    this.bloodLog = mergeLogs(this.bloodLog, incoming, full);
    return this.bloodLog;
  }

  onError(l: ErrorListener): () => void {
    this.errorListeners.add(l);
    return () => this.errorListeners.delete(l);
  }

  onStatus(l: StatusListener): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  /** 鲜花/鸡蛋等全桌互动特效（一次性事件，不入 state/log） */
  onFx(l: FxListener): () => void {
    this.fxListeners.add(l);
    return () => this.fxListeners.delete(l);
  }

  private setStatus(s: ConnStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }
}

// 网络恢复 / 手机息屏回到前台：断线状态下立即重连（不等退避计时器走完）
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => net.forceReconnectIfClosed());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') net.forceReconnectIfClosed();
  });
  // 其他标签页登录/登出：同步内存中的账号令牌（后续入房消息即带/不带 auth；注意此事件不跨标签页触发本页 storage 监听自身）
  window.addEventListener('storage', (e) => {
    if (e.key === AUTH_KEY || e.key === null) net.syncAuthTokenFromStorage();
  });
}

export const net = new Net();
