import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import type { C2S, GameMode, PublicRoomInfo, S2C, Suit } from '@shared/protocol';
import type { BloodView } from '@shared/bloodProtocol';
import * as engine from './game/engine';
import * as blood from './blood/engine';
import { buildBloodView, LOG_TAIL_LINES, promptFor } from './blood/view';
import { botAct, createBrain, updateBrains, type BotBrain } from './blood/botAI';
import type { BloodState } from './blood/types';
import { GameError, RESULT_MS, type GState } from './game/types';
import { IpTable, SlidingWindow, TokenBucket } from './net/limits';
import { recordMatch, type MatchEntry, type MatchPlayerRow } from './matchlog';
import { accountName, computeLadderPoints, isNameRegistered, recordLadderEvent, verifyToken } from './auth';
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
  sessions: Map<string, Session>;
  game: GState | BloodState | null;
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
      // pwJoins 是唯一漏在清理之外的限流表：任何访问过密码房的 IP 都会永久留一条
      // （与 net/limits.ts 的「带闲置自动清理，防 Map 无限膨胀」注释相矛盾）
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
        // 观战会话断开即移除：无座位/手牌状态（重连恢复价值仅日志序号），
        // 否则断线观战者永久占 MAX_SPECTATORS 坑位，10 个断开连接即可定向占满观战席
        try {
          this.handleLeave(room, session);
        } catch (e) {
          console.error('[room] 观战断开清理异常:', e);
        }
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
        room.game = blood.createBloodGame(players.length, players, now, room.charExpansion, room.expansion, {
          targetTickets: room.targetTickets || undefined,
        });
        room.matchLogged = false;
        room.gameStartedAt = now;
        // 新一局：logSeq 归零重排，必须让各会话的日志增量游标归零，
        // 否则新局日志的 seq（从 1 开始）会被客户端按"已见过"去重，日志面板停在上一局
        for (const s of room.sessions.values()) s.lastEventSeq = 0;
        this.drainNotified.delete(room.code); // 同上：再来一场的新对局重新预告
        if (this.draining) this.notifyDrain(room);
        break;
      }
      case 'backToRoom': {
        if (!bs.final) throw new GameError('IN_GAME', '对局尚未结束');
        // hostId 空缺或房主会话已断线（关标签页未走离开流程）时由首个调用者接任——校验全部通过后才接任，失败不留副作用
        const hostSess = room.hostId ? room.sessions.get(room.hostId) : undefined;
        if (!room.hostId || !hostSess?.connected) room.hostId = session.id;
        if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以返回房间');
        // 清掉断线的真人会话（token 一并失效）：对局已结束，断线者从大厅经「回到房间」重新加入即可
        for (const s of [...room.sessions.values()]) {
          if (!s.bot && !s.connected) this.removeSession(room, s);
        }
        room.game = null; // 回到房间等待页：可加减人/改设置后重新开局
        break; // switch 收尾统一 broadcast，不再重复
      }
      default:
        send(session.ws, { t: 'error', code: 'UNKNOWN_MSG', msg: '未知消息' });
        return;
    }
    const actor = bs.players.find((x) => x.id === pid);
    if (actor) actor.wasAuto = false; // 真人操作：清除超时托管标记
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
    const code = String(msg.code ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) throw new GameError('ROOM_NOT_FOUND', '房间不存在或已解散');
    if (room.password) {
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
    const spectatorCount = [...room.sessions.values()].filter((s) => s.spectator).length;
    if (spectatorCount >= MAX_SPECTATORS) throw new GameError('ROOM_LIMIT', '观战人数已达上限');
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
    const mode: GameMode = msg.mode === 'blood' ? 'blood' : 'classic';
    const room = this.createRoom(msg.maxPlayers, mode, ip);
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
    if (room.password) {
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
      sessions: new Map(),
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
      } else {
        const cg = room.game as GState;
        // 仅在安全时机调用（结算后/未在手牌中），直接移除
        cg.players = cg.players.filter((p) => p.id !== session.id);
      }
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
        this.rooms.delete(room.code);
        return;
      }
      this.broadcast(room);
      return;
    }
    const g = room.game;
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
      this.rooms.delete(room.code);
      return;
    }
    this.broadcast(room);
  }

  private handleStart(room: Room, session: Session): void {
    if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以开始游戏');
    const seatedPlayers = [...room.sessions.values()].filter((s) => !s.spectator).length;
    if (seatedPlayers < 2) throw new GameError('NOT_ENOUGH_PLAYERS', '至少需要 2 名玩家');
    const now = Date.now();
    if (room.mode === 'blood') {
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
      room.game = blood.createBloodGame(players.length, players, now, room.charExpansion, room.expansion, {
        targetTickets: room.targetTickets || undefined,
      });
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
      this.drainNotified.delete(room.code); // 公告按局去重：新对局须重新预告（旧局收过不代表新局知道）
      if (this.draining) this.notifyDrain(room);
    }
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
    if (msg.maxPlayers != null) {
      const mp = clampInt(msg.maxPlayers, 2, 4, room.maxPlayers);
      const stranded = [...room.sessions.values()].some((x) => x.seat >= mp);
      if (stranded) throw new GameError('SEATS_OCCUPIED', '有玩家坐在更大号座位，无法缩小房间');
      room.maxPlayers = mp;
    }
    if (msg.charExpansion != null) room.charExpansion = !!msg.charExpansion;
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
    this.tokenIndex.set(bot.token, { room, sessionId: bot.id });
    this.bindings.set(session.ws!, { room, session: bot });
    room.sessions.delete(session.id);
    if (!room.hostId) room.hostId = bot.id;
    gp.name = bot.name;
    bs.log.push({ seq: ++bs.logSeq, kind: 'action', text: `👋 ${bot.name} 接替机器人入座` });
    this.sendHello(session.ws!, bot);
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
    if (g && room.mode === 'blood') {
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
    const g = room.game;
    this.maybeRecordFinal(room, g);
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
        if (g && room.mode === 'blood' && 'market' in g) {
          // 首帧（新入房/重连）或落后超过尾部窗口 → 下发全量日志；其余帧只带尾部，
          // 增量由上面的 event 补齐 —— 避免每帧重传整局记录
          //（实测一局 4 人局日志 497 行 ≈ 29.5KB，占整条 state 的 84%）
          const logFull = wasFresh || behind > LOG_TAIL_LINES;
          const view: BloodView = buildBloodView(room, g, s.id, { logFull, logTail: LOG_TAIL_LINES });
          send(s.ws, { t: 'state', view });
        } else if (g) {
          send(s.ws, { t: 'state', view: buildView(room, s.id) });
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

  listRooms(): { code: string; mode: GameMode; phase: string; players: number; host: string }[] {
    return [...this.rooms.values()].map((room) => {
      const g = room.game;
      const phase = g && 'phase' in g ? String(g.phase) : 'waiting';
      const host = [...room.sessions.values()].find((s) => s.id === room.hostId)?.name ?? '';
      return { code: room.code, mode: room.mode, phase, players: room.sessions.size, host };
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
