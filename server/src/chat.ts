/**
 * 全服聊天枢纽：大厅/对局皆可发言，广播给所有连接。
 * - 身份：登录用户（auth 令牌）用账号名；匿名用客户端昵称（清洗 + 注册名保护 + 路人兜底），
 *   解析逻辑由调用方注入（index.ts 持有 verifyToken/注册名表，本模块不依赖 auth/rooms）
 * - 防护：每 IP 10 秒 5 条（超频静默丢弃——无回显即反馈）、文本清洗 120 字上限
 * - 历史：仅内存最近 80 条（重启清零，零存储面）
 * - 接入：index.ts 在 manager.handleConnection 之前挂消息前置拦截，按 raw 前缀 `{"t":"chat`
 *   识别聊天消息（C2S 只有 chat/chatHistory 以此开头），消费后跳过房间分发层
 */
import { IpTable, SlidingWindow } from './net/limits';
import type { ChatMsg } from '@shared/protocol';

const CHAT_MAX_LEN = 120;
const HISTORY_MAX = 80;

export interface ChatIdentity {
  name: string;
  account: boolean;
}

export interface ChatDeps {
  /** 向单个连接发消息 */
  send(ws: unknown, msg: unknown): void;
  /** 广播给全服所有可用连接 */
  broadcast(msg: unknown): void;
  /** 身份解析：登录令牌 → 账号名；否则客户端昵称（清洗/保护/兜底） */
  resolveIdentity(ws: unknown, name: unknown, auth: unknown): ChatIdentity;
}

/** 文本清洗：滤控制/零宽字符（防排版污染与隐形指令），trim 后截断 */
function cleanChatText(raw: unknown): string {
  return typeof raw === 'string'
    ? raw
        .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
        .trim()
        .slice(0, CHAT_MAX_LEN)
    : '';
}

export class ChatHub {
  private history: ChatMsg[] = [];
  /** 每 IP 10 秒 5 条；IpTable 闲置自清理由调用方周期 prune 或依赖其 lastHit 判定（此处消息稀疏，无需主动清理） */
  private limits = new IpTable(
    () => new SlidingWindow(10_000, 5),
    (w, now) => w.idle(now),
  );
  /** 历史快照限流：80 条约 35KB/次，须独立限频防循环拉取出站洪水 */
  private historyLimits = new IpTable(
    () => new SlidingWindow(60_000, 6),
    (w, now) => w.idle(now),
  );

  constructor(private deps: ChatDeps) {}

  /** 清理限流表闲置条目（每 IP 一条，长期运行需周期清理防 Map 膨胀） */
  prune(): void {
    this.limits.prune();
    this.historyLimits.prune();
  }

  /** 处理一条原始消息；返回 true 表示属于聊天（已消费），调用方应跳过房间分发层 */
  onRaw(ws: unknown, raw: string): boolean {
    if (!raw.startsWith('{"t":"chat')) return false;
    let msg: { t?: unknown; text?: unknown; name?: unknown; auth?: unknown };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return true; // 聊天前缀但解析失败：消费掉，不进房间层
    }
    if (msg.t === 'chatHistory') {
      const hip = (ws as { ip?: string }).ip ?? '';
      if (this.historyLimits.get(hip).allow()) {
        this.deps.send(ws, { t: 'chatLog', msgs: this.history.slice() });
      }
      return true;
    }
    if (msg.t !== 'chat') return true;
    const text = cleanChatText(msg.text);
    if (!text) return true;
    const ip = (ws as { ip?: string }).ip ?? '';
    if (!this.limits.get(ip).allow()) return true; // 超频静默丢弃
    const id = this.deps.resolveIdentity(ws, msg.name, msg.auth);
    const m: ChatMsg = { name: id.name, text, ts: Date.now(), ...(id.account ? { account: true } : {}) };
    this.history.push(m);
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    this.deps.broadcast({ t: 'chatMsg', name: m.name, text: m.text, ts: m.ts, ...(m.account ? { account: true } : {}) });
    return true;
  }
}
