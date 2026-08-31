import { randomBytes, randomInt } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import type { C2S, GameMode, S2C } from '@shared/protocol';
import type { BloodView } from '@shared/bloodProtocol';
import * as engine from './game/engine';
import * as blood from './blood/engine';
import { buildBloodView } from './blood/view';
import type { BloodState } from './blood/types';
import { GameError, RESULT_MS, type GState } from './game/types';
import { buildView } from './views';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_IDLE_MS = 5 * 60_000; // 全员断线 5 分钟后删除房间（保留重连机会）
const BETTING_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);

export interface Session {
  id: string;
  token: string;
  name: string;
  seat: number;
  connected: boolean;
  ws: WebSocket | null;
  /** 该会话已收到的事件序号（用于增量推送） */
  lastEventSeq: number;
}

export interface Room {
  code: string;
  hostId: string;
  maxPlayers: number;
  mode: GameMode;
  settings: { sb: number; bb: number; startChips: number };
  /** 血色模式：选将开关（默认关，房主开局前可切换） */
  charPick: boolean;
  /** 血色模式：拓展黑市开关（默认关，房主开局前可切换） */
  expansion: boolean;
  sessions: Map<string, Session>;
  game: GState | BloodState | null;
  /** 手牌结束后再移除的玩家（中途退出且还在手牌中） */
  pendingRemove: Set<string>;
  emptySince: number;
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
  const s = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, 12) : '';
  return s || `玩家${fallbackSeed % 100}`;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private tokenIndex = new Map<string, { room: Room; sessionId: string }>();
  private bindings = new WeakMap<WebSocket, { room: Room; session: Session }>();

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
        blood.bSwap(bs, pid, msg.cardIds ?? [], now);
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
        blood.bReorg(bs, pid, msg.choice, now);
        break;
      case 'bRematch': {
        if (room.hostId !== session.id) throw new GameError('NOT_HOST', '只有房主可以再来一场');
        if (bs.phase !== 'gameover') return;
        room.game = blood.bloodRematch(bs, now, room.charPick, room.expansion);
        break;
      }
      default:
        send(session.ws, { t: 'error', code: 'UNKNOWN_MSG', msg: '未知消息' });
        return;
    }
    this.broadcast(room);
  }

  /* ---------------- 入房 ---------------- */

  private handleCreate(ws: WebSocket, msg: Extract<C2S, { t: 'create' }>): void {
    const mode: GameMode = msg.mode === 'blood' ? 'blood' : 'classic';
    const room = this.createRoom(msg.maxPlayers, mode);
    const session = this.addSession(room, msg.name);
    this.bind(ws, room, session);
    send(ws, { t: 'hello', token: session.token, playerId: session.id });
    this.broadcast(room);
  }

  private handleJoin(ws: WebSocket, msg: Extract<C2S, { t: 'join' }>): void {
    const code = String(msg.code ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) throw new GameError('ROOM_NOT_FOUND', '房间不存在或已解散');
    if (room.sessions.size >= room.maxPlayers) throw new GameError('ROOM_FULL', '房间已满员');
    const session = this.addSession(room, msg.name);
    this.bind(ws, room, session);
    send(ws, { t: 'hello', token: session.token, playerId: session.id });
    this.broadcast(room);
  }

  private handleRejoin(ws: WebSocket, msg: Extract<C2S, { t: 'rejoin' }>): void {
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
    this.bind(ws, room, session);
    send(ws, { t: 'hello', token: session.token, playerId: session.id });
    this.broadcast(room);
  }

  private bind(ws: WebSocket, room: Room, session: Session): void {
    session.ws = ws;
    session.connected = true;
    this.bindings.set(ws, { room, session });
  }

  private createRoom(maxPlayersRaw: number, mode: GameMode = 'classic'): Room {
    const maxPlayers = Math.min(4, Math.max(2, Math.floor(Number(maxPlayersRaw) || 4)));
    let code = makeCode();
    while (this.rooms.has(code)) code = makeCode();
    const room: Room = {
      code,
      hostId: '',
      maxPlayers,
      mode,
      settings: { sb: 5, bb: 10, startChips: 1000 },
      charPick: false,
      expansion: false,
      sessions: new Map(),
      game: null,
      pendingRemove: new Set(),
      emptySince: 0,
    };
    this.rooms.set(code, room);
    return room;
  }

  private addSession(room: Room, nameRaw: unknown): Session {
    const taken = new Set([...room.sessions.values()].map((s) => s.seat));
    let seat = 0;
    while (taken.has(seat)) seat++;
    const session: Session = {
      id: makeId(),
      token: randomBytes(16).toString('hex'),
      name: cleanName(nameRaw, room.sessions.size + 1),
      seat,
      connected: true,
      ws: null,
      lastEventSeq: room.game?.logSeq ?? 0,
    };
    room.sessions.set(session.id, session);
    this.tokenIndex.set(session.token, { room, sessionId: session.id });
    if (!room.hostId) room.hostId = session.id;
    return session;
  }

  private removeSession(room: Room, session: Session): void {
    room.sessions.delete(session.id);
    this.tokenIndex.delete(session.token);
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
      const next = [...room.sessions.values()].find((s) => s.connected) ?? [...room.sessions.values()][0];
      room.hostId = next?.id ?? '';
    }
  }

  /* ---------------- 房间内操作 ---------------- */

  private handleLeave(room: Room, session: Session): void {
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
        const next = [...room.sessions.values()].find((s) => s.connected && s.id !== session.id);
        if (next) room.hostId = next.id;
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
    if (room.sessions.size < 2) throw new GameError('NOT_ENOUGH_PLAYERS', '至少需要 2 名玩家');
    const now = Date.now();
    if (room.mode === 'blood') {
      if (room.game) return;
      const players = [...room.sessions.values()]
        .sort((a, b) => a.seat - b.seat)
        .map((s) => ({ id: s.id, name: s.name, seat: s.seat }));
      room.game = blood.createBloodGame(room.maxPlayers, players, now, room.charPick, room.expansion);
    } else {
      if (!room.game) {
        const players = [...room.sessions.values()]
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
    if (msg.charPick != null) room.charPick = !!msg.charPick;
    if (msg.expansion != null) room.expansion = !!msg.expansion;
    this.broadcast(room);
  }

  private handleSit(room: Room, session: Session, msg: Extract<C2S, { t: 'sit' }>): void {
    const g = room.game;
    if (g && g.phase !== 'waiting') throw new GameError('IN_GAME', '对局进行中不能换座位');
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
      const connectedCount = [...room.sessions.values()].filter((s) => s.connected).length;
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
