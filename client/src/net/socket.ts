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
type RoomListListener = (rooms: import('@shared/protocol').PublicRoomInfo[]) => void;
type ChatMsgListener = (m: import('@shared/protocol').ChatMsg) => void;
type ChatLogListener = (msgs: import('@shared/protocol').ChatMsg[]) => void;
type RoomChatMsgListener = (m: import('@shared/protocol').ChatMsg) => void;
type RoomChatLogListener = (msgs: import('@shared/protocol').ChatMsg[]) => void;

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
  private roomListListeners = new Set<RoomListListener>();
  private chatMsgListeners = new Set<ChatMsgListener>();
  private chatLogListeners = new Set<ChatLogListener>();
  private roomChatMsgListeners = new Set<RoomChatMsgListener>();
  private roomChatLogListeners = new Set<RoomChatLogListener>();
  private accountListeners = new Set<AccountListener>();
  private reconnectTimer: number | null = null;
  private reconnectDelay = 800;
  private started = false;
  /** 已写入 lastRoom 的房间码（避免每条 state 消息重复写 localStorage） */
  private notedCode: string | null = null;
  /** 主动退出房间时所在的连接：该连接上迟到的 state 帧一律丢弃（见 onmessage state 分支） */
  private leavingWs: WebSocket | null = null;
  /** 主动退出引发的重连周期：静默进行，不跌入 closed/connecting 状态（避免退房后闪断线横幅） */
  private quietReconnect = false;
  /** 当前血战日志所属的房间码：换房（code 变化）时强制全量重置，防跨房日志混排 */
  private bloodLogCode: string | null = null;
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
    // 主动退出的静默重连周期：跳过 connecting 状态（连接本来就是我们请服务器关的，不是断线）
    if (!this.quietReconnect) this.setStatus('connecting');
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
      this.quietReconnect = false;
      this.reconnectDelay = 800;
      // rejoin 必须先于 setStatus('open')：状态监听者（如聊天弹窗的重连补拉）会在 open
      // 同步发出房间请求，服务端按消息序处理——先绑座才不会吃到 NOT_IN_ROOM
      if (this.token) this.send({ t: 'rejoin', token: this.token });
      this.setStatus('open');
    };
    ws.onmessage = (ev) => {
      let msg: S2C;
      try {
        msg = JSON.parse(String(ev.data)) as S2C;
      } catch {
        return;
      }
      if (msg.t === 'hello') {
        this.leavingWs = null; // 新会话绑定（含同一连接上的再次入房）：迟到帧防护完成使命
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
        // 主动退出后（见 leaveRoom），服务器处理 leave 前已广播的最后一帧 state 可能仍在途：
        // 此时套用会把刚清空的 view 复原成旧牌桌（玩家表现为「点退出没反应，要退两次，
        // 第二次报『尚未加入房间』」），还会把刚清除的 lastRoom 重写回去（大厅重现「回到房间」横幅）。
        // 该连接上的后续帧一律丢弃；重连后的新连接或 hello（新入房）不受影响。
        if (ws === this.leavingWs) return;
        const code = typeof msg.view?.code === 'string' ? msg.view.code : null;
        // code 变化或 lastRoom 被他处清空/覆盖（多标签页共享）时重写，自愈
        if (code && (code !== this.notedCode || loadLastRoom()?.code !== code)) {
          this.notedCode = code;
          saveLastRoom(code);
        }
        const v = msg.view as AnyView;
        if (v.kind === 'blood') {
          // 房间码变化 → 强制全量重置：中途入房/观战时服务端首帧只带尾部（lastEventSeq 初始化为
          // 当前 logSeq，logFull=false），不重置会把上一个房间的日志行按 seq 混排进本局面板
          const full = v.logFull !== false || code !== this.bloodLogCode;
          v.log = this.mergeBloodLog(v.log ?? [], full);
          this.bloodLogCode = code;
        }
        this.view = v;
        this.viewListeners.forEach((l) => l(v));
      } else if (msg.t === 'event') {
        // 已退出房间：迟到增量并入会污染下一个房间的日志基线（随后虽有换房重置兜底，此处直接掐掉）
        if (ws === this.leavingWs) return;
        // 血战日志增量：服务端把每帧新增的行单独下发（随后必有一条 state），
        // 先并入本地累积，这样滑出尾部窗口的旧行也不会丢
        this.mergeBloodLog([msg.line], false);
      } else if (msg.t === 'fx') {
        this.fxListeners.forEach((l) => l(msg));
      } else if (msg.t === 'roomList') {
        this.roomListListeners.forEach((l) => l(msg.rooms));
      } else if (msg.t === 'chatMsg') {
        this.chatMsgListeners.forEach((l) => l(msg));
      } else if (msg.t === 'chatLog') {
        this.chatLogListeners.forEach((l) => l(msg.msgs));
      } else if (msg.t === 'roomChatMsg') {
        this.roomChatMsgListeners.forEach((l) => l(msg));
      } else if (msg.t === 'roomChatLog') {
        this.roomChatLogListeners.forEach((l) => l(msg.msgs));
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
      // 主动退出引发的关闭（见 leaveRoom）：连接是我们请服务器关的，静默重连即可，
      // 不置 closed——否则每次退房后大厅都闪 1 秒多的「连接断开，正在重连」横幅。
      // 若重连失败，后续连接的 close 不再命中 leavingWs，断线提示照常出现（自愈）。
      if (ws === this.leavingWs) {
        this.quietReconnect = true;
        this.scheduleReconnect();
        return;
      }
      this.quietReconnect = false; // 静默链到此为止：之后任何断开都正常提示
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
      (msg.t === 'create' || msg.t === 'join' || msg.t === 'spectate' || msg.t === 'rejoin' || msg.t === 'chat')
    ) {
      (msg as { auth?: string }).auth = this.authToken;
    }
    // 聊天身份：匿名玩家的昵称来自大厅保存名（登录用户由服务端按 auth 强制账号名，忽略此字段）
    if (msg.t === 'chat' && !('name' in msg)) {
      const saved = this.loadName();
      if (saved) (msg as { name?: string }).name = saved;
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
    // 标记本连接：服务器处理 leave 前发出的 state 帧仍在途，到达后不得把 view 弹回旧牌桌
    this.leavingWs = this.ws;
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

  /** 公开房间列表快照（大厅轮询用） */
  onRoomList(l: RoomListListener): () => void {
    this.roomListListeners.add(l);
    return () => this.roomListListeners.delete(l);
  }

  /** 全服聊天：实时消息广播 */
  onChatMsg(l: ChatMsgListener): () => void {
    this.chatMsgListeners.add(l);
    return () => this.chatMsgListeners.delete(l);
  }

  /** 全服聊天：历史快照（打开聊天窗时拉取） */
  onChatLog(l: ChatLogListener): () => void {
    this.chatLogListeners.add(l);
    return () => this.chatLogListeners.delete(l);
  }

  /** 房间内聊天：实时消息（仅同房间会话可见，含本人回显） */
  onRoomChatMsg(l: RoomChatMsgListener): () => void {
    this.roomChatMsgListeners.add(l);
    return () => this.roomChatMsgListeners.delete(l);
  }

  /** 房间内聊天：历史快照（打开聊天窗时拉取） */
  onRoomChatLog(l: RoomChatLogListener): () => void {
    this.roomChatLogListeners.add(l);
    return () => this.roomChatLogListeners.delete(l);
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
