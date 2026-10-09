import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import type { C2S, ChatMsg, GameMode, PublicRoomInfo, S2C, Suit } from '@shared/protocol';
import type { BloodView } from '@shared/bloodProtocol';
import * as engine from './game/engine';
import * as blood from './blood/engine';
import { buildBloodView, LOG_TAIL_LINES, promptFor } from './blood/view';
import { botAct, createBrain, updateBrains, type BotBrain } from './blood/botAI';
import type { BloodState } from './blood/types';
import type { MinesDifficulty, MinesState } from '@shared/minesProtocol';
import * as mines from './mines/engine';
import { GameError, RESULT_MS, type GState } from './game/types';
import { IpTable, SlidingWindow, TokenBucket } from './net/limits';
import { recordMatch, type MatchEntry, type MatchPlayerRow } from './matchlog';
import { accountName, computeLadderPoints, isNameRegistered, recordLadderEvent, verifyToken } from './auth';
import { cleanChatText } from './chat';
import { recordAccountVisit } from './dau';
import { recordAction, recordChat, recordGameEnd, recordGameStart } from './audit';
import { dianjiangRemaining, recordDianjiangUse } from './dianjiang';
import { charPoolIds } from '@shared/bloodChars';
import { buildView } from './views';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_IDLE_MS = 5 * 60_000; // 全员断线 5 分钟后删除房间（保留重连机会）
const MAX_ALLBOT_ROOMS = 10; // 全机器人房间数量上限（超出后 bot 停止行动，等待空房回收）
const BETTING_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);
export const MAX_ROOMS = 400; // 房间总数上限（防脚本刷房耗内存；千人在线 ÷ 4 人房 ≈ 250 房，留余量）
const MAX_ROOMS_PER_IP = 5; // 单 IP 同时拥有的房间上限（留 CGNAT 余量：移动网络大量用户共享出口 IP）
const MAX_JOIN_PER_MIN = 30;
const BOT_BUY_PAUSE_MS = 5000; // 机器人购买后停顿：让玩家看清宣告与市场变化，再进行下一次购买
const MAX_SPECTATORS = 10; // 单房间观战人数上限
const ROOM_CHAT_MAX = 80; // 房间内对话历史上限：随房间存亡（销毁即清空），不落盘

declare module 'ws' {
  interface WebSocket {
    /** 客户端 IP（握手时记录，用于连接/建房配额） */
    ip?: string;
  }
}

export interface Session {
  id: string;
  token: string;
  name: string;
  seat: number;
  connected: boolean;
  ws: WebSocket | null;
  /** 该会话已收到的事件序号（用于增量推送） */
  lastEventSeq: number;
  /** 注册账号 id（登录态玩家才有；战绩/天梯积分按此归属，机器人/匿名没有） */
  accountId?: string;
  /** 服务端机器人（不占用 WebSocket 连接，广播时跳过序列化） */
  bot?: boolean;
  /** 观战者：不占座位、只收视图（seat 恒为 -1） */
  spectator?: boolean;
  /** 上次鲜花/鸡蛋互动时间（限频用） */
  lastReact?: number;
  /** 本会话最近一次绑定连接的来源 IP（断线后 ws 置 null 会丢 ws.ip，审计快照用 lastIp 兜底） */
  lastIp?: string;
  /** 点将卡：本局指定角色（等待房设置；开局生效并扣当日次数；仅注册账号有效） */
  dianjiangPick?: string;
}

export interface Room {
  code: string;
  hostId: string;
  /** 创建者 IP（建房配额用） */
  ownerIp: string;
  maxPlayers: number;
  mode: GameMode;
  settings: { sb: number; bb: number; startChips: number };
  /** 血色模式：拓展选将开关（选将始终进行；开=角色池并入拓展角色，关=仅基础4角色） */
  charExpansion: boolean;
  /** 血色模式：拓展黑市开关（默认关，房主开局前可切换） */
  expansion: boolean;
  /** 血色模式：自定义目标票数（0=按人数默认 24/20/16，钳制 8-30） */
  targetTickets: number;
  /** 扫雷模式：难度（默认 easy） */
  minesDifficulty: 'easy' | 'medium' | 'hard';
  /** 扫雷模式：时限秒数（0=按难度默认） */
  minesTimeSec: number;
  /** 扫雷模式：全员断线起始时刻（宽限 30s 覆盖刷新重连，仍无人在线则就地终局） */
  minesEmptySince: number;
  sessions: Map<string, Session>;
  /** 房间内对话历史（含观战者发言；仅内存，房间销毁即随之丢弃） */
  chatLog: ChatMsg[];
  game: GState | BloodState | MinesState | null;
  /** 手牌结束后再移除的玩家（中途退出且还在手牌中） */
  pendingRemove: Set<string>;
  /** 房间密码（可选；设置后加入/观战须携带） */
  password?: string;
  emptySince: number;
  /** 机器人跨回合记忆（按会话 id） */
  botBrains: Map<string, BotBrain>;
  /** 机器人下次允许行动的时间戳（随机 0.8-2s 思考延迟） */
  botNextAct: Map<string, number>;
  /** 当前对局已落库（终局摘要只写一次；开局/重开时重置） */
  matchLogged: boolean;
  /** 当前对局开始时间（局时长统计用） */
  gameStartedAt: number | null;
  /** 周期驱动连续异常计数（成功一次即清零；连续超限强制回收该房间） */
  tickFails?: number;
}

function send(ws: WebSocket | null, msg: S2C): void {
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* 连接已失效，忽略 */
    }
  }
}

function makeId(): string {
  return randomBytes(8).toString('hex');
}

function makeCode(): string {
  return Array.from({ length: 4 }, () => CODE_CHARS[randomInt(0, CODE_CHARS.length)]).join('');
}

function cleanName(raw: unknown, fallbackSeed: number): string {
  const s =
    typeof raw === 'string'
      ? raw
          .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 12)
      : '';
  return s || `玩家${fallbackSeed % 100}`;
}

/** 恒时比较（哈希后定长对比），防逐字符比较的时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** 房间密码校验（无密码房间恒通过）；返回 null=通过，否则为错误码 */
export function verifyRoomPassword(room: Pick<Room, 'password'>, password: unknown): 'WRONG_PASSWORD' | null {
  if (!room.password) return null;
  const pw = typeof password === 'string' ? password : '';
  return safeEqual(pw, room.password) ? null : 'WRONG_PASSWORD';
}

/** 每连接消息令牌桶（持续 ~6条/秒，突发 30；正常游戏远低于此） */
const msgBuckets = new WeakMap<WebSocket, TokenBucket>();
function takeMessageSlot(ws: WebSocket): boolean {
  let bucket = msgBuckets.get(ws);
  if (!bucket) {
    bucket = new TokenBucket(6, 30);
    msgBuckets.set(ws, bucket);
  }
  return bucket.take();
}

/** 数值参数安全钳制：客户端可发任意 JSON，NaN/Infinity 一旦入库会污染整局筹码与座位校验 */
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 数组参数边界校验：客户端可发任意 JSON（数字/对象/null），非字符串数组一律按规范错误拒绝，防引擎内 TypeError */
function strArr(v: unknown): string[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new blood.BloodError('BAD_MSG', '参数格式错误');
  }
  return v as string[];
}

/** 通用数组校验（元素须为非 null 对象，如 bBlufferDeclare 的宣告列表——null 元素会在引擎 map(d=>d.id) 处 TypeError→INTERNAL） */
function arrOf(v: unknown): unknown[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => x == null || typeof x !== 'object')) {
    throw new blood.BloodError('BAD_MSG', '参数格式错误');
  }
  return v;
}

/** 数字数组校验（黑市栏位序号等） */
function numArr(v: unknown): number[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new blood.BloodError('BAD_MSG', '参数格式错误');
  }
  return v as number[];
}

/* ---------------- 操作审计（旁路落盘，见 audit.ts；不触碰对局状态） ----------------
 * 用模块级函数而非类方法：测试普遍把 handleBlood/handleAct 解构出来裸调用（this 为 undefined），
 * 审计 taps 不得依赖 this。 */

/** 当前对局的审计 key；未开局时 gameStartedAt 为空 → audit 内部按索引未命中自动丢弃 */
function auditKeyOf(room: Room): string {
  return `${room.code}:${room.gameStartedAt ?? 0}`;
}

/** 操作尝试（含将被规则拒绝的——刷非法消息本身是作弊探针） */
function auditPlayerAct(room: Room, session: Session, t: string, rawMsg: unknown): void {
  const raw = { ...(rawMsg as Record<string, unknown>) };
  delete raw.t;
  delete raw.auth;
  delete raw.adminToken;
  delete raw.name;
  recordAction({
    key: auditKeyOf(room),
    ts: Date.now(),
    seat: session.seat,
    name: session.name,
    ...(session.accountId ? { accountId: session.accountId } : {}),
    t,
    ...(Object.keys(raw).length > 0 ? { p: raw } : {}),
  });
}

