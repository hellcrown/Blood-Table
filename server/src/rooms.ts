import { randomBytes, randomInt } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import type { C2S, GameMode, S2C, Suit } from '@shared/protocol';
import type { BloodView } from '@shared/bloodProtocol';
import * as engine from './game/engine';
import * as blood from './blood/engine';
import { buildBloodView, promptFor } from './blood/view';
import { botAct, createBrain, updateBrains, type BotBrain } from './blood/botAI';
import type { BloodState } from './blood/types';
import { GameError, RESULT_MS, type GState } from './game/types';
import { IpTable, SlidingWindow, TokenBucket } from './net/limits';
import { buildView } from './views';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_IDLE_MS = 5 * 60_000; // 全员断线 5 分钟后删除房间（保留重连机会）
const MAX_ALLBOT_ROOMS = 10; // 全机器人房间数量上限（超出后 bot 停止行动，等待空房回收）
const BETTING_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);
const MAX_ROOMS = 64; // 房间总数上限（防脚本刷房耗内存）
const MAX_ROOMS_PER_IP = 3; // 单 IP 同时拥有的房间上限
const MAX_JOIN_PER_MIN = 30;
const BOT_BUY_PAUSE_MS = 5000; // 机器人购买后停顿：让玩家看清宣告与市场变化，再进行下一次购买
const MAX_SPECTATORS = 10; // 单房间观战人数上限 // 机器人购买后停顿：让玩家看清宣告与市场变化，再进行下一次购买 // 单 IP 每分钟加入/建房尝试上限（防房间码枚举）

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
  /** 服务端机器人（不占用 WebSocket 连接，广播时跳过序列化） */
  bot?: boolean;
  /** 观战者：不占座位、只收视图（seat 恒为 -1） */
  spectator?: boolean;
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
  emptySince: number;
  /** 机器人跨回合记忆（按会话 id） */
  botBrains: Map<string, BotBrain>;
  /** 机器人下次允许行动的时间戳（随机 0.8-2s 思考延迟） */
  botNextAct: Map<string, number>;
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

export class RoomManager {
  private rooms = new Map<string, Room>();
  private tokenIndex = new Map<string, { room: Room; sessionId: string }>();
  private bindings = new WeakMap<WebSocket, { room: Room; session: Session }>();
  /** 单 IP 加入尝试限流（防房间码暴力枚举） */
  private joinAttempts = new IpTable(
    () => new SlidingWindow(60_000, MAX_JOIN_PER_MIN),
    (w, now) => w.idle(now),
  );

  constructor() {
    // 限流表闲置清理：防止海量 IP 源缓慢撑大内存
    setInterval(() => this.joinAttempts.prune(), 5 * 60_000).unref();
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
      // 房主暂时掉线不转移（重连自动恢复身份）；仅真正退出房间时才转移
      this.broadcast(room);
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
        this.handleNextHand(room);
        return;
      case 'rematch':
        this.handleRematch(room, session);
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
    switch (msg.t) {
      case 'bPickChar':
        blood.bPickChar(bs, pid, msg.charId, now);
        break;
      case 'bSetup':
        blood.bSetup(bs, pid, msg.removed ?? [], now);
        break;
      case 'bSwap':
        blood.bSwap(bs, pid, msg.cardIds ?? [], (msg as { drawCount?: number }).drawCount, now);
        break;
      case 'bSwapStop':
        blood.bSwapStop(bs, pid, now);
        break;
      case 'bPlay':
        blood.bPlay(bs, pid, msg.cardIds ?? [], now);
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
        blood.bPreciseDel(bs, pid, msg.cardIds ?? [], now);
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
        blood.bSecretDelete(bs, pid, msg.cardIds ?? [], now);
        break;
      case 'bViolent':
        blood.bViolent(bs, pid, msg.seat, now);
        break;
      case 'bRefreshPick':
        blood.bRefreshPick(bs, pid, msg.slots ?? [], now);
        break;
      case 'bPassBuy':
        blood.bPassBuy(bs, pid, now);
        break;
      case 'bRemove':
        blood.bRemove(bs, pid, msg.cardIds ?? [], now);
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
        blood.bDesignerDiscard(bs, pid, msg.cardIds ?? [], now);
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
        blood.bFryerDel(bs, pid, msg.cardIds ?? [], (msg as { done?: boolean }).done ?? false, now);
        break;
      case 'bCurseHide':
        blood.bCurseHide(bs, pid, (msg as { cardId?: string }).cardId ?? '', now);
        break;
      case 'bCurseTake':
        blood.bCurseTake(bs, pid, msg.cardIds ?? [], now);
        break;
      case 'bUndertakerSwap':
        blood.bUndertakerSwap(bs, pid, msg.cardIds ?? [], now);
        break;
      case 'bGodPeekChoice':
        blood.bGodPeekChoice(bs, pid, (msg as { mode?: 'extra' | 'blood' }).mode ?? 'blood', now);
        break;
      case 'bDetectivePick':
        blood.bDetectivePick(bs, pid, (msg as { mode?: 'top' | 'bottom' | 'skip' }).mode ?? 'skip', msg.cardIds ?? [], now);
        break;
      case 'bHackerSetup':
        blood.bHackerSetup(bs, pid, msg.removed ?? [], now);
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
          (msg as { declared?: { id: string; r: number; s: Suit | null }[] }).declared ?? [],
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
        if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以再来一场');
        if (bs.phase !== 'gameover') return;
        room.botBrains.clear(); // 记忆只在单局内有效
        room.botNextAct.clear();
        room.game = blood.bloodRematch(bs, now, room.charExpansion, room.expansion);
        break;
      }
      default:
        send(session.ws, { t: 'error', code: 'UNKNOWN_MSG', msg: '未知消息' });
        return;
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
    const code = String(msg.code ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) throw new GameError('ROOM_NOT_FOUND', '房间不存在或已解散');
    const spectatorCount = [...room.sessions.values()].filter((s) => s.spectator).length;
    if (spectatorCount >= MAX_SPECTATORS) throw new GameError('ROOM_LIMIT', '观战人数已达上限');
    this.detachBinding(ws);
    const session = this.addSession(room, msg.name, true);
    this.bind(ws, room, session);
    send(ws, { t: 'hello', token: session.token, playerId: session.id });
    this.broadcast(room);
  }

