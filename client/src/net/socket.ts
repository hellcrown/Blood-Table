import type { C2S, S2C } from '@shared/protocol';
import type { BloodView } from '@shared/bloodProtocol';

export type ConnStatus = 'connecting' | 'open' | 'closed';
export type AnyView = import('@shared/protocol').TableView | BloodView;

type ViewListener = (v: AnyView | null) => void;
type ErrorListener = (msg: string) => void;
type StatusListener = (s: ConnStatus) => void;

const TOKEN_KEY = 'blood.token';
const NAME_KEY = 'blood.name';
// token 存 sessionStorage：每个标签页独立会话，同浏览器多开互不干扰；刷新仍可恢复

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
        this.view = msg.view as AnyView;
        this.viewListeners.forEach((l) => l(msg.view as AnyView));
      } else if (msg.t === 'error') {
        if (msg.code === 'TOKEN_INVALID' || msg.code === 'ROOM_CLOSED') {
          // 会话/房间失效：静默回到大厅
          this.clearToken();
          return;
        }
        if (msg.code === 'TOKEN_INVALID') {
          // token 失效：静默回到大厅
          this.clearToken();
          return;
        }
        this.errorListeners.forEach((l) => l(msg.msg));
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
    this.setView(null);
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
