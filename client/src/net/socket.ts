import type { C2S, S2C } from '@shared/protocol';
import type { BloodView } from '@shared/bloodProtocol';

export type ConnStatus = 'connecting' | 'open' | 'closed';
export type AnyView = import('@shared/protocol').TableView | BloodView;

type ViewListener = (v: AnyView | null) => void;
type ErrorListener = (code: string, msg: string) => void;
type StatusListener = (s: ConnStatus) => void;

const TOKEN_KEY = 'blood.token';
const NAME_KEY = 'blood.name';
const LAST_ROOM_KEY = 'blood.lastRoom';
// token 存 sessionStorage：每个标签页独立会话，同浏览器多开互不干扰；刷新仍可恢复
// lastRoom 存 localStorage：跨标签页/会话保留「最近房间码」，供大厅「回到房间」横幅使用

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
  private reconnectTimer: number | null = null;
  private reconnectDelay = 800;
  private started = false;
  /** 已写入 lastRoom 的房间码（避免每条 state 消息重复写 localStorage） */
  private notedCode: string | null = null;

  view: AnyView | null = null;
  token: string | null = sessionStorage.getItem(TOKEN_KEY);
  playerId: string | null = null;
  status: ConnStatus = 'connecting';

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
    ws.onopen = () => {
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
        sessionStorage.setItem(TOKEN_KEY, msg.token);
      } else if (msg.t === 'state') {
        const code = typeof msg.view?.code === 'string' ? msg.view.code : null;
        if (code && code !== this.notedCode) {
          this.notedCode = code;
          saveLastRoom(code);
        }
        this.view = msg.view as AnyView;
        this.viewListeners.forEach((l) => l(msg.view as AnyView));
      } else if (msg.t === 'error') {
        if (msg.code === 'TOKEN_INVALID' || msg.code === 'ROOM_CLOSED' || msg.code === 'KICKED') {
          // 会话/房间失效或被请离：回到大厅（必须清视图，否则卡死在旧牌桌）
          this.clearToken();
          this.setView(null);
          if (msg.code !== 'TOKEN_INVALID') clearLastRoom(); // 房间已解散/被请离：清除「回到房间」；仅 token 失效时保留（房间可能还在，可重新加入）
          if (msg.code === 'KICKED') this.errorListeners.forEach((l) => l(msg.code, msg.msg)); // 被请离要给出原因
          return;
        }
        this.errorListeners.forEach((l) => l(msg.code, msg.msg));
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
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
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(Math.round(this.reconnectDelay * 1.6), 5000);
      this.connect();
    }, this.reconnectDelay);
  }

  send(msg: C2S): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  leaveRoom(): void {
    this.send({ t: 'leave' });
    this.clearToken();
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
    sessionStorage.removeItem(TOKEN_KEY);
  }

  private setView(v: AnyView | null): void {
    this.view = v;
    this.viewListeners.forEach((l) => l(v));
  }

  saveName(name: string): void {
    localStorage.setItem(NAME_KEY, name);
  }

  loadName(): string {
    return localStorage.getItem(NAME_KEY) ?? '';
  }

  onView(l: ViewListener): () => void {
    this.viewListeners.add(l);
    return () => this.viewListeners.delete(l);
  }

  onError(l: ErrorListener): () => void {
    this.errorListeners.add(l);
    return () => this.errorListeners.delete(l);
  }

  onStatus(l: StatusListener): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  private setStatus(s: ConnStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }
}

export const net = new Net();