  private handleCreate(ws: WebSocket, msg: Extract<C2S, { t: 'create' }>): void {
    const ip = ws.ip ?? '';
    if (this.rooms.size >= MAX_ROOMS) throw new GameError('ROOM_LIMIT', '房间数已达上限，请稍后再试');
    const owned = [...this.rooms.values()].filter((r) => r.ownerIp === ip).length;
    if (owned >= MAX_ROOMS_PER_IP) {
      throw new GameError('ROOM_LIMIT', '每个 IP 同时最多创建 3 个房间，请先解散旧房间');
    }
    this.detachBinding(ws);
    const mode: GameMode = msg.mode === 'blood' ? 'blood' : 'classic';
    const room = this.createRoom(msg.maxPlayers, mode, ip);
    const session = this.addSession(room, msg.name);
    this.bind(ws, room, session);
    send(ws, { t: 'hello', token: session.token, playerId: session.id });
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
    this.detachBinding(ws);
    const session = this.addSession(room, msg.name);
    this.bind(ws, room, session);
    send(ws, { t: 'hello', token: session.token, playerId: session.id });
    this.broadcast(room);
  }

  private handleRejoin(ws: WebSocket, msg: Extract<C2S, { t: 'rejoin' }>): void {
    this.detachBinding(ws); // 该连接此前绑定的会话先离场清理，防幽灵占座
    const loc = this.tokenIndex.get(String(msg.token ?? ''));
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
    if (!room.hostId && !session.spectator) room.hostId = session.id; // 房主空缺（原房主离开后只剩 bot）时由重连者接任
    this.bind(ws, room, session);
    send(ws, { t: 'hello', token: session.token, playerId: session.id });
    this.broadcast(room);
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
    };
    this.rooms.set(code, room);
    return room;
  }

  private addSession(room: Room, nameRaw: unknown, spectator = false): Session {
    let name = cleanName(nameRaw, room.sessions.size + 1);
    const names = new Set([...room.sessions.values()].map((s) => s.name));
    if (names.has(name)) {
      let i = 2;
      while (names.has(`${name.slice(0, 10)}#${i}`)) i++;
      name = `${name.slice(0, 10)}#${i}`;
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
        // 血色对局仅在选将/初始构筑前/终局可安全移除
        if (bs.phase === 'pick' || bs.phase === 'setup' || bs.phase === 'gameover') {
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
    if (g && player && player.inHand && !player.folded && BETTING_PHASES.has(g.phase)) {
      // 手牌进行中：标记断线，等结算后移除；到其回合会自动弃牌
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
      room.game = blood.createBloodGame(room.maxPlayers, players, now, room.charExpansion, room.expansion, {
        targetTickets: room.targetTickets || undefined,
      });
    } else {
      if (!room.game) {
        const players = [...room.sessions.values()]
          .filter((s) => !s.spectator)
          .sort((a, b) => a.seat - b.seat)
          .map((s) => ({ id: s.id, name: s.name, seat: s.seat, chips: room.settings.startChips }));
        room.game = engine.createGame(room.settings, room.maxPlayers, players);
      }
      if (room.game.phase !== 'waiting') return;
      engine.startHand(room.game, now);
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
    if (msg.sb != null) s.sb = Math.max(1, Math.floor(msg.sb));
    if (msg.bb != null) s.bb = Math.max(2, Math.floor(msg.bb));
    if (msg.startChips != null) s.startChips = Math.max(20, Math.floor(msg.startChips));
    if (s.bb < s.sb) s.bb = s.sb;
    if (s.startChips < s.bb) s.startChips = s.bb;
    if (msg.maxPlayers != null) {
      const mp = Math.min(4, Math.max(2, Math.floor(msg.maxPlayers)));
      const stranded = [...room.sessions.values()].some((x) => x.seat >= mp);
      if (stranded) throw new GameError('SEATS_OCCUPIED', '有玩家坐在更大号座位，无法缩小房间');
      room.maxPlayers = mp;
    }
    if (msg.charExpansion != null) room.charExpansion = !!msg.charExpansion;
    if (msg.expansion != null) room.expansion = !!msg.expansion;
    if (msg.targetTickets != null) {
      const n = Math.round(msg.targetTickets);
      room.targetTickets = Math.min(30, Math.max(0, Number.isFinite(n) ? n : 0));
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
    room.botNextAct.set(bot.id, 0);
    this.broadcast(room);
  }

  /** 房主请离真人玩家：按离开流程清理并强制断开（对局中断线由超时托管兜底） */
  private handleKickPlayer(room: Room, session: Session, msg: Extract<C2S, { t: 'kickPlayer' }>): void {
    if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以请离玩家');
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
    this.handleLeave(room, target);
    if (target.ws) {
      try {
        target.ws.close(4003, 'kicked');
      } catch {
        /* 忽略 */
      }
      this.bindings.delete(target.ws);
      target.ws = null;
    }
    target.connected = false;
    this.tokenIndex.delete(target.token); // 被请离者的会话令牌失效，无法自动重回房间
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
    if (!session.spectator) throw new GameError('NOT_SPECTATOR', '你不是观战者');
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
    send(session.ws, { t: 'hello', token: bot.token, playerId: bot.id });
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
      } catch {
        acted = false; // 决策异常回退：交由超时托管安全默认
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
    if (session.spectator) {
      session.spectator = false; // 观战转玩家
      if (!room.hostId) room.hostId = session.id;
    }
    const seat = Math.floor(msg.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.maxPlayers) {
      throw new GameError('BAD_SEAT', '座位号无效');
    }
    if (seat === session.seat) return;
    if ([...room.sessions.values()].some((s) => s.seat === seat)) {
      throw new GameError('SEAT_TAKEN', '该座位已有人');
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
    engine.applyAction(g as GState, session.seat, msg.action, Date.now());
    this.broadcast(room);
  }

  private handleNextHand(room: Room): void {
    const g = room.game;
    if (!g || room.mode !== 'classic' || (g as GState).phase !== 'result') return;
    this.reconcileRemoved(room);
    engine.requestNextHand(g as GState, Date.now());
    this.broadcast(room);
  }

  private handleRematch(room: Room, session: Session): void {
    const g = room.game;
    if (!g || room.mode !== 'classic') return;
    const cg = g as GState;
    if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以再来一场');
    if (cg.phase !== 'gameover') return;
    for (const s of room.sessions.values()) {
      if (!cg.players.some((p) => p.id === s.id)) {
        engine.addPlayer(cg, { id: s.id, name: s.name, seat: s.seat, chips: room.settings.startChips });
      }
    }
    engine.rematch(cg);
    this.broadcast(room);
  }

  /* ---------------- 周期驱动 ---------------- */

  tickAll(): void {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
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
          for (const s of room.sessions.values()) this.tokenIndex.delete(s.token);
          this.rooms.delete(room.code);
          continue;
        }
      } else {
        room.emptySince = 0;
      }
      if (changed) this.broadcast(room);
    }
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

  broadcast(room: Room): void {
    const g = room.game;
    const lastSeq = g ? g.logSeq : 0;
    for (const s of room.sessions.values()) {
      if (s.ws && s.ws.readyState === s.ws.OPEN) {
        if (g) {
          for (const line of g.log) {
            if (line.seq > s.lastEventSeq) send(s.ws, { t: 'event', line });
          }
        }
        s.lastEventSeq = lastSeq;
        if (g && room.mode === 'blood' && 'market' in g) {
          const view: BloodView = buildBloodView(room, g, s.id);
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