/** 开局快照：座位/昵称/账号/bot/IP（断线会话取 lastIp 兜底）+ 非 bot 座位同 IP 标记 */
function auditRoomStart(room: Room): void {
  const players = [...room.sessions.values()]
    .filter((s) => !s.spectator)
    .sort((a, b) => a.seat - b.seat)
    .map((s) => ({
      seat: s.seat,
      name: s.name,
      ...(s.accountId ? { accountId: s.accountId } : {}),
      ...(s.bot ? { bot: true } : {}),
      ...(s.ws?.ip ? { ip: s.ws.ip } : s.lastIp ? { ip: s.lastIp } : {}),
    }));
  recordGameStart({
    room: room.code,
    mode: room.mode,
    startedAt: room.gameStartedAt ?? Date.now(),
    settings:
      room.mode === 'blood'
        ? { targetTickets: room.targetTickets, charExpansion: room.charExpansion, expansion: room.expansion }
        : room.mode === 'mines'
          ? { difficulty: room.minesDifficulty, timeSec: room.minesTimeSec }
          : { ...room.settings },
    players,
  });
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  /** 部署排水：true 时向进行中对局广播一次更新公告（deploy.sh 重启前等待房间清空） */
  private draining = false;
  private drainNotified = new Set<string>();
  private tokenIndex = new Map<string, { room: Room; sessionId: string }>();
  private bindings = new WeakMap<WebSocket, { room: Room; session: Session }>();
  /** 单 IP 加入尝试限流（防房间码暴力枚举） */
  private joinAttempts = new IpTable(
    () => new SlidingWindow(60_000, MAX_JOIN_PER_MIN),
    (w, now) => w.idle(now),
  );
  /** 带密码房间的加入尝试限流（防密码爆破，更严格） */
  private pwJoins = new IpTable(
    () => new SlidingWindow(60_000, 10),
    (w, now) => w.idle(now),
  );
  /** 单房间密码错误全局限速（防多 IP 分布式爆破同一房间）：错误达 20 次/分即整体冷却 */
  private pwFailsByRoom = new Map<string, SlidingWindow>();
  /** 公开房间列表请求限流：12 次/分/IP（客户端 10s 轮询 + 手动刷新，正常使用远达不到） */
  private roomListLimit = new IpTable(
    () => new SlidingWindow(60_000, 12),
    (w, now) => w.idle(now),
  );
  /** 房间内对话限频：10 秒 5 条/IP（与全服聊天同口径；超频静默丢弃） */
  private roomChatLimits = new IpTable(
    () => new SlidingWindow(10_000, 5),
    (w, now) => w.idle(now),
  );
  /** 房间对话历史快照限流：6 次/分/IP（80 条约 8KB，防循环拉取） */
  private roomChatHistLimits = new IpTable(
    () => new SlidingWindow(60_000, 6),
    (w, now) => w.idle(now),
  );
  /** 管理员会话令牌校验器（index.ts 注入，指向 adminTokens 表）：持有有效令牌的 join/spectate 免密码 */
  private adminTokenValidator: ((t: string) => boolean) | null = null;

  private roomPwFailWindow(code: string): SlidingWindow {
    let w = this.pwFailsByRoom.get(code);
    if (!w) {
      w = new SlidingWindow(60_000, 20);
      this.pwFailsByRoom.set(code, w);
    }
    return w;
  }

  /** 密码错误记录 + 判定是否已锁定该房间 */
  private notePasswordFail(code: string): void {
    this.roomPwFailWindow(code).allow();
  }

  private roomPasswordLocked(code: string): boolean {
    return this.roomPwFailWindow(code).reached();
  }

  constructor() {
    // 限流表闲置清理：防止海量 IP 源缓慢撑大内存
    setInterval(() => {
      this.joinAttempts.prune();
      this.roomListLimit.prune();
      this.roomChatLimits.prune();
      this.roomChatHistLimits.prune();
      // pwJoins 曾漏在清理之外（访问过密码房的 IP 永久留一条），现已补齐同口径 prune
      this.pwJoins.prune();
      const now = Date.now();
      for (const [code, w] of this.pwFailsByRoom) {
        if (w.idle(now)) this.pwFailsByRoom.delete(code);
      }
    }, 5 * 60_000).unref();
  }

  /* ---------------- 连接管理 ---------------- */

  handleConnection(ws: WebSocket): void {
    ws.on('message', (raw) => this.onMessage(ws, raw));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => {
      /* close 事件会跟进 */
    });
  }

  private onClose(ws: WebSocket): void {
    const binding = this.bindings.get(ws);
    this.bindings.delete(ws);
    if (!binding) return;
    const { room, session } = binding;
    if (session.ws === ws) {
      session.ws = null;
      session.connected = false;
      if (session.spectator) {
        // 观战会话断开：宽限 30s 再移除。立刻移除会让网络抖动（客户端 ~1s 后自动重连）
        // 直接把观战者踢回大厅（会话令牌已随移除失效，重连收到「会话已失效」）；
        // 宽限期内重连经 tokenIndex 接管原会话，超时未归才移除释放观战坑位
        const t = setTimeout(() => {
          try {
            if (!session.connected && room.sessions.get(session.id) === session) {
              this.removeSession(room, session);
              if (room.sessions.size === 0 && this.rooms.get(room.code) === room) this.rooms.delete(room.code);
              this.broadcast(room);
            }
          } catch (e) {
            console.error('[room] 观战宽限清理异常:', e);
          }
        }, 30_000);
        t.unref?.();
        return;
      }
      // 房主暂时掉线不转移（重连自动恢复身份）；仅真正退出房间时才转移。
      // broadcast 有防御 try：消息/时钟路径均有 catch，唯独连接关闭路径此前无保护，视图构建异常会击穿进程
      try {
        this.broadcast(room);
      } catch (e) {
        console.error('[room] 断线广播异常:', e);
      }
    }
  }

  private onMessage(ws: WebSocket, raw: RawData): void {
    if (!takeMessageSlot(ws)) {
      if (msgBuckets.get(ws)?.flooded()) {
        try {
          ws.close(4009, 'flood');
        } catch {
          /* 忽略 */
        }
      }
      return; // 超速消息直接丢弃
    }
    let msg: C2S;
    try {
      msg = JSON.parse(String(raw)) as C2S;
    } catch {
      send(ws, { t: 'error', code: 'BAD_MSG', msg: '消息格式错误' });
      return;
    }
    // null/非对象消息（如字面量 "null"）也按 BAD_MSG 拒绝——解引用必须在 try 内或先行判空，
    // 否则 uncaughtException 会击穿整个进程（远程未认证即可触发）
    if (msg == null || typeof msg.t !== 'string') {
      send(ws, { t: 'error', code: 'BAD_MSG', msg: '消息格式错误' });
      return;
    }
    try {
      this.dispatch(ws, msg);
    } catch (e) {
      if (e instanceof GameError) send(ws, { t: 'error', code: e.code, msg: e.message });
      else if (e instanceof blood.BloodError) send(ws, { t: 'error', code: e.code, msg: e.message });
      else {
        console.error('[room] 消息处理异常:', e);
        send(ws, { t: 'error', code: 'INTERNAL', msg: '服务器内部错误' });
      }
    }
  }

  private dispatch(ws: WebSocket, msg: C2S): void {
    switch (msg.t) {
      case 'create':
        this.handleCreate(ws, msg);
        return;
      case 'join':
        this.handleJoin(ws, msg);
        return;
      case 'spectate':
        this.handleSpectate(ws, msg);
        return;
      case 'rejoin':
        this.handleRejoin(ws, msg);
        return;
      case 'ping':
        send(ws, { t: 'pong', n: msg.n });
        return;
      case 'listRooms':
        this.handleListRooms(ws);
        return;
      case 'chat':
      case 'chatHistory':
        // 全服聊天由 index.ts 的 ChatHub 前置拦截处理；两个 message 监听器并存，
        // 每条聊天消息仍会进入本分发层——此 no-op 必须存在，否则每条聊天都会
        // 额外收到 NOT_IN_ROOM（未入房）/UNKNOWN_MSG（已入房）错误
        return;
    }
    const binding = this.bindings.get(ws);
    if (!binding) {
      send(ws, { t: 'error', code: 'NOT_IN_ROOM', msg: '尚未加入房间' });
      return;
    }
    const { room, session } = binding;
    switch (msg.t) {
      case 'leave':
        this.handleLeave(room, session);
        return;
      case 'roomChat':
        this.handleRoomChat(room, session, msg);
        return;
      case 'roomChatHistory':
        this.handleRoomChatHistory(room, session);
        return;
      case 'dianjiang':
        this.handleDianjiang(room, session, msg);
        return;
      case 'start':
        this.handleStart(room, session);
        return;
      case 'settings':
        this.handleSettings(room, session, msg);
        return;
      case 'sit':
        this.handleSit(room, session, msg);
        return;
      case 'addBot':
        this.handleAddBot(room, session);
        return;
      case 'kickBot':
        this.handleKickBot(room, session, msg);
        return;
      case 'kickPlayer':
        this.handleKickPlayer(room, session, msg);
        return;
      case 'enterSpectate':
        this.handleEnterSpectate(room, session);
        return;
      case 'replaceBot':
        this.handleReplaceBot(room, session, msg);
        return;
      case 'mReveal':
        this.handleMReveal(room, session, msg);
        return;
      case 'mRematch':
        this.handleMRematch(room, session);
        return;
      case 'backToRoom':
        this.handleBackToRoom(room, session);
        return;
      case 'act':
        this.handleAct(room, session, msg);
        return;
      case 'nextHand':
        this.handleNextHand(room, session);
        return;
      case 'rematch':
        this.handleRematch(room, session);
        return;
      case 'react':
        this.handleReact(room, session, msg);
        return;
      default:
        this.handleBlood(room, session, msg);
    }
  }

  /* ---------------- 血色模式 ---------------- */

  private handleBlood(room: Room, session: Session, msg: C2S): void {
    auditPlayerAct(room, session, msg.t, msg); // 审计：所有操作尝试旁路落盘（未开局自动丢弃）
    if (session.spectator) {
      throw new blood.BloodError('SPECTATING', '观战中不能执行玩家操作');
    }
    if (!msg.t.startsWith('b')) {
      send(session.ws, { t: 'error', code: 'UNKNOWN_MSG', msg: '未知消息' });
      return;
    }
    const g = room.game;
    if (room.mode !== 'blood' || !g || g.phase === undefined || !('market' in g)) {
      send(session.ws, { t: 'error', code: 'NO_GAME', msg: '血色对局尚未开始' });
      return;
    }
    const bs = g as BloodState;
    const now = Date.now();
    const pid = session.id;
    // 未入局会话（对局开始后才入座的玩家）不得执行对局动作：
    // 否则各 b* 函数的 find(...)! 非空断言会 TypeError→INTERNAL，被刷时日志洪水且与真实故障不可区分。
    // 豁免 bRematch/backToRoom：房主可能不在对局玩家内（对局中入座接任），终局后仍需可操作，否则房间锁死
    const inGame = bs.players.some((p) => p.id === pid);
    if (!inGame && msg.t !== 'bRematch' && msg.t !== 'backToRoom') {
      throw new blood.BloodError('NO_PLAYER', '你不在当前对局中（等待下一局开始）');
    }
    switch (msg.t) {
      case 'bCrownBid':
        // 已出价：静默忽略并直接返回（不落收尾的 wasAuto 清除，防托管标记被迟到的重复消息洗掉；状态无变化无需广播）。
        // 出价数值不做钳制直传引擎：越界/畸形由引擎统一按 BAD_MSG 拒绝（竞拍是离散选择，拒绝优于静默改值）
        if (bs.crownBids[pid] != null) return;
        blood.bCrownBid(bs, pid, msg.bid, now);
        break;
      case 'bPickChar':
        blood.bPickChar(bs, pid, msg.charId, now);
        break;
      case 'bSetup':
        blood.bSetup(bs, pid, strArr(msg.removed), now);
        break;
      case 'bSwap':
        blood.bSwap(bs, pid, strArr(msg.cardIds), (msg as { drawCount?: number }).drawCount, now);
        break;
      case 'bSwapDraw':
        blood.bSwapDraw(bs, pid, (msg as { count?: number }).count ?? 0, now);
        break;
      case 'bSwapStop':
        blood.bSwapStop(bs, pid, now);
        break;
      case 'bPlay':
        blood.bPlay(bs, pid, strArr(msg.cardIds), now);
        break;
      case 'bUseItem':
        blood.bUseItem(bs, pid, msg.itemId ?? null, now);
        break;
      case 'bSteal':
        blood.bSteal(bs, pid, msg.seat, now);
        break;
      case 'bShowdownDone':
        blood.bShowdownDone(bs, pid, now);
        break;
      case 'bResign':
        blood.bResign(bs, pid, now);
        break;
      case 'bSecretTarget':
        blood.bSecretTarget(bs, pid, msg.seat, now);
        break;
      case 'bPinpoint':
        blood.bPinpoint(bs, pid, msg.seat, msg.rank, now);
        break;
      case 'bIrisGuess':
        blood.bIrisGuess(bs, pid, msg.seat, msg.cat, now);
        break;
      case 'bEraserClaim':
        blood.bEraserClaim(bs, pid, msg.cat, now);
        break;
      case 'bPreciseDel':
        blood.bPreciseDel(bs, pid, strArr(msg.cardIds), now);
        break;
      case 'bPullChip':
        blood.bPullChip(bs, pid, msg.cardId, now);
        break;
      case 'bSpringUse':
        blood.bSpringUse(bs, pid, msg.chipId, msg.mod, now);
        break;
      case 'bRevealChipTarget':
        blood.bRevealChipTarget(bs, pid, msg.seat, msg.cardId, msg.defId, now);
        break;
      case 'bSkipDecision':
        blood.bSkipDecision(bs, pid, now);
        break;
      case 'bBarrierDecide':
        blood.bBarrierDecide(bs, pid, msg.use, now);
        break;
      case 'bItemAsk':
        blood.bItemAsk(bs, pid, msg.use, now);
        break;
      case 'bDemagPick':
        blood.bDemagPick(bs, pid, msg.cardId, msg.defId, now);
        break;
      case 'bPinpointVictimPick':
        blood.bPinpointVictimPick(bs, pid, msg.cardId, now);
        break;
      case 'bBuy':
        blood.bBuy(bs, pid, msg.slot, msg.insertInto, now);
        break;
      case 'bInsertChip':
        blood.bInsertChip(bs, pid, msg.cardId, now);
        break;
      case 'bInsertSkip':
        blood.bInsertSkip(bs, pid, now);
        break;
      case 'bSecretDelete':
        blood.bSecretDelete(bs, pid, strArr(msg.cardIds), now);
        break;
      case 'bViolent':
        blood.bViolent(bs, pid, msg.seat, now);
        break;
      case 'bRefreshPick':
        blood.bRefreshPick(bs, pid, numArr(msg.slots), now);
        break;
      case 'bPassBuy':
        blood.bPassBuy(bs, pid, now);
        break;
      case 'bRemove':
        blood.bRemove(bs, pid, strArr(msg.cardIds), now);
        break;
      case 'bRemoveDone':
        blood.bRemoveDone(bs, pid, now);
        break;
      case 'bReorg':
        blood.bReorg(bs, pid, msg.choice, now, (msg as { pickCardId?: string }).pickCardId);
        break;
      /* ---- 拓展角色技能交互 ---- */
      case 'bGamblerGuess':
        blood.bGamblerGuess(bs, pid, msg.seat, now);
        break;
      case 'bBomberClaim':
        blood.bBomberClaim(bs, pid, (msg as { x?: number }).x ?? 0, now);
        break;
      case 'bSuccubusSteal':
        blood.bSuccubusSteal(bs, pid, msg.seat, now);
        break;
      case 'bScalperDeal':
        blood.bScalperDeal(bs, pid, (msg as { accept?: boolean }).accept ?? false, now);
        break;
      case 'bStudentDump':
        blood.bStudentDump(bs, pid, (msg as { accept?: boolean }).accept ?? false, (msg as { cardId?: string }).cardId, now);
        break;
      case 'bDesignerDiscard':
        blood.bDesignerDiscard(bs, pid, strArr(msg.cardIds), now);
        break;
      case 'bDogTarget':
        blood.bDogTarget(bs, pid, msg.seat, now);
        break;
      case 'bGeneralChoice':
        blood.bGeneralChoice(bs, pid, (msg as { mode?: 'gift' | 'extra' | 'skip' }).mode ?? 'skip', msg.seat, now);
        break;
      case 'bVagrantDraw':
        blood.bVagrantDraw(bs, pid, msg.seat, now);
        break;
      case 'bFryerDraw':
        blood.bFryerDraw(bs, pid, now);
        break;
      case 'bFryerDel':
        blood.bFryerDel(bs, pid, strArr(msg.cardIds), (msg as { done?: boolean }).done ?? false, now);
        break;
      case 'bCurseHide':
        blood.bCurseHide(bs, pid, (msg as { cardId?: string }).cardId ?? '', now);
        break;
      case 'bCurseTake':
        blood.bCurseTake(bs, pid, strArr(msg.cardIds), now);
        break;
      case 'bUndertakerSwap':
        blood.bUndertakerSwap(bs, pid, strArr(msg.cardIds), now);
        break;
      case 'bGodPeekChoice':
        blood.bGodPeekChoice(bs, pid, (msg as { mode?: 'extra' | 'blood' }).mode ?? 'blood', now);
        break;
      case 'bDetectivePick':
        blood.bDetectivePick(bs, pid, (msg as { mode?: 'top' | 'bottom' | 'skip' }).mode ?? 'skip', strArr(msg.cardIds), now);
        break;
      case 'bHackerSetup':
        blood.bHackerSetup(bs, pid, strArr(msg.removed), now);
        break;
      case 'bSmugglerMark':
        blood.bSmugglerMark(bs, pid, (msg as { slot?: number }).slot ?? -1, now);
        break;
      case 'bPirateRob':
        blood.bPirateRob(bs, pid, msg.seat, now);
        break;
      case 'bPirateDecide':
        blood.bPirateDecide(bs, pid, (msg as { resist?: boolean }).resist ?? false, now);
        break;
      case 'bAuctionPick':
        blood.bAuctionPick(bs, pid, (msg as { idx?: number }).idx ?? -1, now);
        break;
      case 'bAgentAsk':
        blood.bAgentAsk(bs, pid, msg.seat, now);
        break;
      case 'bAgentDecide':
        blood.bAgentDecide(bs, pid, msg.accept, now);
        break;
      case 'bAuctionBid':
        blood.bAuctionBid(bs, pid, (msg as { amount?: number }).amount ?? 0, now);
        break;
      case 'bBuySeer':
        blood.bBuySeer(bs, pid, (msg as { idx?: number }).idx ?? -1, now);
        break;
      case 'bImpDraw':
        blood.bImpDraw(bs, pid, msg.seat, now);
        break;
      case 'bImpRedeem':
        blood.bImpRedeem(bs, pid, (msg as { accept?: boolean }).accept ?? false, now);
        break;
      case 'bFacelessPick':
        blood.bFacelessPick(bs, pid, (msg as { charId?: string }).charId ?? '', now);
        break;
      case 'bFacelessConvert':
        blood.bFacelessConvert(bs, pid, now);
        break;
      case 'bBlufferDeclare':
        blood.bBlufferDeclare(
          bs,
          pid,
          arrOf(
            (msg as { declared?: { id: string; r: number; s: Suit | null }[] }).declared,
          ) as { id: string; r: number; s: Suit | null }[],
          now,
        );
        break;
      case 'bBlufferChallenge':
        blood.bBlufferChallenge(bs, pid, (msg as { challenge?: boolean }).challenge ?? false, now);
        break;
      case 'bCeoGive':
        blood.bCeoGive(bs, pid, msg.seat, (msg as { amount?: number }).amount ?? 0, now);
        break;
      case 'bCeoDone':
        blood.bCeoDone(bs, pid, now);
        break;
      case 'bCeoDecide':
        blood.bCeoDecide(bs, pid, (msg as { accept?: boolean }).accept ?? false, now);
        break;
      case 'bMynameSet':
        blood.bMynameSet(bs, pid, (msg as { cat?: number }).cat ?? 0, (msg as { name?: string }).name ?? '', now);
        break;
      case 'bCleanerDel':
        blood.bCleanerDel(bs, pid, msg.seat, (msg as { cardId?: string }).cardId ?? '', now);
        break;
      case 'bRematch': {
        if (room.hostId !== session.id) {
          // 房主空缺或房主会话已断线（关标签页未走离开流程）时，终局后由首个可操作者接任，防房间锁死
          const hostSess = room.hostId ? room.sessions.get(room.hostId) : undefined;
          if (bs.phase !== 'gameover' || hostSess?.connected) throw new GameError('NOT_HOST', '只有房主可以再来一场');
          room.hostId = session.id;
        }
        if (bs.phase !== 'gameover') return;
        room.botBrains.clear(); // 记忆只在单局内有效
        room.botNextAct.clear();
        // 重开同样补节拍偏移（addBot 的错开被 clear 掉了）
        for (const s of room.sessions.values()) {
          if (s.bot) room.botNextAct.set(s.id, now + randomInt(300, 1500));
        }
        // 从房间当前会话重建对局（而非旧局 players）：对局中入座者不再被排除在重开局之外；
        // 目标票数沿用房间设置（0=按新人数默认），与 handleStart 开局口径一致。
        // 排除断线且令牌已被清空的会话（被踢者特征）——其幽灵座位没人能接管，不该被再发进新手局
        const players = [...room.sessions.values()]
          .filter((s) => !s.spectator && (s.bot || s.connected || s.token !== ''))
          .sort((a, b) => a.seat - b.seat)
          .map((s) => ({ id: s.id, name: s.name, seat: s.seat }));
        const { forced, honored } = this.collectForcedChars(room);
        room.game = blood.createBloodGame(players.length, players, now, room.charExpansion, room.expansion, {
          targetTickets: room.targetTickets || undefined,
          forcedChars: forced,
        });
        for (const h of honored) recordDianjiangUse(h.accountId); // 再来一场是新的一局，重新扣次
        room.matchLogged = false;
        room.gameStartedAt = now;
        auditRoomStart(room); // 审计：再来一场的新对局开局快照
        // 新一局：logSeq 归零重排，必须让各会话的日志增量游标归零，
        // 否则新局日志的 seq（从 1 开始）会被客户端按"已见过"去重，日志面板停在上一局
        for (const s of room.sessions.values()) s.lastEventSeq = 0;
        this.drainNotified.delete(room.code); // 同上：再来一场的新对局重新预告
        if (this.draining) this.notifyDrain(room);
        break;
      }
      default:
        send(session.ws, { t: 'error', code: 'UNKNOWN_MSG', msg: '未知消息' });
        return;
    }
    // backToRoom 已上提到分发层（handleBackToRoom，按模式分支）；此处血色只剩 bRematch。
    // bRematch 已替换 room.game 时，bs 是被丢弃的旧引用——不得再写
    if (room.game === bs) {
      const actor = bs.players.find((x) => x.id === pid);
      if (actor) actor.wasAuto = false; // 真人操作：清除超时托管标记
    }
    this.broadcast(room);
  }

  /* ---------------- 入房 ---------------- */

  /** 同一连接换房/重入前，先对旧绑定执行离开清理（否则旧房间永远"在线"，无法被空房回收） */
  private detachBinding(ws: WebSocket): void {
    const old = this.bindings.get(ws);
    if (!old) return;
    this.bindings.delete(ws);
    const { room, session } = old;
    if (session.ws === ws) session.ws = null; // 先摘除连接，避免离场清理误关当前连接
    this.handleLeave(room, session);
  }

  /** 观战加入：不占座位、不参与操作，仅接收对局视图 */
  private handleSpectate(ws: WebSocket, msg: Extract<C2S, { t: 'spectate' }>): void {
    // 与 join 同口径烧尝试配额：spectate 对房间存在性同样可探测（ROOM_NOT_FOUND vs 密码错误），
    // 漏烧会把 join 侧的房间码暴力枚举防御整个旁路掉
    if (!this.joinAttempts.get(ws.ip ?? '').allow()) {
      throw new GameError('RATE_LIMITED', '尝试过于频繁，请稍后再试');
    }
    const code = String(msg.code ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) throw new GameError('ROOM_NOT_FOUND', '房间不存在或已解散');
    if (room.password && !this.isAdminMessage(msg)) {
      if (this.roomPasswordLocked(code)) {
        throw new GameError('RATE_LIMITED', '该房间密码错误次数过多，请 1 分钟后再试');
      }
      if (!this.pwJoins.get(ws.ip ?? '').allow()) {
        throw new GameError('RATE_LIMITED', '尝试过于频繁，请稍后再试');
      }
      const err = verifyRoomPassword(room, msg.password);
      if (err) {
        this.notePasswordFail(code);
        throw new GameError(err, '房间密码错误');
      }
    }
    // 计数排除本连接当前绑定的会话：同连接重入观战（换房间码重试）时不得把自己算进满员
    const bound = this.bindings.get(ws)?.session;
    const spectatorCount = [...room.sessions.values()].filter((s) => s.spectator && s.id !== bound?.id).length;
    if (spectatorCount >= MAX_SPECTATORS && !this.isAdminMessage(msg)) {
      throw new GameError('ROOM_LIMIT', '观战人数已达上限');
    }
    this.detachBinding(ws);
    const session = this.addSession(room, msg.name, true, this.resolveAccount(msg.auth));
    this.bind(ws, room, session);
    this.sendHello(ws, session);
    this.broadcast(room);
  }

  /** 校验客户端携带的账号令牌；无效/缺失一律按匿名处理（匿名即玩不受影响） */
  private resolveAccount(auth: unknown): string | undefined {
    return verifyToken(auth)?.accountId;
  }

  /** 会话问候：登录态附带账号信息（客户端据此展示已登录身份） */
  private sendHello(ws: WebSocket, session: Session): void {
    send(ws, {
      t: 'hello',
      token: session.token,
      playerId: session.id,
      ...(session.accountId ? { account: { id: session.accountId, name: session.name } } : {}),
    });
  }

  private handleCreate(ws: WebSocket, msg: Extract<C2S, { t: 'create' }>): void {
    const ip = ws.ip ?? '';
    if (this.rooms.size >= MAX_ROOMS) throw new GameError('ROOM_LIMIT', '房间数已达上限，请稍后再试');
    const owned = [...this.rooms.values()].filter((r) => r.ownerIp === ip).length;
    if (owned >= MAX_ROOMS_PER_IP) {
      throw new GameError('ROOM_LIMIT', `每个 IP 同时最多创建 ${MAX_ROOMS_PER_IP} 个房间，请先解散旧房间`);
    }
    this.detachBinding(ws);
    const mode: GameMode = msg.mode === 'blood' ? 'blood' : msg.mode === 'mines' ? 'mines' : 'classic';
    const room = this.createRoom(mode === 'mines' ? 2 : msg.maxPlayers, mode, ip); // 扫雷固定 1~2 人
    const pw = typeof msg.password === 'string' ? msg.password.trim().slice(0, 12) : '';
    if (pw) room.password = pw;
    const session = this.addSession(room, msg.name, false, this.resolveAccount(msg.auth));
    this.bind(ws, room, session);
    this.sendHello(ws, session);
    this.broadcast(room);
  }

  private handleJoin(ws: WebSocket, msg: Extract<C2S, { t: 'join' }>): void {
    const ip = ws.ip ?? '';
    if (!this.joinAttempts.get(ip).allow()) {
      throw new GameError('RATE_LIMITED', '尝试过于频繁，请稍后再试');
    }
    const code = String(msg.code ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) throw new GameError('ROOM_NOT_FOUND', '房间不存在或已解散');
    const seated = [...room.sessions.values()].filter((s) => !s.spectator).length;
    if (seated >= room.maxPlayers) throw new GameError('ROOM_FULL', '房间已满员');
    if (room.password && !this.isAdminMessage(msg)) {
      // 带密码房间：先查房间级锁定（防多 IP 分布式爆破），再按 IP 限速，最后校验密码
      if (this.roomPasswordLocked(code)) {
        throw new GameError('RATE_LIMITED', '该房间密码错误次数过多，请 1 分钟后再试');
      }
      if (!this.pwJoins.get(ip).allow()) {
        throw new GameError('RATE_LIMITED', '尝试过于频繁，请稍后再试');
      }
      const err = verifyRoomPassword(room, msg.password);
      if (err) {
        this.notePasswordFail(code);
        throw new GameError(err, '房间密码错误');
      }
    }
    this.detachBinding(ws);
    const session = this.addSession(room, msg.name, false, this.resolveAccount(msg.auth));
    this.bind(ws, room, session);
    this.sendHello(ws, session);
    this.broadcast(room);
  }

  private handleRejoin(ws: WebSocket, msg: Extract<C2S, { t: 'rejoin' }>): void {
    this.detachBinding(ws); // 该连接此前绑定的会话先离场清理，防幽灵占座
    const acc = this.resolveAccount(msg.auth);
    // 会话 token 优先；查不到时（换设备/换浏览器）回退按账号找活跃会话 → 跨设备回到座位
    const loc =
      this.tokenIndex.get(String(msg.token ?? '')) ?? (acc ? this.findSessionByAccount({ accountId: acc }) : undefined);
    if (!loc) throw new GameError('TOKEN_INVALID', '会话已失效，请重新加入');
    const { room, sessionId } = loc;
    const session = room.sessions.get(sessionId);
    if (!session) throw new GameError('TOKEN_INVALID', '会话已失效，请重新加入');
    // 顶掉旧连接
    if (session.ws && session.ws !== ws) {
      try {
        session.ws.close(4000, 'replaced');
      } catch {
        /* 忽略 */
      }
      this.bindings.delete(session.ws);
    }
    session.ws = ws;
    session.connected = true;
    room.pendingRemove.delete(session.id);
    if (session.accountId) recordAccountVisit(session.accountId); // 日活：重连回座位也是一次活跃
    // 引擎侧断线标记同步复位：血色 pick 阶段离场者重连后若仍是 connected=false，
    // 竞拍开始会按「已离场」替其预填 0 价且 bCrownBid 静默忽略重复出价，重连者永远无法参与竞拍
    if (room.game && room.mode === 'blood' && 'market' in room.game) {
      const bp = (room.game as BloodState).players.find((x) => x.id === session.id);
      if (bp) bp.connected = true;
    }
    if (!room.hostId && !session.spectator) room.hostId = session.id; // 房主空缺（原房主离开后只剩 bot）时由重连者接任
    this.bind(ws, room, session);
    this.sendHello(ws, session);
    this.broadcast(room);
  }

  /** 按账号找活跃会话（跨设备重连）：优先已入座会话，其次观战会话。
   *  只救援**离线**会话——在线会话属于另一台正在使用的设备，自动重连触发账号回退时不得顶掉它。 */
  private findSessionByAccount(acc: { accountId: string }): { room: Room; sessionId: string } | undefined {
    let fallback: { room: Room; sessionId: string } | undefined;
    for (const room of this.rooms.values()) {
      for (const s of room.sessions.values()) {
        if (s.bot || s.connected || s.accountId !== acc.accountId) continue;
        const loc = { room, sessionId: s.id };
        if (!s.spectator) return loc;
        fallback ??= loc;
      }
    }
    return fallback;
  }

  private bind(ws: WebSocket, room: Room, session: Session): void {
    session.ws = ws;
    session.connected = true;
    if (ws.ip) session.lastIp = ws.ip; // 断线会话的 ws 会被置空，审计快照靠 lastIp 拿回 IP
    this.bindings.set(ws, { room, session });
  }

  private createRoom(maxPlayersRaw: number, mode: GameMode = 'classic', ownerIp = ''): Room {
    const maxPlayers = Math.min(4, Math.max(2, Math.floor(Number(maxPlayersRaw) || 4)));
    let code = makeCode();
    while (this.rooms.has(code)) code = makeCode();
    const room: Room = {
      code,
      hostId: '',
      ownerIp,
      maxPlayers,
      mode,
      settings: { sb: 5, bb: 10, startChips: 1000 },
      charExpansion: false,
      expansion: false,
      targetTickets: 0,
      minesDifficulty: 'easy' as const,
      minesTimeSec: 0,
      minesEmptySince: 0,
      sessions: new Map(),
      chatLog: [],
      game: null,
      pendingRemove: new Set(),
      emptySince: 0,
      botBrains: new Map(),
      botNextAct: new Map(),
      matchLogged: false,
      gameStartedAt: null,
    };
    this.rooms.set(code, room);
    return room;
  }

  private addSession(room: Room, nameRaw: unknown, spectator = false, accountId?: string): Session {
    // 同一账号同房仅允许一个落座会话：双开可同时看两手自己的底牌做联合决策（血色双座协同更甚）。
    // 例外——同账号的**断线**落座会话由新连接接管（等价于按账号重连）：新标签页/新设备没有
    // session token 只会发 join，若直接拒绝，掉线玩家在血色对局中（座位保留到终局）就再也无法回来
    if (!spectator && accountId) {
      const dupe = [...room.sessions.values()].find((s) => s.accountId === accountId && !s.spectator);
      if (dupe) {
        if (dupe.connected) throw new GameError('ALREADY_IN_ROOM', '该账号已在本房间落座，不能重复加入');
        dupe.connected = true;
        room.pendingRemove.delete(dupe.id);
        if (room.mode === 'blood' && room.game && 'market' in room.game) {
          const bp = (room.game as BloodState).players.find((x) => x.id === dupe.id);
          if (bp) bp.connected = true; // 与 handleRejoin 同口径：复位引擎侧断线标记
        }
        if (accountId) recordAccountVisit(accountId); // 日活：断线会话被接管同样是一次活跃
        return dupe; // 调用方随后 bind(ws) 并 sendHello（hello 会下发 dupe.token 供后续重连）
      }
    }
    // 登录态强制使用账号昵称（防冒名，天梯榜展示一致）；匿名不得占用已注册昵称
    let name = accountId ? (accountName(accountId) ?? cleanName(nameRaw, room.sessions.size + 1)) : cleanName(nameRaw, room.sessions.size + 1);
    const names = new Set([...room.sessions.values()].map((s) => s.name));
    // 后缀候选同样要避开注册名表：否则匿名者可拿到「小明#2」冒充已注册用户「小明#2」（真号进房反被挤成 #2#2）
    if (names.has(name) || (!accountId && isNameRegistered(name))) {
      let i = 2;
      let cand = `${name.slice(0, 10)}#${i}`;
      while (names.has(cand) || isNameRegistered(cand)) {
        i++;
        cand = `${name.slice(0, 10)}#${i}`;
      }
      name = cand;
    }
    let seat = -1;
    if (!spectator) {
      const taken = new Set([...room.sessions.values()].map((s) => s.seat).filter((s) => s >= 0));
      seat = 0;
      while (taken.has(seat)) seat++;
    }
    const session: Session = {
      id: makeId(),
      token: randomBytes(16).toString('hex'),
      name,
      seat,
      connected: true,
      ws: null,
      lastEventSeq: room.game?.logSeq ?? 0,
      ...(accountId ? { accountId } : {}),
      ...(spectator ? { spectator: true } : {}),
    };
    room.sessions.set(session.id, session);
    this.tokenIndex.set(session.token, { room, sessionId: session.id });
    if (accountId) recordAccountVisit(accountId); // 日活：登录账号入房即一次活跃（匿名按连接 IP 统计）
    if (!room.hostId && !spectator) room.hostId = session.id;
    return session;
  }

  private removeSession(room: Room, session: Session): void {
    if (session.ws) {
      try {
        session.ws.close(4001, 'removed');
      } catch {
        /* 忽略 */
      }
      this.bindings.delete(session.ws);
      session.ws = null;
    }
    session.connected = false;
    room.sessions.delete(session.id);
    this.tokenIndex.delete(session.token);
    room.botBrains.delete(session.id);
    room.botNextAct.delete(session.id);
    if (room.game) {
      if (room.mode === 'blood') {
        const bs = room.game as BloodState;
        // 血色对局仅在竞拍/选将/初始构筑前/终局可安全移除
        if (bs.phase === 'crownBid' || bs.phase === 'pick' || bs.phase === 'setup' || bs.phase === 'gameover') {
          bs.players = bs.players.filter((p) => p.id !== session.id);
        }
      } else if (room.mode !== 'mines') {
        const cg = room.game as GState;
        // 仅在安全时机调用（结算后/未在手牌中），直接移除
        cg.players = cg.players.filter((p) => p.id !== session.id);
      }
      // 扫雷：ms.players 保持完整——离场者已由 mLeave 记出局状态，
      // 删掉会让终局排名/进度面板丢失其记录（与引擎层口径一致：退出者留在排名）
    }
    room.pendingRemove.delete(session.id);
    if (room.hostId === session.id) {
      // 房主转移永不交给机器人；只剩 bot 时置空，由下一位加入的真人接任
      const next = [...room.sessions.values()].find((s) => s.connected && !s.bot && !s.spectator);
      room.hostId = next?.id ?? '';
    }
  }

  /* ---------------- 房间内操作 ---------------- */

  private handleLeave(room: Room, session: Session): void {
    if (session.spectator) {
      this.removeSession(room, session);
      if (room.sessions.size === 0) {
        if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
        return;
      }
      this.broadcast(room);
      return;
    }
    const g = room.game;
    // 扫雷模式：进行中离场立即出局并结算（幽灵玩家不得参与排名/判胜），随后移除会话
    if (room.mode === 'mines' && g && 'difficulty' in g) {
      if ((g as MinesState).phase === 'playing') mines.mLeave(g as MinesState, session.id, Date.now());
      this.removeSession(room, session);
      if (room.sessions.size === 0) {
        // 末人离开=房间就地删除，不走 disposeRoom——审计 end 必须在此补写，
        // 否则单人局中途退出（1~2 人改动后的常见路径）会在索引里永久悬挂「进行中」
        try {
          const ms = g as MinesState;
          if (ms.phase === 'gameover' && !room.matchLogged) {
            room.matchLogged = true;
            recordGameEnd({
              key: auditKeyOf(room),
              endedAt: Date.now(),
              summary: { mode: 'mines', difficulty: ms.difficulty, ranking: ms.ranking },
              log: ms.log,
            });
          } else if (!room.matchLogged) {
            recordGameEnd({
              key: auditKeyOf(room),
              endedAt: Date.now(),
              summary: { resolved: false },
              log: ms.log,
              resolvedOnly: true,
            });
          }
        } catch (e) {
          console.error('[audit] 扫雷末人离开审计失败:', e);
        }
        if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
        return;
      }
      this.broadcast(room);
      return;
    }
    // 血色模式：直接离场标记断线（回合由超时托管兜底），终局/构筑前由 GC 清理
    if (room.mode === 'blood' && g) {
      session.connected = false;
      if (session.ws) {
        try {
          session.ws.close(4001, 'leave');
        } catch {
          /* 忽略 */
        }
        this.bindings.delete(session.ws);
        session.ws = null;
      }
      // 选将/构筑阶段离场：立即为其自动完成（否则全桌要等 60s 超时托管）
      const bs = g as BloodState;
      const bp = bs.players.find((p) => p.id === session.id);
      if (bp) {
        try {
          const now = Date.now();
          bp.connected = false; // 引擎侧离场标记：beginCrownBid 据此对先于竞拍离场者预填 0 价
          if (bs.phase === 'pick' && !bp.charId) blood.bPickChar(bs, bp.id, bp.charOptions[0], now);
          // pick 选将可能触发 beginCrownBid（预填已覆盖离场者）；此处兜底竞拍中直接离场的补价
          if (bs.phase === 'crownBid' && bs.crownBids[bp.id] == null) {
            bp.wasAuto = true; // 与超时托管同口径：非本人出价
            blood.bCrownBid(bs, bp.id, 0, now); // 离场按不参与（0）托管，不替离场者花血筹
          } else if (bs.phase === 'setup' && bp.setupRound < 2) blood.bSetup(bs, bp.id, [], now);
        } catch {
          /* 阶段守卫兜底 */
        }
      }
      if (room.hostId === session.id) {
        const next = [...room.sessions.values()].find((s) => s.connected && !s.bot && !s.spectator && s.id !== session.id);
        // 只剩机器人时不转移（置空），原房主重连即恢复身份，新玩家加入自动接任
        room.hostId = next?.id ?? '';
      }
      this.broadcast(room);
      return;
    }
    const player =
      g && room.mode === 'classic' ? (g as GState).players.find((p) => p.id === session.id) : undefined;
    if (
      g &&
      player &&
      BETTING_PHASES.has(g.phase) &&
      ((player.inHand && !player.folded) || player.committed > 0)
    ) {
      // 手牌进行中：标记断线，等结算后移除；到其回合会自动弃牌。
      // 已弃牌但本手有投入（committed>0）同样延后移除——即时删除会让其投入随玩家从池中凭空消失。
      room.pendingRemove.add(session.id);
      session.connected = false;
      if (session.ws) {
        try {
          session.ws.close(4001, 'leave');
        } catch {
          /* 忽略 */
        }
        this.bindings.delete(session.ws);
        session.ws = null;
      }
    } else {
      this.removeSession(room, session);
    }
    if (room.sessions.size === 0) {
      if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
      return;
    }
    this.broadcast(room);
  }

  private handleStart(room: Room, session: Session): void {
    if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以开始游戏');
    const seatedPlayers = [...room.sessions.values()].filter((s) => !s.spectator).length;
    if (seatedPlayers < (room.mode === 'mines' ? 1 : 2)) {
      throw new GameError('NOT_ENOUGH_PLAYERS', room.mode === 'mines' ? '至少需要 1 名玩家' : '至少需要 2 名玩家');
    }
    const now = Date.now();
    if (room.mode === 'mines') {
      if (room.game) return;
      const players = [...room.sessions.values()]
        .filter((s) => !s.spectator)
        .sort((a, b) => a.seat - b.seat)
        .map((s) => ({ id: s.id, name: s.name, seat: s.seat }));
      room.game = mines.createMinesGame(room.minesDifficulty, players, now, room.minesTimeSec);
      room.matchLogged = false; // 终局审计 end 的哨兵（broadcast mines 分支置位）
      room.gameStartedAt = now;
      // 新一局：扫雷 logSeq 归零重排，日志增量游标归零（否则新局日志被客户端按已见去重）
      for (const s of room.sessions.values()) s.lastEventSeq = 0;
    } else if (room.mode === 'blood') {
      if (room.game) return;
      const players = [...room.sessions.values()]
        .filter((s) => !s.spectator)
        .sort((a, b) => a.seat - b.seat)
        .map((s) => ({ id: s.id, name: s.name, seat: s.seat }));
      room.botBrains.clear(); // 记忆只在单局内有效（不做跨局学习）
      room.botNextAct.clear();
      // 开局给各 bot 随机节拍偏移（addBot 时的错开会被这里清掉，重新错开防同 tick 对齐）
      for (const s of room.sessions.values()) {
        if (s.bot) room.botNextAct.set(s.id, now + randomInt(300, 1500));
      }
      const { forced, honored } = this.collectForcedChars(room);
      room.game = blood.createBloodGame(players.length, players, now, room.charExpansion, room.expansion, {
        targetTickets: room.targetTickets || undefined,
        forcedChars: forced,
      });
      for (const h of honored) recordDianjiangUse(h.accountId); // 指定真正生效才扣当日次数
      room.matchLogged = false;
      room.gameStartedAt = now;
      // 新一局：logSeq 归零重排，让各会话的日志增量游标归零（否则新局日志会被客户端按已见过去重）
      for (const s of room.sessions.values()) s.lastEventSeq = 0;
      this.drainNotified.delete(room.code); // 公告按局去重：新对局须重新预告（旧局收过不代表新局知道）
      if (this.draining) this.notifyDrain(room);
    } else {
      if (!room.game) {
        const players = [...room.sessions.values()]
          .filter((s) => !s.spectator)
          .sort((a, b) => a.seat - b.seat)
          .map((s) => ({ id: s.id, name: s.name, seat: s.seat, chips: room.settings.startChips }));
        room.game = engine.createGame(room.settings, room.maxPlayers, players);
      }
      if (room.game.phase !== 'waiting') return;
      // 复盘等待期新入座的玩家补进对局（否则其座位不可见、开局也不发牌，且人数不足会让 startHand 抛错卡死房间）
      const cg = room.game as GState;
      for (const s of room.sessions.values()) {
        if (s.spectator || cg.players.some((p) => p.id === s.id)) continue;
        engine.addPlayer(cg, { id: s.id, name: s.name, seat: s.seat, chips: room.settings.startChips });
      }
      engine.startHand(room.game, now);
      room.matchLogged = false;
      room.gameStartedAt = now;
      this.drainNotified.delete(room.code); // 公告按局去重：新对局须重新预告
      if (this.draining) this.notifyDrain(room);
    }
    auditRoomStart(room); // 审计：开局快照（两种模式统一在此采集，gameStartedAt 已就位）
    this.broadcast(room);
  }

  private handleSettings(
    room: Room,
    session: Session,
    msg: Extract<C2S, { t: 'settings' }>,
  ): void {
    if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以修改设置');
    const g = room.game;
    if (g && room.mode === 'blood') throw new GameError('IN_GAME', '对局进行中不能修改设置');
    if (g && g.phase !== 'waiting') throw new GameError('IN_GAME', '对局进行中不能修改设置');
    const s = room.settings;
    if (msg.sb != null) s.sb = clampInt(msg.sb, 1, 1_000_000, s.sb);
    if (msg.bb != null) s.bb = clampInt(msg.bb, 2, 1_000_000, s.bb);
    if (msg.startChips != null) s.startChips = clampInt(msg.startChips, 20, 1_000_000, s.startChips);
    if (s.bb < s.sb) s.bb = s.sb;
    if (s.startChips < s.bb) s.startChips = s.bb;
    if (msg.maxPlayers != null && room.mode !== 'mines') {
      // 扫雷房人数固定 1~2：忽略 maxPlayers 变更（UI 也不提供）
      const mp = clampInt(msg.maxPlayers, 2, 4, room.maxPlayers);
      const stranded = [...room.sessions.values()].some((x) => x.seat >= mp);
      if (stranded) throw new GameError('SEATS_OCCUPIED', '有玩家坐在更大号座位，无法缩小房间');
      room.maxPlayers = mp;
    }
    if (msg.charExpansion != null) room.charExpansion = !!msg.charExpansion;
    if (msg.minesDifficulty != null) {
      // 扫雷难度：仅白名单枚举；对局进行中的拒绝由上方 IN_GAME 守卫覆盖（扫雷 game 非等待期）
      if (msg.minesDifficulty === 'easy' || msg.minesDifficulty === 'medium' || msg.minesDifficulty === 'hard') {
        room.minesDifficulty = msg.minesDifficulty;
      }
    }
    if (msg.minesTimeSec != null) {
      room.minesTimeSec = clampInt(msg.minesTimeSec, 0, 3600, 0); // 0=按难度默认，其余 60s~1h
    }
    if (msg.expansion != null) room.expansion = !!msg.expansion;
    if (msg.targetTickets != null) {
      const n = Math.round(msg.targetTickets);
      // 与界面承诺/引擎 resolveTargetTickets 同口径：非 0 钳 8-30。此前 rooms 层放行 1-7——
      // 视图「N 票」与天梯结算按原值、引擎开局却钳到 8，口径分裂且小目标可刷速胜天梯分
      room.targetTickets = Number.isFinite(n) ? (n === 0 ? 0 : Math.min(30, Math.max(8, n))) : 0;
    }
    if (msg.password != null) {
      const pw = typeof msg.password === 'string' ? msg.password.trim().slice(0, 12) : '';
      room.password = pw || undefined; // 空串清除密码
    }
    // 再来一场后的 waiting 期（GState 仍存在）允许改设置：必须同步进引擎快照。
    // seatCount/settings 是 createGame 时快照且引擎不再读房间——不同步会让 addPlayer 放进
    // 座位号 ≥ seatCount 的「幽灵玩家」（发不到牌 → 手牌无限循环/结算 TypeError/白赢池），
    // 并让 rematch 沿用旧起始筹码与盲注（同桌两种筹码，可利用）。
    if (g) {
      const cg = g as GState;
      cg.seatCount = room.maxPlayers;
      cg.settings = { ...room.settings };
    }
    this.broadcast(room);
  }

  /* ---------------- 机器人 ---------------- */

  private allBotRoomCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) {
      if (r.sessions.size > 0 && [...r.sessions.values()].every((s) => s.bot)) n++;
    }
    return n;
  }

  private handleAddBot(room: Room, session: Session): void {
    if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以添加机器人');
    if (room.mode !== 'blood') throw new GameError('BAD_MODE', '机器人仅支持血色模式');
    if (room.game) throw new GameError('IN_GAME', '对局进行中不能添加机器人');
    const seated = [...room.sessions.values()].filter((s) => !s.spectator).length;
    if (seated >= room.maxPlayers) throw new GameError('ROOM_FULL', '房间已满员');
    const botNo = [...room.sessions.values()].filter((s) => s.bot).length + 1;
    const taken = new Set([...room.sessions.values()].map((s) => s.seat));
    let seat = 0;
    while (taken.has(seat)) seat++;
    const bot: Session = {
      id: makeId(),
      token: randomBytes(16).toString('hex'),
      name: `🤖机器人${botNo}`,
      seat,
      connected: true,
      ws: null,
      lastEventSeq: 0,
      bot: true,
    };
    room.sessions.set(bot.id, bot);
    room.botBrains.set(bot.id, createBrain());
    room.botNextAct.set(bot.id, Date.now() + randomInt(300, 1500)); // 随机错开节拍，避免多 bot 房同 tick 碰撞放大卡顿
    this.broadcast(room);
  }

  /** 房主请离真人玩家：按离开流程清理并强制断开（对局中断线由超时托管兜底） */
  private handleKickPlayer(room: Room, session: Session, msg: Extract<C2S, { t: 'kickPlayer' }>): void {
    if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以请离玩家');
    // 座位号必须为非负整数：观战者会话恒为 seat=-1，放行会命中插入序第一个观战者并走完整踢出流程
    if (!Number.isInteger(msg.seat) || msg.seat < 0) throw new GameError('BAD_SEAT', '座位号不合法');
    const seat = Math.floor(msg.seat);
    const target = [...room.sessions.values()].find((s) => s.seat === seat && s.id !== session.id);
    if (!target) throw new GameError('BAD_SEAT', '该座位没有可请离的玩家');
    if (target.bot) {
      // bot 座位：未开局时直接移除（对局中仍走「移除机器人」的限制）
      if (room.game) throw new GameError('IN_GAME', '对局进行中不能移除机器人');
      this.removeSession(room, target);
      this.broadcast(room);
      return;
    }
    send(target.ws, { t: 'error', code: 'KICKED', msg: '你已被房主请出房间' });
    // 血色安全阶段（竞拍/选将/构筑/终局）直接移除会话：此后其幽灵座位会锁死房间
    // （占满员名额、令牌已失效无人可接管、bRematch 还会把它再发进新手局）；对局中仍走断线托管
    const bloodPhase = room.mode === 'blood' && room.game ? (room.game as BloodState).phase : null;
    if (bloodPhase != null && ['crownBid', 'pick', 'setup', 'gameover'].includes(bloodPhase)) {
      if (target.ws) {
        try {
          target.ws.close(4003, 'kicked');
        } catch {
          /* 忽略 */
        }
        this.bindings.delete(target.ws);
      }
      this.removeSession(room, target);
      this.broadcast(room);
      return;
    }
    // 非安全阶段（对局进行中）：先按请离断开（关闭码 4003，客户端据此区别于主动离开
    // —— handleLeave 内部会用 4001 关一次，故必须在它之前关并把 ws 置空）
    if (target.ws) {
      try {
        target.ws.close(4003, 'kicked');
      } catch {
        /* 忽略 */
      }
      this.bindings.delete(target.ws);
      target.ws = null;
    }
    // 引擎侧按离开流程处理：标 connected=false 进入超时托管，并自动完成竞拍/选将/构筑；
    // classic 手牌进行中会走 pendingRemove 延迟移除（与主动离开同口径，见 handleLeave）
    this.handleLeave(room, target);
    // 请离必须断根：会话令牌立即失效并清空（bRematch 以「断线且无令牌」识别被踢幽灵并排除）；
    // 账号令牌同步除名——否则被踢者可凭 30 天登录令牌经账号重连找回会话，踢人对登录玩家形同虚设
    this.tokenIndex.delete(target.token);
    target.token = '';
    delete target.accountId;
    // 血色对局中段：handleLeave 只标记断线，会话仍占满员名额（加入判定按会话数）而令牌已失效、
    // 无人可接管，替补永远进不来 —— 直接移除会话。引擎侧不受影响：对局中的玩家由 bs.players 持有，
    // removeSession 的血色阶段守卫保证不会删掉它，超时托管照常接手。
    // classic 手牌进行中则保持 pendingRemove 延迟移除：removeSession 的 classic 分支没有阶段守卫，
    // 立即删除会把手牌进行中的玩家从 cg.players 删掉——其已投入的筹码随玩家从底池凭空消失，
    // 若恰为行动中人，legalActionsFor 返回 null 令 tick 空转，每 500ms 广播直到全员离场 GC。
    if (room.mode === 'blood' && room.sessions.has(target.id)) {
      this.removeSession(room, target);
    }
  }

  /** 等待界面：已入座玩家进入观战席（释放座位；开局后不可） */
  private handleEnterSpectate(room: Room, session: Session): void {
    if (session.spectator) return;
    if (room.game) throw new GameError('IN_GAME', '对局开始后不能进入观战席');
    session.spectator = true;
    session.seat = -1;
    if (room.hostId === session.id) {
      const next = [...room.sessions.values()].find((s) => s.connected && !s.bot && !s.spectator && s.id !== session.id);
      room.hostId = next?.id ?? '';
    }
    this.broadcast(room);
  }

  /** 观战者接替机器人座位：沿用机器人的会话 id 与对局内身份，立即参与当前对局 */
  private handleReplaceBot(room: Room, session: Session, msg: Extract<C2S, { t: 'replaceBot' }>): void {
    if (room.mode !== 'blood' || !room.game) throw new GameError('IN_GAME', '当前没有可接替的对局');
    const bs = room.game as BloodState;
    if (bs.phase === 'gameover') throw new GameError('IN_GAME', '对局已结束，请等待房主返回房间');
    if (!session.spectator) throw new GameError('NOT_SPECTATOR', '你不是观战者');
    // 与 addSession 的同账号查重同口径：账号已在本房落座时不得再接替机器人，
    // 否则「先落座再观战」可绕过查重形成同一账号双座（看两手自己的牌协同作弊）
    if (
      session.accountId &&
      [...room.sessions.values()].some((s) => s.accountId === session.accountId && !s.spectator && s.id !== session.id)
    ) {
      throw new GameError('ALREADY_IN_ROOM', '该账号已在本房间落座，不能再接替机器人');
    }
    const seat = Math.floor(msg.seat);
    const bot = [...room.sessions.values()].find((s) => s.bot && s.seat === seat);
    if (!bot) throw new GameError('BAD_SEAT', '该座位没有机器人');
    const gp = bs.players.find((p) => p.id === bot.id);
    if (!gp) throw new GameError('BAD_SEAT', '该机器人不在当前对局中');
    // 会话令牌转移：观战者以机器人会话的身份继续（对局内玩家 id 不变，无需改动对局状态）
    const oldBotToken = bot.token;
    this.tokenIndex.delete(oldBotToken);
    bot.token = session.token;
    bot.name = session.name;
    bot.accountId = session.accountId;
    bot.spectator = false;
    bot.bot = false;
    bot.ws = session.ws;
    bot.connected = true;
    if (bot.accountId) recordAccountVisit(bot.accountId); // 日活：接替机器人入座也是一次活跃
    this.tokenIndex.set(bot.token, { room, sessionId: bot.id });
    this.bindings.set(session.ws!, { room, session: bot });
    room.sessions.delete(session.id);
    if (!room.hostId) room.hostId = bot.id;
    gp.name = bot.name;
    bs.log.push({ seq: ++bs.logSeq, kind: 'action', text: `👋 ${bot.name} 接替机器人入座` });
    this.sendHello(session.ws!, bot);
    this.broadcast(room);
  }

  private handleMReveal(room: Room, session: Session, msg: Extract<C2S, { t: 'mReveal' }>): void {
    if (session.spectator) throw new blood.BloodError('SPECTATING', '观战中不能执行玩家操作');
    const g = room.game;
    if (room.mode !== 'mines' || !g || g.phase !== 'playing') return;
    mines.mReveal(g as MinesState, session.id, msg.r, msg.c, Date.now());
    this.broadcast(room);
  }

  private handleMRematch(room: Room, session: Session): void {
    if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以再来一局');
    const g = room.game;
    if (room.mode !== 'mines' || !g || (g as MinesState).phase !== 'gameover') return;
    const players = [...room.sessions.values()]
      .filter((s) => !s.spectator)
      .sort((a, b) => a.seat - b.seat)
      .map((s) => ({ id: s.id, name: s.name, seat: s.seat }));
    if (players.length < 1) throw new GameError('NOT_ENOUGH_PLAYERS', '至少需要 1 名玩家'); // 扫雷 1~2 人：与 handleStart 同口径
    room.game = mines.createMinesGame(room.minesDifficulty, players, Date.now(), room.minesTimeSec);
    room.matchLogged = false;
    room.gameStartedAt = Date.now();
    this.drainNotified.delete(room.code); // 新一局重新预告（若在排水期）
    auditRoomStart(room); // 再来一局写新局的审计开局行
    for (const s of room.sessions.values()) s.lastEventSeq = 0;
    this.broadcast(room);
  }

  /** 返回房间等待页（终局后）。本分发分支遮蔽了 handleBlood 内血色的旧 case（已删），
   *  其语义必须在此按模式完整保留：血色=断线接任+断线会话清理；扫雷/德州=房主（或接任者）清局 */
  private handleBackToRoom(room: Room, session: Session): void {
    const g = room.game;
    if (!g) throw new GameError('IN_GAME', '对局尚未结束');
    if (room.mode === 'blood') {
      // 血色终局判定按 final（finishByTickets/宿命胜利都同步置位；phase 单独不可信）
      if (!('final' in g) || !g.final) throw new GameError('IN_GAME', '对局尚未结束');
    } else if (g.phase !== 'gameover') {
      throw new GameError('IN_GAME', '对局尚未结束');
    }
    // hostId 空缺或房主会话已断线（关标签页未走离开流程）时由首个调用者接任——校验全部通过后才接任，失败不留副作用
    const hostSess = room.hostId ? room.sessions.get(room.hostId) : undefined;
    if (!room.hostId || !hostSess?.connected) room.hostId = session.id;
    if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以返回房间');
    if (room.mode === 'blood') {
      // 清掉断线的真人会话（token 一并失效）：对局已结束，断线者从大厅经「回到房间」重新加入即可
      for (const s of [...room.sessions.values()]) {
        if (!s.bot && !s.connected) this.removeSession(room, s);
      }
    }
    room.game = null; // 回到房间等待页：可加减人/改设置后重新开局
    this.broadcast(room);
  }

  private handleKickBot(room: Room, session: Session, msg: Extract<C2S, { t: 'kickBot' }>): void {
    if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以移除机器人');
    if (room.game) throw new GameError('IN_GAME', '对局进行中不能移除机器人');
    const seat = Math.floor(msg.seat);
    const bot = [...room.sessions.values()].find((s) => s.bot && s.seat === seat);
    if (!bot) throw new GameError('BAD_SEAT', '该座位没有机器人');
    this.removeSession(room, bot);
    this.broadcast(room);
  }

  /** 机器人调度：每 tick 至多执行 1 个决策；有 0.8-2s 随机思考延迟 */
  private runBots(room: Room, gs: BloodState, now: number): boolean {
    if (gs.phase === 'gameover') return false;
    const bots = [...room.sessions.values()].filter((s) => s.bot).sort((a, b) => a.seat - b.seat);
    if (bots.length === 0) return false;
    // 全 bot 房数量上限：超出后 bot 静止（房间将在空房回收中解散）
    if (bots.length === room.sessions.size && this.allBotRoomCount() > MAX_ALLBOT_ROOMS) return false;
    updateBrains(room.botBrains, bots.map((b) => b.id), gs);
    for (const bot of bots) {
      const player = gs.players.find((p) => p.id === bot.id);
      if (!player) continue;
      const prompt = promptFor(gs, player);
      if (prompt.k === 'wait') continue;
      if (now < (room.botNextAct.get(bot.id) ?? 0)) continue;
      let acted = false;
      const buyAnnounceAt = gs.phase === 'buy' ? (gs.announce?.at ?? 0) : 0; // 行动前的宣告时间戳
      try {
        const brain = room.botBrains.get(bot.id) ?? createBrain();
        room.botBrains.set(bot.id, brain); // 写回：跨回合记忆与长线策略在开局/重开清空后能重新积累
        acted = botAct(brain, gs, bot.id, now);
      } catch (e) {
        acted = false; // 决策异常回退：交由超时托管安全默认（留痕便于发现 bot 决策 bug）
        console.warn('[bot] 决策异常（回退托管）:', e instanceof Error ? e.message : e);
      }
      if (acted && gs.phase === 'buy' && (gs.announce?.at ?? 0) > buyAnnounceAt) {
        // 购买阶段发生了购买/宣告：全场停顿 5s 再进行下一次购买（含轮到下一位）
        for (const b of bots) {
          room.botNextAct.set(b.id, Math.max(room.botNextAct.get(b.id) ?? 0, now + BOT_BUY_PAUSE_MS));
        }
        return true;
      }
      room.botNextAct.set(bot.id, now + (acted ? 800 + randomInt(0, 1200) : 600));
      if (acted) return true;
    }
    return false;
  }

  private handleSit(room: Room, session: Session, msg: Extract<C2S, { t: 'sit' }>): void {
    const g = room.game;
    if (g && g.phase !== 'waiting') {
      throw new GameError(
        'IN_GAME',
        session.spectator ? '对局进行中暂不能入座，请等待下一局开始' : '对局进行中不能换座位',
      );
    }
    const seat = Math.floor(msg.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.maxPlayers) {
      throw new GameError('BAD_SEAT', '座位号无效');
    }
    if (seat === session.seat) return;
    if ([...room.sessions.values()].some((s) => s.seat === seat)) {
      throw new GameError('SEAT_TAKEN', '该座位已有人');
    }
    // 观战转玩家：全部校验通过后才翻转标志，失败不得留副作用（否则留下 seat=-1 的伪玩家会话）
    if (session.spectator) {
      session.spectator = false;
      if (!room.hostId) room.hostId = session.id;
    }
    session.seat = seat;
    const player = g?.players.find((p) => p.id === session.id);
    if (player) player.seat = seat;
    if (g) g.players.sort((x, y) => x.seat - y.seat);
    this.broadcast(room);
  }

  private handleAct(room: Room, session: Session, msg: Extract<C2S, { t: 'act' }>): void {
    auditPlayerAct(room, session, msg.t, msg); // 审计：德州操作旁路落盘
    const g = room.game;
    if (!g || room.mode !== 'classic') throw new GameError('NO_GAME', '对局尚未开始');
    if (session.spectator) throw new GameError('SPECTATING', '观战中不能执行玩家操作');
    // 按会话身份定位玩家（而非直接信任 seat），观战者/已移除会话无法替座行动
    const p = (g as GState).players.find((x) => x.id === session.id);
    if (!p) throw new GameError('NO_SEAT', '你不在当前对局中');
    engine.applyAction(g as GState, p.seat, msg.action, Date.now());
    this.broadcast(room);
  }

  private handleNextHand(room: Room, session: Session): void {
    if (session.spectator) return; // 观战者不能替全桌跳过结算等待
    const g = room.game;
    if (!g || room.mode !== 'classic' || (g as GState).phase !== 'result') return;
    this.reconcileRemoved(room);
    engine.requestNextHand(g as GState, Date.now());
    this.broadcast(room);
  }

  /** 鲜花/鸡蛋互动：校验后向全桌（含观战者）广播飞行特效指令；限频 2s/人 防刷屏 */
  private handleReact(
    room: Room,
    session: Session,
    msg: Extract<C2S, { t: 'react' }>,
  ): void {
    const g = room.game;
    if (room.mode !== 'blood' || !g || !('market' in g)) throw new GameError('NO_GAME', '血色对局尚未开始');
    const bs = g as BloodState;
    const from = bs.players.find((p) => p.id === session.id);
    if (!from) throw new blood.BloodError('NO_PLAYER', '你不在当前对局中');
    if (msg.kind !== 'flower' && msg.kind !== 'egg') throw new GameError('BAD_MSG', '未知互动类型');
    const now = Date.now();
    // 200ms：支持「连砸」手感（客户端本地 250ms 节流对齐，正常连点不会触到这里）；仍防广播洪水
    if (session.lastReact != null && now - session.lastReact < 200) {
      throw new GameError('RATE_LIMITED', '互动太频繁，休息一下');
    }
    session.lastReact = now;
    const to = bs.players.find((p) => p.seat === msg.seat);
    if (!to || to.id === from.id) throw new blood.BloodError('BAD_TARGET', '目标无效');
    for (const s of room.sessions.values()) {
      send(s.ws, { t: 'fx', kind: msg.kind, from: from.seat, to: to.seat });
    }
  }

  /* ---------------- 房间内对话 ---------------- */

  /**
   * 房间内对话：发言者须已入房（含观战者），广播给房内全部会话（含本人回显）。
   * 历史挂在 Room.chatLog（上限 80 条）——房间销毁（全员离开/闲置回收/异常清理）即随之丢弃，
   * 天然满足「销毁前可见」；不落盘：房间本身无持久化，对局重启同样清零。
   * 身份直接取会话名（入房时已清洗/查重，登录者强制账号名），无需再防冒名。
   */
  private handleRoomChat(room: Room, session: Session, msg: Extract<C2S, { t: 'roomChat' }>): void {
    const text = cleanChatText(msg.text);
    if (!text) return;
    const ip = session.ws?.ip ?? '';
    if (!this.roomChatLimits.get(ip).allow()) return; // 超频静默丢弃（与全服聊天同口径：无回显即未发出）
    const m: ChatMsg = { name: session.name, text, ts: Date.now(), ...(session.accountId ? { account: true } : {}) };
    room.chatLog.push(m);
    if (room.chatLog.length > ROOM_CHAT_MAX) room.chatLog.splice(0, room.chatLog.length - ROOM_CHAT_MAX);
    recordChat({
      key: auditKeyOf(room),
      ts: m.ts,
      seat: session.seat,
      name: m.name,
      ...(session.accountId ? { accountId: session.accountId } : {}),
      text: m.text,
    }); // 审计：房间聊天（限频已通过；观战者 seat=-1）
    for (const s of room.sessions.values()) {
      // bot 无连接、断线会话 ws 为 null：send 内部按 readyState 静默跳过
      send(s.ws, { t: 'roomChatMsg', name: m.name, text: m.text, ts: m.ts, ...(m.account ? { account: true } : {}) });
    }
  }

  /** 房间对话历史快照（打开聊天面板时拉取；限流防循环拉取出站洪水） */
  private handleRoomChatHistory(room: Room, session: Session): void {
    const ip = session.ws?.ip ?? '';
    if (!this.roomChatHistLimits.get(ip).allow()) return;
    send(session.ws, { t: 'roomChatLog', msgs: room.chatLog.slice() });
  }

  /**
   * 点将卡：等待房指定/取消本局角色。仅注册账号、仅血色房等待期、角色须在当前房间池内。
   * 开局时生效并扣当日次数（见 collectForcedChars）；次数用完再设置直接拒绝，明示而非静默失效。
   */
  private handleDianjiang(room: Room, session: Session, msg: Extract<C2S, { t: 'dianjiang' }>): void {
    if (room.mode !== 'blood') throw new GameError('BAD_MODE', '点将卡仅血色模式可用');
    if (room.game) throw new GameError('IN_GAME', '对局进行中不能更改点将');
    if (session.spectator) throw new GameError('SPECTATING', '观战中不能使用点将卡');
    if (msg.charId == null) {
      session.dianjiangPick = undefined;
      this.broadcast(room);
      return;
    }
    if (!session.accountId) throw new GameError('AUTH_REQUIRED', '点将卡仅注册用户可用，请先登录');
    const charId = String(msg.charId);
    if (!charPoolIds(room.charExpansion).includes(charId)) throw new GameError('BAD_CARD', '该角色不在本局角色池中');
    if (dianjiangRemaining(session.accountId) <= 0) {
      throw new GameError('RATE_LIMITED', '今日点将次数已用完（每天 3 局），明天再来');
    }
    session.dianjiangPick = charId;
    this.broadcast(room);
  }

  /** 开局前收集各座位的点将指定：座位序先到先得（同角色冲突后者落选且不扣次） */
  private collectForcedChars(room: Room): { forced: Record<string, string>; honored: { accountId: string }[] } {
    const forced: Record<string, string> = {};
    const honored: { accountId: string }[] = [];
    if (room.mode !== 'blood') return { forced, honored };
    const pool = charPoolIds(room.charExpansion);
    for (const s of [...room.sessions.values()].filter((x) => !x.spectator).sort((a, b) => a.seat - b.seat)) {
      if (!s.dianjiangPick || !s.accountId) continue;
      if (dianjiangRemaining(s.accountId) <= 0) continue;
      if (!pool.includes(s.dianjiangPick)) continue;
      if (Object.values(forced).includes(s.dianjiangPick)) continue; // 同角色先到先得
      forced[s.id] = s.dianjiangPick;
      honored.push({ accountId: s.accountId });
    }
    return { forced, honored };
  }

  private handleRematch(room: Room, session: Session): void {
    const g = room.game;
    if (!g || room.mode !== 'classic') return;
    const cg = g as GState;
    if (room.hostId !== session.id) {
      const hostSess = room.hostId ? room.sessions.get(room.hostId) : undefined;
      // 终局且房主断线（关标签页）/空缺时由首个在场真人接任（观战者不接任）；其余保持 NOT_HOST 口径
      if (cg.phase !== 'gameover' || hostSess?.connected || session.spectator) {
        throw new GameError('NOT_HOST', '只有房主可以再来一场');
      }
      room.hostId = session.id;
    }
    if (cg.phase !== 'gameover') return;
    for (const s of room.sessions.values()) {
      if (s.spectator) continue; // 观战者（seat=-1）不能进入牌局，否则成为幽灵玩家导致牌局死锁
      if (!cg.players.some((p) => p.id === s.id)) {
        engine.addPlayer(cg, { id: s.id, name: s.name, seat: s.seat, chips: room.settings.startChips });
      }
    }
    engine.rematch(cg);
    this.broadcast(room);
  }

  /* ---------------- 周期驱动 ---------------- */

  /**
   * 全房间周期驱动。异常必须按房间隔离：try 包在整个循环外时，一个确定性抛错的「毒房间」
   * 会每 500ms 复发一次，Map 迭代序在其后的所有房间从此不再被驱动，且其自身永远走不到空房回收。
   */
  tickAll(): void {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      try {
        this.tickRoom(room, now);
        room.tickFails = 0;
      } catch (e) {
        room.tickFails = (room.tickFails ?? 0) + 1;
        console.error(`[tick] 房间 ${room.code} 驱动异常(${room.tickFails}):`, e);
        // 连续抛错判定为毒房间：强制回收，防日志洪水与全局停摆
        if ((room.tickFails ?? 0) >= 3) {
          console.error(`[tick] 房间 ${room.code} 连续异常，强制回收`);
          this.disposeRoom(room);
        }
      }
    }
  }

  private tickRoom(room: Room, now: number): void {
    const g = room.game;
    let changed = false;
    if (g && room.mode === 'mines') {
      // 全员（非观战会话）断线 30s 仍无人回来：就地终局。
      // 宽限覆盖页面刷新的重连窗口；没有它，单人局关页后会挂机到时限，重进只能观战干等
      const humansConnected = [...room.sessions.values()].some((s) => !s.spectator && s.connected);
      if (!humansConnected && (g as MinesState).phase === 'playing') {
        if (!room.minesEmptySince) room.minesEmptySince = now;
        if (now - room.minesEmptySince >= 30_000) changed = mines.minesForceEnd(g as MinesState, now);
      } else {
        room.minesEmptySince = 0;
        changed = mines.minesTick(g as MinesState, now); // 超时排名结算
      }
    } else if (g && room.mode === 'blood') {
      changed = blood.bloodTick(g as BloodState, now);
      if (!changed) changed = this.runBots(room, g as BloodState, now);
    } else if (g) {
      const cg = g as GState;
      if (cg.phase === 'result' && cg.resultAt != null && now >= cg.resultAt + RESULT_MS) {
        this.reconcileRemoved(room);
        engine.requestNextHand(cg, now);
        changed = true;
      } else {
        changed = engine.tick(cg, now);
      }
    }
    // 回收只看真实玩家：机器人在线不阻止空房回收
    const connectedCount = [...room.sessions.values()].filter((s) => s.connected && !s.bot).length;
    if (connectedCount === 0) {
      if (!room.emptySince) room.emptySince = now;
      if (now - room.emptySince >= ROOM_IDLE_MS) {
        this.disposeRoom(room);
        return;
      }
    } else {
      room.emptySince = 0;
    }
    if (changed) this.broadcast(room);
  }

  /** 解散房间：令牌全部失效并通知在线会话回大厅（空房回收为静默版，在线会话本身为空） */
  private disposeRoom(room: Room): void {
    // 审计：中途解散（空房回收/毒房间强制回收）的进行中对局补一条 end，时间线不再悬空；
    // resolved:false 标记非正常终局（这类局不进 matchlog，但审计文件里可按 key 追溯）。
    // matchLogged=false 守卫：正常终局（maybeRecordFinal 已写真摘要）后的 5 分钟空房回收
    // 不得用 resolved:false 覆盖真实胜负摘要。
    // 独立 try：毒房间的属性读取本身就可能抛错（round7 毒房间即如此），审计绝不能阻断解散
    try {
      if (room.game != null && room.gameStartedAt != null && !room.matchLogged) {
        recordGameEnd({
          key: auditKeyOf(room),
          endedAt: Date.now(),
          summary: { resolved: false },
          log: room.game.log,
          resolvedOnly: true,
        });
      }
    } catch (e) {
      console.error('[audit] 解散局审计记录失败:', e);
    }
    for (const s of room.sessions.values()) {
      this.tokenIndex.delete(s.token);
      if (s.ws && s.connected) {
        send(s.ws, { t: 'error', code: 'ROOM_CLOSED', msg: '房间出现异常已被关闭，请重新加入' });
        try {
          s.ws.close(4002, 'cleared');
        } catch {
          /* 忽略 */
        }
      }
    }
    this.rooms.delete(room.code);
  }

  private reconcileRemoved(room: Room): void {
    for (const id of room.pendingRemove) {
      const session = room.sessions.get(id);
      if (!session) continue;
      this.removeSession(room, session);
    }
    room.pendingRemove.clear();
  }

  /* ---------------- 广播 ---------------- */

  /** 终局落库：final 首次出现且尚未记录时写一条对局摘要（每局一次）；血色局同时结算天梯积分 */
  private maybeRecordFinal(room: Room, g: GState | BloodState | null): void {
    if (!g || room.matchLogged || !('final' in g) || !g.final) return;
    room.matchLogged = true;
    const now = Date.now();
    const durationMin =
      room.gameStartedAt != null && now > room.gameStartedAt
        ? Math.round(((now - room.gameStartedAt) / 60_000) * 10) / 10
        : undefined;
    let entry: MatchEntry;
    if (room.mode === 'blood' && 'market' in g) {
      entry = {
        endedAt: now,
        ...(durationMin != null ? { durationMin } : {}),
        mode: 'blood',
        seatCount: g.players.length,
        winnerSeat: g.final.winnerSeat,
        room: room.code,
        ...(room.gameStartedAt != null ? { startedAt: room.gameStartedAt } : {}),
        settings: {
          // 引擎解析后的实际目标（resolveTargetTickets：自定义钳 8-30，缺省按 maxPlayers 24/20/16）。
          // 此前记 room 原始设置——开局人数少于座位数或旧值 1-7 时与对局实际 target 不一致，天梯结算口径随之扭曲
          targetTickets: g.target,
          charExpansion: room.charExpansion,
          expansion: room.expansion,
        },
        players: g.final.ranking.map((r, i): MatchPlayerRow => {
          const p = g.players.find((x) => x.seat === r.seat);
          const sess = room.sessions.get(p?.id ?? '');
          return {
            name: r.name,
            seat: r.seat,
            rank: i + 1,
            ...(sess?.accountId ? { accountId: sess.accountId } : {}),
            ...(p?.charId ? { charId: p.charId } : {}),
            tickets: r.tickets,
            blood: r.blood,
            isBot: sess?.bot ?? false,
            wasAuto: !!r.wasAuto,
          };
        }),
      };
      // 投降局不记天梯（非完整竞技局：2人局第二名=投降者票数可倒挂，gap 轴可被串通喂满；互投刷胜场同理）
      if (!g.final.resigned) this.maybeAwardLadderPoints(room, entry, durationMin);
    } else {
      const cg = g as GState;
      const final = cg.final!; // 外层守卫已保证非空（as GState 丢失收窄）
      entry = {
        endedAt: now,
        ...(durationMin != null ? { durationMin } : {}),
        mode: 'classic',
        seatCount: cg.players.length,
        winnerSeat: final.ranking[0]?.seat ?? -1,
        room: room.code,
        ...(room.gameStartedAt != null ? { startedAt: room.gameStartedAt } : {}),
        settings: { ...room.settings },
        players: final.ranking.map((r, i): MatchPlayerRow => {
          const p = cg.players.find((x) => x.seat === r.seat);
          const sess = room.sessions.get(p?.id ?? '');
          return {
            name: r.name,
            seat: r.seat,
            rank: i + 1,
            ...(sess?.accountId ? { accountId: sess.accountId } : {}),
            chips: r.chips,
            isBot: sess?.bot ?? false,
            wasAuto: !!r.wasAuto,
          };
        }),
      };
    }
    try {
      recordMatch(entry);
    } catch (e) {
      console.error('[room] 对局落库失败:', e);
    }
    // 审计：终局摘要（含每人最终状态与 IP）+ 引擎叙述；与 matchLogged 哨兵同频，每局一次
    recordGameEnd({
      key: auditKeyOf(room),
      endedAt: now,
      ...(durationMin != null ? { durationMin } : {}),
      winnerSeat: entry.winnerSeat,
      summary: entry,
      log: g.log,
    });
  }

  /**
   * 天梯积分结算（仅血色局）：冠军已注册、且除自己外至少 1 名「非同账号」真人才计分；
   * 全机器人局不计分。0 分胜局也落事件（累计胜场）。
   */
  private maybeAwardLadderPoints(room: Room, entry: MatchEntry, durationMin: number | undefined): void {
    try {
      const winner = entry.players[0];
      if (!winner?.accountId) return;
      // 排除同账号双开占座：否则一人两座即可自己满足「真人对手」条件，单机自刷积分
      const humanRivals = entry.players.filter((p) => p.rank !== 1 && !p.isBot && p.accountId !== winner.accountId).length;
      if (humanRivals < 1) return; // 对手全是机器人（或自己的小号座位）：不计分
      const target =
        entry.settings?.targetTickets ?? (entry.seatCount <= 2 ? 24 : entry.seatCount === 3 ? 20 : 16);
      const points = computeLadderPoints(
        durationMin ?? 0,
        winner.tickets ?? 0,
        entry.players[1]?.tickets ?? 0,
        target,
      );
      recordLadderEvent({
        accountId: winner.accountId,
        ts: entry.endedAt,
        durationMin: durationMin ?? 0,
        tickets: winner.tickets ?? 0,
        secondTickets: entry.players[1]?.tickets ?? 0,
        targetTickets: target,
        seatCount: entry.seatCount,
        points,
      });
    } catch (e) {
      console.error('[room] 天梯积分结算失败:', e);
    }
  }

  broadcast(room: Room): void {
    const bsIsGameover = (g: MinesState | GState | BloodState): boolean =>
      'market' in g ? (g as BloodState).phase === 'gameover' : 'difficulty' in g ? (g as MinesState).phase === 'gameover' : false;

    const g = room.game;
    const isMinesGame = (x: unknown): x is MinesState =>
      x != null && typeof x === 'object' && 'difficulty' in x && room.mode === 'mines';
    if (!isMinesGame(g)) this.maybeRecordFinal(room, g);
    // 扫雷终局审计：必须在会话循环外——全员断线时终局广播没有收件人，
    // 循环内写会让真实排名永久丢失（disposeRoom 只能补 resolved:false）
    if (isMinesGame(g) && g.phase === 'gameover' && !room.matchLogged) {
      room.matchLogged = true;
      const durationMin =
        room.gameStartedAt != null ? Math.round(((Date.now() - room.gameStartedAt) / 60_000) * 10) / 10 : undefined;
      recordGameEnd({
        key: auditKeyOf(room),
        endedAt: Date.now(),
        ...(durationMin != null && durationMin > 0 ? { durationMin } : {}),
        winnerSeat: g.players.find((p) => p.id === g.winnerId)?.seat,
        summary: { mode: 'mines', difficulty: g.difficulty, ranking: g.ranking },
        log: g.log,
      });
    }
    const lastSeq = g ? g.logSeq : 0;
    for (const s of room.sessions.values()) {
      if (s.ws && s.ws.readyState === s.ws.OPEN) {
        // 该会话落后多少条日志、以及是否为首次下发（必须在更新 lastEventSeq 之前算）
        const behind = lastSeq - s.lastEventSeq;
        const wasFresh = s.lastEventSeq === 0;
        if (g) {
          for (const line of g.log) {
            if (line.seq > s.lastEventSeq) send(s.ws, { t: 'event', line });
          }
        }
        s.lastEventSeq = lastSeq;
        if (g && room.mode === 'mines' && 'difficulty' in g) {
          const ms = g as MinesState;
          // 观战者在终局自动回到房间等待页；玩家与观战中会话收对局视图
          //（终局审计已上提至循环外：全员断线的终局也要落真实排名）
          if (s.spectator && ms.phase === 'gameover') {
            send(s.ws, { t: 'state', view: buildView(room, s.id, true) });
          } else {
            send(s.ws, { t: 'state', view: mines.buildMinesView(ms, s.spectator === true, s.id, room.code, room.hostId) });
          }
        } else if (g && room.mode === 'blood' && 'market' in g) {
          // 首帧（新入房/重连）或落后超过尾部窗口 → 下发全量日志；其余帧只带尾部，
          // 增量由上面的 event 补齐 —— 避免每帧重传整局记录
          //（实测一局 4 人局日志 497 行 ≈ 29.5KB，占整条 state 的 84%）
          // 血色观战者同理：终局自动回房间等待页
          if (s.spectator && bsIsGameover(g)) {
            send(s.ws, { t: 'state', view: buildView(room, s.id, true) });
            continue;
          }
          const logFull = wasFresh || behind > LOG_TAIL_LINES;
          const view: BloodView = buildBloodView(room, g, s.id, { logFull, logTail: LOG_TAIL_LINES });
          send(s.ws, { t: 'state', view });
        } else {
          send(s.ws, { t: 'state', view: buildView(room, s.id) });
        }
      } else {
        s.lastEventSeq = lastSeq;
      }
    }
  }

  /** 管理接口：列出所有房间概要 */
  /**
   * 公开房间列表（大厅展示）：仅无密码房。players = 非观战会话数（含 bot 与断线座位），
   * 与满员判定同口径；等待中优先、同状态人数多在前；封顶 100 条防极端膨胀。
   */
  listPublicRooms(): PublicRoomInfo[] {
    const out: PublicRoomInfo[] = [];
    for (const room of this.rooms.values()) {
      if (room.password) continue;
      const g = room.game;
      const phase = g && 'phase' in g ? String(g.phase) : 'waiting';
      out.push({
        code: room.code,
        mode: room.mode,
        phase,
        players: [...room.sessions.values()].filter((x) => !x.spectator).length,
        maxPlayers: room.maxPlayers,
        host: [...room.sessions.values()].find((x) => x.id === room.hostId)?.name ?? '',
      });
    }
    out.sort((a, b) => {
      const aw = a.phase === 'waiting' ? 0 : a.phase === 'gameover' ? 2 : 1;
      const bw = b.phase === 'waiting' ? 0 : b.phase === 'gameover' ? 2 : 1;
      return aw - bw || b.players - a.players;
    });
    return out.slice(0, 100);
  }

  /** 公开房间列表请求：限流后下发快照（未入房即可请求，与 ping 同层） */
  private handleListRooms(ws: WebSocket): void {
    if (!this.roomListLimit.get(ws.ip ?? '').allow()) {
      throw new GameError('RATE_LIMITED', '刷新太频繁，请稍候');
    }
    send(ws, { t: 'roomList', rooms: this.listPublicRooms() });
  }

  /** 注入管理员会话令牌校验（index.ts 持有 adminTokens 表） */
  setAdminTokenValidator(fn: (t: string) => boolean): void {
    this.adminTokenValidator = fn;
  }

  /** join/spectate 消息附带的管理员令牌是否有效 */
  private isAdminMessage(msg: { adminToken?: unknown }): boolean {
    return typeof msg.adminToken === 'string' && msg.adminToken !== '' && (this.adminTokenValidator?.(msg.adminToken) ?? false);
  }

  listRooms(): { code: string; mode: GameMode; phase: string; players: number; host: string; maxPlayers: number }[] {
    return [...this.rooms.values()].map((room) => {
      const g = room.game;
      const phase = g && 'phase' in g ? String(g.phase) : 'waiting';
      const host = [...room.sessions.values()].find((s) => s.id === room.hostId)?.name ?? '';
      return { code: room.code, mode: room.mode, phase, players: room.sessions.size, host, maxPlayers: room.maxPlayers };
    });
  }

  roomCount(): number {
    return this.rooms.size;
  }

  /** 进行中对局数（game 非空的房间，含终局未返回——玩家点「返回房间」后自然清零） */
  countActiveGames(): number {
    let n = 0;
    for (const r of this.rooms.values()) {
      if (r.game != null) n++;
    }
    return n;
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** 向单个房间的对局推一条排水公告（去重由 drainNotified 保证） */
  private notifyDrain(room: Room): void {
    if (room.game == null || this.drainNotified.has(room.code)) return;
    room.game.log.push({ seq: ++room.game.logSeq, kind: 'sys', text: '⚠️ 服务器即将更新维护：本局结束后将短暂重启，重启后需重新建房或加入' });
    this.drainNotified.add(room.code);
  }

  /** 部署排水开关：置真时向所有进行中对局各推一条更新公告（新开局的对局在 handleStart/bRematch 里补推） */
  setDraining(v: boolean): void {
    if (this.draining === v) return;
    this.draining = v;
    if (!v) {
      this.drainNotified.clear();
      return;
    }
    for (const r of this.rooms.values()) {
      this.notifyDrain(r);
      if (r.game != null) this.broadcast(r);
    }
  }

  /** 一键清空所有房间（管理用途） */
  clearAllRooms(): number {
    const n = this.rooms.size;
    for (const room of this.rooms.values()) {
      try {
        if (room.game != null && room.gameStartedAt != null && !room.matchLogged) {
          recordGameEnd({
          key: auditKeyOf(room),
          endedAt: Date.now(),
          summary: { resolved: false },
          log: room.game.log,
          resolvedOnly: true,
        });
        }
      } catch {
        /* 审计失败不阻断清空 */
      }
      for (const s of room.sessions.values()) {
        this.tokenIndex.delete(s.token);
        send(s.ws, { t: 'error', code: 'ROOM_CLOSED', msg: '服务器房间已全部清空，请重新建房' });
        if (s.ws) {
          try {
            s.ws.close(4002, 'cleared');
          } catch {
            /* 忽略 */
          }
        }
      }
    }
    this.rooms.clear();
    return n;
  }
}
